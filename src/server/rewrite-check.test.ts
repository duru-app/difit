import { describe, expect, it } from 'vitest';

import { checkRewrite, type RewriteState } from './rewrite-check.js';

const FEATURE_BRANCH: RewriteState = {
  branch: 'feature',
  defaultBranch: 'main',
  targetInHead: true,
  operationInProgress: false,
  rewordsMerge: false,
  leftBranches: [],
};

describe('checkRewrite', () => {
  it('lets a feature branch through with nothing to say', () => {
    expect(checkRewrite(FEATURE_BRANCH)).toEqual({ blocks: [], warnings: [], warningBranches: {} });
  });

  it('warns on the default branch without blocking', () => {
    expect(checkRewrite({ ...FEATURE_BRANCH, branch: 'main' })).toEqual({
      blocks: [],
      warnings: ['default-branch'],
      warningBranches: {},
    });
  });

  it('warns about nothing when the repository has no default branch to tell', () => {
    expect(checkRewrite({ ...FEATURE_BRANCH, defaultBranch: null }).warnings).toEqual([]);
  });

  it('blocks while a git operation is in progress', () => {
    expect(checkRewrite({ ...FEATURE_BRANCH, operationInProgress: true }).blocks).toEqual([
      'operation-in-progress',
    ]);
  });

  it('blocks a detached HEAD, a target off HEAD and a merge being reworded', () => {
    expect(checkRewrite({ ...FEATURE_BRANCH, branch: null }).blocks).toEqual(['detached-head']);
    expect(checkRewrite({ ...FEATURE_BRANCH, targetInHead: false }).blocks).toEqual([
      'target-not-in-head',
    ]);
    expect(checkRewrite({ ...FEATURE_BRANCH, rewordsMerge: true }).blocks).toEqual([
      'merge-commit',
    ]);
  });

  it('names the stopped rebase before the detached HEAD it causes', () => {
    expect(
      checkRewrite({ ...FEATURE_BRANCH, branch: null, operationInProgress: true }).blocks,
    ).toEqual(['operation-in-progress', 'detached-head']);
  });

  it('reports a warning alongside a block', () => {
    expect(checkRewrite({ ...FEATURE_BRANCH, branch: 'main', operationInProgress: true })).toEqual({
      blocks: ['operation-in-progress'],
      warnings: ['default-branch'],
      warningBranches: {},
    });
  });

  it('warns about the branches the rewrite leaves behind, by name', () => {
    expect(
      checkRewrite({
        ...FEATURE_BRANCH,
        leftBranches: [
          { name: 'work2', why: 'worktree' },
          { name: 'rebasing', why: 'operation' },
        ],
      }),
    ).toEqual({
      blocks: [],
      warnings: ['branch-elsewhere'],
      warningBranches: { 'branch-elsewhere': ['work2', 'rebasing'] },
    });
  });
});
