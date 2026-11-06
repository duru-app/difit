import type { RewordRejection, RewriteWarning } from '../types/diff.js';

export interface RewriteState {
  // Short name; null while HEAD is detached.
  branch: string | null;
  defaultBranch: string | null;
  targetInHead: boolean;
  operationInProgress: boolean;
  rewordsMerge: boolean;
}

export interface RewriteCheck {
  blocks: RewordRejection[];
  warnings: RewriteWarning[];
}

export function checkRewrite(state: RewriteState): RewriteCheck {
  const blocks: RewordRejection[] = [];
  // A stopped rebase also detaches HEAD; what the reviewer needs to hear is the rebase.
  if (state.operationInProgress) blocks.push('operation-in-progress');
  if (state.branch === null) blocks.push('detached-head');
  if (!state.targetInHead) blocks.push('target-not-in-head');
  if (state.rewordsMerge) blocks.push('merge-commit');
  const onDefaultBranch = state.branch !== null && state.branch === state.defaultBranch;
  return { blocks, warnings: onDefaultBranch ? ['default-branch'] : [] };
}
