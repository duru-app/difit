import { describe, expect, it } from 'vitest';

import { inStoredOrder, positionOfLines } from './commentPosition';

describe('positionOfLines', () => {
  it('writes the ranges on the side of the position as before', () => {
    expect(
      positionOfLines(
        'new',
        [77, 80],
        [
          { side: 'new', line: 40 },
          { side: 'new', line: [11, 12] },
        ],
      ),
    ).toEqual({
      side: 'new',
      line: { start: 77, end: 80 },
      extraRanges: [{ start: 11, end: 12 }, 40],
    });
    expect(positionOfLines('old', 5)).toEqual({ side: 'old', line: 5 });
  });

  it('names the side of each range on the other side and puts those last', () => {
    expect(
      positionOfLines(
        'new',
        [12, 13],
        [
          { side: 'old', line: 20 },
          { side: 'old', line: [12, 14] },
          { side: 'new', line: 3 },
        ],
      ),
    ).toEqual({
      side: 'new',
      line: { start: 12, end: 13 },
      extraRanges: [3, { side: 'old', start: 12, end: 14 }, { side: 'old', start: 20, end: 20 }],
    });
  });
});

describe('inStoredOrder', () => {
  it('keeps what rides along with each range next to it', () => {
    expect(
      inStoredOrder('new', [
        { side: 'old' as const, line: 9, content: 'old nine' },
        { side: 'new' as const, line: 4, content: 'new four' },
        { side: 'new' as const, line: 2, content: 'new two' },
      ]).map(({ content }) => content),
    ).toEqual(['new two', 'new four', 'old nine']);
  });
});
