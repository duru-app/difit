import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { fetch } from 'undici';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { getReviewRecordPath, readReviewRecord } from './review-record.js';
import { startServer } from './server.js';
import type {
  DiffCommentThread,
  DiffResponse,
  DiffSelection,
  ReviewDecision,
} from '../types/diff.js';
import { createDiffSelection } from '../utils/diffSelection.js';

let home: string;
const savedEnv = { ...process.env };
const cleanups: Array<() => Promise<void> | void> = [];
let nextPort = 9400;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-review-record-home-'));
  // A test run started from a commit hook would otherwise point every git call at that commit.
  process.env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'difit',
    GIT_AUTHOR_EMAIL: 'difit@example.com',
    GIT_COMMITTER_NAME: 'difit',
    GIT_COMMITTER_EMAIL: 'difit@example.com',
  });
});

afterAll(() => {
  process.env = savedEnv;
  rmSync(home, { recursive: true, force: true, maxRetries: 10 });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(repo: string, message: string, files: Record<string, string | null>): string {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(repo, path));
    else writeFileSync(join(repo, path), content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

const lines = (...content: string[]) => `${content.join('\n')}\n`;

function createRepo(): { repo: string; base: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), 'difit-review-record-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true, maxRetries: 10 }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const base = commit(repo, 'base', { 'a.txt': lines('one', 'two', 'three') });
  const head = commit(repo, 'change', {
    'a.txt': lines('one', 'TWO', 'three', 'four'),
    'b.txt': lines('alpha', 'beta'),
  });
  return { repo, base, head };
}

interface Review {
  port: number;
  stop: () => Promise<void>;
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  threads: () => Promise<DiffCommentThread[]>;
  state: () => Promise<{ threads: DiffCommentThread[]; decisions: ReviewDecision[] }>;
  output: () => Promise<string>;
  leftOut: () => Promise<{ threads: DiffCommentThread[]; text: string }>;
}

async function open(
  repoPath: string,
  selection: DiffSelection,
  options: { clearComments?: boolean } = {},
): Promise<Review> {
  const { port, server } = await startServer({
    selection,
    repoPath,
    preferredPort: nextPort,
    ...options,
  });
  nextPort = port + 1;
  let stopped = false;
  const stop = () =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve();
      stopped = true;
      server?.close(() => resolve());
      server?.closeAllConnections();
    });
  cleanups.push(stop);
  const url = (path: string) => `http://localhost:${port}${path}`;
  const get = async (path: string) => (await fetch(url(path))).json();
  const state = () =>
    get('/api/comments-json') as Promise<{
      threads: DiffCommentThread[];
      decisions: ReviewDecision[];
    }>;
  return {
    port,
    stop,
    get,
    post: async (path, body) =>
      (
        await fetch(url(path), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json(),
    state,
    threads: async () => (await state()).threads,
    output: async () => (await fetch(url('/api/comments-output'))).text(),
    leftOut: () =>
      get('/api/comments-left-out') as Promise<{ threads: DiffCommentThread[]; text: string }>,
  };
}

function thread(
  id: string,
  filePath: string,
  line: number,
  content: string,
  commit: string,
): DiffCommentThread {
  return {
    id,
    filePath,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    position: { side: 'new', line },
    codeSnapshot: { content, commit },
    messages: [
      {
        id,
        body: `about ${content}`,
        author: 'User',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

const resolved = (threadId: string): ReviewDecision => ({
  threadId,
  kind: 'resolved',
  fixupSha: '',
  at: '2026-01-02T00:00:00.000Z',
});

const short = (sha: string) => sha.slice(0, 7);

it('brings threads, replies, decisions and the original code back on the same range', async () => {
  const { repo, base, head } = createRepo();
  const first = await open(repo, createDiffSelection(base, 'main'));
  await first.post('/api/comments', {
    threads: [
      thread('t1', 'a.txt', 2, 'TWO', short(head)),
      thread('t2', 'b.txt', 1, 'alpha', short(head)),
    ],
    decisions: [resolved('t2')],
  });
  await first.post('/api/comment-imports', [
    {
      type: 'reply',
      threadId: 't1',
      filePath: 'a.txt',
      position: { side: 'new', line: 2 },
      body: 'On it.',
    },
  ]);
  const before = await first.state();
  await first.stop();

  const second = await open(repo, createDiffSelection(base, 'main'));

  expect(await second.state()).toMatchObject({
    threads: before.threads,
    decisions: before.decisions,
  });
  const [t1] = await second.threads();
  expect(t1).toMatchObject({ codeSnapshot: { content: 'TWO', commit: short(head) } });
  expect(t1?.messages.map(({ body }) => body)).toEqual(['about TWO', 'On it.']);
  const output = await second.output();
  expect(output).toContain('a.txt:L2');
  expect(output).toContain('On it.');
  expect(output).not.toContain('b.txt');
  expect(output).not.toContain('바뀐 줄');
});

it('keeps the comments given at startup when started with --clean', async () => {
  const { repo, base } = createRepo();
  const selection = createDiffSelection(base, 'main');
  const given = {
    type: 'thread' as const,
    id: 'given',
    filePath: 'a.txt',
    position: { side: 'new' as const, line: 2 },
    body: 'Given at startup.',
  };
  const { port, server } = await startServer({
    selection,
    repoPath: repo,
    preferredPort: nextPort,
    clearComments: true,
    commentImports: [given],
  });
  nextPort = port + 1;
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
    server?.closeAllConnections();
  });

  const again = await open(repo, selection);

  expect((await again.threads()).map(({ id }) => id)).toEqual(['given']);
});

it('has the change on disk before it answers', async () => {
  const { repo, base, head } = createRepo();
  const review = await open(repo, createDiffSelection(base, 'main'));
  const recordPath = (await getReviewRecordPath(repo))!;

  await review.post('/api/comments', { threads: [thread('t1', 'a.txt', 2, 'TWO', short(head))] });
  expect((await readReviewRecord(recordPath)).reviews[0]?.threads.map(({ id }) => id)).toEqual([
    't1',
  ]);

  await review.post('/api/decisions', [resolved('t1')]);
  expect((await readReviewRecord(recordPath)).reviews[0]?.decisions).toEqual([resolved('t1')]);

  await fetch(`http://localhost:${review.port}/api/comments/t1`, { method: 'DELETE' });
  expect((await readReviewRecord(recordPath)).reviews[0]?.threads).toEqual([]);
});

it('shows the same threads from another worktree of the repository', async () => {
  const { repo, base, head } = createRepo();
  const first = await open(repo, createDiffSelection(base, 'main'));
  await first.post('/api/comments', { threads: [thread('t1', 'a.txt', 2, 'TWO', short(head))] });
  await first.stop();
  const other = mkdtempSync(join(tmpdir(), 'difit-review-record-worktree-'));
  cleanups.push(() => rmSync(other, { recursive: true, force: true, maxRetries: 10 }));
  git(repo, ['worktree', 'add', '-q', '--detach', join(other, 'tree'), head]);

  const second = await open(join(other, 'tree'), createDiffSelection(base, head));

  expect((await second.threads()).map(({ id }) => id)).toEqual(['t1']);
});

it('keeps another repository and another range apart', async () => {
  const { repo, base, head } = createRepo();
  const first = await open(repo, createDiffSelection(base, 'main'));
  await first.post('/api/comments', { threads: [thread('t1', 'a.txt', 2, 'TWO', short(head))] });
  await first.stop();

  const otherBase = await open(repo, createDiffSelection(`${head}^`, head, 'merge-base'));
  expect(await otherBase.threads()).toEqual([]);
  const elsewhere = createRepo();
  const otherRepo = await open(elsewhere.repo, createDiffSelection(elsewhere.base, 'main'));
  expect(await otherRepo.threads()).toEqual([]);
});

it('takes over the earlier review once commits are stacked on its target', async () => {
  const { repo, base, head } = createRepo();
  const first = await open(repo, createDiffSelection(base, 'main'));
  await first.post('/api/comments', {
    threads: [
      thread('moved', 'a.txt', 4, 'four', short(head)),
      thread('gone', 'a.txt', 2, 'TWO', short(head)),
      thread('done', 'b.txt', 1, 'alpha', short(head)),
    ],
    decisions: [resolved('done')],
  });
  await first.stop();
  const stacked = commit(repo, 'drop TWO, push four down', {
    'a.txt': lines('zero', 'one', 'three', 'four'),
  });

  const second = await open(repo, createDiffSelection(base, 'main'));

  const { threads, decisions } = await second.state();
  expect(threads.map(({ id }) => id).sort()).toEqual(['done', 'gone', 'moved']);
  expect(threads.find(({ id }) => id === 'gone')).toMatchObject({
    codeSnapshot: { content: 'TWO', commit: short(head) },
  });
  expect(decisions).toEqual([resolved('done')]);
  const [movedText, goneText] = (await second.output())
    .split('=====')
    .filter((section) => section.includes('about'))
    .sort((a, b) => Number(a.includes('about TWO')) - Number(b.includes('about TWO')));
  expect(movedText).toContain('a.txt:L4');
  expect(movedText).not.toContain('바뀐 줄');
  expect(goneText).toContain('a.txt:L2');
  expect(goneText).toContain('바뀐 줄: 지적을 단 코드가 지금 diff 에 없다');
  const { reviews } = await readReviewRecord((await getReviewRecordPath(repo))!);
  expect(reviews.map(({ selection }) => selection)).toEqual([
    createDiffSelection(short(base), short(stacked)),
  ]);
});

it('prints the line a taken-over thread moved to', async () => {
  const { repo, base, head } = createRepo();
  const first = await open(repo, createDiffSelection(base, 'main'));
  await first.post('/api/comments', {
    threads: [thread('moved', 'a.txt', 4, 'four', short(head))],
  });
  await first.stop();
  commit(repo, 'push four down', { 'a.txt': lines('zero', 'one', 'TWO', 'three', 'four') });

  const second = await open(repo, createDiffSelection(base, 'main'));

  const output = await second.output();
  expect(output).toContain('a.txt:L5');
  expect(output).not.toContain('바뀐 줄');
});

it('leaves a review alone when the base differs or its target is not an ancestor', async () => {
  const { repo, base, head } = createRepo();
  const first = await open(repo, createDiffSelection(base, 'main'));
  await first.post('/api/comments', { threads: [thread('t1', 'a.txt', 2, 'TWO', short(head))] });
  await first.stop();

  const stacked = commit(repo, 'more', { 'b.txt': lines('alpha', 'beta', 'gamma') });
  const otherBase = await open(repo, createDiffSelection(head, stacked));
  expect(await otherBase.threads()).toEqual([]);
  await otherBase.stop();

  git(repo, ['reset', '-q', '--hard', head]);
  git(repo, ['commit', '-q', '--amend', '-m', 'change, reworded']);
  const rewritten = await open(repo, createDiffSelection(base, 'main'));
  expect(await rewritten.threads()).toEqual([]);
  await rewritten.stop();

  const again = await open(repo, createDiffSelection(base, head));
  expect((await again.threads()).map(({ id }) => id)).toEqual(['t1']);
});

it('leaves out threads on a file the restarted diff does not have, on every reading', async () => {
  const { repo, base, head } = createRepo();
  const first = await open(repo, createDiffSelection(base, 'main'));
  await first.post('/api/comments', {
    threads: [
      thread('kept', 'a.txt', 2, 'TWO', short(head)),
      thread('out', 'b.txt', 1, 'alpha', short(head)),
    ],
  });
  await first.stop();
  commit(repo, 'take b.txt back out', { 'b.txt': null });

  const second = await open(repo, createDiffSelection(base, 'main'));

  expect((await second.threads()).map(({ id }) => id)).toEqual(['kept']);
  expect(await second.output()).not.toContain('b.txt');
  expect(await second.output()).toContain('Total comments: 1');
  const waiting = await (await fetch(`http://localhost:${second.port}/api/comments-wait`)).text();
  expect(waiting).toContain('"threadId":"kept"');
  expect(waiting).not.toContain('"threadId":"out"');
  const leftOut = await second.leftOut();
  expect(leftOut.threads.map(({ id }) => id)).toEqual(['out']);
  expect(leftOut.text).toContain('b.txt:L1');
  expect(leftOut.text).toContain('about alpha');

  // What the browser then saves holds only the threads it was given.
  await second.post('/api/comments', {
    threads: [...(await second.threads()), thread('new', 'a.txt', 1, 'one', 'unknown')],
  });
  expect((await second.leftOut()).threads.map(({ id }) => id)).toEqual(['out']);
  const { reviews } = await readReviewRecord((await getReviewRecordPath(repo))!);
  expect(reviews[0]?.threads.map(({ id }) => id).sort()).toEqual(['kept', 'new', 'out']);
});

it('shows a left-out thread again once its file is back in the diff', async () => {
  const { repo, base, head } = createRepo();
  const first = await open(repo, createDiffSelection(base, 'main'));
  await first.post('/api/comments', {
    threads: [thread('out', 'b.txt', 1, 'alpha', short(head))],
  });
  await first.stop();
  commit(repo, 'take b.txt back out', { 'b.txt': null });
  const without = await open(repo, createDiffSelection(base, 'main'));
  expect(await without.threads()).toEqual([]);
  await without.stop();
  commit(repo, 'put b.txt back', { 'b.txt': lines('alpha', 'beta') });

  const withFile = await open(repo, createDiffSelection(base, 'main'));

  expect((await withFile.threads()).map(({ id }) => id)).toEqual(['out']);
  expect((await withFile.leftOut()).threads).toEqual([]);
});

it('sets aside threads an agent copies onto a file the diff does not have', async () => {
  const { repo, base, head } = createRepo();
  const review = await open(repo, createDiffSelection(base, 'main'));

  const added = (await review.post('/api/comment-imports', [
    {
      type: 'thread',
      id: 'in',
      filePath: 'a.txt',
      position: { side: 'new', line: 2 },
      body: 'Keep.',
    },
    {
      type: 'thread',
      id: 'out',
      filePath: 'other.txt',
      position: { side: 'new', line: 7 },
      body: 'Lost?',
    },
    { type: 'reply', filePath: 'other.txt', position: { side: 'new', line: 7 }, body: 'A reply.' },
  ])) as { warnings: string[] };

  expect(added.warnings).toEqual([
    expect.stringContaining('Left out 1 thread(s) on files that are not in this diff: other.txt'),
  ]);
  expect((await review.threads()).map(({ id }) => id)).toEqual(['in']);
  expect(await review.output()).not.toContain('other.txt');
  const leftOut = await review.leftOut();
  expect(leftOut.threads.map(({ id }) => id)).toEqual(['out']);
  expect(leftOut.threads[0]?.messages.map(({ body }) => body)).toEqual(['Lost?', 'A reply.']);
  expect(leftOut.text).toContain('other.txt:L7');

  await review.stop();
  const again = await open(repo, createDiffSelection(base, head));
  expect((await again.threads()).map(({ id }) => id)).toEqual(['in']);
  expect((await again.leftOut()).threads.map(({ id }) => id)).toEqual(['out']);
});

it('keeps a thread on a file only a fixup of a pinned review changes', async () => {
  const { repo, base, head } = createRepo();
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'fixup! change', '-m', 'Review-Thread: t1']);
  writeFileSync(join(repo, 'extra.txt'), lines('extra'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--amend', '--no-edit']);
  const fixup = git(repo, ['rev-parse', 'HEAD']);
  const first = await open(repo, createDiffSelection(base, head));
  await first.post('/api/comments', {
    threads: [
      thread('t1', 'a.txt', 2, 'TWO', short(head)),
      thread('t2', 'extra.txt', 1, 'extra', short(fixup)),
    ],
  });
  await first.stop();

  const second = await open(repo, createDiffSelection(base, head));

  expect((await second.threads()).map(({ id }) => id)).toEqual(['t1', 't2']);
});

it('starts empty and forgets the stored reviews with --clean', async () => {
  const { repo, base, head } = createRepo();
  const first = await open(repo, createDiffSelection(base, 'main'));
  await first.post('/api/comments', { threads: [thread('t1', 'a.txt', 2, 'TWO', short(head))] });
  await first.stop();

  const cleaned = await open(repo, createDiffSelection(base, 'main'), { clearComments: true });
  expect(await cleaned.threads()).toEqual([]);
  expect((await readReviewRecord((await getReviewRecordPath(repo))!)).reviews).toEqual([]);
  await cleaned.stop();

  const after = await open(repo, createDiffSelection(base, 'main'));
  expect(await after.threads()).toEqual([]);
});

it('restores the review of another range when the browser opens it', async () => {
  const { repo, base, head } = createRepo();
  const earlier = commit(repo, 'more', { 'b.txt': lines('alpha', 'beta', 'gamma') });
  const first = await open(repo, createDiffSelection(head, earlier));
  await first.post('/api/comments', {
    threads: [thread('t1', 'b.txt', 3, 'gamma', short(earlier))],
  });
  await first.stop();

  const second = await open(repo, createDiffSelection(base, head));
  expect(await second.threads()).toEqual([]);
  await second.get(`/api/diff?base=${head}&target=${earlier}`);

  expect((await second.threads()).map(({ id }) => id)).toEqual(['t1']);
});

it('brings the threads back on the new SHAs after a reword rewrote the history', async () => {
  const { repo, base, head } = createRepo();
  const first = await open(repo, createDiffSelection(base, head));
  await first.post('/api/comments', {
    threads: [thread('t1', 'a.txt', 2, 'TWO', short(head))],
    decisions: [resolved('t1')],
  });
  const { rewritten } = (await first.post(`/api/reword?base=${base}&target=${head}`, {
    commit: head,
    original: 'change',
    message: 'change a and b',
    acknowledged: ['default-branch'],
  })) as { rewritten: Record<string, string> };
  const newHead = rewritten[head]!;
  await first.stop();

  const second = await open(repo, createDiffSelection(base, newHead));

  const [t1] = await second.threads();
  expect(t1).toMatchObject({ id: 't1', codeSnapshot: { commit: short(newHead) } });
  expect((await second.state()).decisions.map(({ threadId }) => threadId)).toEqual(['t1']);
  const path = (await getReviewRecordPath(repo))!;
  expect((await readReviewRecord(path)).reviews.map(({ selection }) => selection)).toEqual([
    createDiffSelection(short(base), short(newHead)),
  ]);
});

it('moves the earlier review into the one the browser reopens on a newer commit', async () => {
  const { repo, base, head } = createRepo();
  const review = await open(repo, createDiffSelection(base, head));
  await review.post('/api/comments', {
    threads: [
      thread('moved', 'a.txt', 4, 'four', short(head)),
      thread('done', 'b.txt', 1, 'alpha', short(head)),
    ],
    decisions: [resolved('done')],
  });
  const stacked = commit(repo, 'push four down', {
    'a.txt': lines('zero', 'one', 'TWO', 'three', 'four'),
  });
  const earlier = createDiffSelection(short(base), short(head));
  const reopened = createDiffSelection(short(base), short(stacked));

  const diff = (await review.get(`/api/diff?base=${base}&target=${stacked}`)) as DiffResponse;

  expect(diff.review?.selection).toEqual(reopened);
  expect(diff.reviewMoves).toEqual([{ from: earlier, to: reopened }]);
  const state = await review.state();
  expect(state.threads.map(({ id }) => id).sort()).toEqual(['done', 'moved']);
  expect(state.decisions).toEqual([resolved('done')]);
  expect(await review.output()).toContain('a.txt:L5');
  const { reviews } = await readReviewRecord((await getReviewRecordPath(repo))!);
  expect(reviews.map(({ selection }) => selection)).toEqual([reopened]);
  expect(reviews[0]?.threads.map(({ id }) => id).sort()).toEqual(['done', 'moved']);

  await review.stop();
  const restarted = await open(repo, createDiffSelection(base, stacked));
  expect(await restarted.state()).toMatchObject({
    threads: state.threads,
    decisions: state.decisions,
  });
});

it('hands the reopened review to a wait and to a tab that still ask for the earlier one', async () => {
  const { repo, base, head } = createRepo();
  const review = await open(repo, createDiffSelection(base, head));
  await review.post('/api/comments', {
    threads: [
      {
        ...thread('answered', 'a.txt', 2, 'TWO', short(head)),
        messages: [
          ...thread('answered', 'a.txt', 2, 'TWO', short(head)).messages,
          {
            id: 'reply',
            body: 'done',
            author: 'Agent',
            createdAt: '2026-01-01T00:00:01.000Z',
            updatedAt: '2026-01-01T00:00:01.000Z',
          },
        ],
      },
    ],
  });
  const waiting = new AbortController();
  cleanups.push(() => waiting.abort());
  const wait = fetch(`http://localhost:${review.port}/api/comments-wait`, {
    signal: waiting.signal,
  })
    .then((response) => response.text())
    .catch((error: unknown) => String(error));
  const stacked = commit(repo, 'more', { 'b.txt': lines('alpha', 'beta', 'gamma') });

  await review.get(`/api/diff?base=${base}&target=${stacked}`);
  await review.post(`/api/comments?base=${base}&target=${stacked}`, {
    threads: [...(await review.threads()), thread('later', 'b.txt', 3, 'gamma', short(stacked))],
  });

  expect(await wait).toContain('"threadId":"later"');
  const older = (await review.get(`/api/diff?base=${base}&target=${head}`)) as DiffResponse;
  expect(older.review?.selection).toEqual(createDiffSelection(short(base), short(stacked)));
  const asked = (await review.get(`/api/comments-json?base=${base}&target=${head}`)) as {
    threads: DiffCommentThread[];
  };
  expect(asked.threads.map(({ id }) => id)).toEqual(['answered', 'later']);
  const { reviews } = await readReviewRecord((await getReviewRecordPath(repo))!);
  expect(reviews).toHaveLength(1);
});

it('takes over a review behind the reopened one that another server stored', async () => {
  const { repo, base, head } = createRepo();
  const middle = commit(repo, 'more', { 'b.txt': lines('alpha', 'beta', 'gamma') });
  const other = await open(repo, createDiffSelection(base, middle));
  await other.post('/api/comments', {
    threads: [thread('theirs', 'b.txt', 3, 'gamma', short(middle))],
  });
  await other.stop();
  const review = await open(repo, createDiffSelection(base, head));
  await review.post('/api/comments', { threads: [thread('mine', 'a.txt', 2, 'TWO', short(head))] });
  const stacked = commit(repo, 'even more', { 'b.txt': lines('alpha', 'beta', 'gamma', 'delta') });
  const reopened = createDiffSelection(short(base), short(stacked));

  const diff = (await review.get(`/api/diff?base=${base}&target=${stacked}`)) as DiffResponse;

  expect((await review.threads()).map(({ id }) => id).sort()).toEqual(['mine', 'theirs']);
  expect(diff.reviewMoves?.map(({ from }) => from.targetCommitish).sort()).toEqual(
    [short(head), short(middle)].sort(),
  );
  const { reviews } = await readReviewRecord((await getReviewRecordPath(repo))!);
  expect(reviews.map(({ selection }) => selection)).toEqual([reopened]);
});

it('leaves out the threads of the earlier review on a file the reopened diff does not have', async () => {
  const { repo, base, head } = createRepo();
  const review = await open(repo, createDiffSelection(base, head));
  await review.post('/api/comments', {
    threads: [
      thread('kept', 'a.txt', 2, 'TWO', short(head)),
      thread('out', 'b.txt', 1, 'alpha', short(head)),
    ],
  });
  const stacked = commit(repo, 'take b.txt back out', { 'b.txt': null });

  await review.get(`/api/diff?base=${base}&target=${stacked}`);

  expect((await review.threads()).map(({ id }) => id)).toEqual(['kept']);
  expect((await review.leftOut()).threads.map(({ id }) => id)).toEqual(['out']);
  const { reviews } = await readReviewRecord((await getReviewRecordPath(repo))!);
  expect(reviews).toHaveLength(1);
  expect(reviews[0]?.threads.map(({ id }) => id).sort()).toEqual(['kept', 'out']);
});

it('carries the comments into the reopened review of a server started with --clean', async () => {
  const { repo, base, head } = createRepo();
  const review = await open(repo, createDiffSelection(base, head), { clearComments: true });
  await review.post('/api/comments', {
    threads: [
      thread('kept', 'a.txt', 2, 'TWO', short(head)),
      thread('out', 'b.txt', 1, 'alpha', short(head)),
    ],
  });
  const stacked = commit(repo, 'take b.txt back out', { 'b.txt': null });

  await review.get(`/api/diff?base=${base}&target=${stacked}`);

  expect((await review.threads()).map(({ id }) => id)).toEqual(['kept']);
  expect((await review.leftOut()).threads.map(({ id }) => id)).toEqual(['out']);
  const { reviews } = await readReviewRecord((await getReviewRecordPath(repo))!);
  expect(reviews.map(({ selection }) => selection)).toEqual([
    createDiffSelection(short(base), short(stacked)),
  ]);
});
