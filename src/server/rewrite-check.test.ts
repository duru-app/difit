import { describe, expect, it } from 'vitest';

import { checkRewrite, type RewriteState } from './rewrite-check.js';
import type { DiffCommentMessage, ReviewDecision, ThreadFixup } from '../types/diff.js';

const FEATURE_BRANCH: RewriteState = {
  branch: 'feature',
  defaultBranch: 'main',
  targetInHead: true,
  operationInProgress: false,
  rewordsMerge: false,
  leftBranches: [],
  rewritesPushedCommit: false,
  commentSessions: [],
};

const said = (author: string, extra: Partial<DiffCommentMessage> = {}): DiffCommentMessage => ({
  id: `${author}-1`,
  body: 'text',
  author,
  createdAt: '2026-11-07T00:00:00Z',
  updatedAt: '2026-11-07T00:00:00Z',
  ...extra,
});

const blocksWith = (
  messages: DiffCommentMessage[],
  decisions: ReviewDecision[] = [],
  fixups: ThreadFixup[] = [],
) =>
  checkRewrite({
    ...FEATURE_BRANCH,
    commentSessions: [
      {
        threads: [{ id: 't1', messages }],
        decisions,
        fixupsByThread: new Map([['t1', fixups]]),
      },
    ],
  }).blocks;

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

  it('warns when the rewrite replaces a commit already on the upstream', () => {
    expect(checkRewrite({ ...FEATURE_BRANCH, rewritesPushedCommit: true })).toEqual({
      blocks: [],
      warnings: ['pushed-commit'],
      warningBranches: {},
    });
  });

  it('gives both warnings for a pushed commit on the default branch', () => {
    expect(
      checkRewrite({ ...FEATURE_BRANCH, branch: 'main', rewritesPushedCommit: true }).warnings,
    ).toEqual(['default-branch', 'pushed-commit']);
  });

  it("blocks while a thread is the agent's turn", () => {
    expect(blocksWith([said('User')])).toEqual(['agent-working']);
  });

  it('blocks while the agent has promised a fix that has not come', () => {
    expect(blocksWith([said('User'), said('Agent', { fixPending: true })])).toEqual([
      'agent-working',
    ]);
  });

  it("blocks on the agent's turn in any session of the server", () => {
    const empty = { threads: [], decisions: [], fixupsByThread: undefined };
    const waiting = {
      threads: [{ id: 't2', messages: [said('User')] }],
      decisions: [],
      fixupsByThread: undefined,
    };
    expect(checkRewrite({ ...FEATURE_BRANCH, commentSessions: [empty, waiting] }).blocks).toEqual([
      'agent-working',
    ]);
  });

  it("lets a rewrite through when the agent has answered and nothing is the agent's", () => {
    expect(blocksWith([said('User'), said('Agent')])).toEqual([]);
    expect(blocksWith([said('Agent')])).toEqual([]);
  });

  it('lets a rewrite through once the promised fix has come, until it is rejected', () => {
    const fixup: ThreadFixup = {
      sha: 'f'.repeat(40),
      shortSha: 'fffffff',
      patchId: 'patch',
      authoredAt: '2026-11-07T00:00:01Z',
      subject: 'fixup! feature',
      threadIds: ['t1'],
      files: [],
    };
    const messages = [said('User'), said('Agent', { fixPending: true })];
    const rejected: ReviewDecision = {
      threadId: 't1',
      kind: 'rejected',
      fixupSha: fixup.sha,
      patchId: fixup.patchId,
      at: '2026-11-07T00:00:02Z',
    };
    expect(blocksWith(messages, [], [fixup])).toEqual([]);
    expect(blocksWith(messages, [rejected], [fixup])).toEqual(['agent-working']);
  });

  it('lets a rewrite through once the reviewer closed the thread', () => {
    const closed: ReviewDecision = {
      threadId: 't1',
      kind: 'resolved',
      fixupSha: '',
      at: '2026-11-07T00:00:01Z',
    };
    expect(blocksWith([said('User')], [closed])).toEqual([]);
    expect(blocksWith([said('User'), said('Agent', { fixPending: true })], [closed])).toEqual([]);
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

  it('warns about the default branch left on the old commits apart from the other branches', () => {
    expect(
      checkRewrite({
        ...FEATURE_BRANCH,
        leftBranches: [
          { name: 'main', why: 'default' },
          { name: 'work2', why: 'worktree' },
        ],
      }),
    ).toEqual({
      blocks: [],
      warnings: ['default-branch-left', 'branch-elsewhere'],
      warningBranches: { 'default-branch-left': ['main'], 'branch-elsewhere': ['work2'] },
    });
  });
});
