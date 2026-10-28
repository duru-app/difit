import { describe, expect, it } from 'vitest';

import type { CommentThread, DiffLine } from '../../types/diff';

import {
  endsOnRow,
  extendTo,
  type LinePick,
  pickLines,
  placeCard,
  pickRows,
  type PickRows,
  rangesOfPick,
  threadHoldsLine,
  toggleLine,
} from './linePick';

const at = (lineNumber: number, side: 'old' | 'new' = 'new') => ({ side, lineNumber });
const normal = (oldLineNumber: number, newLineNumber = oldLineNumber): DiffLine => ({
  type: 'normal',
  content: '',
  oldLineNumber,
  newLineNumber,
});
const deleted = (oldLineNumber: number): DiffLine => ({
  type: 'delete',
  content: '',
  oldLineNumber,
});
const added = (newLineNumber: number): DiffLine => ({ type: 'add', content: '', newLineNumber });

// Lines on the screen: 10-15, 36-41 and 72-82, with hidden lines between.
const ROWS = pickRows(
  [
    ...Array.from({ length: 6 }, (_, i) => 10 + i),
    ...Array.from({ length: 6 }, (_, i) => 36 + i),
    ...Array.from({ length: 11 }, (_, i) => 72 + i),
  ].map((line) => normal(line)),
  'unified',
);
const rangesAfter = (pick: LinePick | null, rows: PickRows = ROWS) =>
  pick
    ? rangesOfPick(pick, rows).map(({ side, line }) => (side === 'new' ? line : { old: line }))
    : null;

describe('picking separate lines for one comment', () => {
  it('starts with the clicked line, and with the line clicked before it when there is one', () => {
    expect(rangesAfter(toggleLine(null, at(40)))).toEqual([40]);
    expect(rangesAfter(toggleLine(null, at(40), at(12)))).toEqual([12, 40]);
    expect(rangesAfter(toggleLine(null, at(40), at(12, 'old')))).toEqual([{ old: 12 }, 40]);
  });

  it('adds lines one at a time and joins neighbours into one range', () => {
    let pick = toggleLine(null, at(40), at(12));
    pick = toggleLine(pick, at(77));
    pick = toggleLine(pick, at(78));

    expect(rangesAfter(pick)).toEqual([12, 40, [77, 78]]);
  });

  it('takes a picked line out again, splitting the range it was in', () => {
    const pick = pickLines('new', [77, 80]);

    expect(rangesAfter(toggleLine(pick, at(78)))).toEqual([77, [79, 80]]);
    expect(rangesAfter(toggleLine(pickLines('new', 12), at(12)))).toBeNull();
  });

  it('grows the range added last with Shift and keeps the others', () => {
    let pick = toggleLine(null, at(40), at(12));
    pick = toggleLine(pick, at(77));
    pick = extendTo(pick, at(12), at(80), ROWS);

    expect(rangesAfter(pick)).toEqual([12, 40, [77, 80]]);
    expect(rangesAfter(extendTo(pick, at(12), at(79), ROWS))).toEqual([12, 40, [77, 79]]);
  });

  it('keeps a line added with Ctrl when a Shift range covered it and then shrank', () => {
    let pick = toggleLine(null, at(38));
    pick = toggleLine(pick, at(40));
    pick = extendTo(pick, null, at(36), ROWS);
    expect(rangesAfter(pick)).toEqual([[36, 40]]);

    expect(rangesAfter(extendTo(pick, null, at(41), ROWS))).toEqual([38, [40, 41]]);
  });

  it('leaves lines hidden between two parts of the diff out of a Shift range', () => {
    const pick = toggleLine(null, at(12));

    expect(rangesAfter(extendTo(pick, null, at(38), ROWS))).toEqual([
      [12, 15],
      [36, 38],
    ]);
  });

  it('picks one range from the line clicked before when nothing was added one at a time', () => {
    expect(rangesAfter(extendTo(null, at(10), at(12), ROWS))).toEqual([[10, 12]]);
    expect(rangesAfter(extendTo(pickLines('new', [77, 80]), at(10), at(12), ROWS))).toEqual([
      [10, 12],
    ]);
    expect(rangesAfter(extendTo(null, null, at(12), ROWS))).toEqual([12]);
  });
});

describe('picking deleted and kept lines for one comment', () => {
  const lines = [normal(9), deleted(10), deleted(11), added(10), normal(12, 11)];
  const unified = pickRows(lines, 'unified');
  const split = pickRows(lines, 'split');

  it('adds a deleted line to kept lines with Ctrl', () => {
    expect(rangesAfter(toggleLine(toggleLine(null, at(10)), at(11, 'old')), unified)).toEqual([
      { old: 11 },
      10,
    ]);
  });

  it('picks every row between the two clicks in the unified view, whichever side', () => {
    expect(rangesAfter(extendTo(null, at(10, 'old'), at(11), unified), unified)).toEqual([
      { old: [10, 11] },
      [10, 11],
    ]);
    expect(rangesAfter(extendTo(null, at(9), at(11), unified), unified)).toEqual([
      { old: [10, 11] },
      [9, 11],
    ]);
  });

  it('picks both columns between a left and a right click in the split view', () => {
    expect(rangesAfter(extendTo(null, at(10, 'old'), at(11), split), split)).toEqual([
      { old: [10, 11] },
      [10, 11],
    ]);
    expect(rangesAfter(extendTo(null, at(9, 'old'), at(11, 'old'), split), split)).toEqual([
      { old: [9, 11] },
    ]);
  });

  it('counts an unchanged line picked in both columns once, on the new side', () => {
    expect(rangesAfter(toggleLine(toggleLine(null, at(9, 'old')), at(9)), split)).toEqual([9]);
    expect(rangesAfter(toggleLine(null, at(9, 'old')), split)).toEqual([{ old: 9 }]);
  });

  it('puts the range on the bottom row last, the new side when both end on one row', () => {
    expect(rangesAfter(toggleLine(toggleLine(null, at(10)), at(10, 'old')), split)).toEqual([
      { old: 10 },
      10,
    ]);
    expect(rangesAfter(toggleLine(toggleLine(null, at(9)), at(11, 'old')), split)).toEqual([
      9,
      { old: 11 },
    ]);
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

  it('matches a range on the other side by its own side', () => {
    const mixed = {
      ...thread,
      extraLines: [{ side: 'old' as const, line: [12, 14] as [number, number] }],
    };
    expect(threadHoldsLine(mixed, 'old', 13)).toBe(true);
    expect(threadHoldsLine(mixed, 'new', 13)).toBe(false);
  });
});

describe('where a saved thread shows its card', () => {
  const lines = [normal(9), deleted(10), deleted(11), added(10), normal(12, 11)];
  const unified = pickRows(lines, 'unified');
  const split = pickRows(lines, 'split');
  const thread: Pick<CommentThread, 'line' | 'extraLines' | 'side'> = {
    line: 11,
    side: 'old',
    extraLines: [{ side: 'new', line: 10 }],
  };

  it('goes under the range that ends lowest on the layout shown', () => {
    expect(placeCard(thread, split)).toEqual({
      card: { side: 'old', line: 11 },
      others: [{ side: 'new', line: 10 }],
    });
    expect(placeCard(thread, unified)).toEqual({
      card: { side: 'new', line: 10 },
      others: [{ side: 'old', line: 11 }],
    });
  });

  it('leaves out the marker of a range ending on the row of the card', () => {
    const twoForTwo = pickRows(
      [deleted(10), deleted(11), added(10), added(11), normal(12)],
      'split',
    );
    expect(
      placeCard(
        { line: [10, 11], side: 'new', extraLines: [{ side: 'old', line: [10, 11] }] },
        twoForTwo,
      ),
    ).toEqual({ card: { side: 'new', line: [10, 11] }, others: [] });
  });

  it('keeps the stored range when no range is on the screen', () => {
    expect(placeCard(thread, pickRows([normal(40)], 'unified'))?.card).toEqual({
      side: 'old',
      line: 11,
    });
    expect(placeCard({ side: 'new' }, unified)).toBeNull();
  });

  it('marks the rows the other ranges end on', () => {
    expect(endsOnRow([{ side: 'old', line: [10, 11] }], { oldLineNumber: 11 })).toBe(true);
    expect(endsOnRow([{ side: 'old', line: [10, 11] }], { newLineNumber: 11 })).toBe(false);
  });
});
