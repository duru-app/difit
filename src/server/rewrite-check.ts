import type {
  DiffCommentThread,
  LeftBranch,
  ReviewDecision,
  RewordRejection,
  RewriteWarning,
  ThreadFixup,
} from '../types/diff.js';
import { isAgentAtWork } from '../utils/reviewDecisions.js';

interface RewriteCommentSession {
  threads: Array<Pick<DiffCommentThread, 'id' | 'messages'>>;
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
}

export function checkRewrite(state: RewriteState): RewriteCheck {
  const blocks: RewordRejection[] = [];
  // A stopped rebase also detaches HEAD; what the reviewer needs to hear is the rebase.
  if (state.operationInProgress) blocks.push('operation-in-progress');
  if (state.branch === null) blocks.push('detached-head');
  if (!state.targetInHead) blocks.push('target-not-in-head');
  if (state.rewordsMerge) blocks.push('merge-commit');
  const agentAtWork = state.commentSessions.some(({ threads, decisions, fixupsByThread }) =>
    threads.some((thread) => isAgentAtWork(thread, fixupsByThread, decisions)),
  );
  if (agentAtWork) blocks.push('agent-working');
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
  return { blocks, warnings, warningBranches };
}
