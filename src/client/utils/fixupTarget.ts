import type { DiffSelection, DiffSide, LineNumber, SidedLine } from '../../types/diff';

import { rangeOfLine } from './directEdit';

const rangeParams = (line: LineNumber) => {
  const { start, end } = rangeOfLine(line);
  return { start: String(start), end: String(end) };
};

export async function fetchFixupTarget(
  view: DiffSelection,
  filePath: string,
  line: LineNumber | undefined,
  side: DiffSide,
  extraLines: readonly SidedLine[] = [],
): Promise<string | undefined> {
  const lines = line === undefined ? { scope: 'file' } : rangeParams(line);
  const params = new URLSearchParams({
    base: view.baseCommitish,
    target: view.targetCommitish,
    path: filePath,
    side,
    ...lines,
  });
  for (const extra of extraLines) {
    const { start, end } = rangeOfLine(extra.line);
    params.append('range', `${extra.side === side ? '' : `${extra.side}:`}${start}-${end}`);
  }
  try {
    const response = await fetch(`/api/fixup-target?${params.toString()}`);
    if (!response.ok) return undefined;
    const body = (await response.json()) as { fixupTarget?: unknown };
    return typeof body.fixupTarget === 'string' ? body.fixupTarget : undefined;
  } catch {
    return undefined;
  }
}
