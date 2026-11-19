import { describe, expect, it } from 'vitest';

import type { DiffFile, DiffLine, WalkthroughStep } from '../../types/diff';

import { placeOfStep, referenceFilesOf } from './walkthroughStep';

const COMMIT = '3f1c9e0a1b2c3d4e5f60718293a4b5c6d7e8f901';

const line = (type: DiffLine['type'], oldLine?: number, newLine?: number): DiffLine => ({
  type,
  content: 'x',
  ...(oldLine === undefined ? {} : { oldLineNumber: oldLine }),
  ...(newLine === undefined ? {} : { newLineNumber: newLine }),
});

// Shows new lines 10-13 of src/a.ts; 1-9 and 14 on are folded.
const files: DiffFile[] = [
  {
    path: 'src/a.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    chunks: [
      {
        header: '@@ -10,4 +10,4 @@',
        oldStart: 10,
        oldLines: 4,
        newStart: 10,
        newLines: 4,
        lines: [
          line('context', 10, 10),
          line('delete', 11),
          line('add', undefined, 11),
          line('context', 12, 12),
          line('context', 13, 13),
        ],
      },
    ],
  },
  {
    path: 'src/gone.ts',
    status: 'deleted',
    additions: 0,
    deletions: 3,
    chunks: [],
  },
];

const step = (file: string, from: number, to?: number): WalkthroughStep => ({
  file,
  line: from,
  ...(to === undefined ? {} : { endLine: to }),
  description: 'd',
});

describe('placeOfStep', () => {
  it.each([
    ['a line the diff shows', step('src/a.ts', 11), { kind: 'shown', lines: [11] }],
    ['a range the diff shows', step('src/a.ts', 11, 13), { kind: 'shown', lines: [11, 12, 13] }],
    ['a range half folded', step('src/a.ts', 12, 16), { kind: 'shown', lines: [12, 13] }],
    ['a folded line', step('src/a.ts', 3), { kind: 'not-shown' }],
    [
      'a file the diff does not have',
      step('src/other.ts', 4, 6),
      { kind: 'reference', line: 4, endLine: 6 },
    ],
    ['a file the diff deleted', step('src/gone.ts', 1), { kind: 'not-shown' }],
  ])('places %s', (_, given, expected) => {
    expect(placeOfStep(given, { commit: COMMIT, diffTarget: '3f1c9e0', files })).toEqual(
      expected.kind === 'not-shown' ? expected : { ...expected, file: given.file },
    );
  });

  it('places a range that runs far past the end of the file without walking every number', () => {
    expect(
      placeOfStep(step('src/a.ts', 12, 2 ** 40), {
        commit: COMMIT,
        diffTarget: '3f1c9e0',
        files,
      }),
    ).toEqual({ kind: 'shown', file: 'src/a.ts', lines: [12, 13] });
  }, 1000);

  it('shows nothing on a view of another commit, whose lines are numbered differently', () => {
    expect(
      placeOfStep(step('src/a.ts', 11), {
        commit: COMMIT,
        diffTarget: 'b0b0b0b',
        files,
      }),
    ).toEqual({ kind: 'not-shown' });
  });

  it('leaves a file the diff does not have unplaced on a view of another commit', () => {
    expect(
      placeOfStep(step('src/other.ts', 1), {
        commit: COMMIT,
        diffTarget: 'b0b0b0b',
        files,
      }),
    ).toEqual({ kind: 'not-shown' });
  });

  it('matches a working-tree walkthrough to the working-tree view', () => {
    expect(
      placeOfStep(step('src/a.ts', 10), {
        commit: 'working',
        diffTarget: 'working',
        files,
      }),
    ).toEqual({ kind: 'shown', file: 'src/a.ts', lines: [10] });
  });
});

describe('referenceFilesOf', () => {
  const view = { commit: COMMIT, diffTarget: '3f1c9e0', files };

  it('attaches each file the diff does not have once, in the order the steps reach it', () => {
    expect(
      referenceFilesOf(
        [
          step('src/b.ts', 40),
          step('src/a.ts', 11),
          step('src/c.ts', 2),
          step('src/b.ts', 10, 12),
          step('src/gone.ts', 1),
        ],
        view,
      ).map(({ file }) => file),
    ).toEqual(['src/b.ts', 'src/c.ts']);
  });

  it('keeps every part the steps of a file need, with three lines around each', () => {
    expect(
      referenceFilesOf([step('src/b.ts', 40), step('src/b.ts', 10, 12)], view)[0]?.parts,
    ).toEqual([
      { start: 7, end: 15 },
      { start: 37, end: 43 },
    ]);
  });

  it('joins parts that touch or overlap and never starts before line 1', () => {
    expect(
      referenceFilesOf([step('src/b.ts', 2), step('src/b.ts', 9), step('src/b.ts', 12)], view)[0]
        ?.parts,
    ).toEqual([{ start: 1, end: 15 }]);
  });

  it('attaches nothing on a view of another commit', () => {
    expect(
      referenceFilesOf([step('src/b.ts', 40)], {
        ...view,
        diffTarget: 'b0b0b0b',
      }),
    ).toEqual([]);
  });
});
