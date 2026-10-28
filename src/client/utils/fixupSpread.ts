import type {
  CommentThread,
  DiffChunk,
  DiffFile,
  ReviewDecision,
  ThreadFixup,
} from '../../types/diff';
import { isSameCommit } from '../../utils/diffSelection';
import { deriveThreadReviewState, pendingFixupsFor } from '../../utils/reviewDecisions';

import type { ThreadPlacement } from './outdatedComments';

export type FixupFile = ThreadFixup['files'][number];

const FILE_STATUS_LABEL: Partial<Record<FixupFile['status'], string>> = {
  added: '새 파일',
  deleted: '지운 파일',
};

export const fixupFileName = (file: FixupFile) =>
  file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;

export function fixupFileLabels(file: FixupFile): string[] {
  const status = FILE_STATUS_LABEL[file.status];
  return [...(status ? [status] : []), ...(file.isGenerated ? ['생성된 파일'] : [])];
}

export type AnsweredThread = Pick<
  CommentThread,
  'id' | 'file' | 'line' | 'extraLines' | 'side' | 'isOutdated'
>;

export const sameAnsweredThread = (a: AnsweredThread, b: AnsweredThread) =>
  a.id === b.id &&
  a.file === b.file &&
  JSON.stringify([a.line, a.extraLines, a.side]) ===
    JSON.stringify([b.line, b.extraLines, b.side]) &&
  a.isOutdated === b.isOutdated;

export interface FixupFileRef {
  fixupSha: string;
  path: string;
}

export interface FixupBox {
  fixup: ThreadFixup;
  threads: AnsweredThread[];
  file: FixupFile;
  chunk: DiffChunk;
  chunkIndex: number;
  // The line on the new side of the reviewed diff that the box goes below; at least 1.
  anchor: number;
}

export interface FixupOnlyFiles {
  fixup: ThreadFixup;
  threads: AnsweredThread[];
  files: FixupFile[];
}

export function fixupDiffFile(file: FixupFile): DiffFile {
  const lines = file.chunks.flatMap((chunk) => chunk.lines);
  return {
    ...file,
    additions: lines.filter((line) => line.type === 'add').length,
    deletions: lines.filter((line) => line.type === 'delete').length,
  };
}

export type FixupFilePlace =
  | { kind: 'box'; reviewPath: string }
  | { kind: 'fixup-only' }
  | { kind: 'card'; threadId: string };

export interface FixupSpread {
  // Keyed by the path of the reviewed file, then by the anchor of its boxes.
  boxesByFile: Map<string, Map<number, FixupBox[]>>;
  fixupOnly: FixupOnlyFiles[];
  // Reviewed file path to the first shown fixup file that changed it.
  touchedReviewFiles: Map<string, FixupFileRef>;
  places: Map<string, FixupFilePlace>;
  // Thread id to the fixup-only group it is drawn in and its placement there.
  outsidePlacements: Map<string, OutsidePlacement>;
}

interface OutsidePlacement {
  fixupSha: string;
  placement: ThreadPlacement;
}

export interface OutsideThread {
  id: string;
  file: string;
  snapshotCommit: string | undefined;
}

export interface ThreadsOutsideReview<Thread extends OutsideThread> {
  threads: readonly Thread[];
  // Null when the thread is not shown in this view.
  place: (thread: Thread, file: FixupFile, fixup: ThreadFixup) => ThreadPlacement | null;
}

interface ShownFixups {
  enabled: boolean;
  fixupsByThread: ReadonlyMap<string, ThreadFixup[]>;
  decisions: ReviewDecision[];
}

// An outdated thread has no trustworthy line to draw under, so it gets no overlay.
export function overlaidFixups(
  overlay: ShownFixups,
  thread: Pick<CommentThread, 'id' | 'isOutdated'>,
): ThreadFixup[] {
  if (!overlay.enabled || thread.isOutdated) return [];
  const fixups = overlay.fixupsByThread.get(thread.id) ?? [];
  const state = deriveThreadReviewState(thread.id, fixups, overlay.decisions);
  if (state !== 'awaiting-approval' && state !== 'approved') return [];
  return pendingFixupsFor(thread.id, fixups, overlay.decisions);
}

// The last line on the chunk's old side at or above its last change; 0 when that is above line 1.
export function anchorOf(chunk: DiffChunk): number {
  let last = chunk.oldLines === 0 ? chunk.oldStart : chunk.oldStart - 1;
  let anchor = last;
  for (const line of chunk.lines) {
    if (line.type !== 'add') last = line.oldLineNumber ?? last;
    if (line.type !== 'normal') anchor = last;
  }
  return anchor;
}

const deletedOldLines = (chunk: DiffChunk) =>
  chunk.lines.flatMap((line) =>
    line.type === 'delete' && line.oldLineNumber !== undefined ? [line.oldLineNumber] : [],
  );

const nextLineAfter = (start: number, count: number) => (count === 0 ? start + 1 : start + count);

type LineShift = Pick<DiffChunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>;

function oldLineOf<Shift extends LineShift>(
  shifts: readonly Shift[],
  newLine: number,
  insideShift: (shift: Shift) => number | null,
): number | null {
  let offset = 0;
  for (const shift of shifts) {
    const isAbove = shift.newLines === 0 ? newLine <= shift.newStart : newLine < shift.newStart;
    if (isAbove) break;
    const newNext = nextLineAfter(shift.newStart, shift.newLines);
    if (newLine < newNext) return insideShift(shift);
    offset = nextLineAfter(shift.oldStart, shift.oldLines) - newNext;
  }
  return newLine + offset;
}

const lastOldLineAtOrAbove = (newLine: number) => (chunk: DiffChunk) => {
  let last = chunk.oldLines === 0 ? chunk.oldStart : chunk.oldStart - 1;
  for (const line of chunk.lines) {
    if (line.type !== 'add') last = line.oldLineNumber ?? last;
    if (line.newLineNumber === newLine) return last;
  }
  return last;
};

type Lines = Array<number | null>;

// Walks a path and lines on the old side of fixupsInLogOrder[index] back to the review target. A
// line an earlier fixup added maps to the old line above it; a line a commit answering no thread
// added or changed maps to null, as the review has no such line.
function toReviewedSide(
  path: string,
  lines: Lines,
  fixupsInLogOrder: readonly ThreadFixup[],
  index: number,
): { path: string; lines: Lines } {
  let current = { path, lines };
  for (let at = index; at >= 0; at--) {
    const fixup = fixupsInLogOrder[at];
    if (!fixup) continue;
    const file = at < index && fixup.files.find((candidate) => candidate.path === current.path);
    if (file) {
      current = {
        path: file.oldPath ?? file.path,
        lines: current.lines.map((line) =>
          line === null ? null : oldLineOf(file.chunks, line, lastOldLineAtOrAbove(line)),
        ),
      };
    }
    const plain = fixup.plainChangesBefore?.find((change) => change.path === current.path);
    if (plain) {
      current = {
        path: plain.oldPath ?? plain.path,
        lines: current.lines.map((line) =>
          line === null ? null : oldLineOf(plain.shifts, line, () => null),
        ),
      };
    }
  }
  return current;
}

export const fixupFileKey = ({ fixupSha, path }: FixupFileRef) => `${fixupSha}:${path}`;

export function boxesByAnchor(boxes: readonly FixupBox[]): Map<number, FixupBox[]> {
  const byAnchor = new Map<number, FixupBox[]>();
  for (const box of boxes) {
    const atAnchor = byAnchor.get(box.anchor);
    if (atAnchor) atAnchor.push(box);
    else byAnchor.set(box.anchor, [box]);
  }
  return byAnchor;
}

export function reviewPathsOf(fixupsInLogOrder: readonly ThreadFixup[]): Map<string, string> {
  const paths = new Map<string, string>();
  fixupsInLogOrder.forEach((fixup, logIndex) => {
    for (const file of fixup.files) {
      paths.set(
        fixupFileKey({ fixupSha: fixup.sha, path: file.path }),
        toReviewedSide(file.oldPath ?? file.path, [], fixupsInLogOrder, logIndex).path,
      );
    }
  });
  return paths;
}

// A thread outside the review belongs to the group of the fixup its snapshot was taken on and is
// placed there once, before any later fixup is spread. A thread whose snapshot names no listed
// fixup, or whose fixup shows no fixup-only copy of its file, is placed on the latest group so far
// that shows its file, and placed again on each later group that shows it. A fixup file goes to the
// card of a thread on its reviewed file, matched by its reviewed path, or of a placed thread outside
// the review, matched by its path before the fixup; to the fixup-only group when neither of its
// paths is a reviewed file; under the lines of its reviewed file; or, when the review deletes that
// file or lacks a line the fixup changed or changed next to, to the card of the first thread it
// answers.
export function spreadFixups<Thread extends OutsideThread>(
  overlay: ShownFixups,
  fixupsInLogOrder: readonly ThreadFixup[],
  threads: readonly AnsweredThread[],
  reviewFiles: readonly Pick<DiffFile, 'path' | 'status'>[],
  outsideReview: ThreadsOutsideReview<Thread> = { threads: [], place: () => null },
): FixupSpread {
  const answeredShasOf = new Map(
    threads.map(({ id }) => [
      id,
      new Set(overlaidFixups(overlay, { id, isOutdated: false }).map(({ sha }) => sha)),
    ]),
  );
  const reviewPaths = new Set(reviewFiles.map(({ path }) => path));
  const drawnPaths = new Set(
    reviewFiles.filter(({ status }) => status !== 'deleted').map(({ path }) => path),
  );
  const spread: FixupSpread = {
    boxesByFile: new Map(),
    fixupOnly: [],
    touchedReviewFiles: new Map(),
    places: new Map(),
    outsidePlacements: new Map(),
  };
  const boxesOfFile = new Map<string, FixupBox[]>();

  const outsideIds = new Set(outsideReview.threads.map(({ id }) => id));
  const madeOn = new Map<number, Thread[]>();
  const unanchored: Thread[] = [];
  for (const thread of outsideReview.threads) {
    const { snapshotCommit } = thread;
    const index = snapshotCommit
      ? fixupsInLogOrder.findIndex(({ sha }) => isSameCommit(sha, snapshotCommit))
      : -1;
    if (index < 0) unanchored.push(thread);
    else madeOn.set(index, [...(madeOn.get(index) ?? []), thread]);
  }
  const placeIn = (thread: Thread, group: FixupOnlyFiles) => {
    const file = group.files.find(({ path }) => path === thread.file);
    if (!file) return false;
    const placement = outsideReview.place(thread, file, group.fixup);
    if (placement)
      spread.outsidePlacements.set(thread.id, { fixupSha: group.fixup.sha, placement });
    else spread.outsidePlacements.delete(thread.id);
    return true;
  };
  const answering = (thread: AnsweredThread): AnsweredThread | null => {
    if (!outsideIds.has(thread.id)) return thread.isOutdated ? null : thread;
    const placement = spread.outsidePlacements.get(thread.id)?.placement;
    return placement && !placement.isOutdated
      ? { ...thread, line: placement.line, extraLines: placement.extraLines, isOutdated: false }
      : null;
  };
  const answeredBy = (sha: string) =>
    threads.flatMap((thread) => {
      const shown = answeredShasOf.get(thread.id)?.has(sha) && answering(thread);
      return shown ? [shown] : [];
    });

  const spreadFixup = (fixup: ThreadFixup, logIndex: number): FixupOnlyFiles | null => {
    const answered = answeredBy(fixup.sha);
    const [firstAnswered] = answered;
    if (!firstAnswered) return null;
    const outside: FixupFile[] = [];
    for (const file of fixup.files) {
      const ref = { fixupSha: fixup.sha, path: file.path };
      const reviewed = toReviewedSide(
        file.oldPath ?? file.path,
        [...file.chunks.map(anchorOf), ...file.chunks.flatMap(deletedOldLines)],
        fixupsInLogOrder,
        logIndex,
      );
      const reviewPath = reviewed.path;
      const isReviewed = reviewPaths.has(reviewPath);
      if (isReviewed && !spread.touchedReviewFiles.has(reviewPath)) {
        spread.touchedReviewFiles.set(reviewPath, ref);
      }
      const parentPath = file.oldPath ?? file.path;
      const cardThread = answered.find((thread) =>
        outsideIds.has(thread.id)
          ? thread.file === parentPath
          : isReviewed && thread.file === reviewPath,
      );
      if (cardThread) {
        spread.places.set(fixupFileKey(ref), { kind: 'card', threadId: cardThread.id });
        continue;
      }
      if (!isReviewed && !reviewPaths.has(file.path)) {
        outside.push(file);
        spread.places.set(fixupFileKey(ref), { kind: 'fixup-only' });
        continue;
      }
      if (!drawnPaths.has(reviewPath) || reviewed.lines.includes(null)) {
        spread.places.set(fixupFileKey(ref), { kind: 'card', threadId: firstAnswered.id });
        continue;
      }
      const boxes = file.chunks.map((chunk, chunkIndex) => ({
        fixup,
        threads: answered,
        file,
        chunk,
        chunkIndex,
        anchor: Math.max(1, reviewed.lines[chunkIndex] ?? 1),
      }));
      boxesOfFile.set(reviewPath, [...(boxesOfFile.get(reviewPath) ?? []), ...boxes]);
      spread.places.set(fixupFileKey(ref), { kind: 'box', reviewPath });
    }
    return outside.length > 0 ? { fixup, threads: answered, files: outside } : null;
  };

  fixupsInLogOrder.forEach((fixup, logIndex) => {
    const earlierGroups = spread.fixupOnly.length;
    const group = spreadFixup(fixup, logIndex);
    if (group) {
      spread.fixupOnly.push(group);
      for (const thread of unanchored) placeIn(thread, group);
    }
    for (const thread of madeOn.get(logIndex) ?? []) {
      if (group && placeIn(thread, group)) continue;
      unanchored.push(thread);
      for (const shown of spread.fixupOnly.slice(0, earlierGroups).reverse()) {
        if (placeIn(thread, shown)) break;
      }
    }
  });
  for (const [path, boxes] of boxesOfFile) spread.boxesByFile.set(path, boxesByAnchor(boxes));
  return spread;
}
