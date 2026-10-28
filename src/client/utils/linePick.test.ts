import { describe, expect, it } from 'vitest';

import type { CommentThread } from '../../types/diff';

import {
  extendTo,
  extraRangeEndsAt,
  type LinePick,
  pickLines,
  type PickChange,
  rangesOfPick,
  threadHoldsLine,
  toggleLine,
} from './linePick';

const at = (lineNumber: number, side: 'old' | 'new' = 'new') => ({ side, lineNumber });
const picked = (change: PickChange): LinePick | null => {
  if ('mixedSides' in change) throw new Error('mixed sides');
  return change.pick;
};
const rangesAfter = (change: PickChange) => {
  const pick = picked(change);
  return pick ? rangesOfPick(pick) : null;
};
// Lines on the screen: 10-15, 36-41 and 72-82, with hidden lines between.
const SHOWN = [
  ...Array.from({ length: 6 }, (_, i) => 10 + i),
  ...Array.from({ length: 6 }, (_, i) => 36 + i),
  ...Array.from({ length: 11 }, (_, i) => 72 + i),
];

describe('picking separate lines for one comment', () => {
  it('starts with the clicked line, and with the line clicked before it when there is one', () => {
    expect(rangesAfter(toggleLine(null, at(40)))).toEqual([40]);
    expect(rangesAfter(toggleLine(null, at(40), at(12)))).toEqual([12, 40]);
    expect(rangesAfter(toggleLine(null, at(40), at(12, 'old')))).toEqual([40]);
  });

  it('adds lines one at a time and joins neighbours into one range', () => {
    let pick = picked(toggleLine(null, at(40), at(12)));
    pick = picked(toggleLine(pick, at(77)));
    pick = picked(toggleLine(pick, at(78)));

    expect(rangesOfPick(pick!)).toEqual([12, 40, [77, 78]]);
  });

  it('takes a picked line out again, splitting the range it was in', () => {
    const pick = pickLines('new', [77, 80]);

    expect(rangesAfter(toggleLine(pick, at(78)))).toEqual([77, [79, 80]]);
    expect(rangesAfter(toggleLine(pickLines('new', 12), at(12)))).toBeNull();
  });

  it('grows the range added last with Shift and keeps the others', () => {
    let pick = picked(toggleLine(null, at(40), at(12)));
    pick = picked(toggleLine(pick, at(77)));
    pick = picked(extendTo(pick, at(12), at(80), SHOWN));

    expect(rangesOfPick(pick!)).toEqual([12, 40, [77, 80]]);
    expect(rangesAfter(extendTo(pick, at(12), at(79), SHOWN))).toEqual([12, 40, [77, 79]]);
  });

  it('keeps a line added with Ctrl when a Shift range covered it and then shrank', () => {
    let pick = picked(toggleLine(null, at(38)));
    pick = picked(toggleLine(pick, at(40)));
    pick = picked(extendTo(pick, null, at(36), SHOWN));
    expect(rangesOfPick(pick!)).toEqual([[36, 40]]);

    expect(rangesAfter(extendTo(pick, null, at(41), SHOWN))).toEqual([38, [40, 41]]);
  });

  it('leaves lines hidden between two parts of the diff out of a Shift range', () => {
    const pick = picked(toggleLine(null, at(12)));

    expect(rangesAfter(extendTo(pick, null, at(38), SHOWN))).toEqual([
      [12, 15],
      [36, 38],
    ]);
  });

  it('picks one range from the line clicked before when nothing was added one at a time', () => {
    expect(rangesAfter(extendTo(null, at(10), at(12), SHOWN))).toEqual([[10, 12]]);
    expect(rangesAfter(extendTo(pickLines('new', [77, 80]), at(10), at(12), SHOWN))).toEqual([
      [10, 12],
    ]);
    expect(rangesAfter(extendTo(null, null, at(12), SHOWN))).toEqual([12]);
  });

  it('refuses a deleted line next to kept lines, and the other way round', () => {
    const pick = picked(toggleLine(null, at(12)));

    expect(toggleLine(pick, at(12, 'old'))).toEqual({ mixedSides: true });
    expect(extendTo(pick, at(12), at(14, 'old'), SHOWN)).toEqual({ mixedSides: true });
  });
});

describe('the lines of a saved thread', () => {
  const thread: Pick<CommentThread, 'line' | 'extraLines' | 'side'> = {
    line: [77, 80],
    extraLines: [
      { side: 'new', line: 12 },
      { side: 'new', line: [40, 41] },
    ],
    side: 'new',
  };

  it('holds every line of every range on its own side', () => {
    expect([12, 40, 41, 77, 80].every((line) => threadHoldsLine(thread, 'new', line))).toBe(true);
    expect(threadHoldsLine(thread, 'new', 13)).toBe(false);
    expect(threadHoldsLine(thread, 'old', 12)).toBe(false);
  });

  it('marks the last line of each range other than the one its card is under', () => {
    expect([12, 41].every((line) => extraRangeEndsAt(thread, 'new', line))).toBe(true);
    expect(extraRangeEndsAt(thread, 'new', 40)).toBe(false);
    expect(extraRangeEndsAt(thread, 'new', 80)).toBe(false);
  });

  it('matches a range on the other side by its own side', () => {
    const mixed = {
      ...thread,
      extraLines: [{ side: 'old' as const, line: [12, 14] as [number, number] }],
    };
    expect(threadHoldsLine(mixed, 'old', 13)).toBe(true);
    expect(threadHoldsLine(mixed, 'new', 13)).toBe(false);
    expect(extraRangeEndsAt(mixed, 'old', 14)).toBe(true);
    expect(extraRangeEndsAt(mixed, 'new', 14)).toBe(false);
  });
});
