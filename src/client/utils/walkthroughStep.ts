import type { DiffFile, WalkthroughStep } from '../../types/diff';
import { isSameCommit } from '../../utils/diffSelection';
import { rangesAroundNewLines } from '../hooks/useExpandedLines';

import { LINE_LINK_MAX_LINES, linesOf } from './diffLineLinks';

export type StepPlace =
  | { kind: 'shown'; file: string; lines: number[] }
  // Some of `lines` are hidden between the changes and show once opened.
  | { kind: 'folded'; file: string; lines: number[] }
  | { kind: 'not-shown' };

interface StepView {
  // The review target the walkthrough was uploaded on, whose lines its steps name.
  commit: string;
  diffTarget: string | undefined;
  // With the lines opened so far merged in; an opened file's last chunk counts the lines it hides below.
  files: readonly DiffFile[];
}

function lastLineOf(file: DiffFile): number {
  const last = file.chunks.at(-1);
  if (!last || !('hiddenLinesAfter' in last) || typeof last.hiddenLinesAfter !== 'number') {
    return Number.POSITIVE_INFINITY;
  }
  return last.hiddenLinesAfter < 0
    ? Number.POSITIVE_INFINITY
    : last.newStart + last.newLines - 1 + last.hiddenLinesAfter;
}

export function placeOfStep(step: WalkthroughStep, view: StepView): StepPlace {
  if (view.diffTarget === undefined || !isSameCommit(view.commit, view.diffTarget)) {
    return { kind: 'not-shown' };
  }
  const file = view.files.find(({ path, status }) => path === step.file && status !== 'deleted');
  if (!file) return { kind: 'not-shown' };
  const end = step.endLine ?? step.line;
  const shown = [
    ...new Set(
      file.chunks.flatMap((chunk) => chunk.lines.flatMap((line) => line.newLineNumber ?? [])),
    ),
  ]
    .filter((line) => line >= step.line && line <= end)
    .sort((left, right) => left - right);
  const isShown = new Set(shown);
  const folded = linesOf(
    { file: file.path, line: step.line, endLine: Math.min(end, lastLineOf(file)) },
    LINE_LINK_MAX_LINES,
  ).filter((line) => !isShown.has(line) && rangesAroundNewLines(file, [line], 0).length > 0);
  if (folded.length > 0) {
    return {
      kind: 'folded',
      file: file.path,
      lines: [...shown, ...folded].sort((left, right) => left - right),
    };
  }
  return shown.length === 0
    ? { kind: 'not-shown' }
    : { kind: 'shown', file: file.path, lines: shown };
}
