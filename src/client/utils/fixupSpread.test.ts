import { describe, expect, it } from 'vitest';

import type { DiffChunk, LineNumber, ReviewDecision, ThreadFixup } from '../../types/diff';

import {
  type AnsweredThread,
  anchorOf,
  fixupDiffFile,
  reviewPathsOf,
  revertedReviewFiles,
  sameAnsweredThread,
  spreadFixups,
} from './fixupSpread';

const chunk = (
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
  lines: DiffChunk['lines'],
): DiffChunk => ({
  header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
  oldStart,
  oldLines,
  newStart,
  newLines,
  lines,
});

const replaceLine = (line: number) =>
  chunk(line, 1, line, 1, [
    { type: 'delete', content: 'old', oldLineNumber: line },
    { type: 'add', content: 'new', newLineNumber: line },
  ]);

const insertTop = (count: number) =>
  chunk(
    0,
    0,
    1,
    count,
    Array.from({ length: count }, (_, index) => ({
      type: 'add' as const,
      content: `top ${index}`,
      newLineNumber: index + 1,
    })),
  );

type FixupFile = ThreadFixup['files'][number];

const file = (path: string, chunks: DiffChunk[], extra: Partial<FixupFile> = {}): FixupFile => ({
  path,
  status: 'modified',
  chunks,
  ...extra,
});

const fixupOf = (sha: string, threadIds: string[], files: FixupFile[]): ThreadFixup => ({
  sha,
  shortSha: sha.slice(0, 7),
  patchId: `patch-${sha}`,
  authoredAt: '2026-01-01T00:00:00Z',
  subject: 'fixup! x',
  threadIds,
  files,
});

const thread = (id: string, path: string, line: LineNumber = 5) => ({ id, file: path, line });

const on = (fixupSha: string, line: number) => ({
  fixupSha,
  placement: { line, isOutdated: false },
});

const byThread = (fixups: ThreadFixup[]) => {
  const map = new Map<string, ThreadFixup[]>();
  fixups.forEach((fixup) =>
    fixup.threadIds.forEach((id) => map.set(id, [...(map.get(id) ?? []), fixup])),
  );
  return map;
};

const spread = (
  fixups: ThreadFixup[],
  threads: Array<ReturnType<typeof thread>>,
  reviewPaths: string[],
  { enabled = true, decisions = [] as ReviewDecision[] } = {},
) =>
  spreadFixups(
    { enabled, fixupsByThread: byThread(fixups), decisions },
    fixups,
    threads,
    reviewPaths.map((path) => ({ path, status: 'modified' as const })),
  );

const boxesOf = (result: ReturnType<typeof spread>, path: string) =>
  [...(result.boxesByFile.get(path)?.values() ?? [])].flat();

const anchors = (result: ReturnType<typeof spread>, path: string) =>
  boxesOf(result, path).map((box) => box.anchor);

describe('anchorOf', () => {
  it('anchors a pure insertion below the old line it follows', () => {
    expect(
      anchorOf(
        chunk(7, 0, 8, 2, [
          { type: 'add', content: 'a', newLineNumber: 8 },
          { type: 'add', content: 'b', newLineNumber: 9 },
        ]),
      ),
    ).toBe(7);
  });

  it('anchors a modification on the replaced line', () => {
    expect(anchorOf(replaceLine(45))).toBe(45);
  });

  it('anchors a deletion at the top on the deleted line', () => {
    expect(anchorOf(chunk(1, 1, 0, 0, [{ type: 'delete', content: 'x', oldLineNumber: 1 }]))).toBe(
      1,
    );
  });

  it('gives 0 for lines inserted above the first line', () => {
    expect(anchorOf(insertTop(2))).toBe(0);
  });

  it('anchors mixed lines on the last old line at or above the last change', () => {
    expect(
      anchorOf(
        chunk(10, 4, 10, 4, [
          { type: 'normal', content: 'a', oldLineNumber: 10, newLineNumber: 10 },
          { type: 'delete', content: 'b', oldLineNumber: 11 },
          { type: 'add', content: 'B', newLineNumber: 11 },
          { type: 'normal', content: 'c', oldLineNumber: 12, newLineNumber: 12 },
          { type: 'add', content: 'd', newLineNumber: 13 },
          { type: 'normal', content: 'e', oldLineNumber: 13, newLineNumber: 14 },
        ]),
      ),
    ).toBe(12);
  });
});

describe('spreadFixups', () => {
  it('leaves the commented file to the card, boxes reviewed files and groups the rest', () => {
    const fixup = fixupOf(
      'aaa1111',
      ['t1'],
      [
        file('a.ts', [replaceLine(5)]),
        file('b.ts', [replaceLine(45), replaceLine(50)]),
        file('c.test.ts', [insertTop(3)], { status: 'added' }),
        file('pnpm-lock.yaml', [replaceLine(2)], { isGenerated: true }),
      ],
    );

    const result = spread([fixup], [thread('t1', 'a.ts')], ['a.ts', 'b.ts']);

    expect([...result.boxesByFile.keys()]).toEqual(['b.ts']);
    expect(anchors(result, 'b.ts')).toEqual([45, 50]);
    expect(boxesOf(result, 'b.ts').map((box) => box.chunkIndex)).toEqual([0, 1]);
    expect(result.fixupOnly).toHaveLength(1);
    expect(result.fixupOnly[0]?.files.map(({ path }) => path)).toEqual([
      'c.test.ts',
      'pnpm-lock.yaml',
    ]);
    expect([...result.touchedReviewFiles]).toEqual([
      ['a.ts', { fixupSha: 'aaa1111', path: 'a.ts' }],
      ['b.ts', { fixupSha: 'aaa1111', path: 'b.ts' }],
    ]);
    expect(result.places.get('aaa1111:a.ts')).toEqual({ kind: 'card', threadId: 't1' });
    expect(result.places.get('aaa1111:b.ts')).toEqual({ kind: 'box', reviewPath: 'b.ts' });
    expect(result.places.get('aaa1111:c.test.ts')).toEqual({ kind: 'fixup-only' });
  });

  it('boxes reviewed files and groups the rest for a fixup answering a comment on a whole commit', () => {
    const fixup = fixupOf(
      'aaa1111',
      ['c1'],
      [file('a.ts', [replaceLine(5)]), file('notes.md', [insertTop(2)], { status: 'added' })],
    );

    const result = spreadFixups(
      { enabled: true, fixupsByThread: byThread([fixup]), decisions: [] },
      [fixup],
      [{ id: 'c1', commit: 'bbb2222', isOutdated: false }],
      [{ path: 'a.ts', status: 'modified' }],
    );

    expect(result.places.get('aaa1111:a.ts')).toEqual({ kind: 'box', reviewPath: 'a.ts' });
    expect(boxesOf(result, 'a.ts')[0]?.threads.map(({ id }) => id)).toEqual(['c1']);
    expect(result.places.get('aaa1111:notes.md')).toEqual({ kind: 'fixup-only' });
  });

  it('puts a change above the first line below line 1', () => {
    const fixup = fixupOf(
      'aaa1111',
      ['t1'],
      [file('a.ts', [replaceLine(5)]), file('b.ts', [insertTop(2)])],
    );

    expect(anchors(spread([fixup], [thread('t1', 'a.ts')], ['a.ts', 'b.ts']), 'b.ts')).toEqual([1]);
  });

  it('finds the reviewed file of a renamed one by its old path', () => {
    const fixup = fixupOf(
      'aaa1111',
      ['t1'],
      [
        file('a.ts', [replaceLine(5)]),
        file('three.ts', [replaceLine(8)], { oldPath: 'third.ts', status: 'renamed' }),
      ],
    );

    const result = spread([fixup], [thread('t1', 'a.ts')], ['a.ts', 'third.ts']);

    expect(anchors(result, 'third.ts')).toEqual([8]);
    expect(result.places.get('aaa1111:three.ts')).toEqual({ kind: 'box', reviewPath: 'third.ts' });
    expect(result.fixupOnly).toEqual([]);
  });

  it('spreads a fixup answering several threads once, keeping every thread on its boxes', () => {
    const fixup = fixupOf(
      'aaa1111',
      ['t1', 't2'],
      [
        file('a.ts', [replaceLine(5)]),
        file('b.ts', [replaceLine(3)]),
        file('c.ts', [replaceLine(9)]),
      ],
    );

    const result = spread(
      [fixup],
      [thread('t1', 'a.ts'), thread('t2', 'b.ts', 3)],
      ['a.ts', 'b.ts', 'c.ts'],
    );

    expect([...result.boxesByFile.keys()]).toEqual(['c.ts']);
    expect(boxesOf(result, 'c.ts')[0]?.threads.map(({ id }) => id)).toEqual(['t1', 't2']);
    expect(result.places.get('aaa1111:b.ts')).toEqual({ kind: 'card', threadId: 't2' });
  });

  it('spreads every fixup a thread is waiting on, skipping the rejected one', () => {
    const first = fixupOf('aaa1111', ['t1'], [file('a.ts', [replaceLine(5)])]);
    const rejected = fixupOf('bbb2222', ['t1'], [file('c.ts', [replaceLine(7)])]);
    const second = fixupOf('ccc3333', ['t1'], [file('b.ts', [replaceLine(3)])]);

    const result = spread([first, rejected, second], [thread('t1', 'a.ts')], ['a.ts', 'b.ts'], {
      decisions: [{ threadId: 't1', kind: 'rejected', fixupSha: 'bbb2222', at: '2026-01-02' }],
    });

    expect(result.places.get('aaa1111:a.ts')).toEqual({ kind: 'card', threadId: 't1' });
    expect(result.places.get('ccc3333:b.ts')).toEqual({ kind: 'box', reviewPath: 'b.ts' });
    expect(result.places.has('bbb2222:c.ts')).toBe(false);
  });

  it('spreads nothing when overlaying is off or the fixup was rejected', () => {
    const fixup = fixupOf(
      'aaa1111',
      ['t1'],
      [
        file('a.ts', [replaceLine(5)]),
        file('b.ts', [replaceLine(45)]),
        file('c.ts', [insertTop(1)], { status: 'added' }),
      ],
    );
    const rejected: ReviewDecision = {
      threadId: 't1',
      kind: 'rejected',
      fixupSha: 'aaa1111',
      at: '2026-01-02T00:00:00Z',
    };
    const empty = {
      boxesByFile: new Map(),
      fixupOnly: [],
      touchedReviewFiles: new Map(),
      places: new Map(),
      outsidePlacements: new Map(),
    };

    expect(spread([fixup], [thread('t1', 'a.ts')], ['a.ts', 'b.ts'], { enabled: false })).toEqual(
      empty,
    );
    expect(
      spread([fixup], [thread('t1', 'a.ts')], ['a.ts', 'b.ts'], { decisions: [rejected] }),
    ).toEqual(empty);
  });

  it('spreads nothing for an outdated thread, whose card is not drawn', () => {
    const fixup = fixupOf(
      'aaa1111',
      ['t1'],
      [file('a.ts', [replaceLine(5)]), file('b.ts', [replaceLine(45)])],
    );

    const result = spreadFixups(
      { enabled: true, fixupsByThread: byThread([fixup]), decisions: [] },
      [fixup],
      [{ ...thread('t1', 'a.ts'), isOutdated: true }],
      [
        { path: 'a.ts', status: 'modified' },
        { path: 'b.ts', status: 'modified' },
      ],
    );

    expect(result.boxesByFile.size).toBe(0);
  });

  it('counts the lines of a later fixup on the reviewed commit, through the earlier ones', () => {
    const first = fixupOf(
      'aaa1111',
      ['t1'],
      [file('a.ts', [replaceLine(5)]), file('b.ts', [insertTop(2)])],
    );
    const second = fixupOf(
      'bbb2222',
      ['t2'],
      [file('a.ts', [replaceLine(30)]), file('b.ts', [replaceLine(1), replaceLine(47)])],
    );

    const result = spread(
      [first, second],
      [thread('t1', 'a.ts'), thread('t2', 'a.ts', 30)],
      ['a.ts', 'b.ts'],
    );

    expect(boxesOf(result, 'b.ts').map((box) => [box.fixup.shortSha, box.anchor])).toEqual([
      ['aaa1111', 1],
      ['bbb2222', 1],
      ['bbb2222', 45],
    ]);
    expect(
      result.boxesByFile
        .get('b.ts')
        ?.get(1)
        ?.map((box) => box.fixup.shortSha),
    ).toEqual(['aaa1111', 'bbb2222']);
  });

  it('follows a file an earlier fixup renamed back to its reviewed path', () => {
    const first = fixupOf(
      'aaa1111',
      ['t1'],
      [
        file('a.ts', [replaceLine(5)]),
        file('new.ts', [], { oldPath: 'old.ts', status: 'renamed' }),
      ],
    );
    const second = fixupOf(
      'bbb2222',
      ['t2'],
      [file('a.ts', [replaceLine(30)]), file('new.ts', [replaceLine(12)])],
    );

    const result = spread(
      [first, second],
      [thread('t1', 'a.ts'), thread('t2', 'a.ts', 30)],
      ['a.ts', 'old.ts'],
    );

    expect(anchors(result, 'old.ts')).toEqual([12]);
    expect(result.fixupOnly).toEqual([]);
  });
});

describe('commits answering no thread before a fixup', () => {
  const after = (fixup: ThreadFixup, plainChangesBefore: ThreadFixup['plainChangesBefore']) => ({
    ...fixup,
    plainChangesBefore,
  });
  const insertedAtTop = (count: number) => ({
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: count,
  });

  it('counts the lines of the fixup on the reviewed commit past the lines they added', () => {
    const fixup = after(
      fixupOf('aaa1111', ['t1'], [file('a.ts', [replaceLine(5)]), file('b.ts', [replaceLine(50)])]),
      [{ path: 'b.ts', shifts: [insertedAtTop(10)] }],
    );

    expect(anchors(spread([fixup], [thread('t1', 'a.ts')], ['a.ts', 'b.ts']), 'b.ts')).toEqual([
      40,
    ]);
  });

  it('follows a file they renamed after an earlier fixup back to its reviewed path', () => {
    const first = fixupOf('aaa1111', ['t1'], [file('a.ts', [replaceLine(5)])]);
    const second = after(
      fixupOf(
        'bbb2222',
        ['t2'],
        [file('a.ts', [replaceLine(30)]), file('new.ts', [replaceLine(12)])],
      ),
      [{ path: 'new.ts', oldPath: 'old.ts', shifts: [insertedAtTop(2)] }],
    );

    const result = spread(
      [first, second],
      [thread('t1', 'a.ts'), thread('t2', 'a.ts', 30)],
      ['a.ts', 'old.ts'],
    );

    expect(anchors(result, 'old.ts')).toEqual([10]);
    expect(result.fixupOnly).toEqual([]);
  });

  it('draws a file the fixup changed on lines they added below the line above them', () => {
    const fixup = after(
      fixupOf('aaa1111', ['t1'], [file('a.ts', [replaceLine(5)]), file('b.ts', [replaceLine(5)])]),
      [{ path: 'b.ts', shifts: [insertedAtTop(10)] }],
    );

    const result = spread([fixup], [thread('t1', 'a.ts')], ['a.ts', 'b.ts']);

    expect(result.places.get('aaa1111:b.ts')).toEqual({ kind: 'box', reviewPath: 'b.ts' });
    expect(boxesOf(result, 'b.ts').map((box) => box.anchor)).toEqual([1]);
    expect(result.touchedReviewFiles.get('b.ts')).toEqual({ fixupSha: 'aaa1111', path: 'b.ts' });
  });

  it('draws a chunk that also changes lines they added above its anchor below the line above them', () => {
    const deleted = chunk(
      10,
      4,
      9,
      0,
      [10, 11, 12, 13].map((line) => ({
        type: 'delete' as const,
        content: `line ${line}`,
        oldLineNumber: line,
      })),
    );
    const fixup = after(
      fixupOf('aaa1111', ['t1'], [file('a.ts', [replaceLine(5)]), file('b.ts', [deleted])]),
      [{ path: 'b.ts', shifts: [{ oldStart: 10, oldLines: 0, newStart: 11, newLines: 2 }] }],
    );

    const result = spread([fixup], [thread('t1', 'a.ts')], ['a.ts', 'b.ts']);

    expect(result.places.get('aaa1111:b.ts')).toEqual({ kind: 'box', reviewPath: 'b.ts' });
    expect(boxesOf(result, 'b.ts').map((box) => box.anchor)).toEqual([11]);
  });

  it('marks each chunk by whether it changes lines they changed', () => {
    const fixup = after(
      fixupOf(
        'aaa1111',
        ['t1'],
        [file('a.ts', [replaceLine(5)]), file('b.ts', [replaceLine(21), replaceLine(50)])],
      ),
      [{ path: 'b.ts', shifts: [{ oldStart: 20, oldLines: 2, newStart: 20, newLines: 3 }] }],
    );

    const result = spread([fixup], [thread('t1', 'a.ts')], ['a.ts', 'b.ts']);

    expect(boxesOf(result, 'b.ts').map((box) => box.anchor)).toEqual([19, 49]);
  });

  it('marks a later fixup by the lines they wrote after an earlier fixup, not by the lines it added', () => {
    const added = chunk(9, 0, 10, 1, [{ type: 'add', content: 'added', newLineNumber: 10 }]);
    const first = fixupOf('aaa1111', ['t1'], [file('b.ts', [added])]);
    const second = after(
      fixupOf('bbb2222', ['t2'], [file('b.ts', [replaceLine(2), replaceLine(13)])]),
      [{ path: 'b.ts', shifts: [insertedAtTop(3)] }],
    );

    const result = spread(
      [first, second],
      [thread('t1', 'a.ts'), thread('t2', 'a.ts', 30)],
      ['a.ts', 'b.ts'],
    );

    expect(
      boxesOf(result, 'b.ts')
        .filter((box) => box.fixup.sha === 'bbb2222')
        .map((box) => box.anchor)
        .sort((above, below) => above - below),
    ).toEqual([1, 9]);
  });
});

describe('matching a fixup file to the card on its reviewed path', () => {
  const spreadWithMadeOnFirst = (fixups: ThreadFixup[]) =>
    spreadFixups(
      { enabled: true, fixupsByThread: byThread(fixups), decisions: [] },
      fixups,
      [thread('t1', 'a.ts'), { ...thread('y', 'p.ts', 2), isOutdated: true }],
      [{ path: 'a.ts', status: 'modified' }],
      {
        threads: [{ id: 'y', file: 'p.ts', snapshotCommit: 'aaa1111' }],
        place: () => ({ line: 2, isOutdated: false }),
      },
    );

  it('gives a file an earlier fixup renamed to the card of a thread on its reviewed path', () => {
    const first = fixupOf(
      'aaa1111',
      ['t1'],
      [file('b.ts', [replaceLine(5)], { oldPath: 'a.ts', status: 'renamed' })],
    );
    const second = fixupOf('bbb2222', ['t2'], [file('b.ts', [replaceLine(30)])]);

    const result = spread(
      [first, second],
      [thread('t1', 'a.ts'), thread('t2', 'a.ts', 30)],
      ['a.ts'],
    );

    expect(result.places.get('aaa1111:b.ts')).toEqual({ kind: 'card', threadId: 't1' });
    expect(result.places.get('bbb2222:b.ts')).toEqual({ kind: 'card', threadId: 't2' });
    expect(result.boxesByFile.size).toBe(0);
  });

  it('keeps a file outside the review in the section of the fixup when a thread it answers sits there', () => {
    const fixup = fixupOf(
      'aaa1111',
      ['t1', 'y'],
      [file('a.ts', [replaceLine(5)]), file('p.ts', [insertTop(2)], { status: 'added' })],
    );

    const result = spread([fixup], [thread('t1', 'a.ts'), thread('y', 'p.ts', 1)], ['a.ts']);

    expect(result.places.get('aaa1111:p.ts')).toEqual({ kind: 'fixup-only' });
    expect(result.fixupOnly.map(({ files }) => files.map(({ path }) => path))).toEqual([['p.ts']]);
  });

  it('gives a later fixup on a file outside the review to the card of a thread made in its section', () => {
    const first = fixupOf('aaa1111', ['t1'], [file('p.ts', [insertTop(2)], { status: 'added' })]);
    const second = fixupOf('bbb2222', ['y'], [file('p.ts', [replaceLine(2)])]);

    const result = spreadWithMadeOnFirst([first, second]);

    expect(result.places.get('aaa1111:p.ts')).toEqual({ kind: 'fixup-only' });
    expect(result.places.get('bbb2222:p.ts')).toEqual({ kind: 'card', threadId: 'y' });
    expect(result.fixupOnly.map(({ fixup }) => fixup.sha)).toEqual(['aaa1111']);
  });

  it('gives a later fixup renaming a file outside the review to the card of a thread made in its section', () => {
    const first = fixupOf('aaa1111', ['t1'], [file('p.ts', [insertTop(2)], { status: 'added' })]);
    const second = fixupOf(
      'bbb2222',
      ['y'],
      [file('q.ts', [replaceLine(2)], { oldPath: 'p.ts', status: 'renamed' })],
    );

    const result = spreadWithMadeOnFirst([first, second]);

    expect(result.places.get('bbb2222:q.ts')).toEqual({ kind: 'card', threadId: 'y' });
    expect(result.fixupOnly.map(({ fixup }) => fixup.sha)).toEqual(['aaa1111']);
  });

  it('names the reviewed path of every fixup file, overlaid or not', () => {
    const first = fixupOf(
      'aaa1111',
      ['t1'],
      [file('b.ts', [replaceLine(5)], { oldPath: 'a.ts', status: 'renamed' })],
    );
    const second = fixupOf('bbb2222', ['t2'], [file('b.ts', [replaceLine(30)]), file('c.ts', [])]);

    expect([...reviewPathsOf([first, second])]).toEqual([
      ['aaa1111:b.ts', 'a.ts'],
      ['bbb2222:b.ts', 'a.ts'],
      ['bbb2222:c.ts', 'c.ts'],
    ]);
  });
});

describe('threads on files outside the review', () => {
  const first = fixupOf('aaa1111', ['t1'], [file('p.ts', [insertTop(2)], { status: 'added' })]);
  const madeOnFirst = { id: 'y', file: 'p.ts', snapshotCommit: 'aaa1111' };
  const outdated = { ...thread('y', 'p.ts', 2), isOutdated: true };

  const spreadPlacing = (
    fixups: ThreadFixup[],
    lineOn: (fixupSha: string) => number | null,
    outsideThreads = [madeOnFirst],
  ) => {
    const placedOn: Array<[string, string]> = [];
    const result = spreadFixups(
      { enabled: true, fixupsByThread: byThread(fixups), decisions: [] },
      fixups,
      [thread('t1', 'a.ts'), thread('t2', 'a.ts', 30), outdated],
      [{ path: 'a.ts', status: 'modified' }],
      {
        threads: outsideThreads,
        place: (outside, _file, fixup) => {
          placedOn.push([outside.id, fixup.sha]);
          const line = lineOn(fixup.sha);
          return line === null ? { line: 2, isOutdated: true } : { line, isOutdated: false };
        },
      },
    );
    return { result, placedOn };
  };

  it('places a thread made in the section of a fixup on that fixup and lets a later fixup answer it', () => {
    const second = fixupOf(
      'bbb2222',
      ['t2', 'y'],
      [file('a.ts', [replaceLine(30)]), file('p.ts', [replaceLine(2)])],
    );

    const { result, placedOn } = spreadPlacing([first, second], (sha) =>
      sha === 'aaa1111' ? 2 : null,
    );

    expect(placedOn).toEqual([['y', 'aaa1111']]);
    expect(result.outsidePlacements.get('y')).toEqual(on('aaa1111', 2));
    expect(result.places.get('bbb2222:p.ts')).toEqual({ kind: 'card', threadId: 'y' });
    expect(result.fixupOnly.map(({ fixup }) => fixup.sha)).toEqual(['aaa1111']);
  });

  it('keeps the line of a thread on the fixup it was made on when a later fixup answering it shifts it', () => {
    const second = fixupOf('bbb2222', ['t2', 'y'], [file('p.ts', [insertTop(1)])]);

    const { result } = spreadPlacing([first, second], (sha) => (sha === 'aaa1111' ? 2 : 3));

    expect(result.outsidePlacements.get('y')).toEqual(on('aaa1111', 2));
    expect(result.places.get('bbb2222:p.ts')).toEqual({ kind: 'card', threadId: 'y' });
  });

  it('keeps a thread on the fixup it was made on when a later fixup shows its file without answering it', () => {
    const second = fixupOf('bbb2222', ['t2'], [file('p.ts', [insertTop(1)])]);

    const { result, placedOn } = spreadPlacing([first, second], (sha) =>
      sha === 'aaa1111' ? 2 : 3,
    );

    expect(placedOn).toEqual([['y', 'aaa1111']]);
    expect(result.outsidePlacements.get('y')).toEqual(on('aaa1111', 2));
    expect(result.fixupOnly.map(({ fixup }) => fixup.sha)).toEqual(['aaa1111', 'bbb2222']);
  });

  it('places a thread once when the fixup it was made on also shows its file', () => {
    const zero = fixupOf('zzz0000', ['t2'], [file('p.ts', [insertTop(2)], { status: 'added' })]);

    const { result, placedOn } = spreadPlacing([zero, first], () => 2);

    expect(placedOn).toEqual([['y', 'aaa1111']]);
    expect(result.fixupOnly.map(({ fixup }) => fixup.sha)).toEqual(['zzz0000', 'aaa1111']);
  });
});

describe('placing a thread outside the review once', () => {
  const outdated = (id: string, path = 'p.ts') => ({ ...thread(id, path, 2), isOutdated: true });

  const spreadOutside = (
    fixups: ThreadFixup[],
    answering: AnsweredThread[],
    outsideThreads: Array<{ id: string; file: string; snapshotCommit: string | undefined }>,
    lineOn: (threadId: string, fixupSha: string) => number | null,
  ) => {
    const placedOn: Array<[string, string]> = [];
    const result = spreadFixups(
      { enabled: true, fixupsByThread: byThread(fixups), decisions: [] },
      fixups,
      answering,
      [{ path: 'a.ts', status: 'modified' }],
      {
        threads: outsideThreads,
        place: (outside, _file, fixup) => {
          placedOn.push([outside.id, fixup.sha]);
          const line = lineOn(outside.id, fixup.sha);
          return line === null ? { line: 2, isOutdated: true } : { line, isOutdated: false };
        },
      },
    );
    return { result, placedOn };
  };

  it('draws a thread made on a fixup whose copy of its file went to a card on the shown copy', () => {
    const first = fixupOf('aaa1111', ['t1'], [file('p.ts', [insertTop(2)], { status: 'added' })]);
    const second = fixupOf('bbb2222', ['x'], [file('p.ts', [replaceLine(1)])]);

    const { result, placedOn } = spreadOutside(
      [first, second],
      [thread('t1', 'a.ts'), outdated('x'), outdated('y')],
      [
        { id: 'x', file: 'p.ts', snapshotCommit: 'aaa1111' },
        { id: 'y', file: 'p.ts', snapshotCommit: 'bbb2222' },
      ],
      (id, sha) => (id === 'x' ? 1 : sha === 'aaa1111' ? 2 : 3),
    );

    expect(result.places.get('bbb2222:p.ts')).toEqual({ kind: 'card', threadId: 'x' });
    expect(placedOn).toContainEqual(['y', 'aaa1111']);
    expect(result.outsidePlacements.get('y')).toEqual(on('aaa1111', 2));
  });

  it('gives a later fixup on a file an earlier fixup renamed outside the review to the card of a thread there', () => {
    const first = fixupOf(
      'aaa1111',
      ['t1'],
      [file('p.ts', [replaceLine(1)], { oldPath: 'r.ts', status: 'renamed' })],
    );
    const second = fixupOf(
      'bbb2222',
      ['t2', 'y'],
      [file('p.ts', [replaceLine(2)]), file('n.ts', [insertTop(1)], { status: 'added' })],
    );

    const { result } = spreadOutside(
      [first, second],
      [thread('t1', 'a.ts'), thread('t2', 'a.ts', 30), outdated('y')],
      [{ id: 'y', file: 'p.ts', snapshotCommit: 'aaa1111' }],
      (_id, sha) => (sha === 'aaa1111' ? 2 : null),
    );

    expect(result.places.get('bbb2222:p.ts')).toEqual({ kind: 'card', threadId: 'y' });
    expect(result.outsidePlacements.get('y')).toEqual(on('aaa1111', 2));
    expect(
      result.fixupOnly.map(({ fixup, files, threads }) => [
        fixup.sha,
        files.map(({ path }) => path),
        threads.map(({ id }) => id),
      ]),
    ).toEqual([
      ['aaa1111', ['p.ts'], ['t1']],
      ['bbb2222', ['n.ts'], ['t2', 'y']],
    ]);
  });

  it('answers with a thread whose snapshot names no listed fixup by its placement on the shown copy', () => {
    const first = fixupOf('aaa1111', ['t1'], [file('p.ts', [insertTop(2)], { status: 'added' })]);
    const second = fixupOf('bbb2222', ['y'], [file('p.ts', [replaceLine(2)])]);

    const { result } = spreadOutside(
      [first, second],
      [thread('t1', 'a.ts'), outdated('y')],
      [{ id: 'y', file: 'p.ts', snapshotCommit: 'gone000' }],
      (_id, sha) => (sha === 'aaa1111' ? 2 : null),
    );

    expect(result.places.get('bbb2222:p.ts')).toEqual({ kind: 'card', threadId: 'y' });
    expect(result.outsidePlacements.get('y')).toEqual(on('aaa1111', 2));
  });
});

describe('a thread outside the review belongs to the group it was made on', () => {
  const outdated = (id: string, path = 'p.ts') => ({ ...thread(id, path, 2), isOutdated: true });

  const spreadOutside = (
    fixups: ThreadFixup[],
    answering: AnsweredThread[],
    outsideThreads: Array<{ id: string; file: string; snapshotCommit: string | undefined }>,
    lineOn: (threadId: string, fixupSha: string) => number | null,
    reviewFiles = [{ path: 'a.ts', status: 'modified' as const }],
  ) => {
    const placedOn: Array<[string, string]> = [];
    const result = spreadFixups(
      { enabled: true, fixupsByThread: byThread(fixups), decisions: [] },
      fixups,
      answering,
      reviewFiles,
      {
        threads: outsideThreads,
        place: (outside, _file, fixup) => {
          placedOn.push([outside.id, fixup.sha]);
          const line = lineOn(outside.id, fixup.sha);
          return line === null ? { line: 2, isOutdated: true } : { line, isOutdated: false };
        },
      },
    );
    return { result, placedOn };
  };

  it('spreads a fixup answering a thread made on a group that a later group also shows a file of', () => {
    const a = fixupOf('aaa1111', ['t1'], [file('p.ts', [insertTop(2)], { status: 'added' })]);
    const b = fixupOf(
      'bbb2222',
      ['y'],
      [file('p.ts', [replaceLine(2)]), file('q.ts', [insertTop(2)], { status: 'added' })],
    );
    const c = fixupOf('ccc3333', ['z'], [file('q.ts', [replaceLine(1)])]);

    const { result } = spreadOutside(
      [a, b, c],
      [thread('t1', 'a.ts'), outdated('y'), outdated('z', 'q.ts')],
      [
        { id: 'y', file: 'p.ts', snapshotCommit: 'aaa1111' },
        { id: 'z', file: 'q.ts', snapshotCommit: 'bbb2222' },
      ],
      (id, sha) =>
        id === 'y' && sha === 'aaa1111' ? 2 : id === 'z' && sha === 'bbb2222' ? 1 : null,
    );

    expect(result.places.get('bbb2222:p.ts')).toEqual({ kind: 'card', threadId: 'y' });
    expect(result.places.get('bbb2222:q.ts')).toEqual({ kind: 'fixup-only' });
    expect(result.places.get('ccc3333:q.ts')).toEqual({ kind: 'card', threadId: 'z' });
    expect(result.fixupOnly.map(({ fixup }) => fixup.sha)).toEqual(['aaa1111', 'bbb2222']);
    expect(result.outsidePlacements.get('y')).toEqual(on('aaa1111', 2));
    expect(result.outsidePlacements.get('z')).toEqual(on('bbb2222', 1));
  });

  it('keeps a thread on the group it was made on when a later group changes its line without answering it', () => {
    const a = fixupOf('aaa1111', ['t1'], [file('p.ts', [insertTop(2)], { status: 'added' })]);
    const b = fixupOf('bbb2222', ['t2'], [file('p.ts', [replaceLine(2)])]);
    const c = fixupOf('ccc3333', ['y'], [file('p.ts', [replaceLine(2)])]);

    const { result, placedOn } = spreadOutside(
      [a, b, c],
      [thread('t1', 'a.ts'), thread('t2', 'a.ts', 30), outdated('y')],
      [{ id: 'y', file: 'p.ts', snapshotCommit: 'aaa1111' }],
      (_id, sha) => (sha === 'aaa1111' ? 2 : null),
    );

    expect(placedOn).toEqual([['y', 'aaa1111']]);
    expect(result.outsidePlacements.get('y')).toEqual(on('aaa1111', 2));
    expect(result.places.get('ccc3333:p.ts')).toEqual({ kind: 'card', threadId: 'y' });
    expect(result.fixupOnly.map(({ fixup }) => fixup.sha)).toEqual(['aaa1111', 'bbb2222']);
  });

  it('places a thread whose snapshot names no listed fixup again on each later group showing its file', () => {
    const a = fixupOf('aaa1111', ['t1'], [file('p.ts', [insertTop(2)], { status: 'added' })]);
    const b = fixupOf('bbb2222', ['t2'], [file('p.ts', [insertTop(1)])]);

    const { result, placedOn } = spreadOutside(
      [a, b],
      [thread('t1', 'a.ts'), thread('t2', 'a.ts', 30), outdated('y')],
      [{ id: 'y', file: 'p.ts', snapshotCommit: 'gone000' }],
      (_id, sha) => (sha === 'aaa1111' ? 2 : 3),
    );

    expect(placedOn).toEqual([
      ['y', 'aaa1111'],
      ['y', 'bbb2222'],
    ]);
    expect(result.outsidePlacements.get('y')).toEqual(on('bbb2222', 3));
  });

  it('leaves a reviewed file an earlier fixup renamed to the path of a thread drawn nowhere off its card', () => {
    const a = fixupOf(
      'aaa1111',
      ['t1'],
      [file('p.ts', [replaceLine(5)], { oldPath: 'a.ts', status: 'renamed' })],
    );
    const b = fixupOf('bbb2222', ['y'], [file('p.ts', [replaceLine(9)])]);

    const { result } = spreadOutside(
      [a, b],
      [thread('t1', 'a.ts'), outdated('y')],
      [{ id: 'y', file: 'p.ts', snapshotCommit: 'aaa1111' }],
      () => 2,
    );

    expect(result.places.get('aaa1111:p.ts')).toEqual({ kind: 'card', threadId: 't1' });
    expect(result.places.get('bbb2222:p.ts')).toBeUndefined();
    expect(result.outsidePlacements.has('y')).toBe(false);
    expect(result.fixupOnly).toEqual([]);
  });
});

describe('a reviewed path the review deletes', () => {
  it('leaves a file a fixup brings back there to the card of its first thread', () => {
    const fixup = fixupOf(
      'aaa1111',
      ['t1'],
      [file('a.ts', [replaceLine(5)]), file('gone.ts', [insertTop(1)], { status: 'added' })],
    );

    const result = spreadFixups(
      { enabled: true, fixupsByThread: byThread([fixup]), decisions: [] },
      [fixup],
      [thread('t1', 'a.ts')],
      [
        { path: 'a.ts', status: 'modified' },
        { path: 'gone.ts', status: 'deleted' },
      ],
    );

    expect(result.places.get('aaa1111:gone.ts')).toEqual({ kind: 'card', threadId: 't1' });
    expect(result.fixupOnly).toEqual([]);
    expect(result.boxesByFile.size).toBe(0);
  });
});

describe('fixupDiffFile', () => {
  it('counts the added and deleted lines of a fixup file', () => {
    const changed = file('c.ts', [replaceLine(3), insertTop(2)], { isGenerated: true });

    expect(fixupDiffFile(changed)).toEqual({ ...changed, additions: 3, deletions: 1 });
  });
});

describe('sameAnsweredThread', () => {
  it('finds a thread the same until it moves or goes out of date', () => {
    const before = thread('t2', 'b.ts', [3, 4]);
    const replied = { ...thread('t2', 'b.ts', [3, 4]), messages: [] };

    expect(sameAnsweredThread(replied, before)).toBe(true);
    expect(sameAnsweredThread(thread('t2', 'b.ts', [3, 5]), before)).toBe(false);
    expect(sameAnsweredThread({ ...thread('t2', 'b.ts', [3, 4]), isOutdated: true }, before)).toBe(
      false,
    );
  });
});

describe('revertedReviewFiles', () => {
  const reverted = (fixups: ThreadFixup[], options?: { enabled?: boolean }) =>
    revertedReviewFiles(
      fixups,
      reviewPathsOf(fixups),
      spread(fixups, [thread('t1', 'a.ts'), thread('t2', 'b.ts')], ['a.ts', 'b.ts'], options)
        .places,
      new Set(['a.ts', 'b.ts']),
    );
  const revert = (path: string) => file(path, [replaceLine(5)], { matchesReviewBase: true });

  it('gives a reviewed file the fixup that brought it back to the review base', () => {
    const fixup = fixupOf('aaa1111', ['t1'], [revert('a.ts'), file('b.ts', [replaceLine(5)])]);

    expect(reverted([fixup])).toEqual(new Map([['a.ts', { fixupSha: 'aaa1111', path: 'a.ts' }]]));
  });

  it('follows the last fixup that changed the file', () => {
    const first = fixupOf('aaa1111', ['t1'], [revert('a.ts')]);
    const changedAgain = fixupOf('bbb2222', ['t2'], [file('a.ts', [replaceLine(5)])]);
    const revertedAgain = fixupOf('ccc3333', ['t2'], [revert('a.ts')]);
    const elsewhere = fixupOf('ddd4444', ['t2'], [file('b.ts', [replaceLine(5)])]);

    expect(reverted([first, changedAgain])).toEqual(new Map());
    expect(reverted([first, changedAgain, revertedAgain, elsewhere])).toEqual(
      new Map([['a.ts', { fixupSha: 'ccc3333', path: 'a.ts' }]]),
    );
  });

  it('leaves out a file outside the review', () => {
    const added = fixupOf(
      'aaa1111',
      ['t1'],
      [file('helper.ts', [insertTop(2)], { status: 'added' })],
    );
    const removed = fixupOf(
      'bbb2222',
      ['t1'],
      [file('helper.ts', [], { status: 'deleted', matchesReviewBase: true })],
    );

    expect(reverted([added, removed])).toEqual(new Map());
  });

  it('leaves out a file whose reverting fixup is not shown', () => {
    expect(reverted([fixupOf('aaa1111', ['t1'], [revert('a.ts')])], { enabled: false })).toEqual(
      new Map(),
    );
  });

  it('leaves out a file whose last change is a fixup that is not shown', () => {
    const first = fixupOf('aaa1111', ['t1'], [revert('a.ts')]);
    const unanswered = fixupOf('bbb2222', ['other'], [file('a.ts', [replaceLine(5)])]);

    expect(reverted([first, unanswered])).toEqual(new Map());
  });
});
