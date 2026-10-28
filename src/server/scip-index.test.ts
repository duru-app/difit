import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  type ScipIndex,
  convertScipIndex,
  externalSymbolDisplayName,
  parseGlobalSymbol,
  POSITION_ENCODING,
  readScipIndex,
  writeScipIndex,
} from './scip-index';

// index.scip was made from the Java sources beside it with the semanticdb-javac 0.12.3 plugin
// (javac -Xplugin:semanticdb) and `scip-java index-semanticdb`.
const FIXTURE_DIR = join(__dirname, 'scip-index-fixture');
const FIXTURE = join(FIXTURE_DIR, 'index.scip');
const SERVICE = 'src/main/java/demo/Service.java';
const PORT = 'src/main/java/demo/Port.java';
const CACHE = 'src/main/java/demo/Cache.java';
const MEMBERS = 'src/main/java/demo/MemberRepository.java';

function fixtureSource(dir: string) {
  const sourceLine = (path: string, line: number): string =>
    readFileSync(join(dir, path), 'utf8').split('\n')[line - 1] ?? '';

  // Column of the n-th (0-based) `name` on that line, as a JavaScript string index.
  const columnOf = (path: string, line: number, name: string, nth = 0): number => {
    const text = sourceLine(path, line);
    let column = -1;
    for (let i = 0; i <= nth; i++) column = text.indexOf(name, column + 1);
    if (column < 0) throw new Error(`${name} not on ${path}:${line}`);
    return column;
  };

  const site = (path: string, line: number, name: string, nth = 0) => {
    const startCol = columnOf(path, line, name, nth);
    return { path, line, startCol, endCol: startCol + name.length };
  };

  const use = (caller: string, path: string, line: number, name: string, nth = 0) => ({
    ...site(path, line, name, nth),
    caller: `semanticdb maven . . ${caller}`,
  });

  return { sourceLine, columnOf, site, use };
}

const { sourceLine, columnOf, site, use } = fixtureSource(FIXTURE_DIR);
const IN_FIND = 'demo/Service#이름찾기().';

describe('convertScipIndex on a scip-java index', () => {
  let index: ScipIndex;

  beforeAll(async () => {
    index = await convertScipIndex(FIXTURE);
  });

  it('keeps the documents and the unspecified position encoding scip-java writes', () => {
    expect(index.positionEncoding).toBe(POSITION_ENCODING.unspecified);
    for (const path of [SERVICE, PORT, CACHE, MEMBERS]) expect(index.hasDocument(path)).toBe(true);
    expect(index.hasDocument('src/main/java/demo/Missing.java')).toBe(false);
  });

  it('counts columns in UTF-16 code units, like JavaScript string indexes', () => {
    // An emoji (two code units) and Korean text sit before the name on this line.
    const line = 16;
    expect(sourceLine(SERVICE, line)).toContain('"😀" + 기본값');
    const column = columnOf(SERVICE, line, '기본값');
    expect(column).toBe(27);
    const result = index.lookup(SERVICE, line, column);
    expect(result?.symbol).toBe('local 4');
    expect(result?.references).toContainEqual({
      path: SERVICE,
      line,
      startCol: 27,
      endCol: 30,
      caller: `semanticdb maven . . ${IN_FIND}`,
    });
    // Counted in code points the name would start one column earlier, on the space.
    expect(index.lookup(SERVICE, line, column - 1)).toBeNull();
  });

  it('tells apart two calls of the same name on one line by column', () => {
    const line = 17;
    const viaPort = index.lookup(SERVICE, line, columnOf(SERVICE, line, 'findById', 0));
    const viaCache = index.lookup(SERVICE, line, columnOf(SERVICE, line, 'findById', 1) + 3);

    expect(viaPort).toEqual({
      symbol: 'semanticdb maven . . demo/Port#findById().',
      definitions: [site(PORT, 6, 'findById')],
      references: [use(IN_FIND, SERVICE, line, 'findById', 0)],
      external: false,
    });
    expect(viaCache?.symbol).toBe('semanticdb maven . . demo/Cache#findById().');
    expect(viaCache?.definitions).toEqual([site(CACHE, 6, 'findById')]);
    expect(viaCache?.references).toEqual([use(IN_FIND, SERVICE, line, 'findById', 1)]);
  });

  it('sends a call of a library method redeclared in the repository to the redeclaration', () => {
    const result = index.lookup(SERVICE, 15, columnOf(SERVICE, 15, 'apply'));
    expect(result?.symbol).toBe('semanticdb maven . . demo/MemberRepository#apply().');
    expect(result?.definitions).toEqual([site(MEMBERS, 7, 'apply')]);
    expect(result?.references).toEqual([use(IN_FIND, SERVICE, 15, 'apply')]);
    expect(result?.external).toBe(false);
  });

  it('marks a JDK method as external and lists its uses in the repository', () => {
    const result = index.lookup(SERVICE, 17, columnOf(SERVICE, 17, 'orElse'));
    expect(result).toEqual({
      symbol: 'semanticdb maven jdk 8 java/util/Optional#orElse().',
      definitions: [],
      references: [use(IN_FIND, SERVICE, 17, 'orElse', 0), use(IN_FIND, SERVICE, 17, 'orElse', 1)],
      external: true,
    });
  });

  it('finds a Korean method name from a call and from its declaration', () => {
    const fromCall = index.lookup(SERVICE, 21, columnOf(SERVICE, 21, '이름찾기', 1) + 2);
    const fromDeclaration = index.lookup(SERVICE, 14, columnOf(SERVICE, 14, '이름찾기'));
    expect(fromCall).toEqual({
      symbol: 'semanticdb maven . . demo/Service#이름찾기().',
      definitions: [site(SERVICE, 14, '이름찾기')],
      references: [
        use('demo/Service#twice().', SERVICE, 21, '이름찾기', 0),
        use('demo/Service#twice().', SERVICE, 21, '이름찾기', 1),
      ],
      external: false,
    });
    expect(fromDeclaration).toEqual(fromCall);
  });

  it('keeps a local variable to its own document', () => {
    const local = index.lookup(SERVICE, 15, columnOf(SERVICE, 15, '기본값'));
    expect(local?.definitions).toEqual([site(SERVICE, 15, '기본값')]);
    expect(local?.references).toEqual([
      use(IN_FIND, SERVICE, 16, '기본값'),
      use(IN_FIND, SERVICE, 17, '기본값'),
    ]);

    // Port.java's parameter is also "local 0" in its document, but a different variable.
    const parameter = index.lookup(PORT, 6, columnOf(PORT, 6, 'id)'));
    expect(parameter?.symbol).toBe('local 0');
    expect(parameter?.definitions).toEqual([site(PORT, 6, 'id')]);
    expect(parameter?.references).toEqual([]);
  });

  it('lists the uses of a package without calling it a library', () => {
    const result = index.lookup(SERVICE, 1, columnOf(SERVICE, 1, 'demo'));
    expect(result?.symbol).toBe('semanticdb maven . . demo/');
    expect(result?.definitions).toEqual([]);
    expect(result?.references).toEqual(
      expect.arrayContaining([site(SERVICE, 1, 'demo'), site(PORT, 1, 'demo')]),
    );
    expect(result?.external).toBe(false);
  });

  it('answers null where nothing is named and for files outside the index', () => {
    expect(index.lookup(SERVICE, 17, 2)).toBeNull();
    expect(index.lookup(SERVICE, 17, columnOf(SERVICE, 17, 'findById') + 'findById'.length)).toBe(
      null,
    );
    expect(index.lookup(SERVICE, 500, 0)).toBeNull();
    expect(index.lookup('README.md', 1, 0)).toBeNull();
  });

  it('decodes the same when every read crosses a chunk boundary', async () => {
    const small = await convertScipIndex(FIXTURE, { chunkBytes: 7 });
    for (const [path, line, name] of [
      [SERVICE, 17, 'findById'],
      [SERVICE, 17, 'orElse'],
      [SERVICE, 14, '이름찾기'],
      [PORT, 6, 'id'],
    ] as const) {
      const column = columnOf(path, line, name);
      expect(small.lookup(path, line, column)).toEqual(index.lookup(path, line, column));
    }
  });

  it('gives the event loop a turn after each document once the slice budget is spent', async () => {
    const yields = async (sliceMs: number) => {
      const spy = vi.spyOn(globalThis, 'setImmediate');
      try {
        // One read takes the whole file, so file reads are not what gives the turns.
        await convertScipIndex(FIXTURE, { chunkBytes: 1 << 24, sliceMs });
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };
    const documents = [SERVICE, PORT, CACHE, MEMBERS].length;
    expect(await yields(Infinity)).toBe(0);
    expect(await yields(0)).toBeGreaterThanOrEqual(documents);
  });

  it('stops at the next slice once its signal is aborted', async () => {
    const controller = new AbortController();
    const conversion = convertScipIndex(FIXTURE, { sliceMs: 0, signal: controller.signal });
    controller.abort(new Error('stopped'));
    await expect(conversion).rejects.toThrow('stopped');
  });
});

// Made from the Java sources beside it by `scip-java index` (semanticdb-javac 0.12.3), with
// Lombok 1.18.48 as the annotation processor.
const LOMBOK_DIR = join(__dirname, 'scip-index-lombok-fixture');
const FOO = 'src/main/java/demo/Foo.java';
const DAT = 'src/main/java/demo/Dat.java';
const BAR = 'src/main/java/demo/Bar.java';
const HAND = 'src/main/java/demo/Hand.java';
const PAIR = 'src/main/java/demo/Pair.java';
const USE = 'src/main/java/demo/Use.java';
const RUN = 'demo/Use#run().';
const SUM = 'demo/Pair#sum().';

describe('convertScipIndex on an index of Lombok classes', () => {
  const lombok = fixtureSource(LOMBOK_DIR);
  let index: ScipIndex;

  beforeAll(async () => {
    index = await convertScipIndex(join(LOMBOK_DIR, 'index.scip'));
  });

  const at = (path: string, line: number, name: string, nth = 0) =>
    index.lookup(path, line, lombok.columnOf(path, line, name, nth));

  it('lists the calls of a class-level getter with the uses of its field', () => {
    const fromField = at(PAIR, 11, 'left');
    expect(fromField?.fieldUses).toEqual([
      lombok.use(SUM, PAIR, 8, 'left'),
      { ...lombok.use(SUM, PAIR, 8, 'getLeft'), via: 'getter' },
    ]);
    expect(at(PAIR, 8, 'getLeft')?.fieldUses).toEqual(fromField?.fieldUses);
  });

  it('finds a getter that starts after the declaration when a comment ends its line', () => {
    const expected = [{ ...lombok.use(RUN, USE, 6, 'getName'), via: 'getter' }];
    expect(at(FOO, 8, 'name')?.fieldUses).toEqual(expected);
    expect(at(USE, 6, 'getName')?.fieldUses).toEqual(expected);
    expect(at(FOO, 9, 'count')?.fieldUses).toEqual([
      { ...lombok.use(RUN, USE, 7, 'getCount'), via: 'getter' },
    ]);
  });

  it('lists @Builder calls and leaves out the code Lombok put on the annotations', () => {
    const fromField = at(DAT, 9, 'code');
    // Generated equals, toString, builder and getter bodies refer to the field from the
    // @Data and @Builder lines and from its own declaration.
    expect(fromField?.references.map(({ line }) => line)).toEqual(
      expect.arrayContaining([6, 7, 9]),
    );
    expect(fromField?.fieldUses).toEqual([
      { ...lombok.use(RUN, USE, 8, 'getCode'), via: 'getter' },
      { ...lombok.use(RUN, USE, 10, 'code'), via: 'builder' },
    ]);
    expect(at(USE, 8, 'getCode')?.fieldUses).toEqual(fromField?.fieldUses);
    expect(at(USE, 10, 'code')?.fieldUses).toEqual(fromField?.fieldUses);
    for (const clicked of [fromField, at(USE, 8, 'getCode'), at(USE, 10, 'code')]) {
      expect([...(clicked?.fieldNames ?? [])].sort()).toEqual(['code', 'getCode']);
    }
  });

  it('keeps apart what it cannot place on the field', () => {
    expect(at(HAND, 4, 'size')?.fieldUses).toEqual([
      lombok.use('demo/Hand#getSize().', HAND, 7, 'size'),
    ]);
    expect(at(USE, 13, 'getSize')?.fieldUses).toBeUndefined();
    // Field-level @Getter and every @Setter sit on their annotation.
    expect(at(BAR, 9, 'title')?.fieldUses).toEqual([]);
    expect(at(USE, 11, 'getTitle')?.fieldUses).toBeUndefined();
    expect(at(USE, 12, 'setTitle')?.fieldUses).toBeUndefined();
    expect(at(USE, 9, 'setCode')?.fieldUses).toBeUndefined();
    // scip-java put this getter's definition on its call in the class.
    expect(at(FOO, 7, 'active')?.fieldUses).toEqual([
      lombok.use('demo/Foo#check().', FOO, 12, 'active'),
    ]);
    expect(at(USE, 5, 'isActive')?.fieldUses).toBeUndefined();
    // @Builder on a constructor makes builder methods of its parameters, not of fields.
    expect(at(USE, 14, 'id')?.fieldUses).toBeUndefined();
  });

  it('answers the same from the stored file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'difit-scip-lombok-'));
    try {
      const path = join(dir, 'index.bin');
      await writeScipIndex(index, path);
      const loaded = await readScipIndex(path);
      for (const [file, line, name] of [
        [DAT, 9, 'code'],
        [USE, 10, 'code'],
        [FOO, 8, 'name'],
      ] as const) {
        const column = lombok.columnOf(file, line, name);
        expect(loaded?.lookup(file, line, column)).toEqual(index.lookup(file, line, column));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const IMPL_DIR = join(__dirname, 'scip-index-impl-fixture');
const SHAPE = 'src/main/java/demo/Shape.java';
const POLYGON = 'src/main/java/demo/Polygon.java';
const SQUARE = 'src/main/java/demo/Square.java';
const CIRCLE = 'src/main/java/demo/Circle.java';
const RING = 'src/main/java/demo/Ring.java';
const REPORT = 'src/main/java/demo/Report.java';
const SERVICE_IMPL = 'src/main/java/demo/ReportService.java';
const APP = 'src/main/java/demo/App.java';
const symbolOf = (descriptor: string) => `semanticdb maven . . ${descriptor}`;

describe('convertScipIndex on an index of implementations and calls', () => {
  const impl = fixtureSource(IMPL_DIR);
  let index: ScipIndex;

  beforeAll(async () => {
    index = await convertScipIndex(join(IMPL_DIR, 'index.scip'));
  });

  const at = (path: string, line: number, name: string, nth = 0) =>
    index.lookup(path, line, impl.columnOf(path, line, name, nth));

  it('lists every type that extends or implements a type, however far down', () => {
    expect(index.knowsRelations).toBe(true);
    expect(at(SHAPE, 3, 'Shape')?.implementations).toEqual([
      impl.site(CIRCLE, 3, 'Circle'),
      impl.site(POLYGON, 3, 'Polygon'),
      impl.site(RING, 3, 'Ring'),
      impl.site(SQUARE, 3, 'Square'),
    ]);
    expect(at(CIRCLE, 3, 'Circle')?.implementations).toEqual([impl.site(RING, 3, 'Ring')]);
  });

  it('lists the methods that override abstract, default and concrete methods', () => {
    expect(at(SHAPE, 4, 'area')?.implementations).toEqual([
      impl.site(CIRCLE, 11, 'area'),
      impl.site(SQUARE, 11, 'area'),
    ]);
    expect(at(SHAPE, 6, 'label')?.implementations).toEqual([impl.site(POLYGON, 7, 'label')]);
    expect(at(POLYGON, 4, 'sides')?.implementations).toEqual([impl.site(SQUARE, 16, 'sides')]);
    expect(at(CIRCLE, 15, 'unit')?.implementations).toEqual([impl.site(RING, 9, 'unit')]);
  });

  it('does not take the method an override replaces for one of its implementations', () => {
    expect(at(SQUARE, 11, 'area')?.implementations).toBeUndefined();
    expect(at(SERVICE_IMPL, 5, 'render')?.implementations).toBeUndefined();
    expect(at(RING, 9, 'unit')?.implementations).toBeUndefined();
  });

  it('names the method each use sits in, counting a lambda as part of it', () => {
    expect(at(SHAPE, 4, 'area')?.references).toContainEqual(
      impl.use('demo/Report#total().', REPORT, 13, 'area'),
    );
    expect(at(REPORT, 19, 'describe')?.references).toEqual([
      impl.use('demo/Report#summary().', REPORT, 19, 'describe'),
    ]);
    expect(at(REPORT, 34, 'countdown')?.references).toContainEqual(
      impl.use('demo/Report#countdown().', REPORT, 34, 'countdown'),
    );
  });

  it('names no method for a use in an anonymous class, a field or Lombok code', () => {
    expect(at(SHAPE, 6, 'label')?.references).toContainEqual(impl.site(REPORT, 27, 'label'));
    const ofShape = at(SHAPE, 3, 'Shape')?.references ?? [];
    expect(ofShape).toContainEqual(impl.site(REPORT, 8, 'Shape'));
    // Methods Lombok generated for @Builder all share the annotation's range.
    const onBuilder = ofShape.filter(({ path, line }) => path === REPORT && line === 6);
    expect(onBuilder.length).toBeGreaterThan(0);
    for (const site of onBuilder) expect(site.caller).toBeUndefined();
  });

  it('finds the calls of a method and those made through the interface it implements', () => {
    expect(index.callersOf(symbolOf('demo/ReportService#render().'))).toEqual({
      references: [impl.use('demo/App#direct().', APP, 15, 'render')],
      viaInterface: [impl.use('demo/App#run().', APP, 11, 'render')],
    });
    expect(index.callersOf(symbolOf('demo/Report#summary().'))).toEqual({
      references: [impl.use('demo/ReportService#render().', SERVICE_IMPL, 6, 'summary')],
      viaInterface: [],
    });
    expect(index.callersOf(symbolOf('demo/Missing#nothing().'))).toBeNull();
  });

  it('answers the same from the stored file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'difit-scip-impl-'));
    try {
      const path = join(dir, 'index.bin');
      await writeScipIndex(index, path);
      const loaded = await readScipIndex(path);
      expect(loaded?.knowsRelations).toBe(true);
      for (const [file, line, name] of [
        [SHAPE, 3, 'Shape'],
        [SHAPE, 4, 'area'],
        [REPORT, 19, 'describe'],
      ] as const) {
        const column = impl.columnOf(file, line, name);
        expect(loaded?.lookup(file, line, column)).toEqual(index.lookup(file, line, column));
      }
      const render = symbolOf('demo/ReportService#render().');
      expect(loaded?.callersOf(render)).toEqual(index.callersOf(render));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still answers from a file stored before implementations and callers were kept', async () => {
    const old = await readScipIndex(join(IMPL_DIR, 'index.lookup.v1.gz'));
    expect(old?.knowsRelations).toBe(false);
    const found = old?.lookup(REPORT, 13, impl.columnOf(REPORT, 13, 'area'));
    expect(found?.symbol).toBe(symbolOf('demo/Shape#area().'));
    expect(found?.implementations).toBeUndefined();
    expect(found?.references).toContainEqual(impl.site(REPORT, 13, 'area'));
    expect(found?.references.some((site) => site.caller !== undefined)).toBe(false);
    expect(old?.callersOf(symbolOf('demo/ReportService#render().'))).toBeNull();
  });
});

describe('writeScipIndex and readScipIndex', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'difit-scip-index-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads back an index that answers the same', async () => {
    const original = await convertScipIndex(FIXTURE);
    const path = join(dir, 'index.bin');
    await writeScipIndex(original, path);
    const loaded = await readScipIndex(path);

    expect(loaded).not.toBeNull();
    expect(loaded?.positionEncoding).toBe(original.positionEncoding);
    expect(loaded?.hasDocument(SERVICE)).toBe(true);
    for (const [path, line, name, nth] of [
      [SERVICE, 17, 'findById', 0],
      [SERVICE, 17, 'findById', 1],
      [SERVICE, 15, 'apply', 0],
      [SERVICE, 17, 'orElse', 1],
      [SERVICE, 21, '이름찾기', 0],
      [SERVICE, 16, '기본값', 0],
      [PORT, 6, 'id', 0],
    ] as const) {
      const column = columnOf(path, line, name, nth);
      const expected = original.lookup(path, line, column);
      expect(expected).not.toBeNull();
      expect(loaded?.lookup(path, line, column)).toEqual(expected);
    }
  });

  it('reads nothing from a missing file or one in another format', async () => {
    expect(await readScipIndex(join(dir, 'missing.bin'))).toBeNull();
    const garbage = join(dir, 'garbage.bin');
    writeFileSync(garbage, Buffer.alloc(64, 1));
    expect(await readScipIndex(garbage)).toBeNull();

    const truncated = join(dir, 'truncated.bin');
    await writeScipIndex(await convertScipIndex(FIXTURE), truncated);
    writeFileSync(truncated, readFileSync(truncated).subarray(0, 100));
    expect(await readScipIndex(truncated)).toBeNull();
  });
});

// Minimal protobuf writer for shapes the fixture does not have.
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
const lengthDelimited = (field: number, body: number[]) => [
  ...varint(field * 8 + 2),
  ...varint(body.length),
  ...body,
];
const text = (field: number, value: string) =>
  lengthDelimited(field, [...Buffer.from(value, 'utf8')]);
const varintField = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
const occurrence = (range: number[], symbol: string, roles = 0, packed = true) => [
  ...(packed
    ? lengthDelimited(1, range.flatMap(varint))
    : range.flatMap((value) => varintField(1, value))),
  ...text(2, symbol),
  ...(roles ? varintField(3, roles) : []),
  // An empty enclosing range, which is never used.
  ...lengthDelimited(7, [0, 0, 0, 0]),
];

describe('convertScipIndex on hand-written indexes', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'difit-scip-synthetic-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads three-number ranges, unpacked ranges, multi-line ranges and skips other fields', async () => {
    const raw = Buffer.from([
      ...lengthDelimited(1, text(1, 'tool metadata')),
      ...lengthDelimited(2, [
        ...text(1, 'a/A.java'),
        ...lengthDelimited(2, occurrence([2, 4, 9], 'pkg A#run().', 1)),
        ...lengthDelimited(2, occurrence([5, 1, 5, 4], 'pkg A#run().', 0, false)),
        ...lengthDelimited(2, occurrence([7, 2, 9, 1], 'pkg A#block.')),
        ...lengthDelimited(2, occurrence([8, 0, 3], '')),
        ...text(4, 'java'),
        ...varintField(6, POSITION_ENCODING.utf16),
      ]),
      ...lengthDelimited(2, text(1, 'a/Empty.java')),
      ...lengthDelimited(3, text(1, 'pkg Lib#x.')),
    ]);
    const path = join(dir, 'synthetic.scip');
    writeFileSync(path, raw);
    const index = await convertScipIndex(path);

    expect(index.positionEncoding).toBe(POSITION_ENCODING.utf16);
    expect(index.hasDocument('a/Empty.java')).toBe(true);
    expect(index.lookup('a/A.java', 6, 2)).toEqual({
      symbol: 'pkg A#run().',
      definitions: [{ path: 'a/A.java', line: 3, startCol: 4, endCol: 9 }],
      references: [{ path: 'a/A.java', line: 6, startCol: 1, endCol: 4 }],
      external: false,
    });
    // A range that runs onto later lines covers the rest of its first line.
    expect(index.lookup('a/A.java', 8, 500)?.symbol).toBe('pkg A#block.');
    expect(index.lookup('a/A.java', 9, 0)).toBeNull();
    expect(index.lookup('a/Empty.java', 1, 0)).toBeNull();
  });

  it('puts a definition range that runs onto later lines on its one-line enclosing range', async () => {
    // The shape scip-java gives a Lombok getter on `private final String name;`.
    const raw = Buffer.from(
      lengthDelimited(2, [
        ...text(1, 'Member.java'),
        ...lengthDelimited(2, [
          ...lengthDelimited(1, [8, 30, 9, 6].flatMap(varint)),
          ...text(2, 'pkg Member#getName().'),
          ...varintField(3, 1),
          ...lengthDelimited(7, [8, 25, 30].flatMap(varint)),
        ]),
        ...lengthDelimited(2, occurrence([3, 10, 4, 2], 'pkg Member#block.', 1)),
        ...lengthDelimited(2, occurrence([20, 4, 11], 'pkg Member#getName().')),
      ]),
    );
    const path = join(dir, 'lombok.scip');
    writeFileSync(path, raw);
    const index = await convertScipIndex(path);

    expect(index.lookup('Member.java', 21, 4)?.definitions).toEqual([
      { path: 'Member.java', line: 9, startCol: 25, endCol: 30 },
    ]);
    // Without a one-line enclosing range the site keeps only its start.
    expect(index.lookup('Member.java', 4, 12)?.definitions).toEqual([
      { path: 'Member.java', line: 4, startCol: 10, endCol: 10 },
    ]);
  });

  it('leaves out the declaration a getter refers to even when nothing marks it generated', async () => {
    // No @SuppressWarnings or @lombok.Generated reference shares a range with these.
    const raw = Buffer.from([
      ...lengthDelimited(2, [
        ...text(1, 'Member.java'),
        ...lengthDelimited(2, occurrence([2, 19, 23], 'pkg Member#name.', 1)),
        ...lengthDelimited(2, occurrence([2, 19, 24], 'pkg Member#name.')),
        ...lengthDelimited(2, occurrence([2, 19, 24], 'pkg Member#getName().', 1)),
        ...lengthDelimited(2, occurrence([6, 15, 19], 'pkg Member#name.')),
      ]),
      ...lengthDelimited(2, [
        ...text(1, 'Use.java'),
        ...lengthDelimited(2, occurrence([4, 8, 15], 'pkg Member#getName().')),
      ]),
    ]);
    const path = join(dir, 'unmarked.scip');
    writeFileSync(path, raw);
    const index = await convertScipIndex(path);

    expect(index.lookup('Member.java', 3, 19)?.fieldUses).toEqual([
      { path: 'Member.java', line: 7, startCol: 15, endCol: 19 },
      { path: 'Use.java', line: 5, startCol: 8, endCol: 15, via: 'getter' },
    ]);
  });

  it('prefers the innermost of nested ranges', async () => {
    const raw = Buffer.from(
      lengthDelimited(2, [
        ...text(1, 'B.java'),
        ...lengthDelimited(2, occurrence([0, 0, 20], 'pkg Outer#')),
        ...lengthDelimited(2, occurrence([0, 5, 9], 'pkg Inner#')),
      ]),
    );
    const path = join(dir, 'nested.scip');
    writeFileSync(path, raw);
    const index = await convertScipIndex(path);
    expect(index.lookup('B.java', 1, 6)?.symbol).toBe('pkg Inner#');
    expect(index.lookup('B.java', 1, 12)?.symbol).toBe('pkg Outer#');
  });

  it("answers a member the compiler adds with its type's declaration", async () => {
    const raw = Buffer.from(
      lengthDelimited(2, [
        ...text(1, 'Op.java'),
        ...lengthDelimited(2, occurrence([2, 12, 14], 'pkg Op#', 1)),
        ...lengthDelimited(2, occurrence([9, 20, 26], 'pkg Op#values().')),
        ...lengthDelimited(2, occurrence([10, 4, 10], 'lib Optional#orElse().')),
      ]),
    );
    const path = join(dir, 'enum.scip');
    writeFileSync(path, raw);
    const converted = await convertScipIndex(path);
    await writeScipIndex(converted, join(dir, 'enum.compact'));
    const loaded = await readScipIndex(join(dir, 'enum.compact'));

    for (const index of [converted, loaded]) {
      expect(index?.lookup('Op.java', 10, 21)).toEqual({
        symbol: 'pkg Op#values().',
        definitions: [{ path: 'Op.java', line: 3, startCol: 12, endCol: 14 }],
        references: [{ path: 'Op.java', line: 10, startCol: 20, endCol: 26 }],
        external: false,
      });
      expect(index?.lookup('Op.java', 11, 5)).toMatchObject({ definitions: [], external: true });
    }
  });

  it('rejects a file cut off inside a document', async () => {
    const whole = lengthDelimited(2, [...text(1, 'C.java')]);
    const path = join(dir, 'cut.scip');
    writeFileSync(path, Buffer.from(whole.slice(0, whole.length - 2)));
    await expect(convertScipIndex(path)).rejects.toThrow(/Truncated/);
  });
});

describe('externalSymbolDisplayName', () => {
  it.each([
    [
      'semanticdb maven maven/org.springframework.data/spring-data-commons 2.7.0 org/springframework/data/repository/CrudRepository#save().',
      'org.springframework.data.repository.CrudRepository#save()',
    ],
    ['semanticdb maven jdk 8 java/util/Optional#orElse().', 'java.util.Optional#orElse()'],
    ['semanticdb maven jdk 8 java/util/Optional#orElse(+1).', 'java.util.Optional#orElse()'],
    ['semanticdb maven jdk 8 java/util/Map#Entry#getKey().', 'java.util.Map.Entry#getKey()'],
    ['semanticdb maven jdk 8 java/lang/System#out.', 'java.lang.System#out'],
    ['semanticdb maven jdk 8 java/util/List#', 'java.util.List'],
    ['semanticdb maven jdk 8 java/util/List#[E]', 'java.util.List'],
    ['semanticdb maven jdk 8 java/util/List#add().(e)', 'java.util.List#add()'],
    ['semanticdb maven . . java/util/', 'java.util'],
    ['semanticdb maven jdk 8 java/util/`Weird name`#run().', 'java.util.Weird name#run()'],
    ['scip-typescript npm my  pkg 1.0 src/`a.ts`/run().', 'src.a.ts.run()'],
    ['local 3', 'local 3'],
    ['semanticdb maven jdk 8 java/util/List#add(', 'semanticdb maven jdk 8 java/util/List#add('],
  ])('%s', (symbol, expected) => {
    expect(externalSymbolDisplayName(symbol)).toBe(expected);
  });
});

describe('parseGlobalSymbol', () => {
  it('splits the package, the version and the descriptors with method disambiguators', () => {
    expect(
      parseGlobalSymbol(
        'semanticdb maven maven/org.springframework/spring-web 4.3.30.RELEASE org/springframework/web/Foo#bar(+2).',
      ),
    ).toEqual({
      packageName: 'maven/org.springframework/spring-web',
      version: '4.3.30.RELEASE',
      descriptors: [
        { name: 'org', kind: 'namespace' },
        { name: 'springframework', kind: 'namespace' },
        { name: 'web', kind: 'namespace' },
        { name: 'Foo', kind: 'type' },
        { name: 'bar', kind: 'method', disambiguator: '+2' },
      ],
    });
  });

  it('reads a doubled space in the package name as one space', () => {
    expect(parseGlobalSymbol('scip-typescript npm my  pkg 1.0 src/run().')).toMatchObject({
      packageName: 'my pkg',
      version: '1.0',
    });
  });

  it('gives null for a local symbol or one that does not parse', () => {
    expect(parseGlobalSymbol('local 3')).toBeNull();
    expect(parseGlobalSymbol('semanticdb maven jdk 8 java/util/List#add(')).toBeNull();
  });
});
