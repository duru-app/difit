import type { DiffSide, FixupLines, LineNumber, SidedLine, ThreadFixup } from '../../types/diff';
import { endOfLine, startOfLine } from '../../utils/commentPosition';
import { currentFixupSha } from '../../utils/fixupLines';

import { fixupFileElementId } from './domUtils';
import { rangeLabel, SIDE_NAMES } from './linePick';

// A deleted line is keyed on the old side and every other line on the new one, as the card numbers them.
export const fixupLineElementId = (fixupSha: string, path: string, side: DiffSide, line: number) =>
  `${fixupFileElementId(fixupSha, path)}-${side}-${line}`;

export function fixupLinesLabel({
  fixupSha,
  filePath,
  ranges,
}: Pick<FixupLines, 'fixupSha' | 'filePath'> & { ranges: readonly SidedLine[] }): string {
  const sides = (['old', 'new'] as const).flatMap((side) => {
    const lines = ranges
      .filter((range) => range.side === side)
      .sort((a, b) => startOfLine(a.line) - startOfLine(b.line))
      .map(({ line }) => rangeLabel(line));
    return lines.length > 0 ? [`${SIDE_NAMES[side]} ${lines.join(', ')}`] : [];
  });
  return [fixupSha.slice(0, 7), filePath.split('/').at(-1) ?? filePath, ...sides].join(' · ');
}

const numbersOf = (line: LineNumber) =>
  Array.from({ length: endOfLine(line) - startOfLine(line) + 1 }, (_, i) => startOfLine(line) + i);

// A rebase rewrites the fixup's sha but keeps its patch id.
export function fixupLinesPlace(
  { fixupSha, patchId, filePath, ranges }: FixupLines,
  fixupsByThread: ReadonlyMap<string, readonly ThreadFixup[]>,
): { fixupSha: string; path: string; elementIds: string[] } {
  const fixups = [...fixupsByThread.values()].flat();
  const sha = currentFixupSha({ fixupSha, patchId }, fixups);
  return {
    fixupSha: sha,
    path: filePath,
    elementIds: ranges.flatMap(({ side, line }) =>
      numbersOf(line).map((number) => fixupLineElementId(sha, filePath, side, number)),
    ),
  };
}
