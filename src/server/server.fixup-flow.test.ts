import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import { fetch } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from './server.js';
import type { DiffResponse, RewriteBlockingThread, RewordResponse } from '../types/diff.js';
import { bindingForView, createDiffSelection } from '../utils/diffSelection.js';

let home: string;
const savedEnv = { ...process.env };
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-home-'));
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

function git(repo: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
}

function commit(repo: string, message: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(repo, path), content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

const PINNING_TEST = `import { discount } from './discount.js';

test('discount', () => {
  expect(discount(105)).toBe(10.5);
});
`;

it('folds the fixup for a comment made on one commit into that commit', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const base = commit(repo, 'base', {
    'discount.js': 'export function discount(price) {\n  return price * 0.1;\n}\n',
  });
  const pin = commit(repo, 'test: pin current discount', { 'discount.test.js': PINNING_TEST });
  const fix = commit(repo, 'fix: round discount down', {
    'discount.js': 'export function discount(price) {\n  return Math.floor(price * 0.1);\n}\n',
  });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, fix),
    repoPath: repo,
    preferredPort: 9260,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  const text = async (path: string) => (await fetch(api(path))).text();

  const whole = (await (await fetch(api('/api/diff'))).json()) as DiffResponse;
  const review = whole.review!;
  const reviewQuery = `?base=${review.selection.baseCommitish}&target=${review.selection.targetCommitish}`;
  const shown = (await (
    await fetch(api(`/api/diff?base=${base}&target=${pin}`))
  ).json()) as DiffResponse;
  const binding = bindingForView(
    review,
    createDiffSelection(shown.baseCommitish!, shown.targetCommitish!),
  )!;
  const at = '2026-10-19T00:00:00Z';
  await fetch(api(`/api/comments${reviewQuery}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threads: [
        {
          id: 't1',
          filePath: 'discount.test.js',
          createdAt: at,
          updatedAt: at,
          position: { side: 'new', line: 3 },
          codeSnapshot: { content: "test('discount', () => {", commit: binding.snapshotCommit },
          view: binding.view,
          fixupTarget: binding.fixupTarget,
          messages: [
            { id: 't1', body: 'Say what it pins.', author: 'User', createdAt: at, updatedAt: at },
          ],
        },
      ],
    }),
  });

  const json = (await (await fetch(api('/api/comments-json'))).json()) as {
    threads: Array<{ view?: unknown; fixupTarget?: string }>;
  };
  expect(json.threads[0]?.view).toEqual({ baseCommitish: base, targetCommitish: pin });
  expect(json.threads[0]?.fixupTarget).toBe(pin);
  const shortPin = git(repo, ['rev-parse', '--short', pin]);
  expect(await text('/api/comments-output')).toContain(
    `discount.test.js:L3 [답변 대기]\n고쳐 넣을 커밋: ${shortPin} test: pin current discount\n`,
  );
  expect(await text('/api/comments-wait')).toContain(`"fixupTarget":"${pin}"`);

  writeFileSync(
    join(repo, 'discount.test.js'),
    PINNING_TEST.replace("test('discount'", "test('takes ten percent without rounding'"),
  );
  git(repo, ['commit', '-q', '-a', `--fixup=${pin}`, '--trailer', 'Review-Thread: t1']);
  const fixup = git(repo, ['rev-parse', 'HEAD']);

  const fixups = (await (await fetch(api(`/api/fixups${reviewQuery}`))).json()) as {
    fixups: Array<{ sha: string; threadIds: string[] }>;
  };
  expect(fixups.fixups.map(({ sha, threadIds }) => ({ sha, threadIds }))).toEqual([
    { sha: fixup, threadIds: ['t1'] },
  ]);
  expect(await text('/api/comments-output')).toContain('discount.test.js:L3 [승인 대기]');
  const decide = (decision: Record<string, string>) =>
    fetch(api('/api/decisions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ threadId: 't1', at: new Date().toISOString(), ...decision }]),
    });
  await decide({ kind: 'approved', fixupSha: fixup });
  expect(await text('/api/comments-output')).toContain('discount.test.js:L3 [승인됨]');

  const before = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['rebase', '-q', '-i', '--autosquash', base], { GIT_SEQUENCE_EDITOR: ':' });

  expect(git(repo, ['log', '--format=%s', `${base}..HEAD`]).split('\n')).toEqual([
    'fix: round discount down',
    'test: pin current discount',
  ]);
  expect(git(repo, ['diff', '--exit-code', before, 'HEAD'])).toBe('');
  const newPin = git(repo, ['rev-parse', 'HEAD^']);
  expect(git(repo, ['show', newPin, '--', 'discount.test.js'])).toContain(
    "+test('takes ten percent without rounding', () => {",
  );
  expect(git(repo, ['show', '--name-only', '--format=', 'HEAD'])).toBe('discount.js');
  expect(git(repo, ['log', '-1', '--format=%B', newPin])).not.toContain('Review-Thread');

  await decide({ kind: 'folded', fixupSha: fixup, targetSha: newPin });
  expect(await text('/api/comments-output')).toContain('discount.test.js:L3 [접힘]');
});

it('folds the fixups for comments made on a run and on the whole review into the commits that made their lines', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const base = commit(repo, 'base', {
    'discount.js': 'export function discount(price) {\n  return price * 0.1;\n}\n',
  });
  const pin = commit(repo, 'test: pin current discount', { 'discount.test.js': PINNING_TEST });
  const fix = commit(repo, 'fix: round discount down', {
    'discount.js': 'export function discount(price) {\n  return Math.floor(price * 0.1);\n}\n',
  });
  const docs = commit(repo, 'docs: say discounts round down', { 'README.md': 'Rounds down.\n' });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, docs),
    repoPath: repo,
    preferredPort: 9270,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;

  const whole = (await (await fetch(api('/api/diff'))).json()) as DiffResponse;
  const review = whole.review!;
  const reviewQuery = `?base=${review.selection.baseCommitish}&target=${review.selection.targetCommitish}`;
  const run = (await (
    await fetch(api(`/api/diff?base=${base}&target=${fix}`))
  ).json()) as DiffResponse;
  const bind = async (shown: DiffResponse, path: string, line: number) => {
    const view = createDiffSelection(shown.baseCommitish!, shown.targetCommitish!);
    const params = new URLSearchParams({
      base: view.baseCommitish,
      target: view.targetCommitish,
      path,
      start: String(line),
      end: String(line),
      side: 'new',
    });
    const { fixupTarget } = (await (
      await fetch(api(`/api/fixup-target?${params.toString()}`))
    ).json()) as { fixupTarget: string };
    return bindingForView(review, view, fixupTarget)!;
  };
  const onRun = await bind(run, 'discount.test.js', 3);
  const onWhole = await bind(whole, 'discount.js', 2);
  expect(onRun).toEqual({
    view: { baseCommitish: base, targetCommitish: fix },
    fixupTarget: pin,
    snapshotCommit: fix,
  });
  expect(onWhole).toEqual({ fixupTarget: fix });
  const status = async (query: Record<string, string>) =>
    (await fetch(api(`/api/fixup-target?${new URLSearchParams(query).toString()}`))).status;
  const line = { path: 'discount.js', start: '1', end: '1' };
  expect(await status({ base: docs, target: base, side: 'new', ...line })).toBe(404);
  expect(await status({ base, target: fix, side: 'middle', ...line })).toBe(400);
  expect(await status({ base, target: docs, side: 'new', ...line, range: '2' })).toBe(400);
  const target = async (query: string) =>
    (
      (await (await fetch(api(`/api/fixup-target?${query}`))).json()) as {
        fixupTarget: string;
      }
    ).fixupTarget;
  const unchangedLine = `base=${base}&target=${docs}&side=new&path=discount.js&start=3&end=3`;
  expect(await target(unchangedLine)).toBe(docs);
  expect(await target(`${unchangedLine}&range=1-1&range=2-2`)).toBe(fix);
  expect(await target(`${unchangedLine}&range=old:2-2`)).toBe(docs);
  expect(await status({ base, target: docs, side: 'new', ...line, range: 'left:2-2' })).toBe(400);

  const at = '2026-10-20T00:00:00Z';
  const thread = (id: string, filePath: string, line: number, content: string) => ({
    id,
    filePath,
    createdAt: at,
    updatedAt: at,
    position: { side: 'new', line },
    codeSnapshot: { content, commit: docs },
    messages: [{ id, body: 'Fix this.', author: 'User', createdAt: at, updatedAt: at }],
  });
  await fetch(api(`/api/comments${reviewQuery}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threads: [
        {
          ...thread('t1', 'discount.test.js', 3, "test('discount', () => {"),
          codeSnapshot: { content: "test('discount', () => {", commit: onRun.snapshotCommit },
          view: onRun.view,
          fixupTarget: onRun.fixupTarget,
        },
        {
          ...thread('t2', 'discount.js', 2, '  return Math.floor(price * 0.1);'),
          fixupTarget: onWhole.fixupTarget,
        },
      ],
    }),
  });

  const json = (await (await fetch(api('/api/comments-json'))).json()) as {
    threads: Array<{ id: string; fixupTarget?: string }>;
  };
  expect(json.threads.map(({ id, fixupTarget }) => ({ id, fixupTarget }))).toEqual([
    { id: 't1', fixupTarget: pin },
    { id: 't2', fixupTarget: fix },
  ]);

  writeFileSync(
    join(repo, 'discount.test.js'),
    PINNING_TEST.replace("test('discount'", "test('takes ten percent without rounding'"),
  );
  git(repo, ['commit', '-q', '-a', `--fixup=${pin}`, '--trailer', 'Review-Thread: t1']);
  writeFileSync(
    join(repo, 'discount.js'),
    'export function discount(price) {\n  return Math.floor(price / 10);\n}\n',
  );
  git(repo, ['commit', '-q', '-a', `--fixup=${fix}`, '--trailer', 'Review-Thread: t2']);
  const before = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['rebase', '-q', '-i', '--autosquash', base], { GIT_SEQUENCE_EDITOR: ':' });

  expect(git(repo, ['diff', '--exit-code', before, 'HEAD'])).toBe('');
  expect(git(repo, ['log', '--format=%s', `${base}..HEAD`]).split('\n')).toEqual([
    'docs: say discounts round down',
    'fix: round discount down',
    'test: pin current discount',
  ]);
  expect(git(repo, ['show', 'HEAD~2:discount.test.js'])).toContain(
    "test('takes ten percent without rounding'",
  );
  expect(git(repo, ['show', 'HEAD~1:discount.js'])).toContain('Math.floor(price / 10)');
});

it('binds a comment on the whole file to the last commit that changed it and hands it over without a line', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const base = commit(repo, 'base', {
    'discount.js': 'export function discount(price) {\n  return price * 0.1;\n}\n',
  });
  const pin = commit(repo, 'test: pin current discount', { 'discount.test.js': PINNING_TEST });
  const docs = commit(repo, 'docs: say discounts round down', { 'README.md': 'Rounds down.\n' });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, docs),
    repoPath: repo,
    preferredPort: 9280,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  const fixupTarget = async (query: Record<string, string>) => {
    const response = await fetch(
      api(
        `/api/fixup-target?${new URLSearchParams({ base, target: docs, side: 'new', ...query })}`,
      ),
    );
    return response.ok
      ? ((await response.json()) as { fixupTarget: string }).fixupTarget
      : response.status;
  };

  expect(await fixupTarget({ path: 'discount.test.js', scope: 'file' })).toBe(pin);
  expect(await fixupTarget({ path: 'discount.test.js', scope: 'file', start: '1', end: '1' })).toBe(
    400,
  );
  expect(await fixupTarget({ path: 'discount.test.js', scope: 'folder' })).toBe(400);

  const imported = await fetch(api('/api/comment-imports'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      {
        type: 'thread',
        id: 't1',
        filePath: 'discount.test.js',
        position: { side: 'new', scope: 'file' },
        body: 'Name the test after the rule it pins.',
        author: 'User',
        fixupTarget: pin,
      },
    ]),
  });
  expect(imported.status).toBe(200);

  const output = await (await fetch(api('/api/comments-output'))).text();
  expect(output).toContain('\ndiscount.test.js [답변 대기]\n');
  expect(output).not.toContain('discount.test.js:');
  const waited = await (await fetch(api('/api/comments-wait'))).text();
  expect(JSON.parse(waited.split('data: ')[1]!)).toEqual([
    expect.objectContaining({
      threadId: 't1',
      filePath: 'discount.test.js',
      position: { side: 'new', scope: 'file' },
      fixupTarget: pin,
    }),
  ]);

  writeFileSync(
    join(repo, 'discount.test.js'),
    PINNING_TEST.replace("test('discount'", "test('takes ten percent without rounding'"),
  );
  git(repo, ['commit', '-q', '-a', '-m', `fixup! ${pin}`, '-m', 'Review-Thread: t1']);
  expect(await (await fetch(api('/api/comments-output'))).text()).toContain(
    '\ndiscount.test.js [승인 대기]\n',
  );
});

it('keeps a comment on a whole commit without a file and hands it over naming the commit', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const base = commit(repo, 'base', { 'discount.js': 'export const rate = 0.1;\n' });
  const pin = commit(repo, 'test: pin current discount', { 'discount.test.js': PINNING_TEST });
  const docs = commit(repo, 'docs: say discounts round down', { 'README.md': 'Rounds down.\n' });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, docs),
    repoPath: repo,
    preferredPort: 9285,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  const onCommit = {
    id: 't1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    position: { scope: 'commit' },
    view: createDiffSelection(base, pin),
    fixupTarget: pin,
    messages: [
      {
        id: 't1',
        body: 'Name the commit after the rule it pins.',
        author: 'User',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
  };

  const saved = await fetch(api('/api/comments'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threads: [onCommit] }),
  });
  expect(saved.status).toBe(200);

  const stored = (await (await fetch(api('/api/comments-json'))).json()) as {
    threads: Array<Record<string, unknown>>;
  };
  expect(stored.threads).toEqual([expect.objectContaining({ position: { scope: 'commit' } })]);
  expect(stored.threads[0]).not.toHaveProperty('filePath');
  const output = await (await fetch(api('/api/comments-output'))).text();
  expect(output).toContain(
    `\n커밋 ${pin.slice(0, 7)} test: pin current discount [답변 대기]\nName the commit`,
  );
  const waited = await (await fetch(api('/api/comments-wait'))).text();
  const [handed] = JSON.parse(waited.split('data: ')[1]!) as Array<Record<string, unknown>>;
  expect(handed).toMatchObject({ threadId: 't1', position: { scope: 'commit' }, fixupTarget: pin });
  expect(handed).not.toHaveProperty('filePath');
});

it('rewords a commit in place and moves the review, its comments and its decisions onto the new SHAs', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const base = commit(repo, 'base', { 'price.js': 'export const price = 1;\n' });
  const typo = commit(repo, 'add prcie helper\n\nRounds down.', {
    'helper.js': 'export const helper = 1;\n',
  });
  const tip = commit(repo, 'use helper', { 'price.js': 'export const price = 2;\n' });
  writeFileSync(join(repo, 'helper.js'), 'export const helper = 2;\n');
  git(repo, ['commit', '-q', '-a', '-m', `fixup! ${typo}\n\nReview-Thread: code`]);
  const codeFixup = git(repo, ['rev-parse', 'HEAD']);
  git(repo, [
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    `amend! ${tip}\n\nuse the helper\n\nReview-Thread: message`,
  ]);
  const amend = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'price.js'), 'work in progress\n');

  const { port, server } = await startServer({
    selection: createDiffSelection(base, tip),
    repoPath: repo,
    preferredPort: 9270,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  const diff = await (await fetch(api('/api/diff'))).json();
  const { review } = diff as DiffResponse;
  const query = `?base=${review!.selection.baseCommitish}&target=${review!.selection.targetCommitish}`;
  const at = '2026-10-19T00:00:00Z';
  const author = { author: 'User', createdAt: at, updatedAt: at };
  await fetch(api(`/api/comments${query}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threads: [
        {
          id: 'code',
          filePath: 'helper.js',
          createdAt: at,
          updatedAt: at,
          position: { side: 'new', line: 1 },
          codeSnapshot: { content: 'export const helper = 1;', commit: typo },
          view: { baseCommitish: base, targetCommitish: typo },
          fixupTarget: typo,
          messages: [{ id: 'code', body: 'Make it two.', ...author }],
        },
        {
          id: 'message',
          position: { scope: 'commit' },
          createdAt: at,
          updatedAt: at,
          fixupTarget: tip,
          messages: [{ id: 'message', body: 'Say the helper.', ...author }],
        },
      ],
    }),
  });
  const before = (await (await fetch(api(`/api/fixups${query}`))).json()) as {
    fixups: Array<{ sha: string; patchId: string; threadIds: string[] }>;
  };
  await fetch(api(`/api/decisions${query}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      before.fixups.map(({ sha, patchId, threadIds }) => ({
        threadId: threadIds[0],
        kind: 'approved',
        fixupSha: sha,
        patchId,
        at,
      })),
    ),
  });

  const response = await fetch(api(`/api/reword${query}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commit: typo,
      original: 'add prcie helper\n\nRounds down.',
      message: 'add price helper\n\nRounds down.',
    }),
  });
  const { rewritten } = (await response.json()) as { rewritten: Record<string, string> };

  expect(response.status).toBe(200);
  const newTypo = rewritten[typo]!;
  const newTip = rewritten[tip]!;
  const newCodeFixup = rewritten[codeFixup]!;
  const newAmend = rewritten[amend]!;
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(newAmend);
  expect(git(repo, ['log', '--reverse', '--format=%s', `${base}..HEAD`]).split('\n')).toEqual([
    'add price helper',
    'use helper',
    `fixup! ${newTypo}`,
    `amend! ${newTip}`,
  ]);
  expect(git(repo, ['status', '--porcelain'])).toBe('M price.js');

  const moved = (await (await fetch(api('/api/diff'))).json()) as DiffResponse;
  expect(moved.review!.requested.targetCommitish).toBe(newTip);
  expect(moved.rewritten).toEqual(rewritten);
  expect(moved.review!.commits.map(({ sha, subject }) => [sha, subject])).toEqual([
    [newTypo, 'add price helper'],
    [newTip, 'use helper'],
  ]);

  const movedQuery = `?base=${base}&target=${newTip}`;
  const { fixups } = (await (await fetch(api(`/api/fixups${movedQuery}`))).json()) as {
    fixups: Array<{ sha: string; foldTargetSha?: string }>;
  };
  expect(fixups.map(({ sha, foldTargetSha }) => [sha, foldTargetSha])).toEqual([
    [newCodeFixup, newTypo],
    [newAmend, newTip],
  ]);

  const stored = (await (await fetch(api('/api/comments-json'))).json()) as {
    threads: Array<{
      id: string;
      view?: unknown;
      fixupTarget?: string;
      codeSnapshot?: { commit?: string };
    }>;
    decisions: Array<{ threadId: string; fixupSha: string; patchId?: string; kind: string }>;
  };
  const code = stored.threads.find(({ id }) => id === 'code');
  expect(code?.view).toEqual({ baseCommitish: base, targetCommitish: newTypo });
  expect(code?.fixupTarget).toBe(newTypo);
  expect(code?.codeSnapshot?.commit).toBe(newTypo);
  expect(stored.threads.find(({ id }) => id === 'message')?.fixupTarget).toBe(newTip);
  expect(stored.decisions).toContainEqual(
    expect.objectContaining({ threadId: 'message', fixupSha: newAmend, patchId: newAmend }),
  );
  expect(stored.decisions).toContainEqual(
    expect.objectContaining({ threadId: 'code', fixupSha: newCodeFixup }),
  );

  const short = (sha: string) => git(repo, ['rev-parse', '--short', sha]);
  expect(await (await fetch(api('/api/comments-output'))).text()).toContain(
    `helper.js:L1 [승인됨]\n고쳐 넣을 커밋: ${short(newTypo)} add price helper\n`,
  );
  const json = (await (await fetch(api(`/api/comments-json${query}`))).json()) as {
    threads: unknown[];
  };
  expect(json.threads).toEqual(stored.threads);
  await fetch(api('/api/comment-imports'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      {
        type: 'thread',
        id: 'after',
        author: 'User',
        filePath: 'helper.js',
        position: { side: 'new', line: 1 },
        fixupTarget: typo,
        body: 'Said with the old SHA.',
      },
    ]),
  });
  const added = (await (await fetch(api('/api/comments-json'))).json()) as typeof stored;
  expect(added.threads.find(({ id }) => id === 'after')?.fixupTarget).toBe(newTypo);
  expect(
    await (await fetch(api(`/api/commit-message${movedQuery}&commit=${newTypo}`))).json(),
  ).toEqual({
    message: 'add price helper\n\nRounds down.',
  });

  git(repo, ['checkout', '-q', '--', 'price.js']);
  git(repo, ['-c', 'sequence.editor=true', 'rebase', '-q', '-i', '--autosquash', base]);
  expect(git(repo, ['log', '--reverse', '--format=%s', `${base}..HEAD`]).split('\n')).toEqual([
    'add price helper',
    'use the helper',
  ]);
});

it('warns before rewording on the default branch and rewrites once the warning is acknowledged', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  const typo = commit(repo, 'add typpo', { 'b.js': '1\n' });
  const tip = commit(repo, 'tip', { 'c.js': '1\n' });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, tip),
    repoPath: repo,
    preferredPort: 9275,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  await fetch(api('/api/diff'));
  const reword = (extra: object) =>
    fetch(api(`/api/reword?base=${base}&target=${tip}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit: typo, original: 'add typpo', message: 'add typo', ...extra }),
    });

  const warned = await reword({});
  expect(warned.status).toBe(409);
  expect(await warned.json()).toMatchObject({
    reason: 'needs-confirmation',
    warnings: ['default-branch'],
  });
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(tip);

  const confirmed = await reword({ acknowledged: ['default-branch'] });
  expect(confirmed.status).toBe(200);
  expect(git(repo, ['log', '-1', '--format=%s', 'HEAD~1'])).toBe('add typo');
});

it(
  'moves the branches stacked on the reworded commit, and warns by name about one open elsewhere',
  { timeout: 15_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const repo = join(dir, 'repo');
    git(dir, ['init', '-q', '-b', 'main', repo]);
    const base = commit(repo, 'base', { 'a.js': '1\n' });
    git(repo, ['checkout', '-q', '-b', 'feature']);
    const typo = commit(repo, 'add typpo', { 'b.js': '1\n' });
    const tip = commit(repo, 'tip', { 'c.js': '1\n' });
    git(repo, ['checkout', '-q', '-b', 'up']);
    commit(repo, 'up work', { 'd.js': '1\n' });
    git(repo, ['checkout', '-q', '-b', 'work2', tip]);
    const elsewhere = commit(repo, 'work2 work', { 'e.js': '1\n' });
    git(repo, ['checkout', '-q', 'feature']);
    git(repo, ['worktree', 'add', '-q', join(dir, 'other'), 'work2']);

    const { port, server } = await startServer({
      selection: createDiffSelection(base, tip),
      repoPath: repo,
      preferredPort: 9279,
    });
    cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
    const api = (path: string) => `http://localhost:${port}${path}`;
    await fetch(api('/api/diff'));
    const reword = (extra: object) =>
      fetch(api(`/api/reword?base=${base}&target=${tip}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commit: typo,
          original: 'add typpo',
          message: 'add typo',
          ...extra,
        }),
      });

    const warned = await reword({});
    expect(warned.status).toBe(409);
    expect(await warned.json()).toMatchObject({
      reason: 'needs-confirmation',
      warnings: ['branch-elsewhere'],
      warningBranches: { 'branch-elsewhere': ['work2'] },
    });
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(tip);

    const confirmed = await reword({ acknowledged: ['branch-elsewhere'] });
    expect(confirmed.status).toBe(200);
    expect(((await confirmed.json()) as { branches: unknown }).branches).toEqual({
      moved: ['up'],
      left: [{ name: 'work2', why: 'worktree' }],
    });
    expect(git(repo, ['rev-parse', 'up~1'])).toBe(git(repo, ['rev-parse', 'HEAD']));
    expect(git(repo, ['log', '-1', '--format=%s', 'up~2'])).toBe('add typo');
    expect(git(repo, ['rev-parse', 'work2'])).toBe(elsewhere);
  },
);

it('keeps a local master tracking origin’s default main in place as the default branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const remote = join(dir, 'remote.git');
  git(dir, ['init', '-q', '-b', 'master', repo]);
  git(dir, ['init', '-q', '--bare', remote]);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  const typo = commit(repo, 'add typpo', { 'b.js': '1\n' });
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', 'origin', 'master:main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);
  git(repo, ['branch', '-q', '-u', 'origin/main', 'master']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const tip = commit(repo, 'tip', { 'c.js': '1\n' });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, tip),
    repoPath: repo,
    preferredPort: 9282,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  await fetch(api('/api/diff'));
  const reword = (extra: object) =>
    fetch(api(`/api/reword?base=${base}&target=${tip}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit: typo, original: 'add typpo', message: 'add typo', ...extra }),
    });

  const warned = await reword({});
  expect(warned.status).toBe(409);
  expect(await warned.json()).toMatchObject({
    warnings: ['default-branch-left'],
    warningBranches: { 'default-branch-left': ['master'] },
  });

  const confirmed = await reword({ acknowledged: ['default-branch-left'] });
  expect(confirmed.status).toBe(200);
  expect(((await confirmed.json()) as { branches: unknown }).branches).toEqual({
    moved: [],
    left: [{ name: 'master', why: 'default' }],
  });
  expect(git(repo, ['rev-parse', 'master'])).toBe(typo);
  expect(git(repo, ['log', '-1', '--format=%s', 'HEAD~1'])).toBe('add typo');
});

it('warns before rewording a commit already pushed and rewrites without pushing once confirmed', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  const remote = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-remote-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  cleanups.push(() => rmSync(remote, { recursive: true, force: true }));
  git(remote, ['init', '-q', '--bare']);
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  git(repo, ['remote', 'add', 'origin', remote]);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  const typo = commit(repo, 'add typpo', { 'b.js': '1\n' });
  git(repo, ['push', '-q', '-u', 'origin', 'feature']);
  const local = commit(repo, 'locl', { 'c.js': '1\n' });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, local),
    repoPath: repo,
    preferredPort: 9278,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  await fetch(api('/api/diff'));
  const reword = (body: object) =>
    fetch(api(`/api/reword?base=${base}&target=${local}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const notPushed = await reword({ commit: local, original: 'locl', message: 'local' });
  expect(notPushed.status).toBe(200);
  const head = git(repo, ['rev-parse', 'HEAD']);

  const fixTypo = { commit: typo, original: 'add typpo', message: 'add typo' };
  const warned = await reword(fixTypo);
  expect(warned.status).toBe(409);
  expect(await warned.json()).toMatchObject({
    reason: 'needs-confirmation',
    warnings: ['pushed-commit'],
  });
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head);

  const confirmed = await reword({ ...fixTypo, acknowledged: ['pushed-commit'] });
  expect(confirmed.status).toBe(200);
  expect(git(repo, ['log', '--reverse', '--format=%s', `${base}..HEAD`]).split('\n')).toEqual([
    'add typo',
    'local',
  ]);
  expect(git(remote, ['rev-parse', 'feature'])).toBe(typo);
  expect(git(repo, ['rev-parse', '@{upstream}'])).toBe(typo);
});

it("blocks rewording while a thread is the agent's, and not while the agent only waits", async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  const typo = commit(repo, 'add typpo', { 'b.js': '1\n' });
  const tip = commit(repo, 'mistke', { 'c.js': '1\n' });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, tip),
    repoPath: repo,
    preferredPort: 9279,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  await fetch(api('/api/diff'));
  const query = `?base=${base}&target=${tip}`;
  const reword = (body: object) =>
    fetch(api(`/api/reword${query}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const comment = (entry: object) =>
    fetch(api('/api/comment-imports'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([entry]),
    });

  const waiting = new AbortController();
  cleanups.push(() => waiting.abort());
  const wait = await fetch(api('/api/comments-wait'), { signal: waiting.signal });
  expect(wait.status).toBe(200);
  const onlyWaiting = await reword({ commit: tip, original: 'mistke', message: 'mistake' });
  expect(onlyWaiting.status).toBe(200);
  const movedTip = git(repo, ['rev-parse', 'HEAD']);

  const position = { scope: 'commit' };
  await comment({
    type: 'thread',
    id: 't1',
    author: 'User',
    position,
    fixupTarget: typo,
    body: 'typo in the subject',
  });
  const fixTypo = { commit: typo, original: 'add typpo', message: 'add typo' };
  const blocked = await reword(fixTypo);
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({ reason: 'agent-working' });
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(movedTip);

  await comment({
    type: 'reply',
    author: 'Agent',
    position,
    fixupTarget: typo,
    body: 'on it',
    fixPending: true,
  });
  const stillFixing = await reword(fixTypo);
  expect(stillFixing.status).toBe(409);
  expect(await stillFixing.json()).toMatchObject({ reason: 'agent-working' });

  await comment({
    type: 'reply',
    author: 'Agent',
    position,
    fixupTarget: typo,
    body: 'nothing to change after all',
  });
  const answered = await reword(fixTypo);
  expect(answered.status).toBe(200);
  expect(git(repo, ['log', '--reverse', '--format=%s', `${base}..HEAD`]).split('\n')).toEqual([
    'add typo',
    'mistake',
  ]);
});

it("blocks rewording while a thread of another selection on the server is the agent's", async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  const tip = commit(repo, 'mistke', { 'c.js': '1\n' });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, tip),
    repoPath: repo,
    preferredPort: 9280,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  await fetch(api('/api/diff'));
  await fetch(api('/api/comment-imports?base=HEAD&target=.'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      {
        type: 'thread',
        id: 'working-tree',
        author: 'User',
        filePath: 'c.js',
        position: { side: 'new', line: 1 },
        body: 'about the working tree',
      },
    ]),
  });

  const response = await fetch(api(`/api/reword?base=${base}&target=${tip}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commit: tip, original: 'mistke', message: 'mistake' }),
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ reason: 'agent-working' });
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(tip);
});

it('says where a comment of an earlier review holds a reword up after the review reopened', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  const typo = commit(repo, 'add typpo', { 'b.js': '1\n' });
  const oldTip = commit(repo, 'add c', { 'c.js': '1\n' });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, oldTip),
    repoPath: repo,
    preferredPort: 9281,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  await fetch(api('/api/diff'));
  await fetch(api('/api/comment-imports'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      {
        type: 'thread',
        id: 'earlier',
        author: 'User',
        filePath: 'c.js',
        position: { side: 'new', line: 1 },
        body: 'left on the earlier review',
      },
    ]),
  });

  const newTip = commit(repo, 'add d', { 'd.js': '1\n' });
  await fetch(api(`/api/diff?base=${base}&target=${newTip}`));
  const onNewReview = await fetch(api(`/api/comments-json?base=${base}&target=${newTip}`));
  expect(((await onNewReview.json()) as { threads: unknown[] }).threads).toEqual([]);

  const blocked = await fetch(api(`/api/reword?base=${base}&target=${newTip}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commit: typo, original: 'add typpo', message: 'add typo' }),
  });

  expect(blocked.status).toBe(409);
  const refused = (await blocked.json()) as RewordResponse & {
    blockingThreads: RewriteBlockingThread[];
  };
  expect(refused).toEqual({
    error: 'Rewrite refused: agent-working',
    reason: 'agent-working',
    blockingThreads: [
      {
        threadId: 'earlier',
        review: createDiffSelection(base, oldTip),
        commit: { shortSha: oldTip.slice(0, 7), subject: 'add c' },
        file: 'c.js',
        line: 1,
      },
    ],
  });

  const { review } = refused.blockingThreads[0]!;
  const opened = await fetch(
    api(`/api/diff?base=${review.baseCommitish}&target=${review.targetCommitish}`),
  );
  const { selection } = ((await opened.json()) as DiffResponse).review!;
  const comments = await fetch(
    api(`/api/comments-json?base=${selection.baseCommitish}&target=${selection.targetCommitish}`),
  );
  const shown = (await comments.json()) as { threads: Array<{ id: string }> };
  expect(shown.threads.map(({ id }) => id)).toEqual(['earlier']);
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(newTip);
});

async function blockingThreadsOfReword(
  api: (path: string) => string,
  review: { base: string; tip: string },
  request: { commit: string; original: string; message: string },
): Promise<RewriteBlockingThread[]> {
  const blocked = await fetch(api(`/api/reword?base=${review.base}&target=${review.tip}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  expect(blocked.status).toBe(409);
  return ((await blocked.json()) as { blockingThreads: RewriteBlockingThread[] }).blockingThreads;
}

const agentsTurn = (id: string, filePath: string, line: number) => ({
  type: 'thread',
  id,
  author: 'User',
  filePath,
  position: { side: 'new', line },
  body: 'please fix',
});

it('names the commit a line comes from for a comment with no fixup target', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  const typo = commit(repo, 'add typpo', { 'b.js': 'one\n' });
  const tip = commit(repo, 'add c', { 'c.js': '1\n' });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, tip),
    repoPath: repo,
    preferredPort: 9282,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  await fetch(api('/api/diff'));
  await fetch(api('/api/comment-imports'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([agentsTurn('on-b', 'b.js', 1), agentsTurn('on-c', 'c.js', 1)]),
  });

  const blocking = await blockingThreadsOfReword(
    api,
    { base, tip },
    { commit: typo, original: 'add typpo', message: 'add typo' },
  );

  expect(blocking.map(({ threadId, commit }) => ({ threadId, commit }))).toEqual([
    { threadId: 'on-b', commit: { shortSha: typo.slice(0, 7), subject: 'add typpo' } },
    { threadId: 'on-c', commit: { shortSha: tip.slice(0, 7), subject: 'add c' } },
  ]);
});

it('names the commit of a committed line in a review of the working tree', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const main = commit(repo, 'base', { 'a.js': '1\n' });
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const typo = commit(repo, 'add typpo', { 'b.js': 'one\n' });
  const tip = commit(repo, 'add c', { 'c.js': '1\n' });
  writeFileSync(join(repo, 'b.js'), 'one\ntwo\n');

  const { port, server } = await startServer({
    selection: createDiffSelection(main, tip),
    repoPath: repo,
    preferredPort: 9283,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  await fetch(api('/api/diff'));
  const working = `base=${main.slice(0, 7)}&target=.&baseMode=merge-base`;
  await fetch(api(`/api/diff?${working}`));
  await fetch(api(`/api/comment-imports?${working}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      agentsTurn('committed', 'b.js', 1),
      agentsTurn('uncommitted', 'b.js', 2),
    ]),
  });

  const blocking = await blockingThreadsOfReword(
    api,
    { base: main, tip },
    { commit: typo, original: 'add typpo', message: 'add typo' },
  );

  expect(blocking).toEqual([
    {
      threadId: 'committed',
      review: createDiffSelection(main.slice(0, 7), '.', 'merge-base'),
      commit: { shortSha: typo.slice(0, 7), subject: 'add typpo' },
      file: 'b.js',
      line: 1,
    },
    {
      threadId: 'uncommitted',
      review: createDiffSelection(main.slice(0, 7), '.', 'merge-base'),
      file: 'b.js',
      line: 2,
    },
  ]);
});

it('names a commit for a line a commit deleted in a review of the working tree', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const main = commit(repo, 'base', { 'a.js': '1\n2\n3\n' });
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const typo = commit(repo, 'add typpo', { 'b.js': 'one\n' });
  const tip = commit(repo, 'drop 2', { 'a.js': '1\n3\n' });
  writeFileSync(join(repo, 'a.js'), '1\n');

  const { port, server } = await startServer({
    selection: createDiffSelection(main, tip),
    repoPath: repo,
    preferredPort: 9284,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  await fetch(api('/api/diff'));
  const working = `base=${main.slice(0, 7)}&target=.&baseMode=merge-base`;
  await fetch(api(`/api/diff?${working}`));
  const onOldSide = (id: string, line: number) => ({
    ...agentsTurn(id, 'a.js', line),
    position: { side: 'old', line },
  });
  await fetch(api(`/api/comment-imports?${working}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([onOldSide('deleted-by-commit', 2), onOldSide('deleted-uncommitted', 3)]),
  });

  const blocking = await blockingThreadsOfReword(
    api,
    { base: main, tip },
    { commit: typo, original: 'add typpo', message: 'add typo' },
  );

  expect(blocking.map(({ threadId, commit }) => ({ threadId, commit }))).toEqual([
    { threadId: 'deleted-by-commit', commit: { shortSha: tip.slice(0, 7), subject: 'drop 2' } },
    { threadId: 'deleted-uncommitted' },
  ]);
});

it('refuses to reword while a rebase is stopped and leaves the history', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  const typo = commit(repo, 'add typpo', { 'b.js': '1\n' });
  const tip = commit(repo, 'tip', { 'c.js': '1\n' });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, tip),
    repoPath: repo,
    preferredPort: 9277,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  await fetch(api('/api/diff'));
  git(repo, ['-c', 'sequence.editor=sed -i 1s/^pick/edit/', 'rebase', '-q', '-i', base]);

  const response = await fetch(api(`/api/reword?base=${base}&target=${tip}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commit: typo, original: 'add typpo', message: 'add typo' }),
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ reason: 'operation-in-progress' });
  git(repo, ['rebase', '--abort']);
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(tip);
});

it('stacks an edit made on the card on the agent fixup and folds both into the commit it folds into', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const base = commit(repo, 'base', { 'total.js': 'a1\na2\na3\na4\na5\na6\n' });
  const first = commit(repo, 'feat: rename the first lines', {
    'total.js': 'A1\nA2\na3\na4\na5\na6\n',
  });
  const second = commit(repo, 'feat: rename the last line', {
    'total.js': 'A1\nA2\na3\na4\na5\nB6\n',
  });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, second),
    repoPath: repo,
    preferredPort: 9290,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  const text = async (path: string) => (await fetch(api(path))).text();
  const review = ((await (await fetch(api('/api/diff'))).json()) as DiffResponse).review!;
  const reviewQuery = `?base=${review.selection.baseCommitish}&target=${review.selection.targetCommitish}`;
  await fetch(api(`/api/comments${reviewQuery}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      comments: [{ id: 't1', file: 'total.js', line: 2, body: 'Explain A2' }],
    }),
  });
  const decide = (decisions: Array<Record<string, string>>) =>
    fetch(api('/api/decisions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decisions.map((decision) => ({ threadId: 't1', ...decision }))),
    });

  writeFileSync(join(repo, 'total.js'), 'A1\nA2\nadded-by-agent\na3\na4\na5\nB6\n');
  git(repo, ['commit', '-q', '-a', `--fixup=${first}`, '--trailer', 'Review-Thread: t1']);
  const agentFixup = git(repo, ['rev-parse', 'HEAD']);
  expect(await text('/api/comments-output')).toContain('total.js:L2 [승인 대기]');

  const edit = (body: Record<string, unknown>) =>
    fetch(api(`/api/direct-edit${reviewQuery}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: 'total.js',
        startLine: 3,
        endLine: 3,
        original: ['added-by-agent'],
        replacement: ['added-by-agent, then fixed by the reviewer'],
        threadId: 't1',
        ...body,
      }),
    });
  expect(await (await edit({})).json()).toMatchObject({ reason: 'thread-has-fixup' });

  const response = await edit({ fixupSha: agentFixup, approvedWith: [agentFixup] });
  const { sha } = (await response.json()) as { sha: string };

  expect(response.status).toBe(200);
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(sha);
  expect(git(repo, ['log', '-1', '--format=%B'])).toBe(
    `fixup! ${first}\n\nfeat: rename the first lines\n\nReview-Thread: t1`,
  );
  expect(git(repo, ['diff', agentFixup, sha])).toContain(
    '-added-by-agent\n+added-by-agent, then fixed by the reviewer',
  );
  expect(await text('/api/comments-output')).toContain('total.js:L2 [승인됨]');
  const { decisions } = (await (await fetch(api('/api/comments-json'))).json()) as {
    decisions: Array<{ kind: string; fixupSha: string; at: string }>;
  };
  expect(decisions.map(({ kind, fixupSha }) => ({ kind, fixupSha }))).toEqual([
    { kind: 'approved', fixupSha: agentFixup },
    { kind: 'approved', fixupSha: sha },
  ]);
  expect(new Set(decisions.map(({ at }) => at)).size).toBe(1);

  const folded = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-folded-'));
  cleanups.push(() => rmSync(folded, { recursive: true, force: true }));
  git(folded, ['clone', '-q', repo, '.']);
  git(folded, ['rebase', '-q', '-i', '--autosquash', base], { GIT_SEQUENCE_EDITOR: ':' });
  expect(git(folded, ['diff', '--exit-code', sha, 'HEAD'])).toBe('');
  expect(git(folded, ['log', '--format=%s', `${base}..HEAD`]).split('\n')).toEqual([
    'feat: rename the last line',
    'feat: rename the first lines',
  ]);
  expect(git(folded, ['show', 'HEAD^:total.js'])).toBe(
    'A1\nA2\nadded-by-agent, then fixed by the reviewer\na3\na4\na5\na6',
  );

  await decide([{ kind: 'rejected', fixupSha: sha, at: new Date().toISOString() }]);
  expect(await text('/api/comments-output')).toContain('total.js:L2 [승인 대기]');
  const { fixups } = (await (await fetch(api(`/api/fixups${reviewQuery}`))).json()) as {
    fixups: Array<{ sha: string; foldTargetSha?: string }>;
  };
  expect(fixups).toEqual([
    expect.objectContaining({ sha: agentFixup, foldTargetSha: first }),
    expect.objectContaining({ sha, foldTargetSha: first }),
  ]);
});

it('takes an edit on the card only on the lines the fixup changed', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const lines = Array.from({ length: 25 }, (_, index) => `l${index + 1}`);
  const withLines = (changes: Record<number, string>) =>
    `${lines.map((line, index) => changes[index + 1] ?? line).join('\n')}\n`;
  const base = commit(repo, 'base', { 'total.js': withLines({}) });
  commit(repo, 'feat: change line 18', { 'total.js': withLines({ 18: 'W18' }) });
  const changed20 = commit(repo, 'feat: change line 20', {
    'total.js': withLines({ 18: 'W18', 20: 'X20' }),
  });
  const tip = commit(repo, 'feat: change line 22', {
    'total.js': withLines({ 18: 'W18', 20: 'X20', 22: 'Y22' }),
  });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, tip),
    repoPath: repo,
    preferredPort: 9300,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  const review = ((await (await fetch(api('/api/diff'))).json()) as DiffResponse).review!;
  const reviewQuery = `?base=${review.selection.baseCommitish}&target=${review.selection.targetCommitish}`;
  await fetch(api(`/api/comments${reviewQuery}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comments: [{ id: 't1', file: 'total.js', line: 20, body: 'Rename' }] }),
  });
  writeFileSync(join(repo, 'total.js'), withLines({ 18: 'W18', 20: 'A20', 22: 'Y22' }));
  git(repo, ['commit', '-q', '-a', `--fixup=${changed20}`, '--trailer', 'Review-Thread: t1']);
  const agentFixup = git(repo, ['rev-parse', 'HEAD']);
  const edit = (startLine: number, original: string[], replacement: string[]) =>
    fetch(api(`/api/direct-edit${reviewQuery}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: 'total.js',
        startLine,
        endLine: startLine + original.length - 1,
        original,
        replacement,
        threadId: 't1',
        fixupSha: agentFixup,
        approvedWith: [agentFixup],
      }),
    });

  for (const [startLine, original] of [
    [22, ['Y22']],
    [18, ['W18']],
    [19, ['l19', 'A20']],
  ] as const) {
    const refused = await edit(
      startLine,
      [...original],
      original.map((line) => `${line}!`),
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ reason: 'outside-fixup' });
  }
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(agentFixup);

  const saved = await edit(20, ['A20'], ['A20!']);
  expect(saved.status).toBe(200);
  expect(git(repo, ['log', '-1', '--format=%s'])).toBe(`fixup! ${changed20}`);
});

it('approves nothing when a fixup on the card is rejected while the edit is being committed', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  const hold = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-hold-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  cleanups.push(() => rmSync(hold, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const base = commit(repo, 'base', { 'total.js': 'a1\na2\na3\na4\na5\na6\na7\n' });
  const first = commit(repo, 'feat: rename the lines', {
    'total.js': 'A1\nA2\na3\na4\na5\na6\na7\n',
  });

  const { port, server } = await startServer({
    selection: createDiffSelection(base, first),
    repoPath: repo,
    preferredPort: 9310,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  const review = ((await (await fetch(api('/api/diff'))).json()) as DiffResponse).review!;
  const reviewQuery = `?base=${review.selection.baseCommitish}&target=${review.selection.targetCommitish}`;
  await fetch(api(`/api/comments${reviewQuery}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comments: [{ id: 't1', file: 'total.js', line: 2, body: 'Explain' }] }),
  });
  writeFileSync(join(repo, 'total.js'), 'A1\nA2\nadded-by-agent\na3\na4\na5\na6\na7\n');
  git(repo, ['commit', '-q', '-a', `--fixup=${first}`, '--trailer', 'Review-Thread: t1']);
  const shown = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'total.js'), 'A1\nA2\nadded-by-agent\na3\na4\na5\na6\nlast-by-agent\n');
  git(repo, ['commit', '-q', '-a', `--fixup=${first}`, '--trailer', 'Review-Thread: t1']);
  const rejected = git(repo, ['rev-parse', 'HEAD']);

  const script = join(hold, 'hold.sh');
  writeFileSync(
    script,
    `touch '${hold}/started'\nfor _ in $(seq 500); do [ -e '${hold}/go' ] && break; sleep 0.02; done\nexec cat\n`,
  );
  git(repo, ['config', 'filter.hold.smudge', `sh '${script}'`]);
  writeFileSync(join(repo, '.git', 'info', 'attributes'), 'total.js filter=hold\n');

  const saving = fetch(api(`/api/direct-edit${reviewQuery}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath: 'total.js',
      startLine: 3,
      endLine: 3,
      original: ['added-by-agent'],
      replacement: ['fixed by the reviewer'],
      threadId: 't1',
      fixupSha: shown,
      approvedWith: [shown, rejected],
    }),
  });
  for (let waited = 0; !existsSync(join(hold, 'started')); waited++) {
    expect(waited).toBeLessThan(500);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await fetch(api('/api/decisions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      { threadId: 't1', kind: 'rejected', fixupSha: rejected, at: new Date().toISOString() },
    ]),
  });
  writeFileSync(join(hold, 'go'), '');
  const response = await saving;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    reason: 'card-changed',
    sha: git(repo, ['rev-parse', 'HEAD']),
  });
  const { decisions } = (await (await fetch(api('/api/comments-json'))).json()) as {
    decisions: Array<{ kind: string; fixupSha: string }>;
  };
  expect(decisions.map(({ kind, fixupSha }) => ({ kind, fixupSha }))).toEqual([
    { kind: 'rejected', fixupSha: rejected },
  ]);
  expect(await (await fetch(api('/api/comments-output'))).text()).toContain(
    'total.js:L2 [승인 대기]',
  );

  const committed = git(repo, ['rev-parse', 'HEAD']);
  const again = await fetch(api(`/api/direct-edit${reviewQuery}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath: 'total.js',
      startLine: 3,
      endLine: 3,
      original: ['added-by-agent'],
      replacement: ['fixed by the reviewer'],
      threadId: 't1',
      fixupSha: shown,
      approvedWith: [shown, committed],
    }),
  });
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ reason: 'no-change' });
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(committed);
  expect((await (await fetch(api('/api/comments-json'))).json()) as unknown).toMatchObject({
    decisions: [{ kind: 'rejected', fixupSha: rejected }],
  });
});

async function startReview(repo: string, base: string, target: string, preferredPort: number) {
  const { port, server } = await startServer({
    selection: createDiffSelection(base, target),
    repoPath: repo,
    preferredPort,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  await fetch(api('/api/diff'));
  const post = (path: string, body: unknown) =>
    fetch(api(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { api, post };
}

it('reorders the commits and moves the review, its comments, fixups and decisions along', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  const first = commit(repo, 'first', { 'first.js': 'first\n' });
  const second = commit(repo, 'second', { 'second.js': 'second\n' });
  const third = commit(repo, 'third', { 'third.js': 'third\n' });
  writeFileSync(join(repo, 'first.js'), 'better first\n');
  git(repo, ['commit', '-q', '-a', '-m', `fixup! ${first}\n\nReview-Thread: on-first`]);
  const fixup = git(repo, ['rev-parse', 'HEAD']);
  git(repo, [
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    `amend! ${second}\n\nsecond, renamed\n\nReview-Thread: on-second`,
  ]);
  const amend = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'a.js'), 'work in progress\n');

  const { api, post } = await startReview(repo, base, third, 9281);
  const query = `?base=${base}&target=${third}`;
  const at = '2026-11-07T00:00:00Z';
  const threadOn = (id: string, view: object, fixupTarget: string, filePath: string) => ({
    id,
    filePath,
    position: { side: 'new', line: 1 },
    createdAt: at,
    updatedAt: at,
    view,
    fixupTarget,
    codeSnapshot: { content: filePath.replace('.js', ''), commit: fixupTarget },
    messages: [
      { id: `${id}-m`, body: 'x', author: 'User', createdAt: at, updatedAt: at },
      { id: `${id}-a`, body: 'done', author: 'Agent', createdAt: at, updatedAt: at },
    ],
  });
  await post(`/api/comments${query}`, {
    threads: [
      threadOn('on-first', { baseCommitish: base, targetCommitish: first }, first, 'first.js'),
      threadOn('on-second', { baseCommitish: first, targetCommitish: second }, second, 'second.js'),
      threadOn('on-third', { baseCommitish: second, targetCommitish: third }, third, 'third.js'),
      threadOn('on-run', { baseCommitish: first, targetCommitish: third }, third, 'third.js'),
    ],
  });
  const before = (await (await fetch(api(`/api/fixups${query}`))).json()) as {
    fixups: Array<{ sha: string; patchId: string; threadIds: string[] }>;
  };
  await post(
    `/api/decisions${query}`,
    before.fixups.map(({ sha, patchId, threadIds }) => ({
      threadId: threadIds[0],
      kind: 'approved',
      fixupSha: sha,
      patchId,
      at,
    })),
  );

  const response = await post(`/api/reorder${query}`, { order: [third, first, second] });
  const { rewritten } = (await response.json()) as { rewritten: Record<string, string> };

  expect(response.status).toBe(200);
  const [newThird, newFirst, newSecond, newFixup, newAmend] = [
    third,
    first,
    second,
    fixup,
    amend,
  ].map((sha) => rewritten[sha]!);
  expect(git(repo, ['log', '--reverse', '--format=%s', `${base}..HEAD`]).split('\n')).toEqual([
    'third',
    'first',
    'second',
    `fixup! ${newFirst}`,
    `amend! ${newSecond}`,
  ]);
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(newAmend);
  expect(git(repo, ['status', '--porcelain'])).toBe('M a.js');

  const moved = (await (await fetch(api('/api/diff'))).json()) as DiffResponse;
  expect(moved.review!.requested).toEqual({ baseCommitish: base, targetCommitish: newSecond });
  expect(moved.review!.commits.map(({ sha }) => sha)).toEqual([newThird, newFirst, newSecond]);

  const movedQuery = `?base=${base}&target=${newSecond}`;
  const { fixups } = (await (await fetch(api(`/api/fixups${movedQuery}`))).json()) as {
    fixups: Array<{ sha: string; foldTargetSha?: string }>;
  };
  expect(fixups.map(({ sha, foldTargetSha }) => [sha, foldTargetSha])).toEqual([
    [newFixup, newFirst],
    [newAmend, newSecond],
  ]);

  const stored = (await (await fetch(api('/api/comments-json'))).json()) as {
    threads: Array<{
      id: string;
      view?: unknown;
      fixupTarget?: string;
      codeSnapshot?: { commit?: string };
    }>;
    decisions: Array<{ threadId: string; fixupSha: string; patchId?: string; kind: string }>;
  };
  const thread = (id: string) => stored.threads.find((each) => each.id === id);
  expect(thread('on-first')).toMatchObject({
    view: { baseCommitish: newThird, targetCommitish: newFirst },
    fixupTarget: newFirst,
    codeSnapshot: { commit: newFirst },
  });
  expect(thread('on-third')).toMatchObject({
    view: { baseCommitish: base, targetCommitish: newThird },
    fixupTarget: newThird,
  });
  // The run held second and third, which now have first between them.
  expect(thread('on-run')?.view).toEqual({ baseCommitish: base, targetCommitish: newSecond });
  expect(stored.decisions).toContainEqual(
    expect.objectContaining({ threadId: 'on-first', fixupSha: newFixup, kind: 'approved' }),
  );
  expect(stored.decisions).toContainEqual(
    expect.objectContaining({
      threadId: 'on-second',
      fixupSha: newAmend,
      patchId: newAmend,
      kind: 'approved',
    }),
  );

  const short = git(repo, ['rev-parse', '--short', newFirst]);
  expect(await (await fetch(api('/api/comments-output'))).text()).toContain(
    `first.js:L1 [승인됨]\n고쳐 넣을 커밋: ${short} first\n`,
  );

  // A tab still holding the old SHAs lands on the same commit.
  const staleView = (await (
    await fetch(api(`/api/diff?base=${second}&target=${third}`))
  ).json()) as DiffResponse;
  expect(staleView.files.map(({ path }) => path)).toEqual(['third.js']);
  expect(staleView.review!.requested.targetCommitish).toBe(newSecond);
  const oldReview = (await (
    await fetch(api(`/api/diff?base=${base}&target=${third}`))
  ).json()) as DiffResponse;
  expect(oldReview.files.map(({ path }) => path).sort()).toEqual([
    'first.js',
    'second.js',
    'third.js',
  ]);

  await post(`/api/comment-imports${movedQuery}`, [
    {
      type: 'thread',
      id: 'after',
      author: 'User',
      filePath: 'third.js',
      position: { side: 'new', line: 1 },
      view: { baseCommitish: second, targetCommitish: third },
      fixupTarget: third,
      body: 'Said with the old SHAs.',
    },
  ]);
  const added = (await (await fetch(api('/api/comments-json'))).json()) as typeof stored;
  expect(added.threads.find(({ id }) => id === 'after')).toMatchObject({
    view: { baseCommitish: base, targetCommitish: newThird },
    fixupTarget: newThird,
  });

  git(repo, ['checkout', '-q', '--', 'a.js']);
  git(repo, ['-c', 'sequence.editor=true', 'rebase', '-q', '-i', '--autosquash', base]);
  expect(git(repo, ['log', '--reverse', '--format=%s', `${base}..HEAD`]).split('\n')).toEqual([
    'third',
    'first',
    'second, renamed',
  ]);
  expect(git(repo, ['show', 'HEAD~1:first.js'])).toBe('better first');
});

it('lets the agent hold the old review through a reorder and still see its turn', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  const first = commit(repo, 'first', { 'first.js': '1\n' });
  const second = commit(repo, 'second', { 'second.js': '1\n' });

  const { api, post } = await startReview(repo, base, second, 9282);
  const wait = new AbortController();
  const waiting = fetch(api(`/api/comments-wait?base=${base}&target=${second}`), {
    signal: wait.signal,
  });
  cleanups.push(() => wait.abort());
  const response = await post(`/api/reorder?base=${base}&target=${second}`, {
    order: [second, first],
  });
  expect(response.status).toBe(200);
  const { rewritten } = (await response.json()) as { rewritten: Record<string, string> };
  const newFirst = rewritten[first]!;

  await post(`/api/comment-imports`, [
    {
      type: 'thread',
      id: 'turn',
      author: 'User',
      filePath: 'first.js',
      position: { side: 'new', line: 1 },
      fixupTarget: newFirst,
      body: 'For the agent.',
    },
  ]);

  const answer = await waiting;
  expect(await answer.text()).toContain(newFirst);
});

it('refuses a reorder the review cannot take and leaves the history', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  const adds = commit(repo, 'adds', { 'b.js': '1\n' });
  const edits = commit(repo, 'edits', { 'b.js': '2\n' });

  const { post } = await startReview(repo, base, edits, 9283);
  const reorder = (order: string[]) => post(`/api/reorder?base=${base}&target=${edits}`, { order });
  const refusal = async (order: string[]) => {
    const response = await reorder(order);
    return [response.status, ((await response.json()) as { reason?: string }).reason];
  };

  expect(await refusal([adds])).toEqual([409, 'stale-view']);
  expect(await refusal([adds, 'f'.repeat(40)])).toEqual([409, 'stale-view']);
  expect(await refusal([adds, edits])).toEqual([409, 'no-change']);
  expect(await refusal([edits, adds])).toEqual([409, 'conflict']);
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(edits);
  expect(git(repo, ['status', '--porcelain'])).toBe('');
});

it('runs the same checks before a reorder as before a reword', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const remote = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-remote-'));
  cleanups.push(() => rmSync(remote, { recursive: true, force: true }));
  git(remote, ['init', '-q', '--bare']);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  const first = commit(repo, 'first', { 'b.js': '1\n' });
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  const second = commit(repo, 'second', { 'c.js': '1\n' });

  const { post } = await startReview(repo, base, second, 9284);
  const query = `?base=${base}&target=${second}`;
  const reorder = (extra: object) =>
    post(`/api/reorder${query}`, { order: [second, first], ...extra });

  const warned = await reorder({});
  expect(warned.status).toBe(409);
  expect(await warned.json()).toMatchObject({
    reason: 'needs-confirmation',
    warnings: ['default-branch', 'pushed-commit'],
  });
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(second);

  const at = '2026-11-07T00:00:00Z';
  await post(`/api/comments${query}`, {
    threads: [
      {
        id: 'turn',
        filePath: 'b.js',
        position: { side: 'new', line: 1 },
        createdAt: at,
        updatedAt: at,
        messages: [{ id: 'm', body: 'x', author: 'User', createdAt: at, updatedAt: at }],
      },
    ],
  });
  const blocked = await reorder({ acknowledged: ['default-branch', 'pushed-commit'] });
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({ reason: 'agent-working' });
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(second);
  await post(`/api/comments${query}`, { threads: [] });

  const confirmed = await reorder({ acknowledged: ['default-branch', 'pushed-commit'] });
  expect(confirmed.status).toBe(200);
  expect(git(repo, ['log', '--reverse', '--format=%s', `${base}..HEAD`]).split('\n')).toEqual([
    'second',
    'first',
  ]);
  expect(git(remote, ['rev-parse', 'main'])).toBe(first);
});

it('keeps a merge in the range when a commit moves past it', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  git(repo, ['checkout', '-q', '-b', 'side']);
  commit(repo, 'on the side', { 'side.js': '1\n' });
  git(repo, ['checkout', '-q', 'feature']);
  const before = commit(repo, 'before', { 'before.js': '1\n' });
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
  const merge = git(repo, ['rev-parse', 'HEAD']);
  const after = commit(repo, 'after', { 'after.js': '1\n' });

  const { api, post } = await startReview(repo, base, after, 9285);
  const response = await post(`/api/reorder?base=${base}&target=${after}`, {
    order: [before, after, merge],
  });

  expect(response.status).toBe(200);
  expect(git(repo, ['log', '--merges', '--format=%s', `${base}..HEAD`])).toBe('merge side');
  const { review } = (await (await fetch(api('/api/diff'))).json()) as DiffResponse;
  expect(review!.commits.map(({ subject }) => subject)).toEqual(['before', 'after', 'merge side']);
  expect(review!.commits.at(-1)?.merged?.map(({ subject }) => subject)).toEqual(['on the side']);
});

function conflictingStack() {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const base = commit(repo, 'base', { 'a.js': '1\n' });
  const adds = commit(repo, 'adds', { 'b.js': '1\n' });
  const edits = commit(repo, 'edits', { 'b.js': '2\n' });
  return { repo, base, adds, edits };
}

it('tells a conflict from the commit it stopped at, and whether anyone can take it', async () => {
  const { repo, base, adds, edits } = conflictingStack();
  const { api, post } = await startReview(repo, base, edits, 9285);
  const reorder = () => post(`/api/reorder?base=${base}&target=${edits}`, { order: [edits, adds] });
  const stopped = { commit: { sha: edits, subject: 'edits' } };

  const alone = await reorder();
  expect(alone.status).toBe(409);
  expect(await alone.json()).toMatchObject({
    reason: 'conflict',
    conflict: { ...stopped, agentAttached: false },
  });

  const leaving = new AbortController();
  const waiting = await fetch(api('/api/comments-wait'), { signal: leaving.signal });
  const withWait = await reorder();
  expect(await withWait.json()).toMatchObject({
    conflict: { ...stopped, agentAttached: true },
  });
  leaving.abort();
  await waiting.body?.cancel().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const gone = await reorder();
  expect(await gone.json()).toMatchObject({ conflict: { agentAttached: false } });
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(edits);
  expect(git(repo, ['status', '--porcelain'])).toBe('');
});

describe.skipIf(process.platform === 'win32')('a Claude Code session behind the socket', () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  });

  it('counts as attached only while the socket answers', async () => {
    const { repo, base, adds, edits } = conflictingStack();
    const { post } = await startReview(repo, base, edits, 9286);
    const attached = async () => {
      const response = await post(`/api/reorder?base=${base}&target=${edits}`, {
        order: [edits, adds],
      });
      return ((await response.json()) as { conflict?: { agentAttached?: boolean } }).conflict
        ?.agentAttached;
    };
    const path = join(repo, 'session.sock');
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = path;

    expect(await attached()).toBe(false);

    const received: string[] = [];
    const session = createServer((socket) => {
      socket.on('data', (data) => received.push(data.toString()));
    });
    await new Promise<void>((resolve) => session.listen(path, resolve));
    cleanups.push(() => new Promise<void>((resolve) => session.close(() => resolve())));

    expect(await attached()).toBe(true);
    expect(received).toEqual([]);
  });
});

it('hands a conflicting order over: the agent gets its turn, rebases, and difit follows', async () => {
  const { repo, base, adds, edits } = conflictingStack();
  const other = commit(repo, 'other', { 'o.js': '1\n' });
  const { api, post } = await startReview(repo, base, other, 9287);
  const texts = () => fetch(api('/api/comments-output')).then((response) => response.text());
  const position = { scope: 'commit' };
  const comment = (added: Record<string, unknown>) => post('/api/comment-imports', [added]);

  const waiting = fetch(api('/api/comments-wait'));
  const refused = await post(`/api/reorder?base=${base}&target=${other}`, {
    order: [edits, adds, other],
  });
  expect(await refused.json()).toMatchObject({ conflict: { agentAttached: true } });

  await post('/api/comments', {
    threads: [
      {
        id: 'handed-over',
        position,
        fixupTarget: edits,
        view: { baseCommitish: adds, targetCommitish: edits },
        createdAt: '2026-11-07T00:00:00.000Z',
        updatedAt: '2026-11-07T00:00:00.000Z',
        messages: [
          {
            id: 'handed-over',
            body: '순서를 바꾸다 충돌해 이력을 되돌렸습니다.',
            author: 'User',
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:00.000Z',
          },
        ],
      },
    ],
  });
  const woken = await (await waiting).text();
  expect(woken).toContain('"threadId":"handed-over"');
  expect(woken).toContain(edits);
  expect(await texts()).toContain(`커밋 ${edits.slice(0, 7)} edits [답변 대기]`);

  const blocked = await post(`/api/reorder?base=${base}&target=${other}`, {
    order: [adds, other, edits],
  });
  expect(await blocked.json()).toMatchObject({ reason: 'agent-working' });

  git(repo, ['reset', '-q', '--hard', base]);
  const newEdits = commit(repo, 'edits', { 'b.js': '2\n' });
  const newAdds = commit(repo, 'adds', { 'b.js': '1\n' });
  const newOther = commit(repo, 'other', { 'o.js': '1\n' });
  const followed = await post(`/api/history-rewritten?base=${base}&target=${other}`, {
    rewritten: { [edits]: newEdits, [adds]: newAdds, [other]: newOther },
  });
  expect(followed.status).toBe(200);
  expect(await followed.json()).toMatchObject({
    success: true,
    threads: [{ id: 'handed-over', fixupTarget: newEdits }],
  });

  const { review } = (await (await fetch(api('/api/diff'))).json()) as DiffResponse;
  expect(review!.commits.map(({ sha }) => sha)).toEqual([newEdits, newAdds, newOther]);

  await comment({
    type: 'reply',
    threadId: 'handed-over',
    author: 'Agent',
    position,
    fixupTarget: edits,
    body: '맡겨진 순서로 옮겼습니다.',
  });
  const output = await texts();
  expect(output).toContain(`커밋 ${newEdits.slice(0, 7)} edits`);
  expect(output).toContain('맡겨진 순서로 옮겼습니다.');
  expect(output).toContain('[답변 완료]');
});

it('refuses to follow a rewrite the history does not show', async () => {
  const { repo, base, adds, edits } = conflictingStack();
  const { post } = await startReview(repo, base, edits, 9288);
  const follow = async (body: unknown) => {
    const response = await post(`/api/history-rewritten?base=${base}&target=${edits}`, body);
    return [response.status, ((await response.json()) as { reason?: string }).reason];
  };

  expect(await follow({ rewritten: {} })).toEqual([400, undefined]);
  expect(await follow({ rewritten: { [adds]: 'not-a-sha' } })).toEqual([400, undefined]);
  expect(await follow({ rewritten: { [adds]: 'f'.repeat(40) } })).toEqual([409, 'stale-view']);
  // The commit it names stands on HEAD, but `edits` then has no place in the review.
  git(repo, ['reset', '-q', '--hard', adds]);
  expect(await follow({ rewritten: { [adds]: adds } })).toEqual([409, 'stale-view']);
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(adds);
});

it('hands a reword over when rebuilding a merge conflicts', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const base = commit(repo, 'base', { 'a.js': '1\n2\n3\n' });
  const typo = commit(repo, 'add typpo', { 'b.js': '1\n' });
  git(repo, ['checkout', '-q', '-b', 'side']);
  commit(repo, 'side edit', { 'a.js': '1\nside\n3\n' });
  git(repo, ['checkout', '-q', 'feature']);
  commit(repo, 'main edit', { 'a.js': '1\nmain\n3\n' });
  expect(() => git(repo, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'])).toThrow();
  const merge = commit(repo, 'merge side', { 'a.js': '1\nresolved\n3\n' });

  const { api, post } = await startReview(repo, base, merge, 9289);
  const leaving = new AbortController();
  const waiting = await fetch(api('/api/comments-wait'), { signal: leaving.signal });
  const response = await post(`/api/reword?base=${base}&target=${merge}`, {
    commit: typo,
    original: 'add typpo',
    message: 'add typo',
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    reason: 'conflict',
    conflict: { commit: { sha: merge, subject: 'merge side' }, agentAttached: true },
  });
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(merge);
  leaving.abort();
  await waiting.body?.cancel().catch(() => undefined);
});
