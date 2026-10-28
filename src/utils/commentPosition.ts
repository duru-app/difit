import type {
  DiffCommentPosition,
  DiffLineRange,
  DiffSide,
  ExtraLineRange,
  LineNumber,
  SidedLine,
} from '../types/diff.js';

export function lineOfRange(range: ExtraLineRange): LineNumber {
  return typeof range === 'number' ? range : [range.start, range.end];
}

export function rangeOfLineNumber(line: LineNumber): DiffLineRange {
  return typeof line === 'number' ? line : { start: line[0], end: line[1] };
}

export function startOfLine(line: LineNumber | ExtraLineRange): number {
  if (typeof line === 'number') return line;
  return Array.isArray(line) ? line[0] : line.start;
}

export function endOfLine(line: LineNumber | ExtraLineRange): number {
  if (typeof line === 'number') return line;
  return Array.isArray(line) ? line[1] : line.end;
}

export function sideOfRange(range: ExtraLineRange, positionSide: DiffSide): DiffSide {
  return typeof range === 'object' && 'side' in range ? range.side : positionSide;
}

export function lineOfPosition(position: DiffCommentPosition): LineNumber | undefined {
  return 'line' in position ? lineOfRange(position.line) : undefined;
}

export function rangesOfPosition(position: DiffCommentPosition): ExtraLineRange[] {
  if (!('line' in position)) return [];
  return [...(position.extraRanges ?? []), position.line];
}

export function extraLinesOfPosition(position: DiffCommentPosition): SidedLine[] | undefined {
  if (!('line' in position) || !position.extraRanges?.length) return undefined;
  return position.extraRanges.map((range) => ({
    side: sideOfRange(range, position.side),
    line: lineOfRange(range),
  }));
}

const byStart = (a: SidedLine, b: SidedLine) => startOfLine(a.line) - startOfLine(b.line);

export function inStoredOrder<T extends SidedLine>(side: DiffSide, extra: readonly T[]): T[] {
  return [
    ...extra.filter((range) => range.side === side).sort(byStart),
    ...extra.filter((range) => range.side !== side).sort(byStart),
  ];
}

function extraRangeOf(positionSide: DiffSide, { side, line }: SidedLine): ExtraLineRange {
  if (side === positionSide) return rangeOfLineNumber(line);
  return { side, start: startOfLine(line), end: endOfLine(line) };
}

// The card goes under `line`; ranges must not overlap, and those on `side` must sit above `line`.
export function positionOfLines(
  side: DiffSide,
  line: LineNumber,
  extra: readonly SidedLine[] = [],
): Extract<DiffCommentPosition, { line: DiffLineRange }> {
  const ordered = inStoredOrder(side, extra);
  return {
    side,
    line: rangeOfLineNumber(line),
    ...(ordered.length > 0
      ? { extraRanges: ordered.map((range) => extraRangeOf(side, range)) }
      : {}),
  };
}

// The ranges in the given order when they are all on one side; otherwise the old side's ranges
// and then the new side's, each group ascending and led by its side.
export function sidedRangesLabel(
  lines: readonly SidedLine[],
  span: (line: LineNumber) => string,
): string {
  if (new Set(lines.map(({ side }) => side)).size < 2) {
    return lines.map(({ line }) => span(line)).join(',');
  }
  return (['old', 'new'] as const)
    .map((side) => {
      const spans = lines
        .filter((range) => range.side === side)
        .sort(byStart)
        .map(({ line }) => span(line));
      return `${side}:${spans.join(',')}`;
    })
    .join(',');
}

export const coversBothSides = (side: DiffSide | undefined, extra?: readonly SidedLine[]) =>
  (extra ?? []).some((range) => range.side !== (side ?? 'new'));

const spanLabel = (line: LineNumber) =>
  Array.isArray(line) ? `${line[0]}-${line[1]}` : String(line);

export function locationLabel(
  file: string,
  line: LineNumber | undefined,
  extraLines?: readonly SidedLine[],
  side: DiffSide = 'new',
): string {
  if (line === undefined) return file;
  return `${file}:${sidedRangesLabel([...(extraLines ?? []), { side, line }], spanLabel)}`;
}
