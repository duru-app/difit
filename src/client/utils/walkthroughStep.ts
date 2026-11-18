import type { DiffFile, WalkthroughStep } from '../../types/diff';
import { isSameCommit } from '../../utils/diffSelection';

export type StepPlace = { kind: 'shown'; file: string; lines: number[] } | { kind: 'not-shown' };

interface StepView {
  // The review target the walkthrough was uploaded on, whose lines its steps name.
  commit: string;
  diffTarget: string | undefined;
  files: readonly DiffFile[];
}

export function placeOfStep(step: WalkthroughStep, view: StepView): StepPlace {
  if (view.diffTarget === undefined || !isSameCommit(view.commit, view.diffTarget)) {
    return { kind: 'not-shown' };
  }
  const file = view.files.find(({ path, status }) => path === step.file && status !== 'deleted');
  if (!file) return { kind: 'not-shown' };
  const end = step.endLine ?? step.line;
  const lines = [
    ...new Set(
      file.chunks.flatMap((chunk) => chunk.lines.flatMap((line) => line.newLineNumber ?? [])),
    ),
  ]
    .filter((line) => line >= step.line && line <= end)
    .sort((left, right) => left - right);
  return lines.length === 0 ? { kind: 'not-shown' } : { kind: 'shown', file: file.path, lines };
}
