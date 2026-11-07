import type {
  DiffCommentThread,
  DiffSelection,
  LeftBranch,
  ReviewDecision,
  ReviewScope,
  RewordRejection,
  RewriteBlockingThread,
  RewriteWarning,
  ThreadFixup,
} from '../types/diff.js';
import { isOnCommit, lineOfPosition } from '../utils/commentPosition.js';
import { fixupCommitOf, isCommitTarget } from '../utils/diffSelection.js';
import { isAgentAtWork, isThreadDeleted } from '../utils/reviewDecisions.js';

interface RewriteCommentSession {
  selection: DiffSelection;
  // Undefined on a review that is not pinned to a commit.
  review: Pick<ReviewScope, 'requested' | 'commits'> | undefined;
  threads: DiffCommentThread[];
  decisions: ReviewDecision[];
  // Undefined on a review that is not pinned to a commit.
  fixupsByThread: ReadonlyMap<string, ThreadFixup[]> | undefined;
}

export interface RewriteState {
  // Short name; null while HEAD is detached.
  branch: string | null;
  defaultBranch: string | null;
  targetInHead: boolean;
  operationInProgress: boolean;
  rewordsMerge: boolean;
  leftBranches: LeftBranch[];
  // The branch's upstream holds the oldest commit replaced. The commits after it are replaced too,
  // and the upstream can only hold them if it holds that one.
  rewritesPushedCommit: boolean;
  commentSessions: readonly RewriteCommentSession[];
}

export interface RewriteCheck {
  blocks: RewordRejection[];
  warnings: RewriteWarning[];
  warningBranches: Partial<Record<RewriteWarning, string[]>>;
  blockingThreads: RewriteBlockingThread[];
}

function blockingThreadOf(
  thread: DiffCommentThread,
  { selection, review, decisions }: RewriteCommentSession,
): RewriteBlockingThread {
  const commit = thread.fixupTarget ?? selection.targetCommitish;
  const line = isOnCommit(thread) ? undefined : lineOfPosition(thread.position);
  return {
    threadId: thread.id,
    review: review?.requested ?? selection,
    ...(isCommitTarget(commit) ? { commit: fixupCommitOf(commit, review?.commits ?? []) } : {}),
    ...(isOnCommit(thread) ? {} : { file: thread.filePath }),
    ...(line === undefined ? {} : { line }),
    ...(isThreadDeleted(thread.id, decisions) ? { deleted: true as const } : {}),
  };
}

export function checkRewrite(state: RewriteState): RewriteCheck {
  const blocks: RewordRejection[] = [];
  // A stopped rebase also detaches HEAD; what the reviewer needs to hear is the rebase.
  if (state.operationInProgress) blocks.push('operation-in-progress');
  if (state.branch === null) blocks.push('detached-head');
  if (!state.targetInHead) blocks.push('target-not-in-head');
  if (state.rewordsMerge) blocks.push('merge-commit');
  const blockingThreads = state.commentSessions.flatMap((session) =>
    session.threads
      .filter((thread) => isAgentAtWork(thread, session.fixupsByThread, session.decisions))
      .map((thread) => blockingThreadOf(thread, session)),
  );
  if (blockingThreads.length > 0) blocks.push('agent-working');
  const warnings: RewriteWarning[] = [];
  const warningBranches: RewriteCheck['warningBranches'] = {};
  if (state.branch !== null && state.branch === state.defaultBranch) {
    warnings.push('default-branch');
  }
  const byWarning = [
    ['default-branch-left', state.leftBranches.filter(({ why }) => why === 'default')],
    ['branch-elsewhere', state.leftBranches.filter(({ why }) => why !== 'default')],
  ] as const;
  for (const [warning, left] of byWarning) {
    if (left.length === 0) continue;
    warnings.push(warning);
    warningBranches[warning] = left.map(({ name }) => name);
  }
  if (state.rewritesPushedCommit) warnings.push('pushed-commit');
  return { blocks, warnings, warningBranches, blockingThreads };
}
