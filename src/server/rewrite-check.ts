import type {
  DiffCommentThread,
  DiffSelection,
  LeftBranch,
  ReviewCommit,
  ReviewDecision,
  ReviewScope,
  RewordRejection,
  RewriteBlockingThread,
  RewriteWarning,
  ThreadFixup,
} from '../types/diff.js';
import { isOnCommit, lineOfPosition } from '../utils/commentPosition.js';
import { fixupCommitOf } from '../utils/diffSelection.js';
import { isAgentAtWork, isThreadDeleted } from '../utils/reviewDecisions.js';

type CommentsOfSession = Pick<RewriteCommentSession, 'threads' | 'decisions' | 'fixupsByThread'>;

interface RewriteCommentSession {
  selection: DiffSelection;
  // Undefined on a review that is not pinned to a commit.
  review: Pick<ReviewScope, 'requested'> | undefined;
  // The commits the session's comments can be on, for their subjects.
  commits: readonly ReviewCommit[];
  threads: DiffCommentThread[];
  decisions: ReviewDecision[];
  // Undefined on a review that is not pinned to a commit.
  fixupsByThread: ReadonlyMap<string, ThreadFixup[]> | undefined;
  // By thread id, for each of threadsAtWork with no fixupTarget: the full SHA of the commit its
  // lines come from, null when they are not committed.
  lineCommits: ReadonlyMap<string, string | null>;
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

export function threadsAtWork({
  threads,
  decisions,
  fixupsByThread,
}: CommentsOfSession): DiffCommentThread[] {
  return threads.filter((thread) => isAgentAtWork(thread, fixupsByThread, decisions));
}

function blockingThreadOf(
  thread: DiffCommentThread,
  { selection, review, commits, decisions, lineCommits }: RewriteCommentSession,
): RewriteBlockingThread {
  const commit = thread.fixupTarget ?? lineCommits.get(thread.id);
  const line = isOnCommit(thread) ? undefined : lineOfPosition(thread.position);
  return {
    threadId: thread.id,
    review: review?.requested ?? selection,
    ...(commit ? { commit: fixupCommitOf(commit, commits) } : {}),
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
    threadsAtWork(session).map((thread) => blockingThreadOf(thread, session)),
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
