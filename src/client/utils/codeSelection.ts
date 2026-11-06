import type { DiffSide, LineNumber } from '../../types/diff';

export interface CodeSelection {
  side: DiffSide;
  lineNumber: LineNumber;
  text: string;
}

export type CodeSelectionLayout = 'unified' | 'split';

export const codeCellAttributes = (side: DiffSide, lineNumber: number | undefined) =>
  lineNumber === undefined ? {} : { 'data-code-side': side, 'data-code-line': lineNumber };

interface SelectedCell {
  side: DiffSide;
  lineNumber: number;
  text: string;
}

function textInCell(range: Range, cell: Element): string {
  const part = cell.ownerDocument.createRange();
  part.selectNodeContents(cell);
  const prefix = cell.querySelector('[data-diff-prefix]');
  if (prefix) part.setStartAfter(prefix);
  if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) {
    part.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) {
    part.setEnd(range.endContainer, range.endOffset);
  }
  return part.toString();
}

function trimEmptyEnds(cells: SelectedCell[]): SelectedCell[] {
  const first = cells.findIndex((cell) => cell.text !== '');
  if (first === -1) return [];
  let last = cells.length - 1;
  while (cells[last]?.text === '') last--;
  return cells.slice(first, last + 1);
}

function sideOfCellAt(node: Node, container: Element) {
  const element = node instanceof Element ? node : node.parentElement;
  const cell = element?.closest<HTMLElement>('[data-code-side]');
  return cell && container.contains(cell) ? cell.dataset.codeSide : undefined;
}

// A deleted line of a unified selection has no new line number, so a count of hidden lines goes
// above the deleted lines that follow them.
function textWithHiddenLineCounts(cells: SelectedCell[], side: DiffSide): string {
  const parts: string[] = [];
  let previousLine: number | undefined;
  let afterPreviousLine = 0;
  for (const cell of cells) {
    if (cell.side !== side) {
      parts.push(cell.text);
      continue;
    }
    const hidden = previousLine === undefined ? 0 : cell.lineNumber - previousLine - 1;
    if (hidden > 0) {
      parts.splice(afterPreviousLine, 0, `… ${hidden} ${hidden === 1 ? 'line' : 'lines'}`);
    }
    parts.push(cell.text);
    previousLine = cell.lineNumber;
    afterPreviousLine = parts.length;
  }
  return parts.join('\n');
}

// A unified selection's text keeps deleted and added lines alike, and its lines are counted on the
// new side unless only deleted lines were picked. A split selection keeps to the column of the code
// cell it starts in, or else ends in, though the browser also highlights the other column of the
// rows between. Lines the selection jumps over appear in its text as a count.
export function selectionInCode(
  range: Range,
  container: Element,
  layout: CodeSelectionLayout,
): CodeSelection | null {
  if (range.collapsed || !container.contains(range.commonAncestorContainer)) return null;

  let cells: SelectedCell[] = Array.from(
    container.querySelectorAll<HTMLElement>('[data-code-line]'),
  )
    .filter((cell) => range.intersectsNode(cell))
    .map((cell) => ({
      side: cell.dataset.codeSide === 'old' ? 'old' : 'new',
      lineNumber: Number(cell.dataset.codeLine),
      text: textInCell(range, cell),
    }));

  if (layout === 'split') {
    const column =
      sideOfCellAt(range.startContainer, container) ??
      sideOfCellAt(range.endContainer, container) ??
      cells.find((cell) => cell.text !== '')?.side;
    cells = cells.filter((cell) => cell.side === column);
  }
  cells = trimEmptyEnds(cells);
  if (cells.length === 0) return null;

  if (cells.every((cell) => cell.text.trim() === '')) return null;

  const side: DiffSide = cells.some((cell) => cell.side === 'new') ? 'new' : 'old';
  const lineNumbers = cells.filter((cell) => cell.side === side).map((cell) => cell.lineNumber);
  const start = Math.min(...lineNumbers);
  const end = Math.max(...lineNumbers);
  return {
    side,
    lineNumber: start === end ? start : [start, end],
    text: textWithHiddenLineCounts(cells, side),
  };
}

export function clipToFile(range: Range, file: Element): Range | null {
  const startsInside = file.contains(range.startContainer);
  const endsInside = file.contains(range.endContainer);
  if (startsInside && endsInside) return range;
  if (!startsInside && !endsInside) return null;

  const picksOtherFile = Array.from(file.ownerDocument.querySelectorAll('[data-code-line]')).some(
    (cell) => !file.contains(cell) && range.intersectsNode(cell) && textInCell(range, cell) !== '',
  );
  if (picksOtherFile) return null;

  const clipped = range.cloneRange();
  if (startsInside) clipped.setEnd(file, file.childNodes.length);
  else clipped.setStart(file, 0);
  return clipped;
}

export function quoteSelection(text: string, body: string): string {
  const quote = text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
  return `${quote}\n\n${body}`;
}
