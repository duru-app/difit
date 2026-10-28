import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { deflateRawSync } from 'zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type SourceLocations, declarationLine, findLibrarySource } from './library-source';
import { parseGlobalSymbol } from './scip-index';
import { readZipEntry } from './zip-file';

const posixOnly = process.platform === 'win32' ? it.skip : it;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Record<string, string>, { stored = false } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const content = Buffer.from(text, 'utf8');
    const data = stored ? content : deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc32(content), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let root: string;

function put(path: string, content: string | Buffer): string {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function locations(overrides: Partial<SourceLocations> = {}): SourceLocations {
  return {
    pathDirs: [],
    jvmDir: join(root, 'jvm'),
    gradleHome: join(root, 'gradle'),
    mavenRepository: join(root, 'm2'),
    ...overrides,
  };
}

const OPTIONAL = [
  'package java.util;',
  '',
  '/**',
  ' * A container object. See {@link #orElse(Object)}.',
  ' */',
  'public final class Optional<T> {',
  '    private final T value;',
  '',
  '    private Optional(T value) {',
  '        this.value = value;',
  '    }',
  '',
  '    public static <T> Optional<T> of(T value) {',
  '        return new Optional<>(value);',
  '    }',
  '',
  '    public T orElse(T other) {',
  '        return value != null ? value : other;',
  '    }',
  '}',
  '',
].join('\n');

const OPTIONAL_SYMBOL = 'semanticdb maven jdk 8 java/util/Optional#orElse().';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'difit-library-source-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readZipEntry', () => {
  it('reads a deflated and a stored entry that the pick chooses', async () => {
    const deflated = put('a.zip', zip({ 'a/One.java': 'one', 'a/Two.java': 'two' }));
    const stored = put('b.zip', zip({ 'b/Three.java': 'three' }, { stored: true }));

    const two = await readZipEntry(deflated, (names) => names.find((n) => n.endsWith('Two.java')));
    const three = await readZipEntry(stored, (names) => names[0]);

    expect(two && { name: two.name, text: two.content.toString() }).toEqual({
      name: 'a/Two.java',
      text: 'two',
    });
    expect(three?.content.toString()).toBe('three');
  });

  it('gives null for a missing file, a file that is not a zip, or a pick of nothing', async () => {
    const archive = put('a.zip', zip({ 'One.java': 'one' }));

    expect(await readZipEntry(join(root, 'none.zip'), (names) => names[0])).toBeNull();
    expect(await readZipEntry(put('text.zip', 'not a zip'), (names) => names[0])).toBeNull();
    expect(await readZipEntry(archive, () => undefined)).toBeNull();
  });
});

describe('declarationLine', () => {
  const lines = (...text: string[]) => text;
  const descriptors = (symbol: string) => parseGlobalSymbol(symbol)?.descriptors ?? [];

  it('finds the type, then the method, past comments that name it', () => {
    expect(declarationLine(OPTIONAL.split('\n'), descriptors(OPTIONAL_SYMBOL))).toBe(17);
    expect(
      declarationLine(
        OPTIONAL.split('\n'),
        descriptors('semanticdb maven jdk 8 java/util/Optional#'),
      ),
    ).toBe(6);
  });

  it('counts overloads as scip-java does, instance methods before static ones', () => {
    const source = lines(
      'public class Paths {',
      '  public static Path get(String first) {',
      '    return get(first, "");',
      '  }',
      '  public Path get(URI uri) {',
      '  }',
      '  public static Path get(String first, String more) {',
      '  }',
      '}',
    );
    const line = (disambiguator: string) =>
      declarationLine(source, descriptors(`semanticdb maven jdk 8 a/Paths#get${disambiguator}.`));

    expect(line('()')).toBe(5);
    expect(line('(+1)')).toBe(2);
    expect(line('(+2)')).toBe(7);
    expect(line('(+5)')).toBe(5);
  });

  it('reads the modifiers of a declaration whose name is on a later line', () => {
    const source = lines(
      'public class Assertions {',
      '  public static <T> PredicateAssert<T> assertThat(Predicate<T> actual) {',
      '  }',
      '  //@format:off',
      '  public static <ACTUAL extends Iterable<? extends ELEMENT>, ELEMENT>',
      '         FactoryBasedNavigableIterableAssert<?, ACTUAL, ELEMENT> assertThat(Iterable<? extends ELEMENT> actual,',
      '                                                                         AssertFactory<ELEMENT> factory) {',
      '  }',
      '  public static AbstractBooleanAssert<?> assertThat(boolean actual) {',
      '  }',
      '}',
    );
    const line = (disambiguator: string) =>
      declarationLine(
        source,
        descriptors(`semanticdb maven jdk 8 a/Assertions#assertThat${disambiguator}.`),
      );

    expect(line('()')).toBe(2);
    expect(line('(+1)')).toBe(6);
    expect(line('(+2)')).toBe(9);
  });

  it('counts no call as an overload, nor an annotation argument as static', () => {
    const source = lines(
      'public class Helper {',
      '  public void run(String s) {',
      '    validate(s);',
      '    log.debug("checked {} {}", s,',
      '        s, validate(s));',
      '    String t = ok ? validate(s) : s;',
      '  }',
      '  public boolean validate(Object o) {',
      '  }',
      '  @SuppressWarnings("static-access")',
      '  public boolean validate(String s) {',
      '  }',
      '  private static boolean validate(int i) {',
      '  }',
      '}',
    );
    const line = (disambiguator: string) =>
      declarationLine(
        source,
        descriptors(`semanticdb maven jdk 8 a/Helper#validate${disambiguator}.`),
      );

    expect(line('()')).toBe(8);
    expect(line('(+1)')).toBe(11);
    expect(line('(+2)')).toBe(13);
  });

  it('finds members whose type carries a type-use annotation', () => {
    const source = lines(
      'public abstract class StringUtils {',
      '  private @Nullable String cached;',
      '  public static @Nullable String getFilename(@Nullable String path) {',
      '  }',
      '  public @Nullable String get(int i) {',
      '  }',
      '  public String get(String key) {',
      '  }',
      '  public static <T> @Nullable T first(List<@NonNull T> items) {',
      '  }',
      '}',
    );
    const line = (member: string) =>
      declarationLine(source, descriptors(`semanticdb maven jdk 8 a/StringUtils#${member}`));

    expect(line('cached.')).toBe(2);
    expect(line('getFilename().')).toBe(3);
    expect(line('get().')).toBe(5);
    expect(line('get(+1).')).toBe(7);
    expect(line('first().')).toBe(9);
  });

  it('finds a constructor, a member of a nested type, a field and an enum constant', () => {
    const source = lines(
      'public interface Map<K, V> {',
      '  V get(Object key);',
      '  interface Entry<K, V> {',
      '    K getKey();',
      '  }',
      '  enum Mode {',
      '    FAST,',
      '    SLOW(2);',
      '  }',
      '  public static final int LIMIT = 3;',
      '  Map(int size) {}',
      '  K getKey();',
      '}',
    );
    const line = (member: string) =>
      declarationLine(source, descriptors(`semanticdb maven jdk 8 java/util/${member}`));

    expect(line('Map#Entry#getKey().')).toBe(4);
    expect(line('Map#Mode#SLOW.')).toBe(8);
    expect(line('Map#LIMIT.')).toBe(10);
    expect(line('Map#`<init>`().')).toBe(11);
  });

  it('finds every name of a field declaration that declares several, before a later local', () => {
    const source = lines(
      'public class Segment {',
      '  private int start, end;',
      '  public final double x, y;',
      '  int[] a, b;',
      '  private static final int NONE = -1, LAST = -2;',
      '  void move() {',
      '    double y = 0, b = 1;',
      '  }',
      '}',
    );
    const line = (member: string) =>
      declarationLine(source, descriptors(`semanticdb maven jdk 8 a/Segment#${member}.`));

    expect(line('end')).toBe(2);
    expect(line('y')).toBe(3);
    expect(line('b')).toBe(4);
    expect(line('LAST')).toBe(5);
  });

  it('finds a method whose array brackets or type parameters are spaced unusually', () => {
    const source = lines(
      'public final class OptionalInt {',
      '  public int orElseThrow() {',
      '  }',
      '  public<X extends Throwable> int orElseThrow(Supplier<? extends X> s) throws X {',
      '  }',
      '  public int [] getBitMasks() {',
      '  }',
      '  public static<T> OptionalInt of(T value) {',
      '  }',
      '  public OptionalInt of(int value) {',
      '  }',
      '}',
    );
    const line = (member: string) =>
      declarationLine(source, descriptors(`semanticdb maven jdk 8 a/OptionalInt#${member}.`));

    expect(line('orElseThrow(+1)')).toBe(4);
    expect(line('getBitMasks()')).toBe(6);
    expect(line('of()')).toBe(10);
    expect(line('of(+1)')).toBe(8);
  });

  it('falls back to the type when the member is not found, and to line 1 without the type', () => {
    const source = lines('package a;', 'class Foo {', '  void bar() {}', '}');

    expect(declarationLine(source, descriptors('semanticdb maven jdk 8 a/Foo#baz().'))).toBe(2);
    expect(declarationLine(source, descriptors('semanticdb maven jdk 8 a/Gone#bar().'))).toBe(1);
  });
});

describe('findLibrarySource', () => {
  it('reads a JDK source from the module directory of the src.zip under JAVA_HOME', async () => {
    put('jdk17/release', 'JAVA_VERSION="17.0.20.1"\n');
    put('jdk17/lib/src.zip', zip({ 'java.base/java/util/Optional.java': OPTIONAL }));

    const result = await findLibrarySource(
      OPTIONAL_SYMBOL,
      locations({ javaHome: join(root, 'jdk17') }),
    );

    expect(result).toEqual({
      found: true,
      path: 'java.base/java/util/Optional.java',
      line: 17,
      text: OPTIONAL,
      origin: { kind: 'jdk', installed: '17', indexed: '8' },
    });
  });

  posixOnly(
    'takes the JDK of the java on PATH, and the JDK around the JRE of a JDK 8',
    async () => {
      put('jdk8/release', 'JAVA_VERSION="1.8.0_402"\n');
      put('jdk8/src.zip', zip({ 'java/util/Optional.java': OPTIONAL }));
      put('jdk8/jre/bin/java', '');
      mkdirSync(join(root, 'bin'));
      symlinkSync(join(root, 'jdk8/jre/bin/java'), join(root, 'bin/java'));

      const result = await findLibrarySource(
        OPTIONAL_SYMBOL,
        locations({ pathDirs: [join(root, 'empty'), join(root, 'bin')] }),
      );

      expect(result).toMatchObject({
        found: true,
        path: 'java/util/Optional.java',
        origin: { kind: 'jdk', installed: '8', indexed: '8' },
      });
    },
  );

  posixOnly('skips a JDK whose src.zip is a dangling link', async () => {
    put('jdk17/release', 'JAVA_VERSION="17.0.20.1"\n');
    mkdirSync(join(root, 'jdk17/lib'), { recursive: true });
    symlinkSync(join(root, 'nowhere/src.zip'), join(root, 'jdk17/lib/src.zip'));
    put('jvm/jdk-11/release', 'JAVA_VERSION="11.0.2"\n');
    put('jvm/jdk-11/lib/src.zip', zip({ 'java.base/java/util/Optional.java': OPTIONAL }));

    const result = await findLibrarySource(
      OPTIONAL_SYMBOL,
      locations({ javaHome: join(root, 'jdk17') }),
    );

    expect(result).toMatchObject({ found: true, origin: { installed: '11', indexed: '8' } });
  });

  posixOnly('names the source package of the JDK whose src.zip is a dangling link', async () => {
    for (const [home, version] of [
      ['jvm/java-17', '17.0.20.1'],
      ['jvm/java-8', '1.8.0_504'],
    ] as const) {
      put(`${home}/release`, `JAVA_VERSION="${version}"\n`);
      mkdirSync(join(root, home, 'lib'), { recursive: true });
      symlinkSync(join(root, 'nowhere/src.zip'), join(root, home, 'lib/src.zip'));
    }

    expect(await findLibrarySource(OPTIONAL_SYMBOL, locations())).toEqual({
      found: false,
      missing: { kind: 'jdk', indexed: '8', sourcePackage: 'openjdk-8-source' },
    });
    expect(
      await findLibrarySource('semanticdb maven jdk 11 java/util/Optional#orElse().', locations()),
    ).toEqual({
      found: false,
      missing: { kind: 'jdk', indexed: '11', sourcePackage: 'openjdk-17-source' },
    });
  });

  it('takes the JDK around the JRE that JAVA_HOME names', async () => {
    put('jdk8/release', 'JAVA_VERSION="1.8.0_402"\n');
    put('jdk8/src.zip', zip({ 'java/util/Optional.java': OPTIONAL }));
    mkdirSync(join(root, 'jdk8/jre'), { recursive: true });
    put('jvm/jdk-17/release', 'JAVA_VERSION="17.0.20.1"\n');
    put('jvm/jdk-17/lib/src.zip', zip({ 'java.base/java/util/Optional.java': OPTIONAL }));

    const result = await findLibrarySource(
      'semanticdb maven jdk 17 java/util/Optional#orElse().',
      locations({ javaHome: join(root, 'jdk8/jre') }),
    );

    expect(result).toMatchObject({
      found: true,
      path: 'java/util/Optional.java',
      origin: { installed: '8', indexed: '17' },
    });
  });

  it('prefers the JDK of the indexed version among those in the JVM directory', async () => {
    put('jvm/a-jdk-17/release', 'JAVA_VERSION="17.0.20.1"\n');
    put('jvm/a-jdk-17/lib/src.zip', zip({ 'java.base/java/util/Optional.java': OPTIONAL }));
    put('jvm/b-jdk-8/release', 'JAVA_VERSION="1.8.0_402"\n');
    put('jvm/b-jdk-8/src.zip', zip({ 'java/util/Optional.java': OPTIONAL }));

    const result = await findLibrarySource(OPTIONAL_SYMBOL, locations());

    expect(result).toMatchObject({ found: true, origin: { installed: '8', indexed: '8' } });
  });

  it('says that no JDK source was found, or that the src.zip lacks the file', async () => {
    expect(await findLibrarySource(OPTIONAL_SYMBOL, locations())).toEqual({
      found: false,
      missing: { kind: 'jdk', indexed: '8' },
    });

    put('jdk17/lib/src.zip', zip({ 'java.base/java/lang/String.java': 'class String {}' }));
    expect(
      await findLibrarySource(OPTIONAL_SYMBOL, locations({ javaHome: join(root, 'jdk17') })),
    ).toEqual({
      found: false,
      missing: {
        kind: 'file',
        archive: join(root, 'jdk17/lib/src.zip'),
        path: 'java/util/Optional.java',
      },
    });
  });

  const CRUD =
    'semanticdb maven maven/org.springframework.data/spring-data-commons 2.7.0 org/springframework/data/repository/CrudRepository#save().';
  const CRUD_SOURCE = [
    'package org.springframework.data.repository;',
    '',
    'public interface CrudRepository<T, ID> {',
    '  <S extends T> S save(S entity);',
    '}',
  ].join('\n');
  const CRUD_PATH = 'org/springframework/data/repository/CrudRepository.java';

  it('reads a library source from a sources jar in the Gradle cache', async () => {
    put(
      'gradle/caches/modules-2/files-2.1/org.springframework.data/spring-data-commons/2.7.0/0a1b/spring-data-commons-2.7.0.jar',
      'classes',
    );
    put(
      'gradle/caches/modules-2/files-2.1/org.springframework.data/spring-data-commons/2.7.0/9f8e/spring-data-commons-2.7.0-sources.jar',
      zip({ [CRUD_PATH]: CRUD_SOURCE }),
    );

    expect(await findLibrarySource(CRUD, locations())).toEqual({
      found: true,
      path: CRUD_PATH,
      line: 4,
      text: CRUD_SOURCE,
      origin: { kind: 'gradle', jar: 'spring-data-commons-2.7.0-sources.jar' },
    });
  });

  it('reads a library source from a sources jar in the Maven repository', async () => {
    put(
      'm2/org/springframework/data/spring-data-commons/2.7.0/spring-data-commons-2.7.0-sources.jar',
      zip({ [CRUD_PATH]: CRUD_SOURCE }),
    );

    expect(await findLibrarySource(CRUD, locations())).toMatchObject({
      found: true,
      line: 4,
      origin: { kind: 'maven', jar: 'spring-data-commons-2.7.0-sources.jar' },
    });
  });

  it('names the artifact whose sources jar no cache holds', async () => {
    put(
      'gradle/caches/modules-2/files-2.1/org.springframework.data/spring-data-commons/2.7.0/0a1b/spring-data-commons-2.7.0.jar',
      'classes',
    );

    expect(await findLibrarySource(CRUD, locations())).toEqual({
      found: false,
      missing: { kind: 'jar', artifact: 'org.springframework.data:spring-data-commons:2.7.0' },
    });
  });

  it('does not look for a symbol that names no JDK or Maven artifact', async () => {
    const unknown = { found: false, missing: { kind: 'unknown' } };

    expect(await findLibrarySource('semanticdb maven . . a/Foo#bar().', locations())).toEqual(
      unknown,
    );
    expect(
      await findLibrarySource('semanticdb maven maven/../x 1.0 a/Foo#bar().', locations()),
    ).toEqual(unknown);
    expect(await findLibrarySource('semanticdb maven jdk 8 java/util/', locations())).toEqual(
      unknown,
    );
    expect(await findLibrarySource('local 3', locations())).toEqual(unknown);
  });
});
