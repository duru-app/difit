import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { fetch } from 'undici';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import { startServer } from '../server/server.js';
import type { DiffCommentThread, DiffResponse } from '../types/diff.js';
import { createDiffSelection } from '../utils/diffSelection.js';

import { createCommentCommand } from './comment.js';

let home: string;
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-cli-placement-home-'));
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
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
});

afterAll(() => {
  process.env = savedEnv;
  globalThis.fetch = savedFetch;
  rmSync(home, { recursive: true, force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(repo: string, message: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(repo, path), content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

const at = '2026-11-19T00:00:00Z';
const thread = (
  id: string,
  line: number,
  content: string,
  snapshotCommit: string,
): DiffCommentThread => ({
  id,
  filePath: 'list.js',
  createdAt: at,
  updatedAt: at,
  position: { side: 'new', line },
  codeSnapshot: { content, commit: snapshotCommit },
  messages: [{ id, body: `About ${content}`, author: 'User', createdAt: at, updatedAt: at }],
});

async function run(args: string[]): Promise<string> {
  const written: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    written.push(`${parts.join(' ')}\n`);
  });
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string,
    done?: () => void,
  ) => {
    written.push(chunk);
    done?.();
    return true;
  }) as typeof process.stdout.write);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  try {
    await createCommentCommand().parseAsync(['node', 'difit', ...args]);
  } finally {
    log.mockRestore();
    write.mockRestore();
    exit.mockRestore();
  }
  return written.join('');
}

it('comment wait gives each thread the lines comment get prints for it', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-cli-placement-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const base = commit(repo, 'base', { 'README.md': 'list\n' });
  const before = commit(repo, 'add list', { 'list.js': 'alpha\nbeta\ngone\ntwin\n' });
  const after = commit(repo, 'grow list', {
    'list.js': 'intro\nmore\nalpha\nbeta\ntwin\nlast\ntwin\n',
  });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, after),
    repoPath: repo,
    preferredPort: 9345,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  const review = ((await (await fetch(api('/api/diff'))).json()) as DiffResponse).review!;
  const reviewQuery = `?base=${review.selection.baseCommitish}&target=${review.selection.targetCommitish}`;
  await fetch(api(`/api/comments${reviewQuery}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threads: [
        thread('moved', 2, 'beta', before),
        thread('missing', 3, 'gone', before),
        thread('ambiguous', 4, 'twin', before),
        thread('kept', 6, 'last', after),
      ],
    }),
  });

  const text = await run(['get', '--port', String(port)]);
  const { placements } = JSON.parse(
    await run(['get', '--port', String(port), '--format', 'json']),
  ) as { placements: Record<string, unknown> };
  const waited = (await run(['wait', '--port', String(port)]))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const byId = new Map(waited.map((line) => [line.threadId, line]));

  expect(new Set(byId.keys())).toEqual(new Set(['moved', 'missing', 'ambiguous', 'kept']));
  for (const [id, line] of byId) expect(line.placement).toEqual(placements[id as string]);

  expect(byId.get('moved')).toMatchObject({
    position: { side: 'new', line: 2 },
    placement: { kind: 'moved', line: 4 },
  });
  expect(text).toContain('list.js:L4 [답변 대기]\n처음 단 줄: L2\n');

  expect(byId.get('missing')).toMatchObject({
    position: { side: 'new', line: 3 },
    placement: { kind: 'stale', reason: 'missing', line: 3 },
  });
  expect(text).toContain(
    'list.js:L3 [답변 대기]\n바뀐 줄: 지적을 단 코드가 지금 diff 에 없다. 위 줄 번호는 지적을 단 때의 것이다.\n',
  );
  expect(byId.get('ambiguous')).toMatchObject({
    position: { side: 'new', line: 4 },
    placement: { kind: 'stale', reason: 'ambiguous', line: 4 },
  });
  expect(text).toContain(
    'list.js:L4 [답변 대기]\n바뀐 줄: 지적을 단 코드가 지금 diff 의 여러 곳에 있다. 위 줄 번호는 지적을 단 때의 것이다.\n',
  );

  expect(byId.get('kept')).toEqual({
    threadId: 'kept',
    filePath: 'list.js',
    position: { side: 'new', line: 6 },
    message: 'About last',
    state: 'awaiting-fix',
    label: '답변 대기',
  });
  expect(text).toContain('list.js:L6 [답변 대기]\nAbout last');
});
