import type { LeftBranch, RewordRejection, RewriteWarning } from '../types/diff.js';

export interface RewriteState {
  // Short name; null while HEAD is detached.
  branch: string | null;
  defaultBranch: string | null;
  targetInHead: boolean;
  operationInProgress: boolean;
  rewordsMerge: boolean;
  leftBranches: LeftBranch[];
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
  return { blocks, warnings, warningBranches };
}
