import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { fetch } from 'undici';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { startServer } from './server.js';
import type { DiffCommentThread, DiffResponse } from '../types/diff.js';
import { createDiffSelection } from '../utils/diffSelection.js';

let home: string;
const savedEnv = { ...process.env };
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-comment-placement-home-'));
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
  rmSync(home, { recursive: true, force: true });
});

afterEach(async () => {
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

const at = '2026-11-15T00:00:00Z';
const thread = (
  id: string,
  line: number,
  content: string,
  snapshotCommit: string,
  view?: { baseCommitish: string; targetCommitish: string },
): DiffCommentThread => ({
  id,
  ...(view ? { view } : {}),
  filePath: 'list.js',
  createdAt: at,
  updatedAt: at,
  position: { side: 'new', line },
  codeSnapshot: { content, commit: snapshotCommit },
  messages: [{ id, body: `About ${content}`, author: 'User', createdAt: at, updatedAt: at }],
});

it('gives the lines the screen finds now, and keeps where each comment was made', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-comment-placement-'));
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
    preferredPort: 9318,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  const review = ((await (await fetch(api('/api/diff'))).json()) as DiffResponse).review!;
  const reviewQuery = `?base=${review.selection.baseCommitish}&target=${review.selection.targetCommitish}`;
  const threads = [
    thread('moved', 2, 'beta', before),
    thread('missing', 3, 'gone', before),
    thread('ambiguous', 4, 'twin', before),
    thread('kept', 6, 'last', after),
  ];
  await fetch(api(`/api/comments${reviewQuery}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threads }),
  });

  const output = await (await fetch(api('/api/comments-output'))).text();
  expect(output).toContain('list.js:L4 [답변 대기]\n처음 단 줄: L2\n');
  expect(output).toContain(
    'list.js:L3 [답변 대기]\n바뀐 줄: 지적을 단 코드가 지금 diff 에 없다. 위 줄 번호는 지적을 단 때의 것이다.\n',
  );
  expect(output).toContain(
    'list.js:L4 [답변 대기]\n바뀐 줄: 지적을 단 코드가 지금 diff 의 여러 곳에 있다. 위 줄 번호는 지적을 단 때의 것이다.\n',
  );
  expect(output).toContain('list.js:L6 [답변 대기]\nAbout last');

  const json = (await (await fetch(api('/api/comments-json?placements=true'))).json()) as {
    threads: DiffCommentThread[];
    placements: unknown;
  };
  expect(json.threads).toEqual(threads.map((t) => expect.objectContaining(t)));
  expect(json.placements).toEqual({
    moved: { kind: 'moved', line: 4 },
    missing: { kind: 'stale', reason: 'missing', line: 3 },
    ambiguous: { kind: 'stale', reason: 'ambiguous', line: 4 },
  });
  const plain = (await (await fetch(api('/api/comments-json'))).json()) as object;
  expect(plain).not.toHaveProperty('placements');
});

it('finds the lines of a comment made on one commit in that commit, not in the review target', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-comment-placement-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const base = commit(repo, 'base', { 'README.md': 'list\n' });
  const first = commit(repo, 'add list', { 'list.js': 'alpha\nbeta\n' });
  const second = commit(repo, 'grow list', { 'list.js': 'intro\nmore\nalpha\nbeta\n' });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, second),
    repoPath: repo,
    preferredPort: 9319,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  const review = ((await (await fetch(api('/api/diff'))).json()) as DiffResponse).review!;
  const reviewQuery = `?base=${review.selection.baseCommitish}&target=${review.selection.targetCommitish}`;
  const threads = [
    thread('on-first', 2, 'beta', first, { baseCommitish: base, targetCommitish: first }),
    thread('on-second', 1, 'alpha', first, { baseCommitish: first, targetCommitish: second }),
  ];
  await fetch(api(`/api/comments${reviewQuery}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threads }),
  });

  const json = (await (await fetch(api('/api/comments-json?placements=true'))).json()) as {
    placements: unknown;
  };
  expect(json.placements).toEqual({ 'on-second': { kind: 'moved', line: 3 } });
  const output = await (await fetch(api('/api/comments-output'))).text();
  expect(output).toContain('list.js:L2 [답변 대기]\nAbout beta');
  expect(output).toContain('list.js:L3 [답변 대기]\n처음 단 줄: L1\n');
});

it('finds the lines in the diff the screen opens with, which ignores whitespace changes', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-comment-placement-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const middle = 'mid1\nmid2\nmid3\nmid4\nmid5\nmid6\nmid7\nend\n';
  const base = commit(repo, 'base', { 'list.js': `top\nbeta\n  ws\n${middle}` });
  git(repo, ['checkout', '-q', '-b', 'before-reorder']);
  const before = commit(repo, 'reindent and add', {
    'list.js': `top\nbeta\n    ws\n${middle}beta\n`,
  });
  git(repo, ['checkout', '-q', 'main']);
  const inserted = commit(repo, 'insert n', {
    'list.js': `top\nbeta\n  ws\nmid1\nmid2\nmid3\nmid4\nn1\nn2\nmid5\nmid6\nmid7\nend\n`,
  });
  const reordered = commit(repo, 'reindent and add', {
    'list.js': `top\nbeta\n    ws\nmid1\nmid2\nmid3\nmid4\nn1\nn2\nmid5\nmid6\nmid7\nend\nbeta\n`,
  });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, reordered),
    repoPath: repo,
    preferredPort: 9320,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  const review = ((await (await fetch(api('/api/diff'))).json()) as DiffResponse).review!;
  const reviewQuery = `?base=${review.selection.baseCommitish}&target=${review.selection.targetCommitish}`;
  const threads = [
    thread('appended', 12, 'beta', before, { baseCommitish: inserted, targetCommitish: reordered }),
  ];
  await fetch(api(`/api/comments${reviewQuery}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threads }),
  });

  const json = (await (await fetch(api('/api/comments-json?placements=true'))).json()) as {
    placements: unknown;
  };
  expect(json.placements).toEqual({ appended: { kind: 'moved', line: 14 } });
});
