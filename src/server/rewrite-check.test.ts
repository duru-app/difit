import { describe, expect, it } from 'vitest';

import { checkRewrite, type RewriteState } from './rewrite-check.js';
import type {
  DiffCommentMessage,
  DiffCommentThread,
  ReviewDecision,
  ThreadFixup,
} from '../types/diff.js';

const FEATURE_BRANCH: RewriteState = {
  branch: 'feature',
  defaultBranch: 'main',
  targetInHead: true,
  operationInProgress: false,
  rewordsMerge: false,
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

const thread = (id: string, messages: DiffCommentMessage[]): DiffCommentThread => ({
  id,
  createdAt: '2026-11-07T00:00:00Z',
  updatedAt: '2026-11-07T00:00:00Z',
  messages,
  filePath: 'src/c.js',
  position: { side: 'new', line: 4 },
});

const OLD_REVIEW = { baseCommitish: 'aaaaaaa', targetCommitish: 'bbbbbbb' };
const OLD_REQUESTED = { baseCommitish: 'a'.repeat(40), targetCommitish: 'b'.repeat(40) };
const OLD_COMMITS = [
  {
    sha: 'c'.repeat(40),
    shortSha: 'ccccccc',
    parentSha: 'a'.repeat(40),
    subject: 'feat: first',
  },
  {
    sha: 'b'.repeat(40),
    shortSha: 'bbbbbbb',
    parentSha: 'c'.repeat(40),
    subject: 'feat: second',
  },
];

const pinnedSession = (threads: DiffCommentThread[], decisions: ReviewDecision[] = []) => ({
  selection: OLD_REVIEW,
  review: { requested: OLD_REQUESTED, commits: OLD_COMMITS },
  threads,
  decisions,
  fixupsByThread: new Map<string, ThreadFixup[]>(),
});

const blockingThreadsOf = (session: ReturnType<typeof pinnedSession>) =>
  checkRewrite({ ...FEATURE_BRANCH, commentSessions: [session] }).blockingThreads;

const blocksWith = (
  messages: DiffCommentMessage[],
  decisions: ReviewDecision[] = [],
  fixups: ThreadFixup[] = [],
) =>
  checkRewrite({
    ...FEATURE_BRANCH,
    commentSessions: [
      {
        selection: OLD_REVIEW,
        review: undefined,
        threads: [thread('t1', messages)],
        decisions,
        fixupsByThread: new Map([['t1', fixups]]),
      },
    ],
  }).blocks;

describe('checkRewrite', () => {
  it('lets a feature branch through with nothing to say', () => {
    expect(checkRewrite(FEATURE_BRANCH)).toEqual({ blocks: [], warnings: [], blockingThreads: [] });
  });

  it('warns on the default branch without blocking', () => {
    expect(checkRewrite({ ...FEATURE_BRANCH, branch: 'main' })).toEqual({
      blocks: [],
      warnings: ['default-branch'],
      blockingThreads: [],
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
      blockingThreads: [],
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
    const empty = {
      selection: OLD_REVIEW,
      review: undefined,
      threads: [],
      decisions: [],
      fixupsByThread: undefined,
    };
    const waiting = { ...empty, threads: [thread('t2', [said('User')])] };
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
      blockingThreads: [],
    });
  });

  describe('where the blocking comments are', () => {
    it('names the review target when the comment was made on the whole review', () => {
      expect(blockingThreadsOf(pinnedSession([thread('t1', [said('User')])]))).toEqual([
        {
          threadId: 't1',
          review: OLD_REQUESTED,
          commit: { shortSha: 'bbbbbbb', subject: 'feat: second' },
          file: 'src/c.js',
          line: 4,
        },
      ]);
    });

    it('names the commit a comment will be fixed up into', () => {
      const onFirst = { ...thread('t1', [said('User')]), fixupTarget: 'c'.repeat(40) };
      expect(blockingThreadsOf(pinnedSession([onFirst]))[0]?.commit).toEqual({
        shortSha: 'ccccccc',
        subject: 'feat: first',
      });
    });

    it('names no file for a comment on a whole commit', () => {
      const onCommit: DiffCommentThread = {
        id: 't1',
        createdAt: '2026-11-07T00:00:00Z',
        updatedAt: '2026-11-07T00:00:00Z',
        messages: [said('User')],
        position: { scope: 'commit' },
        fixupTarget: 'c'.repeat(40),
      };
      expect(blockingThreadsOf(pinnedSession([onCommit]))).toEqual([
        {
          threadId: 't1',
          review: OLD_REQUESTED,
          commit: { shortSha: 'ccccccc', subject: 'feat: first' },
        },
      ]);
    });

    it('names no commit for a comment on uncommitted changes', () => {
      const selection = { baseCommitish: 'HEAD', targetCommitish: '.' };
      expect(
        checkRewrite({
          ...FEATURE_BRANCH,
          commentSessions: [
            {
              selection,
              review: undefined,
              threads: [thread('t1', [said('User')])],
              decisions: [],
              fixupsByThread: undefined,
            },
          ],
        }).blockingThreads,
      ).toEqual([{ threadId: 't1', review: selection, file: 'src/c.js', line: 4 }]);
    });

    it('marks a deleted comment whose fixup is still in the range', () => {
      const fixup: ThreadFixup = {
        sha: 'f'.repeat(40),
        shortSha: 'fffffff',
        patchId: 'patch',
        authoredAt: '2026-11-07T00:00:01Z',
        subject: 'fixup! feature',
        threadIds: ['t1'],
        files: [],
      };
      const deleted: ReviewDecision = {
        threadId: 't1',
        kind: 'deleted',
        fixupSha: '',
        at: '2026-11-07T00:00:02Z',
      };
      const session = {
        ...pinnedSession([thread('t1', [said('User')])], [deleted]),
        fixupsByThread: new Map([['t1', [fixup]]]),
      };
      expect(blockingThreadsOf(session)[0]).toMatchObject({ threadId: 't1', deleted: true });
    });

    it('leaves out the comments that do not block', () => {
      const answered = thread('t1', [said('User'), said('Agent')]);
      const waiting = thread('t2', [said('User')]);
      expect(
        blockingThreadsOf(pinnedSession([answered, waiting])).map(({ threadId }) => threadId),
      ).toEqual(['t2']);
    });
  });
});
