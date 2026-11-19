import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { fetch } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from './server.js';
import type { DiffCommentThread } from '../types/diff.js';
import { createDiffSelection } from '../utils/diffSelection.js';

let home: string;
const savedEnv = { ...process.env };
const cleanups: Array<() => Promise<void> | void> = [];
let nextPort = 9600;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-walkthrough-home-'));
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

function commit(repo: string, message: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

const lines = (...content: string[]) => `${content.join('\n')}\n`;

function createRepo(): { repo: string; base: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), 'difit-walkthrough-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true, maxRetries: 10 }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const base = commit(repo, 'base', { 'a.txt': lines('one', 'two', 'three') });
  const head = commit(repo, 'change', { 'a.txt': lines('one', 'TWO', 'three', 'four') });
  return { repo, base, head };
}

interface Answer {
  status: number;
  body: any;
}

async function open(repo: string, base: string) {
  const { port, server } = await startServer({
    selection: createDiffSelection(base, 'main'),
    repoPath: repo,
    preferredPort: nextPort,
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
  const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const response = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const threads = async () =>
    ((await call('GET', '/api/comments-json')).body as { threads: DiffCommentThread[] }).threads;
  return { port, stop, call, threads };
}

type Review = Awaited<ReturnType<typeof open>>;

async function askAndAnswer(review: Review, threadId = 't1') {
  await review.call('POST', '/api/comments', {
    threads: [
      {
        id: threadId,
        filePath: 'a.txt',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        position: { side: 'new', line: 2 },
        messages: [
          {
            id: threadId,
            body: '이 값이 어디서 오는지 흐름을 보여 주세요.',
            author: 'User',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ],
  });
  await review.call('POST', '/api/comment-imports', [
    {
      type: 'reply',
      threadId,
      filePath: 'a.txt',
      position: { side: 'new', line: 2 },
      body: '따라가기를 붙였습니다.',
    },
  ]);
}

const walkthrough = (...steps: Array<Record<string, unknown>>) => ({
  cases: [{ title: '정상 흐름', steps }],
});

describe('walkthrough API', () => {
  it("attaches an uploaded walkthrough to the thread's latest agent reply", async () => {
    const { repo, base, head } = createRepo();
    const review = await open(repo, base);
    await askAndAnswer(review);

    const added = await review.call(
      'PUT',
      '/api/threads/t1/walkthrough',
      walkthrough({ file: 'a.txt', line: 2, description: '두 번째 줄에서 값을 바꾼다.' }),
    );

    expect(added).toMatchObject({ status: 200, body: { success: true, warnings: [] } });
    const [thread] = await review.threads();
    const reply = thread?.messages[1];
    expect(added.body.messageId).toBe(reply?.id);
    expect(reply?.walkthrough).toEqual({
      commit: head,
      cases: [
        {
          title: '정상 흐름',
          steps: [{ file: 'a.txt', line: 2, description: '두 번째 줄에서 값을 바꾼다.' }],
        },
      ],
    });
    expect((await review.call('GET', '/api/threads/t1/walkthrough')).body).toEqual({
      threadId: 't1',
      messageId: reply?.id,
      walkthrough: reply?.walkthrough,
    });
  });

  it('keeps the walkthrough through a later comment add and a save from a stale tab', async () => {
    const { repo, base } = createRepo();
    const review = await open(repo, base);
    await askAndAnswer(review);
    const { body: before } = await review.call('GET', '/api/comments-json');
    await review.call(
      'PUT',
      '/api/threads/t1/walkthrough',
      walkthrough({ file: 'a.txt', line: 2, description: '값을 바꾼다.' }),
    );

    await review.call('POST', '/api/comment-imports', [
      { type: 'thread', filePath: 'a.txt', position: { side: 'new', line: 4 }, body: '덧붙임' },
    ]);
    await review.call('POST', '/api/comments', {
      threads: before.threads,
      baseVersion: before.version,
    });

    const [thread] = await review.threads();
    expect(thread?.messages[1]?.walkthrough?.cases[0]?.steps).toHaveLength(1);
  });

  it('prints no edit time in comment get under a reply whose walkthrough was only attached or removed', async () => {
    const { repo, base } = createRepo();
    const review = await open(repo, base);
    await askAndAnswer(review);
    const path = '/api/threads/t1/walkthrough';
    const output = async () =>
      (await fetch(`http://localhost:${review.port}/api/comments-output`)).text();

    await review.call('PUT', path, walkthrough({ file: 'a.txt', line: 2, description: '값' }));
    const attached = await output();
    await review.call('DELETE', path);
    const removed = await output();

    expect(attached).toContain('따라가기를 붙였습니다.');
    expect(attached).not.toContain('고친 시각');
    expect(removed).toContain('따라가기를 붙였습니다.');
    expect(removed).not.toContain('고친 시각');
  });

  it('prints the edit time in comment get and keeps the walkthrough when a tab that loaded before it edits the reply', async () => {
    const { repo, base } = createRepo();
    const review = await open(repo, base);
    await askAndAnswer(review);
    const { body: loaded } = await review.call('GET', '/api/comments-json');
    await review.call(
      'PUT',
      '/api/threads/t1/walkthrough',
      walkthrough({ file: 'a.txt', line: 2, description: '값' }),
    );
    const [thread] = loaded.threads as DiffCommentThread[];
    const editedAt = new Date(Date.now() + 60_000).toISOString();
    const edited = {
      ...thread!,
      messages: thread!.messages.map((message, index) =>
        index === 1
          ? { ...message, body: '따라가기를 고쳐 붙였습니다.', updatedAt: editedAt }
          : message,
      ),
    };

    await review.call('POST', '/api/comments', {
      threads: [edited],
      baseVersion: loaded.version,
    });

    const [saved] = await review.threads();
    expect(saved?.messages[1]?.body).toBe('따라가기를 고쳐 붙였습니다.');
    expect(saved?.messages[1]?.walkthrough?.cases[0]?.steps).toHaveLength(1);
    const output = await (
      await fetch(`http://localhost:${review.port}/api/comments-output`)
    ).text();
    expect(output).toContain(`고친 시각: ${editedAt}\n따라가기를 고쳐 붙였습니다.`);
  });

  it('warns about each step whose file or line the review target does not have', async () => {
    const { repo, base, head } = createRepo();
    const review = await open(repo, base);
    await askAndAnswer(review);

    const added = await review.call(
      'PUT',
      '/api/threads/t1/walkthrough',
      walkthrough(
        { file: 'a.txt', line: 4, description: '마지막 줄' },
        { file: 'missing.ts', line: 1, description: '없는 파일' },
        { file: 'a.txt', line: 3, endLine: 9, description: '파일 끝을 넘는다' },
      ),
    );

    expect(added.body.success).toBe(true);
    expect(added.body.warnings).toEqual([
      `step 2: missing.ts is not in ${head.slice(0, 7)}`,
      'step 3: a.txt has 4 lines, so line 9 is not there',
    ]);
  });

  it('replaces the walkthrough on the same reply and removes it on request', async () => {
    const { repo, base } = createRepo();
    const review = await open(repo, base);
    await askAndAnswer(review);
    const path = '/api/threads/t1/walkthrough';
    await review.call('PUT', path, walkthrough({ file: 'a.txt', line: 1, description: '처음' }));

    await review.call('PUT', path, walkthrough({ file: 'a.txt', line: 2, description: '고친 것' }));

    const [thread] = await review.threads();
    expect(thread?.messages.filter((message) => message.walkthrough)).toHaveLength(1);
    expect(thread?.messages[1]?.walkthrough?.cases[0]?.steps[0]?.description).toBe('고친 것');

    expect((await review.call('DELETE', path)).body).toMatchObject({ success: true });
    expect((await review.threads())[0]?.messages[1]).not.toHaveProperty('walkthrough');
    expect((await review.call('GET', path)).status).toBe(404);
  });

  it('keeps a removed walkthrough removed through a save from a tab that loaded it', async () => {
    const { repo, base } = createRepo();
    const review = await open(repo, base);
    await askAndAnswer(review);
    const path = '/api/threads/t1/walkthrough';
    await review.call('PUT', path, walkthrough({ file: 'a.txt', line: 2, description: '값' }));
    const { body: loaded } = await review.call('GET', '/api/comments-json');

    await review.call('DELETE', path);
    await review.call('POST', '/api/comments', {
      threads: loaded.threads,
      baseVersion: loaded.version,
    });

    expect((await review.threads())[0]?.messages[1]).not.toHaveProperty('walkthrough');
    expect((await review.call('GET', path)).status).toBe(404);
  });

  it('moves the walkthrough to a newer agent reply when uploaded again', async () => {
    const { repo, base } = createRepo();
    const review = await open(repo, base);
    await askAndAnswer(review);
    const path = '/api/threads/t1/walkthrough';
    await review.call('PUT', path, walkthrough({ file: 'a.txt', line: 1, description: '처음' }));
    await review.call('POST', '/api/comment-imports', [
      {
        type: 'reply',
        threadId: 't1',
        filePath: 'a.txt',
        position: { side: 'new', line: 2 },
        body: '다시 붙였습니다.',
      },
    ]);

    const moved = await review.call(
      'PUT',
      path,
      walkthrough({ file: 'a.txt', line: 2, description: '고친 것' }),
    );

    const [thread] = await review.threads();
    expect(moved.body.messageId).toBe(thread?.messages[2]?.id);
    expect(thread?.messages.map((message) => message.walkthrough !== undefined)).toEqual([
      false,
      false,
      true,
    ]);
    await review.call('DELETE', path);
    expect((await review.call('GET', path)).status).toBe(404);
  });

  it('leaves the walkthrough of a deleted thread alone', async () => {
    const { repo, base } = createRepo();
    const review = await open(repo, base);
    await askAndAnswer(review);
    const path = '/api/threads/t1/walkthrough';
    await review.call('PUT', path, walkthrough({ file: 'a.txt', line: 2, description: '값' }));
    await review.call('POST', '/api/decisions', [
      { threadId: 't1', kind: 'deleted', fixupSha: '', at: '2026-01-02T00:00:00Z' },
    ]);

    expect((await review.call('DELETE', path)).status).toBe(404);
    expect((await review.threads())[0]?.messages[1]?.walkthrough).toBeDefined();
  });

  it('refuses a walkthrough it cannot play or that no agent reply can carry', async () => {
    const { repo, base } = createRepo();
    const review = await open(repo, base);
    await askAndAnswer(review);
    await review.call('POST', '/api/comment-imports', [
      { type: 'thread', filePath: 'a.txt', position: { side: 'new', line: 3 }, body: '혼자 쓴 글' },
    ]);
    const agentThread = (await review.threads()).find(({ id }) => id !== 't1');
    const step = { file: 'a.txt', line: 2, description: '값을 바꾼다.' };

    const noSteps = await review.call('PUT', '/api/threads/t1/walkthrough', { cases: [] });
    const twoCases = await review.call('PUT', '/api/threads/t1/walkthrough', {
      cases: [{ steps: [step] }, { steps: [step] }],
    });
    const noReply = await review.call(
      'PUT',
      `/api/threads/${agentThread?.id}/walkthrough`,
      walkthrough(step),
    );
    const noThread = await review.call('PUT', '/api/threads/nope/walkthrough', walkthrough(step));

    expect(noSteps).toEqual({
      status: 400,
      body: { error: 'Invalid walkthrough: "cases" needs one case' },
    });
    expect(twoCases).toEqual({
      status: 400,
      body: { error: 'Invalid walkthrough: only one case is supported for now' },
    });
    expect(noReply.status).toBe(409);
    expect(noThread.status).toBe(404);
  });
});
