import { describe, expect, it } from 'vitest';

import type { DiffChunk, DiffFile, DiffLine, WalkthroughStep } from '../../types/diff';

import { LINE_LINK_MAX_LINES } from './diffLineLinks';
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
  {
    path: 'src/new.ts',
    status: 'added',
    additions: 2,
    deletions: 0,
    chunks: [
      {
        header: '@@ -0,0 +1,2 @@',
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        lines: [line('add', undefined, 1), line('add', undefined, 2)],
      },
    ],
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
    ['a folded line above the change', step('src/a.ts', 3), { kind: 'folded', lines: [3] }],
    ['a folded line below the change', step('src/a.ts', 20), { kind: 'folded', lines: [20] }],
    ['a range half folded', step('src/a.ts', 12, 15), { kind: 'folded', lines: [12, 13, 14, 15] }],
    ['a file the diff does not have', step('src/other.ts', 1), { kind: 'not-shown' }],
    ['a file the diff deleted', step('src/gone.ts', 1), { kind: 'not-shown' }],
    ['a line past the end of an added file', step('src/new.ts', 3), { kind: 'not-shown' }],
  ])('places %s', (_, given, expected) => {
    expect(placeOfStep(given, { commit: COMMIT, diffTarget: '3f1c9e0', files })).toEqual(
      expected.kind === 'not-shown' ? expected : { ...expected, file: given.file },
    );
  });

  it('places a folded line between two changes', () => {
    const twoChanges: DiffFile = {
      ...files[0]!,
      chunks: [
        { ...files[0]!.chunks[0]! },
        {
          header: '@@ -30,1 +30,1 @@',
          oldStart: 30,
          oldLines: 1,
          newStart: 30,
          newLines: 1,
          lines: [line('context', 30, 30)],
        },
      ],
    };
    expect(
      placeOfStep(step('src/a.ts', 20), {
        commit: COMMIT,
        diffTarget: '3f1c9e0',
        files: [twoChanges],
      }),
    ).toEqual({ kind: 'folded', file: 'src/a.ts', lines: [20] });
  });

  it('places lines the reviewer opened as shown', () => {
    const opened: DiffFile = {
      ...files[0]!,
      chunks: [
        {
          ...files[0]!.chunks[0]!,
          oldStart: 2,
          oldLines: 12,
          newStart: 2,
          newLines: 12,
          lines: [
            ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => line('context', n, n)),
            ...files[0]!.chunks[0]!.lines,
          ],
        },
      ],
    };
    expect(
      placeOfStep(step('src/a.ts', 3), { commit: COMMIT, diffTarget: '3f1c9e0', files: [opened] }),
    ).toEqual({ kind: 'shown', file: 'src/a.ts', lines: [3] });
  });

  describe('once the length of the file is known', () => {
    // The last chunk of an opened file says how many lines it hides below; src/a.ts then ends at 15.
    const known = (hiddenLinesAfter: number): DiffFile[] => [
      { ...files[0]!, chunks: [{ ...files[0]!.chunks[0]!, hiddenLinesAfter } as DiffChunk] },
    ];

    it.each([
      ['a folded line before the end', step('src/a.ts', 15), 2, { kind: 'folded', lines: [15] }],
      ['a line past the end', step('src/a.ts', 16), 2, { kind: 'not-shown' }],
      [
        'a range running past the end',
        step('src/a.ts', 12, 20),
        2,
        { kind: 'folded', lines: [12, 13, 14, 15] },
      ],
    ])('places %s', (_, given, hiddenLinesAfter, expected) => {
      expect(
        placeOfStep(given, {
          commit: COMMIT,
          diffTarget: '3f1c9e0',
          files: known(hiddenLinesAfter),
        }),
      ).toEqual(expected.kind === 'not-shown' ? expected : { ...expected, file: given.file });
    });

    it('places a range that runs far past the end of the file without walking every number', () => {
      expect(
        placeOfStep(step('src/a.ts', 12, 2 ** 40), {
          commit: COMMIT,
          diffTarget: '3f1c9e0',
          files: known(0),
        }),
      ).toEqual({ kind: 'shown', file: 'src/a.ts', lines: [12, 13] });
    }, 1000);
  });

  it('opens at most as many folded lines as a line link does', () => {
    const place = placeOfStep(step('src/a.ts', 12, 2 ** 40), {
      commit: COMMIT,
      diffTarget: '3f1c9e0',
      files,
    });
    expect(place).toMatchObject({ kind: 'folded', file: 'src/a.ts' });
    expect(place.kind === 'folded' && place.lines.length).toBe(LINE_LINK_MAX_LINES);
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
