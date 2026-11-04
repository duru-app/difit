import type {
  CommentThread,
  DiffLine,
  DiffSide,
  LineNumber,
  LineSelection,
  SidedLine,
} from '../../types/diff';

// The lines a comment being written sits on, on either side.
export interface LinePick {
  // Each once, the old side's first, each side ascending.
  lines: readonly LineSelection[];
  // Where Shift+click grows from.
  anchor: LineSelection;
  // What the last Shift+click added; the next one replaces it.
  span: readonly LineSelection[];
  // Lines were added one at a time, so Shift+click keeps the others.
  adding: boolean;
}

export type PickLayout = 'unified' | 'split';

interface PickRow {
  old?: number;
  new?: number;
  unchanged: boolean;
}

// The rows of a file's diff as one layout draws them, top to bottom.
export interface PickRows {
  layout: PickLayout;
  rows: readonly PickRow[];
  rowOf: ReadonlyMap<string, number>;
}

const keyOf = ({ side, lineNumber }: LineSelection) => `${side}:${lineNumber}`;

const sameSelection = (a: LineSelection, b: LineSelection) =>
  a.side === b.side && a.lineNumber === b.lineNumber;

const has = (lines: readonly LineSelection[], line: LineSelection) =>
  lines.some((picked) => sameSelection(picked, line));

const inPickOrder = (a: LineSelection, b: LineSelection) =>
  a.side === b.side ? a.lineNumber - b.lineNumber : a.side === 'old' ? -1 : 1;

const union = (a: readonly LineSelection[], b: readonly LineSelection[]) =>
  [...a, ...b.filter((line) => !has(a, line))].sort(inPickOrder);

const sameLines = (a: readonly LineSelection[], b: readonly LineSelection[]) =>
  a.length === b.length && a.every((line) => has(b, line));

function splitRows(lines: readonly DiffLine[]): PickRow[] {
  const rows: PickRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index++;
    if (!line) continue;
    if (line.type !== 'delete') {
      rows.push({
        old: line.oldLineNumber,
        new: line.newLineNumber,
        unchanged: line.type === 'normal',
      });
      continue;
    }
    const deleted = [line];
    const added: DiffLine[] = [];
    for (let next = lines[index]; next?.type === 'delete'; next = lines[++index])
      deleted.push(next);
    for (let next = lines[index]; next?.type === 'add'; next = lines[++index]) added.push(next);
    for (let k = 0; k < Math.max(deleted.length, added.length); k++) {
      rows.push({
        old: deleted[k]?.oldLineNumber,
        new: added[k]?.newLineNumber,
        unchanged: false,
      });
    }
  }
  return rows;
}

export function pickRows(lines: readonly DiffLine[], layout: PickLayout): PickRows {
  const rows =
    layout === 'split'
      ? splitRows(lines)
      : lines.map((line) => ({
          old: line.oldLineNumber,
          new: line.newLineNumber,
          unchanged: line.type === 'normal',
        }));
  const rowOf = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.old !== undefined) rowOf.set(keyOf({ side: 'old', lineNumber: row.old }), index);
    if (row.new !== undefined) rowOf.set(keyOf({ side: 'new', lineNumber: row.new }), index);
  });
  return { layout, rows, rowOf };
}

const unifiedLineOf = (row: PickRow): LineSelection | undefined => {
  if (row.new !== undefined) return { side: 'new', lineNumber: row.new };
  return row.old === undefined ? undefined : { side: 'old', lineNumber: row.old };
};

// Every line on the rows from one line to the other, both included. The split view takes the
// column of the two lines, or both columns when they sit in different ones.
export function linesBetween(
  { layout, rows, rowOf }: PickRows,
  from: LineSelection,
  to: LineSelection,
): LineSelection[] {
  const fromRow = rowOf.get(keyOf(from));
  const toRow = rowOf.get(keyOf(to));
  if (fromRow === undefined || toRow === undefined) return union([from], [to]);
  const lines: LineSelection[] = [];
  for (const row of rows.slice(Math.min(fromRow, toRow), Math.max(fromRow, toRow) + 1)) {
    if (layout === 'unified') {
      const line = unifiedLineOf(row);
      if (line) lines.push(line);
      continue;
    }
    if (row.old !== undefined && (from.side === 'old' || to.side === 'old')) {
      lines.push({ side: 'old', lineNumber: row.old });
    }
    if (row.new !== undefined && (from.side === 'new' || to.side === 'new')) {
      lines.push({ side: 'new', lineNumber: row.new });
    }
  }
  return union(lines, [from, to]);
}

export function pickLines(side: DiffSide, line: LineNumber): LinePick {
  const [start, end] = Array.isArray(line) ? line : [line, line];
  const lines = Array.from({ length: end - start + 1 }, (_, offset) => ({
    side,
    lineNumber: start + offset,
  }));
  return { lines, anchor: { side, lineNumber: start }, span: lines, adding: false };
}

// Ctrl/Cmd+click: adds the line, or takes it out, splitting the range it was in. With nothing
// picked yet, `seed` (the line clicked just before) is picked along with it.
export function toggleLine(
  pick: LinePick | null,
  selection: LineSelection,
  seed?: LineSelection,
): LinePick | null {
  if (!pick) {
    const lines = seed ? union([seed], [selection]) : [selection];
    return { lines, anchor: selection, span: [], adding: true };
  }
  if (!has(pick.lines, selection)) {
    return {
      ...pick,
      lines: union(pick.lines, [selection]),
      anchor: selection,
      span: [],
      adding: true,
    };
  }
  const lines = pick.lines.filter((line) => !sameSelection(line, selection));
  const last = lines.at(-1);
  if (last === undefined) return null;
  return {
    ...pick,
    lines,
    anchor: has(lines, pick.anchor) ? pick.anchor : last,
    span: [],
    adding: true,
  };
}

// Shift+click: while lines are being added one at a time, grows the range added last; otherwise
// picks the lines from `anchor`, the line clicked before, as one range. Lines hidden between two
// parts of the diff stay out.
export function extendTo(
  pick: LinePick | null,
  anchor: LineSelection | null,
  selection: LineSelection,
  rows: PickRows,
): LinePick | null {
  if (pick?.adding) {
    const kept = pick.lines.filter((line) => !has(pick.span, line));
    const span = linesBetween(rows, pick.anchor, selection).filter((line) => !has(kept, line));
    return { ...pick, lines: union(kept, span), span };
  }
  if (!anchor) return pickLines(selection.side, selection.lineNumber);
  const lines = linesBetween(rows, anchor, selection);
  if (pick && sameLines(pick.lines, lines)) return null;
  return { lines, anchor, span: lines, adding: false };
}

export const samePickLines = (a: LinePick | null, b: LinePick) =>
  !!a && sameLines(a.lines, b.lines);

// The picked lines as ranges in the order of the rows, the one the card goes under last. An
// unchanged line picked on both sides counts once, on the new side.
export function rangesOfPick({ lines }: Pick<LinePick, 'lines'>, rows: PickRows): SidedLine[] {
  const kept = lines.filter((line) => {
    if (line.side !== 'old') return true;
    const row = rows.rows[rows.rowOf.get(keyOf(line)) ?? -1];
    return !(
      row?.unchanged &&
      row.new !== undefined &&
      has(lines, { side: 'new', lineNumber: row.new })
    );
  });
  const ranges: SidedLine[] = [];
  for (const side of ['old', 'new'] as const) {
    const numbers = kept
      .filter((line) => line.side === side)
      .map(({ lineNumber }) => lineNumber)
      .sort((a, b) => a - b);
    let start: number | undefined;
    numbers.forEach((lineNumber, index) => {
      start ??= lineNumber;
      if (numbers[index + 1] === lineNumber + 1) return;
      ranges.push({ side, line: start === lineNumber ? lineNumber : [start, lineNumber] });
      start = undefined;
    });
  }
  return inRowOrder(ranges, rows);
}

const bottomRowOf = (rows: PickRows, { side, line }: SidedLine) =>
  rows.rowOf.get(keyOf({ side, lineNumber: spanOf(line)[1] })) ?? -1;

// Ascending by the row each range ends on, the old side first on one row; ranges off the screen go
// first, in the order given.
function inRowOrder(ranges: readonly SidedLine[], rows: PickRows): SidedLine[] {
  const bottomOf = (range: SidedLine) => bottomRowOf(rows, range);
  const sideOrder = (a: SidedLine, b: SidedLine) =>
    a.side === b.side || bottomOf(a) < 0 ? 0 : a.side === 'old' ? -1 : 1;
  return [...ranges].sort((a, b) => bottomOf(a) - bottomOf(b) || sideOrder(a, b));
}

export const pickHolds = (pick: LinePick | null, side: DiffSide, lineNumber: number | undefined) =>
  !!pick && lineNumber !== undefined && has(pick.lines, { side, lineNumber });

const spanOf = (line: LineNumber): [number, number] => (Array.isArray(line) ? line : [line, line]);

type ThreadLines = Pick<CommentThread, 'line' | 'extraLines' | 'side'>;

const sidedLinesOf = ({ line, extraLines, side }: ThreadLines): SidedLine[] =>
  line === undefined ? [] : [...(extraLines ?? []), { side: side ?? 'new', line }];

export function threadHoldsLine(
  thread: ThreadLines,
  side: DiffSide,
  lineNumber: number | undefined,
): boolean {
  if (lineNumber === undefined) return false;
  return sidedLinesOf(thread).some((range) => {
    const [start, end] = spanOf(range.line);
    return range.side === side && lineNumber >= start && lineNumber <= end;
  });
}

// On this layout a thread's card goes under the range that ends lowest, and its other ranges get
// markers, apart from those ending on the card's row.
export function placeCard(
  thread: ThreadLines,
  rows: PickRows,
): { card: SidedLine; others: SidedLine[] } | null {
  const ordered = inRowOrder(sidedLinesOf(thread), rows);
  const card = ordered.pop();
  if (!card) return null;
  const cardRow = bottomRowOf(rows, card);
  const others = ordered.filter((range) => cardRow < 0 || bottomRowOf(rows, range) !== cardRow);
  return { card, others };
}

export const endsOnRow = (
  ranges: readonly SidedLine[],
  { oldLineNumber, newLineNumber }: { oldLineNumber?: number; newLineNumber?: number },
) =>
  ranges.some(
    ({ side, line }) => spanOf(line)[1] === (side === 'old' ? oldLineNumber : newLineNumber),
  );

export const rangeLabel = (line: LineNumber) => {
  if (!Array.isArray(line)) return `L${line}`;
  const [start, end] = line;
  return start === end ? `L${start}` : `L${start}-L${end}`;
};
