import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseLineChanges } from './line-changes';
import { POSITION_ENCODING, type ScipIndex, convertScipIndex } from './scip-index';
import { type CommitFiles, answerFromScipIndex, commitFiles } from './scip-peek';

// The index.scip fixture and its Java sources; scip-index.test.ts says how it was made.
const FIXTURE_DIR = join(__dirname, 'scip-index-fixture');
const SERVICE = 'src/main/java/demo/Service.java';
const PORT = 'src/main/java/demo/Port.java';
const CACHE = 'src/main/java/demo/Cache.java';

function fixtureLines(path: string): string[] {
  return readFileSync(join(FIXTURE_DIR, path), 'utf8').split('\n');
}

function fixtureCommit(...left: string[]): CommitFiles {
  return {
    existing: async (paths) => new Set(paths.filter((path) => !left.includes(path))),
    readLines: async (paths) =>
      new Map(
        paths.filter((path) => !left.includes(path)).map((path) => [path, fixtureLines(path)]),
      ),
  };
}

function columnOf(path: string, line: number, name: string, nth = 0): number {
  const text = fixtureLines(path)[line - 1] ?? '';
  let column = -1;
  for (let i = 0; i <= nth; i++) column = text.indexOf(name, column + 1);
  if (column < 0) throw new Error(`${name} not on ${path}:${line}`);
  return column;
}

function match(path: string, line: number) {
  return { path, line, text: fixtureLines(path)[line - 1] };
}

let temp: string;

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'difit-scip-peek-'));
});

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe('answerFromScipIndex', () => {
  let index: ScipIndex;

  beforeAll(async () => {
    index = await convertScipIndex(join(FIXTURE_DIR, 'index.scip'));
  });

  const answer = (
    name: string,
    path: string,
    line: number,
    column: number,
    files = fixtureCommit(),
  ) => answerFromScipIndex(index, name, 'abc1234', { path, line, column }, files);

  it('answers with the declaration and uses of the symbol under the clicked name', async () => {
    const line = 17;
    const viaPort = await answer('findById', SERVICE, line, columnOf(SERVICE, line, 'findById'));
    const viaCache = await answer(
      'findById',
      SERVICE,
      line,
      columnOf(SERVICE, line, 'findById', 1) + 2,
    );

    expect(viaPort).toEqual({
      name: 'findById',
      ref: 'abc1234',
      definitions: [match(PORT, 6)],
      references: [match(SERVICE, line)],
      truncated: false,
      source: 'index',
    });
    expect(viaCache?.definitions).toEqual([match(CACHE, 6)]);
  });

  it('names the library when the declaration lives outside the repository', async () => {
    const line = 17;
    const result = await answer('orElse', SERVICE, line, columnOf(SERVICE, line, 'orElse'));

    expect(result).toMatchObject({
      definitions: [],
      // Both uses sit on one line, which shows once.
      references: [match(SERVICE, line)],
      source: 'index',
      library: 'java.util.Optional#orElse()',
      librarySymbol: 'semanticdb maven jdk 8 java/util/Optional#orElse().',
    });
  });

  it('leaves out sites in files the commit does not hold', async () => {
    const line = 17;
    const column = columnOf(SERVICE, line, 'findById');

    const result = await answer('findById', SERVICE, line, column, fixtureCommit(PORT));

    expect(result).toMatchObject({
      definitions: [],
      references: [match(SERVICE, line)],
      source: 'index',
    });
    expect(result?.library).toBeUndefined();
    expect(await answer('findById', SERVICE, line, column, fixtureCommit(SERVICE))).toBeNull();
  });

  it('finds a Korean name by its UTF-16 column', async () => {
    const result = await answer('기본값', SERVICE, 16, 27);

    expect(result?.definitions).toEqual([match(SERVICE, 15)]);
    expect(result?.references).toEqual([match(SERVICE, 16), match(SERVICE, 17)]);
  });

  it('leaves the answer to name search when the index cannot give one', async () => {
    const line = 17;
    const findById = columnOf(SERVICE, line, 'findById');

    // Another name than the one under the column.
    expect(await answer('port', SERVICE, line, findById)).toBeNull();
    expect(await answer('find', SERVICE, line, findById)).toBeNull();
    // Nothing named there.
    expect(await answer('return', SERVICE, line, columnOf(SERVICE, line, 'return'))).toBeNull();
    // A file the index does not hold, or one that is not Java.
    expect(await answer('findById', 'src/main/java/demo/Gone.java', line, findById)).toBeNull();
    expect(await answer('findById', 'README.md', line, findById)).toBeNull();
    const stale: CommitFiles = {
      ...fixtureCommit(),
      readLines: async (paths) =>
        new Map(paths.map((path) => [path, fixtureLines(path).map(() => '')])),
    };
    expect(await answer('findById', SERVICE, line, findById, stale)).toBeNull();
  });

  it('keeps to the limits of name search', async () => {
    const uses = Array.from({ length: 501 }, (_, i) =>
      lengthDelimited(2, occurrence([i + 1, 0, 3], 'pkg A#foo().')),
    );
    const raw = Buffer.from(
      lengthDelimited(2, [
        ...text(1, 'A.java'),
        ...lengthDelimited(2, occurrence([0, 0, 3], 'pkg A#foo().', 1)),
        ...uses.flat(),
      ]),
    );
    const rawPath = join(temp, 'many.scip');
    writeFileSync(rawPath, raw);
    const many = await convertScipIndex(rawPath);
    const files: CommitFiles = {
      existing: async (paths) => new Set(paths),
      readLines: async (paths) =>
        new Map(paths.map((path) => [path, Array.from({ length: 502 }, () => 'foo();')])),
    };

    const result = await answerFromScipIndex(
      many,
      'foo',
      'HEAD',
      { path: 'A.java', line: 1, column: 0 },
      files,
    );

    expect(result?.definitions).toHaveLength(1);
    expect(result?.references).toHaveLength(500);
    expect(result?.truncated).toBe(true);
  });

  it('leaves the answer to name search when the index counts columns in bytes', async () => {
    const files: CommitFiles = {
      existing: async (paths) => new Set(paths),
      readLines: async (paths) => new Map(paths.map((path) => [path, ['foo();']])),
    };
    const answerIn = async (encoding: number) => {
      const rawPath = join(temp, `encoding-${encoding}.scip`);
      writeFileSync(
        rawPath,
        Buffer.from(
          lengthDelimited(2, [
            ...text(1, 'A.java'),
            ...lengthDelimited(2, occurrence([0, 0, 3], 'pkg A#foo().', 1)),
            ...varint(6 * 8),
            ...varint(encoding),
          ]),
        ),
      );
      const encoded = await convertScipIndex(rawPath);
      return answerFromScipIndex(
        encoded,
        'foo',
        'HEAD',
        { path: 'A.java', line: 1, column: 0 },
        files,
      );
    };

    expect(await answerIn(POSITION_ENCODING.utf8)).toBeNull();
    expect((await answerIn(POSITION_ENCODING.utf16))?.source).toBe('index');
  });

  describe('from the index of an older commit', () => {
    const edited = `${fixtureLines(SERVICE)[16]} // edited`;
    const newerService = [
      ...fixtureLines(SERVICE).slice(0, 1),
      '// one',
      '// two',
      ...fixtureLines(SERVICE).slice(1, 16),
      edited,
      ...fixtureLines(SERVICE).slice(17),
    ];
    const newer: CommitFiles = {
      existing: async (paths) => new Set(paths),
      readLines: async (paths) =>
        new Map(paths.map((path) => [path, path === SERVICE ? newerService : fixtureLines(path)])),
    };
    const changes = parseLineChanges(
      [
        `diff --git a/${SERVICE} b/${SERVICE}`,
        `--- a/${SERVICE}`,
        `+++ b/${SERVICE}`,
        '@@ -1,0 +2,2 @@',
        '+// one',
        '+// two',
        '@@ -17 +19 @@',
        `-${fixtureLines(SERVICE)[16]}`,
        `+${edited}`,
        '',
      ].join('\n'),
    )!;
    const borrowed = (name: string, path: string, line: number, column: number) =>
      answerFromScipIndex(index, name, 'fix1234', { path, line, column }, newer, changes);

    it('answers a click on a line left as it was, in the lines of the newer commit', async () => {
      const result = await borrowed('이름찾기', SERVICE, 16, columnOf(SERVICE, 14, '이름찾기'));

      expect(result).toEqual({
        name: '이름찾기',
        ref: 'fix1234',
        definitions: [{ path: SERVICE, line: 16, text: newerService[15] }],
        references: [{ path: SERVICE, line: 23, text: newerService[22] }],
        truncated: false,
        source: 'index',
      });
    });

    it('marks a site on a line changed since as found by name', async () => {
      const result = await borrowed('findById', PORT, 6, columnOf(PORT, 6, 'findById'));

      expect(result?.definitions).toEqual([match(PORT, 6)]);
      expect(result?.references).toEqual([
        { path: SERVICE, line: 19, text: edited, source: 'name' },
      ]);
    });

    it('leaves a click on a line changed since to name search', async () => {
      const column = columnOf(SERVICE, 17, 'findById');
      expect(await borrowed('findById', SERVICE, 19, column)).toBeNull();
      expect(await borrowed('findById', SERVICE, 17, column)).toBeNull();
    });

    it('lists each line holding the name among the lines that replaced a site', async () => {
      const replacement = [
        '        Optional<String> found = port.findById(id);',
        '        String findByIdText = "";',
        '        return found.orElse(cache.findById(id).orElse(기본값));',
      ];
      const split = [
        ...fixtureLines(SERVICE).slice(0, 16),
        ...replacement,
        ...fixtureLines(SERVICE).slice(17),
      ];
      const files: CommitFiles = {
        existing: async (paths) => new Set(paths),
        readLines: async (paths) =>
          new Map(paths.map((path) => [path, path === SERVICE ? split : fixtureLines(path)])),
      };
      const splitChanges = parseLineChanges(
        [
          `diff --git a/${SERVICE} b/${SERVICE}`,
          `--- a/${SERVICE}`,
          `+++ b/${SERVICE}`,
          '@@ -17 +17,3 @@',
          `-${fixtureLines(SERVICE)[16]}`,
          ...replacement.map((line) => `+${line}`),
          '',
        ].join('\n'),
      )!;

      const result = await answerFromScipIndex(
        index,
        'findById',
        'fix1234',
        { path: PORT, line: 6, column: columnOf(PORT, 6, 'findById') },
        files,
        splitChanges,
      );

      expect(result?.references).toEqual([
        { path: SERVICE, line: 17, text: replacement[0], source: 'name' },
        { path: SERVICE, line: 19, text: replacement[2], source: 'name' },
      ]);
    });
  });

  it('lists a use on the line of the declaration under both', async () => {
    const raw = Buffer.from(
      lengthDelimited(2, [
        ...text(1, 'A.java'),
        ...lengthDelimited(2, occurrence([0, 4, 7], 'pkg A#f().', 1)),
        ...lengthDelimited(2, occurrence([0, 19, 22], 'pkg A#f().')),
      ]),
    );
    const rawPath = join(temp, 'recursive.scip');
    writeFileSync(rawPath, raw);
    const recursive = await convertScipIndex(rawPath);
    const line = 'int foo() { return foo(); }';
    const files: CommitFiles = {
      existing: async (paths) => new Set(paths),
      readLines: async (paths) => new Map(paths.map((path) => [path, [line]])),
    };

    const result = await answerFromScipIndex(
      recursive,
      'foo',
      'HEAD',
      { path: 'A.java', line: 1, column: 4 },
      files,
    );

    expect(result?.definitions).toEqual([{ path: 'A.java', line: 1, text: line }]);
    expect(result?.references).toEqual([{ path: 'A.java', line: 1, text: line }]);
  });
});

describe('answerFromScipIndex on Lombok classes', () => {
  // scip-index.test.ts says how this fixture was made.
  const dir = join(__dirname, 'scip-index-lombok-fixture');
  const DAT = 'src/main/java/demo/Dat.java';
  const PAIR = 'src/main/java/demo/Pair.java';
  const USE = 'src/main/java/demo/Use.java';
  const lines = (path: string) => readFileSync(join(dir, path), 'utf8').split('\n');
  const files: CommitFiles = {
    existing: async (paths) => new Set(paths),
    readLines: async (paths) => new Map(paths.map((path) => [path, lines(path)])),
  };
  let index: ScipIndex;

  beforeAll(async () => {
    index = await convertScipIndex(join(dir, 'index.scip'));
  });

  const answer = (name: string, path: string, line: number) =>
    answerFromScipIndex(
      index,
      name,
      'abc1234',
      { path, line, column: (lines(path)[line - 1] ?? '').indexOf(name) },
      files,
    );
  const use = (path: string, line: number, via?: 'getter' | 'builder') => ({
    path,
    line,
    text: lines(path)[line - 1],
    ...(via ? { via } : {}),
  });

  it('lists the getter and builder calls among the uses of a field and marks them', async () => {
    const fromField = await answer('code', DAT, 9);

    expect(fromField).toEqual({
      name: 'code',
      ref: 'abc1234',
      definitions: [use(DAT, 9)],
      references: [use(USE, 8, 'getter'), use(USE, 10, 'builder')],
      truncated: false,
      source: 'index',
    });
    expect((await answer('getCode', USE, 8))?.references).toEqual(fromField?.references);
  });

  it('shows a line that uses the field and calls its getter as a direct use', async () => {
    expect((await answer('left', PAIR, 11))?.references).toEqual([use(PAIR, 8)]);
  });

  describe('from the index of an older commit', () => {
    const editedLines = (edits: Record<string, number[]>): CommitFiles => ({
      existing: async (paths) => new Set(paths),
      readLines: async (paths) =>
        new Map(
          paths.map((path) => [
            path,
            lines(path).map((text, i) =>
              edits[path]?.includes(i + 1) ? `${text} // edited` : text,
            ),
          ]),
        ),
    });
    const changesOf = (edits: Record<string, number[]>) =>
      parseLineChanges(
        Object.entries(edits)
          .flatMap(([path, edited]) => [
            `diff --git a/${path} b/${path}`,
            `--- a/${path}`,
            `+++ b/${path}`,
            ...edited.flatMap((line) => [
              `@@ -${line} +${line} @@`,
              `-${lines(path)[line - 1]}`,
              `+${lines(path)[line - 1]} // edited`,
            ]),
          ])
          .concat('')
          .join('\n'),
      )!;
    const borrowed = (name: string, path: string, line: number, edits: Record<string, number[]>) =>
      answerFromScipIndex(
        index,
        name,
        'fix1234',
        { path, line, column: (lines(path)[line - 1] ?? '').indexOf(name) },
        editedLines(edits),
        changesOf(edits),
      );
    const byName = (path: string, line: number) => ({
      path,
      line,
      text: `${lines(path)[line - 1]} // edited`,
      source: 'name',
    });

    it('keeps changed lines that call the getter or builder of a clicked field', async () => {
      const result = await borrowed('code', DAT, 9, { [USE]: [8, 10] });

      expect(result?.definitions).toEqual([use(DAT, 9)]);
      expect(result?.references).toEqual([byName(USE, 8), byName(USE, 10)]);
    });

    it('keeps a changed declaration of the field behind a clicked getter', async () => {
      const result = await borrowed('getCode', USE, 8, { [DAT]: [9] });

      expect(result?.definitions).toEqual([byName(DAT, 9)]);
    });
  });
});

const IMPL_DIR = join(__dirname, 'scip-index-impl-fixture');
const SHAPE = 'src/main/java/demo/Shape.java';
const SQUARE = 'src/main/java/demo/Square.java';
const CIRCLE = 'src/main/java/demo/Circle.java';

function implLines(path: string): string[] {
  return readFileSync(join(IMPL_DIR, path), 'utf8').split('\n');
}

function implCommit(...left: string[]): CommitFiles {
  return {
    existing: async (paths) => new Set(paths.filter((path) => !left.includes(path))),
    readLines: async (paths) =>
      new Map(paths.filter((path) => !left.includes(path)).map((path) => [path, implLines(path)])),
  };
}

function implMatch(path: string, line: number) {
  return { path, line, text: implLines(path)[line - 1] };
}

describe('answerFromScipIndex on implementations and calls', () => {
  let index: ScipIndex;

  beforeAll(async () => {
    index = await convertScipIndex(join(IMPL_DIR, 'index.scip'));
  });

  const answer = (name: string, path: string, line: number, files = implCommit()) =>
    answerFromScipIndex(
      index,
      name,
      'abc1234',
      { path, line, column: (implLines(path)[line - 1] ?? '').indexOf(name) },
      files,
    );

  it('lists the declarations that implement the clicked method', async () => {
    expect((await answer('area', SHAPE, 4))?.implementations).toEqual([
      implMatch(CIRCLE, 11),
      implMatch(SQUARE, 11),
    ]);
  });

  it('leaves out implementations in files the commit does not hold', async () => {
    expect((await answer('area', SHAPE, 4, implCommit(CIRCLE)))?.implementations).toEqual([
      implMatch(SQUARE, 11),
    ]);
  });

  it('leaves out an implementation on a line changed since the indexed commit', async () => {
    const changes = parseLineChanges(
      [
        `diff --git a/${CIRCLE} b/${CIRCLE}`,
        `--- a/${CIRCLE}`,
        `+++ b/${CIRCLE}`,
        '@@ -11 +11 @@',
        `-${implLines(CIRCLE)[10]}`,
        '+    public double area() { // edited',
        '',
      ].join('\n'),
    )!;
    const result = await answerFromScipIndex(
      index,
      'area',
      'fix1234',
      { path: SHAPE, line: 4, column: (implLines(SHAPE)[3] ?? '').indexOf('area') },
      implCommit(),
      changes,
    );
    expect(result?.implementations).toEqual([implMatch(SQUARE, 11)]);
  });

  it('sends no implementations for a method nothing overrides', async () => {
    const result = await answer('area', SQUARE, 11);
    expect(result?.definitions).toEqual([implMatch(SQUARE, 11)]);
    expect(result).not.toHaveProperty('implementations');
  });
});

describe('commitFiles', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  let repo: string;
  let first: string;

  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
        ),
        HOME: temp,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'difit',
        GIT_AUTHOR_EMAIL: 'difit@example.com',
        GIT_COMMITTER_NAME: 'difit',
        GIT_COMMITTER_EMAIL: 'difit@example.com',
      },
    }).trim();
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };

  beforeAll(() => {
    // A git hook runs the suite with GIT_DIR set, which would point commitFiles at the hooked repository.
    for (const key of Object.keys(process.env).filter((name) => name.startsWith('GIT_'))) {
      vi.stubEnv(key, undefined);
    }
    repo = join(temp, 'repo');
    mkdirSync(repo);
    git('init', '-q');
    write('src/A.java', 'class A {\r\n  int 값;\r\n}\r\n');
    write('src/with space.java', 'class B {}\n');
    write('src/dir/C.java', 'class C {}');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    first = git('rev-parse', 'HEAD');
    write('src/A.java', 'class A2 {}\n');
    git('commit', '-q', '-am', 'second');
  });

  const asked = [
    'src/A.java',
    'src/missing.java',
    'src/with space.java',
    'src/dir',
    'build/generated/G.java',
    'src/dir/C.java',
    'src/A.java',
  ];

  it('reads the files of the given commit, not the latest ones', async () => {
    const lines = await commitFiles(repo, first).readLines(asked);

    expect([...lines.keys()]).toEqual(['src/A.java', 'src/with space.java', 'src/dir/C.java']);
    expect(lines.get('src/A.java')).toEqual(['class A {', '  int 값;', '}', '']);
    expect(lines.get('src/dir/C.java')).toEqual(['class C {}']);
  });

  it('tells which paths the commit holds as files', async () => {
    expect([...(await commitFiles(repo, first).existing(asked))]).toEqual([
      'src/A.java',
      'src/with space.java',
      'src/dir/C.java',
    ]);
  });

  it('stops when the caller gives up', async () => {
    const controller = new AbortController();
    controller.abort();
    const files = commitFiles(repo, first, controller.signal);

    await expect(files.readLines(['src/A.java'])).rejects.toThrow();
    await expect(files.existing(['src/A.java'])).rejects.toThrow();
  });
});

// Minimal protobuf writer for an index larger than the fixture.
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}

function lengthDelimited(field: number, body: number[]): number[] {
  return [...varint(field * 8 + 2), ...varint(body.length), ...body];
}

function text(field: number, value: string): number[] {
  return lengthDelimited(field, [...Buffer.from(value, 'utf8')]);
}

function occurrence(range: number[], symbol: string, roles = 0): number[] {
  return [
    ...lengthDelimited(1, range.flatMap(varint)),
    ...text(2, symbol),
    ...(roles ? [...varint(3 * 8), ...varint(roles)] : []),
  ];
}
