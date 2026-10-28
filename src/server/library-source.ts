import { execFile } from 'child_process';
import { lstat, readFile, readdir, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { basename, delimiter, dirname, join } from 'path';

import type { LibrarySourceResponse } from '../types/diff.js';
import { type Descriptor, parseGlobalSymbol } from './scip-index.js';
import { readZipEntry } from './zip-file.js';

// Finds the source of a declaration that lives in a library, reading only what is already on
// this machine: the src.zip of an installed JDK and -sources.jar files in the Gradle and Maven
// caches.

export interface SourceLocations {
  javaHome?: string;
  // Directories searched for `java`, as in PATH.
  pathDirs: string[];
  // Holds one JDK per directory, as /usr/lib/jvm does.
  jvmDir: string;
  gradleHome: string;
  mavenRepository: string;
}

export function sourceLocations(env: NodeJS.ProcessEnv = process.env): SourceLocations {
  return {
    ...(env.JAVA_HOME ? { javaHome: env.JAVA_HOME } : {}),
    pathDirs: (env.PATH ?? '').split(delimiter).filter(Boolean),
    jvmDir: '/usr/lib/jvm',
    gradleHome: env.GRADLE_USER_HOME || join(homedir(), '.gradle'),
    mavenRepository: join(homedir(), '.m2', 'repository'),
  };
}

const COORDINATE = /^[\w+-][\w.+-]*$/;
const JAVA_VERSION_TIMEOUT_MS = 5_000;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

// "1.8.0_402" → "8", "17.0.20.1" → "17".
function majorVersion(version: string): string | null {
  const parts = version.split(/[._+-]/);
  const major = parts[0] === '1' ? parts[1] : parts[0];
  return major && /^\d+$/.test(major) ? major : null;
}

const versionsByHome = new Map<string, Promise<string | null>>();

// From the `release` file, which JDK 8 builds may lack; then from `java -version`.
function jdkVersion(home: string): Promise<string | null> {
  let version = versionsByHome.get(home);
  if (!version) {
    version = readJdkVersion(home);
    versionsByHome.set(home, version);
  }
  return version;
}

async function readJdkVersion(home: string): Promise<string | null> {
  try {
    const release = await readFile(join(home, 'release'), 'utf8');
    const declared = /^JAVA_VERSION="([^"]+)"/m.exec(release)?.[1];
    if (declared) return majorVersion(declared);
  } catch {}
  const java = join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  if (!(await isFile(java))) return null;
  return new Promise((resolvePromise) => {
    execFile(
      java,
      ['-version'],
      { timeout: JAVA_VERSION_TIMEOUT_MS, windowsHide: true },
      (_error, stdout, stderr) => {
        const declared = /version "([^"]+)"/.exec(`${stderr}${stdout}`)?.[1];
        resolvePromise(declared ? majorVersion(declared) : null);
      },
    );
  });
}

// `dangling` when src.zip is a link to nothing, as Debian and Ubuntu leave it until the
// openjdk-<version>-source package is installed.
async function srcZipOf(home: string): Promise<{ zip: string } | { dangling: boolean }> {
  let dangling = false;
  for (const path of [join(home, 'lib', 'src.zip'), join(home, 'src.zip')]) {
    if (await isFile(path)) return { zip: path };
    if (await isSymlink(path)) dangling = true;
  }
  return { dangling };
}

// The src.zip of a JDK 8 sits next to its jre directory.
function jdkAround(home: string): string {
  return basename(home) === 'jre' ? dirname(home) : home;
}

async function javaOnPath(pathDirs: string[]): Promise<string | null> {
  const name = process.platform === 'win32' ? 'java.exe' : 'java';
  for (const dir of pathDirs) {
    const java = join(dir, name);
    if (!(await isFile(java))) continue;
    return jdkAround(dirname(dirname(await realpath(java))));
  }
  return null;
}

// JAVA_HOME, then the JDK of the `java` on PATH, then the JDKs under `jvmDir`, those of the
// indexed version first. Without a src.zip, names the package that would install one.
async function findJdkSource(
  locations: SourceLocations,
  indexed: string,
): Promise<{ zip: string; version: string | null } | { sourcePackage?: string }> {
  const homes: string[] = [];
  if (locations.javaHome) homes.push(jdkAround(locations.javaHome));
  const pathHome = await javaOnPath(locations.pathDirs).catch(() => null);
  if (pathHome) homes.push(pathHome);
  const installed = await readdir(locations.jvmDir).catch(() => [] as string[]);
  const jvmHomes = installed.sort().map((name) => join(locations.jvmDir, name));
  const versions = await Promise.all(jvmHomes.map((home) => jdkVersion(home)));
  homes.push(
    ...jvmHomes.filter((_, i) => versions[i] === indexed),
    ...jvmHomes.filter((_, i) => versions[i] !== indexed),
  );
  const danglingVersions: string[] = [];
  for (const home of homes) {
    const found = await srcZipOf(home);
    if ('zip' in found) return { zip: found.zip, version: await jdkVersion(home) };
    const version = found.dangling ? await jdkVersion(home) : null;
    if (version) danglingVersions.push(version);
  }
  const missing = danglingVersions.includes(indexed) ? indexed : danglingVersions[0];
  return missing ? { sourcePackage: `openjdk-${missing}-source` } : {};
}

async function findSourcesJar(
  locations: SourceLocations,
  group: string,
  artifact: string,
  version: string,
): Promise<{ jar: string; kind: 'gradle' | 'maven' } | null> {
  const jarName = `${artifact}-${version}-sources.jar`;
  const gradleDir = join(
    locations.gradleHome,
    'caches',
    'modules-2',
    'files-2.1',
    group,
    artifact,
    version,
  );
  const hashes = await readdir(gradleDir).catch(() => [] as string[]);
  for (const hash of hashes.sort()) {
    const jar = join(gradleDir, hash, jarName);
    if (await isFile(jar)) return { jar, kind: 'gradle' };
  }
  const mavenJar = join(locations.mavenRepository, ...group.split('.'), artifact, version, jarName);
  if (await isFile(mavenJar)) return { jar: mavenJar, kind: 'maven' };
  return null;
}

// "java/util/Map#Entry#getKey()." is declared in "java/util/Map.java".
function sourcePath(descriptors: Descriptor[]): string | null {
  const packages: string[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.kind === 'type') {
      return [...packages, `${descriptor.name}.java`].join('/');
    }
    if (descriptor.kind !== 'namespace') return null;
    packages.push(descriptor.name);
  }
  return null;
}

const ANNOTATION = '@[\\w$.]+(?:\\([^)]*\\))?';
const ANNOTATIONS = `(?:${ANNOTATION}\\s+)*`;
// Annotations may stand among the modifiers, as in "public @Nullable String", and type
// parameters may follow a modifier without a space, as in "public<X> X get()".
const MODIFIERS = `(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp|transient|volatile|sealed|non-sealed|${ANNOTATION})(?:\\s+|(?=<)))*`;
// A comma, "?" or "&" belongs to a type only between its angle brackets.
const TYPE = '[\\w$][\\w$.]*(?:<[^()]*>)?(?:\\s*\\[\\])*';
// One of the names before the last in "int a = 1, b[], c;". An initializer with parentheses or
// braces may hold commas of its own, so the names after it are not matched.
const EARLIER_NAME = '[\\w$]+(?:\\s*\\[\\])*\\s*(?:=[^,;(){}]*)?,\\s*';
const NOT_A_TYPE = /^(?:return|new|throw|else|case|yield|assert)\b/;

function isStatic(modifiers: string): boolean {
  return /\bstatic\b/.test(modifiers.replace(new RegExp(ANNOTATION, 'g'), ''));
}

function escapeRegExp(text: string): string {
  return text.replace(/[$.]/g, '\\$&');
}

function isComment(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//');
}

function findLine(lines: string[], from: number, test: (text: string) => boolean): number {
  for (let i = from; i < lines.length; i++) {
    const text = lines[i] ?? '';
    if (!isComment(text) && test(text)) return i;
  }
  return -1;
}

// The lines above `line` that belong to the same declaration, as the modifiers and type
// parameters of "public static <T extends Foo>\n    Bar<T> name(".
function headAbove(lines: string[], line: number): string {
  const head: string[] = [];
  for (let i = line - 1; i >= 0; i--) {
    const text = (lines[i] ?? '').trim();
    if (text === '' || isComment(text) || /[;{}]$/.test(text) || text.endsWith('*/')) break;
    head.unshift(text);
  }
  return head.join(' ');
}

// scip-java numbers the overloads of a method in declaration order, instance methods before
// static ones: "()" is the first, "(+1)" the second.
function methodLine(
  lines: string[],
  from: number,
  name: string,
  disambiguator: string,
  isConstructor: boolean,
): number {
  const returnType = isConstructor ? '()' : `(${TYPE})\\s+`;
  const declaration = new RegExp(
    `^\\s*(${MODIFIERS})(?:<[^()]*>\\s+)?${ANNOTATIONS}${returnType}${escapeRegExp(name)}\\s*\\(`,
  );
  const found: { line: number; isStatic: boolean }[] = [];
  for (let i = from; i < lines.length; i++) {
    const text = lines[i] ?? '';
    if (isComment(text)) continue;
    const match = declaration.exec(text);
    if (!match || NOT_A_TYPE.test(match[2] ?? '')) continue;
    found.push({ line: i, isStatic: isStatic(`${headAbove(lines, i)} ${match[1] ?? ''}`) });
  }
  const ordered = [
    ...found.filter((site) => !site.isStatic),
    ...found.filter((site) => site.isStatic),
  ];
  const nth = /^\+(\d+)$/.exec(disambiguator)?.[1];
  return (ordered[nth === undefined ? 0 : Number(nth)] ?? ordered[0])?.line ?? -1;
}

function fieldLine(lines: string[], from: number, name: string): number {
  const field = new RegExp(
    `^\\s*${MODIFIERS}(${TYPE})\\s+(?:${EARLIER_NAME})*${escapeRegExp(name)}\\s*(?:=|;|,)`,
  );
  const enumConstant = new RegExp(`^\\s*${ANNOTATIONS}${escapeRegExp(name)}\\s*(?:[(,;{]|$)`);
  return findLine(lines, from, (text) => {
    const match = field.exec(text);
    return (match !== null && !NOT_A_TYPE.test(match[1] ?? '')) || enumConstant.test(text);
  });
}

// 1-based.
export function declarationLine(lines: string[], descriptors: Descriptor[]): number {
  let from = 0;
  let found = -1;
  let typeName: string | undefined;
  for (const descriptor of descriptors) {
    if (descriptor.kind === 'type') {
      const type = new RegExp(
        `\\b(?:class|interface|enum|record|@interface)\\s+${escapeRegExp(descriptor.name)}\\b`,
      );
      const line = findLine(lines, from, (text) => type.test(text));
      if (line < 0) break;
      from = found = line;
      typeName = descriptor.name;
    } else if (descriptor.kind === 'method' && found >= 0) {
      const isConstructor = descriptor.name === '<init>';
      const name = isConstructor ? typeName : descriptor.name;
      const disambiguator = descriptor.disambiguator ?? '';
      const line = name ? methodLine(lines, from, name, disambiguator, isConstructor) : -1;
      if (line >= 0) found = line;
      break;
    } else if (descriptor.kind === 'term' && found >= 0) {
      const line = fieldLine(lines, from, descriptor.name);
      if (line >= 0) found = line;
      break;
    }
  }
  return found < 0 ? 1 : found + 1;
}

function toResponse(
  name: string,
  content: Buffer,
  descriptors: Descriptor[],
  origin: Extract<LibrarySourceResponse, { found: true }>['origin'],
): LibrarySourceResponse {
  const text = content.toString('utf8').replace(/\r\n/g, '\n');
  return {
    found: true,
    path: name,
    line: declarationLine(text.split('\n'), descriptors),
    text,
    origin,
  };
}

export async function findLibrarySource(
  symbol: string,
  locations: SourceLocations,
): Promise<LibrarySourceResponse> {
  const parsed = parseGlobalSymbol(symbol);
  const path = parsed && sourcePath(parsed.descriptors);
  if (!parsed || !path) return { found: false, missing: { kind: 'unknown' } };
  const { packageName, version, descriptors } = parsed;

  if (packageName === 'jdk') {
    const jdk = await findJdkSource(locations, version);
    if (!('zip' in jdk))
      return { found: false, missing: { kind: 'jdk', indexed: version, ...jdk } };
    // JDK 9 and later put each file under the directory of its module.
    const entry = await readZipEntry(jdk.zip, (names) =>
      names.find(
        (name) =>
          name === path ||
          (name.endsWith(`/${path}`) && !name.slice(0, -path.length - 1).includes('/')),
      ),
    );
    if (!entry) {
      return { found: false, missing: { kind: 'file', archive: jdk.zip, path } };
    }
    return toResponse(entry.name, entry.content, descriptors, {
      kind: 'jdk',
      installed: jdk.version,
      indexed: version,
    });
  }

  const [manager, group, artifact, ...rest] = packageName.split('/');
  if (
    manager !== 'maven' ||
    group === undefined ||
    artifact === undefined ||
    rest.length > 0 ||
    ![group, artifact, version].every((part) => COORDINATE.test(part))
  ) {
    return { found: false, missing: { kind: 'unknown' } };
  }
  const found = await findSourcesJar(locations, group, artifact, version);
  if (!found) {
    return { found: false, missing: { kind: 'jar', artifact: `${group}:${artifact}:${version}` } };
  }
  const entry = await readZipEntry(found.jar, (names) => names.find((name) => name === path));
  if (!entry) return { found: false, missing: { kind: 'file', archive: found.jar, path } };
  return toResponse(entry.name, entry.content, descriptors, {
    kind: found.kind,
    jar: basename(found.jar),
  });
}
