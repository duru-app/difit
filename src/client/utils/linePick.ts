import type {
  CommentThread,
  DiffSide,
  LineNumber,
  LineSelection,
  SidedLine,
} from '../../types/diff';

// The lines a comment being written sits on, all on one side.
export interface LinePick {
  side: DiffSide;
  // Ascending, each once.
  lines: readonly number[];
  // Where Shift+click grows from.
  anchor: number;
  // What the last Shift+click added; the next one replaces it.
  span: readonly number[];
  // Lines were added one at a time, so Shift+click keeps the others.
  adding: boolean;
}

export type PickChange = { pick: LinePick | null } | { mixedSides: true };

const between = (from: number, to: number, shown: readonly number[]) => {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  return [...new Set([from, to, ...shown.filter((line) => line >= low && line <= high)])].sort(
    (a, b) => a - b,
  );
};

const union = (a: readonly number[], b: readonly number[]) =>
  [...new Set([...a, ...b])].sort((x, y) => x - y);

const sameLines = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((line, index) => line === b[index]);

export function pickLines(side: DiffSide, line: LineNumber): LinePick {
  const [start, end] = Array.isArray(line) ? line : [line, line];
  const lines = Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
  return { side, lines, anchor: start, span: lines, adding: false };
}

// Ctrl/Cmd+click: adds the line, or takes it out, splitting the range it was in. With nothing
// picked yet, `seed` (the line clicked just before) is picked along with it.
export function toggleLine(
  pick: LinePick | null,
  { side, lineNumber }: LineSelection,
  seed?: LineSelection,
): PickChange {
  if (!pick) {
    const lines =
      seed && seed.side === side && seed.lineNumber !== lineNumber
        ? union([seed.lineNumber], [lineNumber])
        : [lineNumber];
    return { pick: { side, lines, anchor: lineNumber, span: [], adding: true } };
  }
  if (pick.side !== side) return { mixedSides: true };
  if (!pick.lines.includes(lineNumber)) {
    return {
      pick: {
        ...pick,
        lines: union(pick.lines, [lineNumber]),
        anchor: lineNumber,
        span: [],
        adding: true,
      },
    };
  }
  const lines = pick.lines.filter((line) => line !== lineNumber);
  const last = lines.at(-1);
  if (last === undefined) return { pick: null };
  return {
    pick: {
      ...pick,
      lines,
      anchor: lines.includes(pick.anchor) ? pick.anchor : last,
      span: [],
      adding: true,
    },
  };
}

// Shift+click: while lines are being added one at a time, grows the range added last; otherwise
// picks the lines from `anchor`, the line clicked before, as one range. `shown` are the line
// numbers on the screen on that side, so lines hidden between two parts of the diff stay out.
export function extendTo(
  pick: LinePick | null,
  anchor: LineSelection | null,
  { side, lineNumber }: LineSelection,
  shown: readonly number[],
): PickChange {
  if (pick?.adding) {
    if (pick.side !== side) return { mixedSides: true };
    const kept = pick.lines.filter((line) => !pick.span.includes(line));
    const span = between(pick.anchor, lineNumber, shown).filter((line) => !kept.includes(line));
    return { pick: { ...pick, lines: union(kept, span), span } };
  }
  if (!anchor || anchor.side !== side) {
    return { pick: pickLines(side, lineNumber) };
  }
  const lines = between(anchor.lineNumber, lineNumber, shown);
  if (pick && pick.side === side && sameLines(pick.lines, lines)) return { pick: null };
  return { pick: { side, lines, anchor: anchor.lineNumber, span: lines, adding: false } };
}

export function rangesOfPick({ lines }: Pick<LinePick, 'lines'>): LineNumber[] {
  const ranges: LineNumber[] = [];
  let start: number | undefined;
  lines.forEach((line, index) => {
    start ??= line;
    const next = lines[index + 1];
    if (next === line + 1) return;
    ranges.push(start === line ? line : [start, line]);
    start = undefined;
  });
  return ranges;
}

export const pickHolds = (pick: LinePick | null, side: DiffSide, lineNumber: number | undefined) =>
  !!pick && pick.side === side && lineNumber !== undefined && pick.lines.includes(lineNumber);

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

export function extraRangeEndsAt(
  thread: ThreadLines,
  side: DiffSide,
  lineNumber: number | undefined,
): boolean {
  if (lineNumber === undefined) return false;
  return (thread.extraLines ?? []).some(
    (range) => range.side === side && spanOf(range.line)[1] === lineNumber,
  );
}

export const rangeLabel = (line: LineNumber) =>
  Array.isArray(line) ? `L${line[0]}-L${line[1]}` : `L${line}`;
