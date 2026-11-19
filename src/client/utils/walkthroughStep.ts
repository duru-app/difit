import type { DiffFile, WalkthroughStep } from '../../types/diff';
import { isSameCommit } from '../../utils/diffSelection';

// `reference`: the review left the file unchanged, so it is shown under the diff on its own.
export type StepPlace =
  | { kind: 'shown'; file: string; lines: number[] }
  | { kind: 'reference'; file: string; line: number; endLine: number }
  | { kind: 'not-shown' };

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
  const inDiff = view.files.find(({ path }) => path === step.file);
  if (!inDiff) {
    return {
      kind: 'reference',
      file: step.file,
      line: step.line,
      endLine: step.endLine ?? step.line,
    };
  }
  const file = inDiff.status === 'deleted' ? undefined : inDiff;
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

const REFERENCE_CONTEXT_LINES = 3;

export interface ReferenceFile {
  file: string;
  // Ascending and apart; `end` may run past the end of the file.
  parts: { start: number; end: number }[];
}

type ReferencePlace = Extract<StepPlace, { kind: 'reference' }>;

const referencePlacesOf = (steps: readonly WalkthroughStep[], view: StepView) =>
  steps
    .map((step) => placeOfStep(step, view))
    .filter((place): place is ReferencePlace => place.kind === 'reference');

export const referenceFilePathsOf = (steps: readonly WalkthroughStep[], view: StepView) => [
  ...new Set(referencePlacesOf(steps, view).map(({ file }) => file)),
];

// A file absent from the map is still loading; `null` means it could not be read.
export type ReferenceLineCounts = ReadonlyMap<string, number | null>;

// `undefined` while the file is still loading.
export function referenceStepFits(
  place: { file: string; line: number },
  lineCounts: ReferenceLineCounts,
): boolean | undefined {
  if (!lineCounts.has(place.file)) return undefined;
  const count = lineCounts.get(place.file) ?? null;
  return count !== null && place.line <= count;
}

export function referenceFilesOf(
  steps: readonly WalkthroughStep[],
  view: StepView,
  lineCounts: ReferenceLineCounts,
): ReferenceFile[] {
  const ranges = new Map<string, { start: number; end: number }[]>();
  for (const place of referencePlacesOf(steps, view)) {
    if (referenceStepFits(place, lineCounts) !== true) continue;
    const fileRanges = ranges.get(place.file) ?? [];
    fileRanges.push({
      start: Math.max(1, place.line - REFERENCE_CONTEXT_LINES),
      end: place.endLine + REFERENCE_CONTEXT_LINES,
    });
    ranges.set(place.file, fileRanges);
  }
  return [...ranges].map(([file, fileRanges]) => {
    const parts: ReferenceFile['parts'] = [];
    for (const range of fileRanges.sort((left, right) => left.start - right.start)) {
      const last = parts.at(-1);
      if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
      else parts.push({ ...range });
    }
    return { file, parts };
  });
}
