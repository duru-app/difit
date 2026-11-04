import { createContext, useContext, type ReactNode } from 'react';

import type {
  CommentThread,
  DiffSelection,
  DirectEditRejection,
  DirectEditRequest,
  FixupRef,
  ReviewDecision,
  ReviewDecisionKind,
  ShownThread,
  ThreadFixup,
  ThreadReviewState,
} from '../../types/diff';
import {
  deriveThreadReviewState,
  isAgentResponding,
  isAnswerableByEdit,
  isEditableOnCard,
  isOpenedByEdit,
  isThreadResolved,
  pendingFixupsFor,
  reviewerEditFixups,
} from '../../utils/reviewDecisions';
import { type EditRange, rangeOfLine, rangesOverlap } from '../utils/directEdit';
import type { FixupBox, FixupFilePlace, FixupFileRef } from '../utils/fixupSpread';

export interface DirectEditFailure {
  message: string;
  output?: string;
  reason?: DirectEditRejection;
}

export interface DirectEditControls {
  // The commit whose version of the file the edited lines come from.
  commit: string;
  // Resolves to null once the fixup commit is made.
  submit: (request: DirectEditRequest) => Promise<DirectEditFailure | null>;
}

export interface FixupOverlayState {
  enabled: boolean;
  fixupsByThread: Map<string, ThreadFixup[]>;
  decisions: ReviewDecision[];
  // The commit being reviewed; null when the target is a working tree, the index or stdin.
  targetCommit: string | null;
  recordDecision: (threadId: string, kind: ReviewDecisionKind, fixupSha: string) => void;
  decideFixups: (threadId: string, kind: ReviewDecisionKind, fixups: readonly FixupRef[]) => void;
  undoApproval: (threadId: string) => void;
  openReviewAt: (commit: string) => void;
  showView: (view: DiffSelection) => void;
  // Null when this review cannot take edits.
  directEdit: DirectEditControls | null;
  // Keyed by the reviewed path, then by anchor; empty unless the whole review is shown.
  boxesByFile: ReadonlyMap<string, ReadonlyMap<number, FixupBox[]>>;
  // Keyed by fixupFileKey; empty unless the whole review is shown.
  fixupPlaces: ReadonlyMap<string, FixupFilePlace>;
  // Keyed by fixupFileKey; the path of the reviewed file each fixup file changes.
  fixupReviewPaths: ReadonlyMap<string, string>;
  // Keyed by the reviewed path; empty unless the whole review is shown.
  fixupTouchedFiles: ReadonlyMap<string, FixupFileRef>;
  // Keyed by the reviewed path; the shown fixup file that brought the file back to the review base.
  fixupRevertedFiles: ReadonlyMap<string, FixupFileRef>;
  fixupLaterEdits: ReadonlyMap<string, ReadonlyMap<number, FixupFileRef>>;
  focusedFixupFile: FixupFileRef | null;
  revealFixupFile: (fixupSha: string, path: string) => void;
  pickThread: (threadId: string) => void;
  // Picks a thread whose card is drawn in the shown view, without switching the view.
  showThreadCard: (threadId: string) => void;
}

export const EMPTY_FIXUP_OVERLAY: FixupOverlayState = {
  enabled: false,
  fixupsByThread: new Map(),
  decisions: [],
  targetCommit: null,
  recordDecision: () => {},
  decideFixups: () => {},
  undoApproval: () => {},
  openReviewAt: () => {},
  showView: () => {},
  directEdit: null,
  boxesByFile: new Map(),
  fixupPlaces: new Map(),
  fixupReviewPaths: new Map(),
  fixupTouchedFiles: new Map(),
  fixupRevertedFiles: new Map(),
  fixupLaterEdits: new Map(),
  focusedFixupFile: null,
  revealFixupFile: () => {},
  pickThread: () => {},
  showThreadCard: () => {},
};

const FixupOverlayContext = createContext<FixupOverlayState>(EMPTY_FIXUP_OVERLAY);

export function FixupOverlayProvider({
  value,
  children,
}: {
  value: FixupOverlayState;
  children: ReactNode;
}) {
  return <FixupOverlayContext.Provider value={value}>{children}</FixupOverlayContext.Provider>;
}

export function useFixupOverlay(): FixupOverlayState {
  return useContext(FixupOverlayContext);
}

export interface ThreadReviewControls {
  state: ThreadReviewState;
  // The fixups under judgment, decided together.
  pendingFixups: FixupRef[];
  revertibleFixups: FixupRef[];
  targetCommit: string | null;
  responding: boolean;
  onDecide: FixupOverlayState['decideFixups'];
  onUndoApproval: (threadId: string) => void;
  onOpenReviewAt: (commit: string) => void;
  onShowView: (view: DiffSelection) => void;
}

export function threadReviewControls(
  overlay: FixupOverlayState,
  thread: ShownThread,
): ThreadReviewControls | undefined {
  if (overlay.targetCommit === null) return undefined;
  const fixups = overlay.fixupsByThread.get(thread.id) ?? [];
  const pending = pendingFixupsFor(thread.id, fixups, overlay.decisions);
  const toRef = ({ sha, patchId }: ThreadFixup): FixupRef => ({ fixupSha: sha, patchId });
  return {
    state: deriveThreadReviewState(thread.id, fixups, overlay.decisions, thread),
    pendingFixups: pending.map(toRef),
    revertibleFixups: reviewerEditFixups(thread, fixups, overlay.decisions).map(toRef),
    targetCommit: overlay.targetCommit,
    responding: isAgentResponding(thread, overlay.fixupsByThread, overlay.decisions),
    onDecide: overlay.decideFixups,
    onUndoApproval: overlay.undoApproval,
    onOpenReviewAt: overlay.openReviewAt,
    onShowView: overlay.showView,
  };
}

export function canAnswerByEdit(overlay: FixupOverlayState, thread: CommentThread): boolean {
  if (!overlay.directEdit || (thread.side ?? 'new') !== 'new' || thread.isOutdated) return false;
  if (thread.line === undefined) return false;
  const fixups = overlay.fixupsByThread.get(thread.id) ?? [];
  if (isOpenedByEdit(thread) || isThreadResolved(thread.id, overlay.decisions, fixups)) {
    return false;
  }
  const state = threadReviewControls(overlay, thread)?.state;
  return state !== undefined && isAnswerableByEdit(state);
}

export function canEditFixupCard(overlay: FixupOverlayState, thread: CommentThread): boolean {
  if (!overlay.directEdit || isOpenedByEdit(thread)) return false;
  const fixups = overlay.fixupsByThread.get(thread.id) ?? [];
  if (isThreadResolved(thread.id, overlay.decisions, fixups)) return false;
  const state = threadReviewControls(overlay, thread)?.state;
  return state !== undefined && isEditableOnCard(state);
}

export function threadAnsweredByEdit(
  overlay: FixupOverlayState,
  threads: CommentThread[],
  range: EditRange,
): string | undefined {
  const answerable = threads.filter(
    (thread) =>
      thread.line !== undefined &&
      canAnswerByEdit(overlay, thread) &&
      rangesOverlap(rangeOfLine(thread.line), range),
  );
  return answerable.length === 1 ? answerable[0]?.id : undefined;
}
