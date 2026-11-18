import { describe, expect, it } from 'vitest';

import type { DiffFile, DiffLine, WalkthroughStep } from '../../types/diff';

import { placeOfStep } from './walkthroughStep';

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
  { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 3, chunks: [] },
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
    ['a file the diff does not have', step('src/other.ts', 1), { kind: 'not-shown' }],
    ['a file the diff deleted', step('src/gone.ts', 1), { kind: 'not-shown' }],
  ])('places %s', (_, given, expected) => {
    expect(placeOfStep(given, { commit: COMMIT, diffTarget: '3f1c9e0', files })).toEqual(
      expected.kind === 'shown' ? { ...expected, file: given.file } : expected,
    );
  });

  it('places a range that runs far past the end of the file without walking every number', () => {
    expect(
      placeOfStep(step('src/a.ts', 12, 2 ** 40), { commit: COMMIT, diffTarget: '3f1c9e0', files }),
    ).toEqual({ kind: 'shown', file: 'src/a.ts', lines: [12, 13] });
  }, 1000);

  it('shows nothing on a view of another commit, whose lines are numbered differently', () => {
    expect(
      placeOfStep(step('src/a.ts', 11), { commit: COMMIT, diffTarget: 'b0b0b0b', files }),
    ).toEqual({ kind: 'not-shown' });
  });

  it('matches a working-tree walkthrough to the working-tree view', () => {
    expect(
      placeOfStep(step('src/a.ts', 10), { commit: 'working', diffTarget: 'working', files }),
    ).toEqual({ kind: 'shown', file: 'src/a.ts', lines: [10] });
  });
});
