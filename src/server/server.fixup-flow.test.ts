import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { fetch } from 'undici';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { startServer } from './server.js';
import type { DiffResponse } from '../types/diff.js';
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
    `discount.test.js:L3 [수정 중]\n고쳐 넣을 커밋: ${shortPin} test: pin current discount\n`,
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
  expect(output).toContain('\ndiscount.test.js [수정 중]\n');
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

it('rewords a commit of the review into an amend! the commit list then shows', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-flow-'));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  const base = commit(repo, 'base', { 'price.js': 'export const price = 1;\n' });
  const typo = commit(repo, 'add prcie helper\n\nRounds down.', {
    'helper.js': 'export const helper = 1;\n',
  });
  const tip = commit(repo, 'use helper', { 'price.js': 'export const price = 2;\n' });
  writeFileSync(join(repo, 'price.js'), 'work in progress\n');

  const { port, server } = await startServer({
    selection: createDiffSelection(base, tip),
    repoPath: repo,
    preferredPort: 9270,
  });
  cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
  const api = (path: string) => `http://localhost:${port}${path}`;
  const review = ((await (await fetch(api('/api/diff'))).json()) as DiffResponse).review!;
  const query = `?base=${review.selection.baseCommitish}&target=${review.selection.targetCommitish}`;
  const messageOf = async () =>
    (
      (await (await fetch(api(`/api/commit-message${query}&commit=${typo}`))).json()) as {
        message: string;
      }
    ).message;

  expect(await messageOf()).toBe('add prcie helper\n\nRounds down.');
  const response = await fetch(api(`/api/reword${query}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commit: typo,
      original: 'add prcie helper\n\nRounds down.',
      message: 'add price helper\n\nRounds down.',
    }),
  });
  const { threadId, sha } = (await response.json()) as { threadId: string; sha: string };

  expect(response.status).toBe(200);
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(sha);
  expect(git(repo, ['log', '-1', '--format=%B'])).toBe(
    `amend! ${typo}\n\nadd price helper\n\nRounds down.\n\nReview-Thread: ${threadId}`,
  );
  expect(git(repo, ['status', '--porcelain'])).toBe('M price.js');
  const { fixups } = (await (await fetch(api(`/api/fixups${query}`))).json()) as {
    fixups: Array<{
      sha: string;
      threadIds: string[];
      foldTargetSha?: string;
      amendedMessage?: unknown;
    }>;
  };
  expect(fixups).toEqual([
    expect.objectContaining({
      sha,
      threadIds: [threadId],
      foldTargetSha: typo,
      amendedMessage: {
        before: 'add prcie helper\n\nRounds down.',
        after: 'add price helper\n\nRounds down.',
      },
    }),
  ]);
  expect(await messageOf()).toBe('add price helper\n\nRounds down.');
  const commits = ((await (await fetch(api(`/api/diff${query}`))).json()) as DiffResponse).review!
    .commits;
  expect(commits.map(({ sha: commitSha }) => commitSha)).toEqual([typo, tip]);
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
