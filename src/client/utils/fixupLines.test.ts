import { describe, expect, it } from 'vitest';

import type { FixupLines, ThreadFixup } from '../../types/diff';

import { fixupLineElementId, fixupLinesPlace, fixupLinesLabel } from './fixupLines';

const lines: FixupLines = {
  fixupSha: 'a'.repeat(40),
  patchId: 'patch-1',
  filePath: 'src/deep/order.ts',
  ranges: [
    { side: 'new', line: [42, 43], code: 'a\nb' },
    { side: 'old', line: 41, code: 'c' },
    { side: 'new', line: 50, code: 'd' },
  ],
};

const fixupWith = (sha: string, patchId: string): ThreadFixup => ({
  sha,
  shortSha: sha.slice(0, 7),
  patchId,
  authoredAt: '2026-01-01T00:00:00Z',
  subject: 'fixup! x',
  threadIds: ['t1'],
  files: [],
});

describe('fixupLinesLabel', () => {
  it('names the fixup, the file and the lines of each side, deleted ones first', () => {
    expect(fixupLinesLabel(lines)).toBe('aaaaaaa · order.ts · 지운 줄 L41 · 남은 줄 L42-L43, L50');
  });
});

describe('fixupLinesPlace', () => {
  it('finds every picked line of the fixup on the screen', () => {
    const place = fixupLinesPlace(lines, new Map([['t1', [fixupWith(lines.fixupSha, 'patch-1')]]]));

    expect(place).toEqual({
      fixupSha: lines.fixupSha,
      path: 'src/deep/order.ts',
      elementIds: [
        fixupLineElementId(lines.fixupSha, 'src/deep/order.ts', 'new', 42),
        fixupLineElementId(lines.fixupSha, 'src/deep/order.ts', 'new', 43),
        fixupLineElementId(lines.fixupSha, 'src/deep/order.ts', 'old', 41),
        fixupLineElementId(lines.fixupSha, 'src/deep/order.ts', 'new', 50),
      ],
    });
  });

  it('follows the fixup to its new commit after a rebase by its patch id', () => {
    const rebased = 'b'.repeat(40);

    const place = fixupLinesPlace(lines, new Map([['t1', [fixupWith(rebased, 'patch-1')]]]));

    expect(place.fixupSha).toBe(rebased);
    expect(place.elementIds[0]).toBe(fixupLineElementId(rebased, 'src/deep/order.ts', 'new', 42));
  });

  it('tells the two sides of one line number apart', () => {
    expect(fixupLineElementId('abc', 'a.ts', 'old', 3)).not.toBe(
      fixupLineElementId('abc', 'a.ts', 'new', 3),
    );
  });
});
