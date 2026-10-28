import { spawn } from 'child_process';

import { type SymbolMatch, type SymbolSearchResponse } from '../types/diff.js';
import type { LineChanges } from './line-changes.js';
import { POSITION_ENCODING, type ScipIndex, externalSymbolDisplayName } from './scip-index.js';
import { MAX_DEFINITIONS, MAX_REFERENCES, clipLine } from './symbol-search.js';

// Answers a symbol peek from a commit's SCIP index.

export interface SymbolPosition {
  path: string;
  // 1-based, as the diff shows it.
  line: number;
  // 0-based, in UTF-16 code units (JavaScript string indexes), the unit scip-java writes.
  column: number;
}

export interface CommitFiles {
  // The paths among `paths` that the commit holds as files.
  existing: (paths: string[]) => Promise<Set<string>>;
  // Source lines of each path, without line endings. Paths the commit does not hold as files
  // are left out.
  readLines: (paths: string[]) => Promise<Map<string, string[]>>;
}

const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const BATCH_TIMEOUT_MS = 30_000;
const BATCH_HEADER = /^[0-9a-f]+ (\S+) (\d+)$/;

export function isJavaPath(path: string): boolean {
  return path.endsWith('.java');
}

export function commitFiles(repoPath: string, commit: string, signal?: AbortSignal): CommitFiles {
  return {
    existing: (paths) => existingAtCommit(repoPath, commit, paths, signal),
    readLines: (paths) => readLinesAtCommit(repoPath, commit, paths, signal),
  };
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].filter((path) => !path.includes('\n'));
}

function catFile(
  repoPath: string,
  mode: '--batch' | '--batch-check',
  commit: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['cat-file', mode], {
      signal,
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = () => child.kill('SIGTERM');
    const timer = setTimeout(stop, BATCH_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (size >= MAX_BATCH_BYTES) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size >= MAX_BATCH_BYTES) stop();
    });
    child.stdin.on('error', () => {});
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', () => {
      clearTimeout(timer);
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      resolvePromise(Buffer.concat(chunks));
    });
    child.stdin.end(paths.map((path) => `${commit}:${path}\n`).join(''));
  });
}

// Each answer is one line, `<oid> <type> <size>` or `<object> missing`, in request order.
async function existingAtCommit(
  repoPath: string,
  commit: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  const requested = uniquePaths(paths);
  if (requested.length === 0) return new Set();
  const output = await catFile(repoPath, '--batch-check', commit, requested, signal);
  const answers = output.toString('utf8').split('\n');
  return new Set(requested.filter((_, i) => BATCH_HEADER.exec(answers[i] ?? '')?.[1] === 'blob'));
}

async function readLinesAtCommit(
  repoPath: string,
  commit: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  const requested = uniquePaths(paths);
  if (requested.length === 0) return new Map<string, string[]>();
  return parseBatch(await catFile(repoPath, '--batch', commit, requested, signal), requested);
}

// Each answer is `<oid> <type> <size>\n<content>\n`, or `<object> missing\n`, in request order.
// Output cut short keeps the files read in full.
function parseBatch(output: Buffer, paths: string[]): Map<string, string[]> {
  const lines = new Map<string, string[]>();
  let pos = 0;
  for (const path of paths) {
    const headerEnd = output.indexOf(0x0a, pos);
    if (headerEnd < 0) break;
    const header = BATCH_HEADER.exec(output.toString('utf8', pos, headerEnd));
    pos = headerEnd + 1;
    if (!header) continue;
    const contentSize = Number(header[2]);
    if (!Number.isSafeInteger(contentSize) || pos + contentSize > output.length) break;
    if (header[1] === 'blob') {
      const text = output.toString('utf8', pos, pos + contentSize);
      lines.set(
        path,
        text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)),
      );
    }
    pos += contentSize + 1;
  }
  return lines;
}

interface Site {
  path: string;
  line: number;
  startCol: number;
  endCol: number;
  via?: SymbolMatch['via'];
}

function oneSitePerLine(sites: Site[]): Site[] {
  const byLine = new Map<string, Site>();
  for (const site of sites) {
    const key = `${site.path}\0${site.line}`;
    const kept = byLine.get(key);
    if (!kept || (kept.via && !site.via)) byLine.set(key, site);
  }
  return [...byLine.values()];
}

const IDENTIFIER_PART = /[\p{L}\p{N}_$]/u;

function holdsName(text: string, name: string): boolean {
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const before = text[at - 1];
    const after = text[at + name.length];
    if (
      (before === undefined || !IDENTIFIER_PART.test(before)) &&
      (after === undefined || !IDENTIFIER_PART.test(after))
    ) {
      return true;
    }
  }
  return false;
}

interface Placed {
  path: string;
  line: number;
  via?: SymbolMatch['via'];
  // Set when the site's line changed since the indexed commit: the lines that replaced it,
  // each listed when it holds one of the names searched for.
  replaced?: { first: number; last: number };
}

function placeSites(sites: Site[], changes: LineChanges | undefined): Placed[] {
  if (!changes) return sites;
  return sites.flatMap((site): Placed[] => {
    const now = changes.toNewer(site.path, site.line);
    if (!now) return [];
    if ('line' in now) return [site.via ? { ...now, via: site.via } : now];
    return [{ path: now.path, line: now.first, replaced: { first: now.first, last: now.last } }];
  });
}

// Null when the index cannot answer for that spot: it counts columns in a unit other than
// the click's UTF-16, the file is not in it, nothing is named there, or what is named there
// is not `name`. Sites in files the commit does not hold, such as annotation processor
// output, are left out. With `changes` the index belongs to an older commit: the clicked line
// must be one the commit left as it was, and sites on lines changed since are marked as found
// by name.
export async function answerFromScipIndex(
  index: ScipIndex,
  name: string,
  ref: string,
  at: SymbolPosition,
  files: CommitFiles,
  changes?: LineChanges,
): Promise<SymbolSearchResponse | null> {
  if (
    index.positionEncoding !== POSITION_ENCODING.unspecified &&
    index.positionEncoding !== POSITION_ENCODING.utf16
  ) {
    return null;
  }
  const indexed = changes ? changes.toOlder(at.path, at.line) : at;
  if (!indexed || !isJavaPath(at.path) || !index.hasDocument(indexed.path)) return null;
  const found = index.lookup(indexed.path, indexed.line, at.column);
  if (!found) return null;
  const clicked = [...found.definitions, ...found.references].find(
    (site) =>
      site.path === indexed.path &&
      site.line === indexed.line &&
      site.startCol <= at.column &&
      // An end equal to the start marks a range that runs onto later lines.
      (at.column < site.endCol || site.endCol === site.startCol),
  );
  if (!clicked) return null;
  if (clicked.endCol !== clicked.startCol && clicked.endCol - clicked.startCol !== name.length) {
    return null;
  }

  const uses: Site[] = found.fieldUses ?? found.references;
  const placedDefinitions = placeSites(oneSitePerLine(found.definitions), changes);
  const placedReferences = placeSites(oneSitePerLine(uses), changes);
  // An implementation is named differently from the clicked symbol when it is a type, so a
  // line changed since cannot be checked by name.
  const placedImplementations = placeSites(
    oneSitePerLine(found.implementations ?? []),
    changes,
  ).filter((site) => !site.replaced);
  const committed = await files.existing([
    at.path,
    ...placedDefinitions.map((site) => site.path),
    ...placedReferences.map((site) => site.path),
    ...placedImplementations.map((site) => site.path),
  ]);
  if (!committed.has(at.path)) return null;
  const definitions = placedDefinitions.filter((site) => committed.has(site.path));
  const references = placedReferences.filter((site) => committed.has(site.path));
  const implementations = placedImplementations.filter((site) => committed.has(site.path));
  const shownDefinitions = definitions.slice(0, MAX_DEFINITIONS);
  const shownReferences = references.slice(0, MAX_REFERENCES);
  const shownImplementations = implementations.slice(0, MAX_DEFINITIONS);
  const lines = await files.readLines([
    at.path,
    ...shownDefinitions.map((site) => site.path),
    ...shownReferences.map((site) => site.path),
    ...shownImplementations.map((site) => site.path),
  ]);
  const clickedText = lines.get(at.path)?.[at.line - 1] ?? '';
  if (clickedText.slice(clicked.startCol, clicked.startCol + name.length) !== name) return null;

  const names = [...new Set([name, ...(found.fieldNames ?? [])])];
  const toMatches = (sites: Placed[]): SymbolMatch[] => {
    const listed = new Set<string>();
    return sites.flatMap((site) => {
      const fileLines = lines.get(site.path) ?? [];
      const { first, last } = site.replaced ?? { first: site.line, last: site.line };
      const matches: SymbolMatch[] = [];
      for (let line = first; line <= last; line++) {
        const text = fileLines[line - 1] ?? '';
        const key = `${site.path}:${line}`;
        if (listed.has(key) || (site.replaced && !names.some((held) => holdsName(text, held)))) {
          continue;
        }
        listed.add(key);
        const match: SymbolMatch = { path: site.path, line, text: clipLine(text) };
        if (site.replaced) matches.push({ ...match, source: 'name' });
        else matches.push(site.via ? { ...match, via: site.via } : match);
      }
      return matches;
    });
  };
  return {
    name,
    ref,
    definitions: toMatches(shownDefinitions),
    references: toMatches(shownReferences),
    ...(shownImplementations.length > 0
      ? { implementations: toMatches(shownImplementations) }
      : {}),
    truncated:
      definitions.length > MAX_DEFINITIONS ||
      references.length > MAX_REFERENCES ||
      implementations.length > MAX_DEFINITIONS,
    source: 'index',
    ...(found.external
      ? { library: externalSymbolDisplayName(found.symbol), librarySymbol: found.symbol }
      : {}),
  };
}
