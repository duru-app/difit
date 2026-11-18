import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { findStackedBranches } from './stacked-branches';

let home: string;
const savedEnv = { ...process.env };
const dirs: string[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-stacked-branches-home-'));
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

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(repo: string, message: string, file = message): string {
  writeFileSync(join(repo, file), `${message}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

// main: base; work1: base a b (HEAD); up: b c; low: a; side: base s
function stackedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'difit-stacked-branches-'));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  commit(repo, 'base');
  git(repo, 'checkout', '-q', '-b', 'work1');
  const a = commit(repo, 'a');
  git(repo, 'branch', 'low');
  const b = commit(repo, 'b');
  git(repo, 'checkout', '-q', '-b', 'up');
  const c = commit(repo, 'c');
  git(repo, 'checkout', '-q', '-b', 'side', 'main');
  commit(repo, 's');
  git(repo, 'checkout', '-q', 'work1');
  return { dir, repo, a, b, c };
}

const find = (repo: string, oldest: string, defaultBranch: string | null = 'main') =>
  findStackedBranches(repo, { oldest, headBranch: 'work1', defaultBranch });

describe('findStackedBranches', () => {
  it('moves every local branch holding the oldest commit, but not HEAD’s own', async () => {
    const { repo, a, c } = stackedRepo();

    expect(await find(repo, a)).toEqual({
      moving: [
        { name: 'low', tip: a },
        { name: 'up', tip: c },
      ],
      left: [],
      pushed: [],
      defaultBranch: 'main',
    });
  });

  it('leaves out a branch below the oldest commit, and keeps the default branch in place by name', async () => {
    const { repo, a, b } = stackedRepo();
    git(repo, 'branch', '-f', 'main', b);

    expect((await find(repo, b)).moving.map(({ name }) => name)).toEqual(['up']);
    expect(await find(repo, a, 'main')).toMatchObject({ left: [{ name: 'main', why: 'default' }] });
    expect((await find(repo, a, null)).moving.map(({ name }) => name)).toEqual([
      'low',
      'main',
      'up',
    ]);
  });

  it('keeps a branch checked out in another worktree in place and says so', async () => {
    const { dir, repo, a } = stackedRepo();
    git(repo, 'worktree', 'add', '-q', join(dir, 'other'), 'up');

    expect(await find(repo, a)).toMatchObject({
      moving: [{ name: 'low' }],
      left: [{ name: 'up', why: 'worktree' }],
    });
  });

  it('neither moves nor names a symbolic branch, and judges the branch it points at', async () => {
    const { dir, repo, a, b } = stackedRepo();
    git(repo, 'branch', '-f', 'main', b);
    git(repo, 'symbolic-ref', 'refs/heads/master', 'refs/heads/main');
    git(repo, 'symbolic-ref', 'refs/heads/head-alias', 'refs/heads/work1');
    git(repo, 'symbolic-ref', 'refs/heads/up-alias', 'refs/heads/up');
    git(repo, 'checkout', '-q', '-b', 'opened', 'up');
    git(repo, 'checkout', '-q', 'work1');
    git(repo, 'worktree', 'add', '-q', join(dir, 'other'), 'opened');
    git(repo, 'symbolic-ref', 'refs/heads/opened-alias', 'refs/heads/opened');

    expect(await find(repo, a)).toEqual({
      moving: [
        { name: 'low', tip: a },
        { name: 'up', tip: git(repo, 'rev-parse', 'up') },
      ],
      left: [
        { name: 'main', why: 'default' },
        { name: 'opened', why: 'worktree' },
      ],
      pushed: [],
      defaultBranch: 'main',
    });
  });

  it('follows a symbolic name given for HEAD’s branch or the default branch', async () => {
    const { repo, a, b } = stackedRepo();
    git(repo, 'branch', '-f', 'main', b);
    git(repo, 'symbolic-ref', 'refs/heads/master', 'refs/heads/main');
    git(repo, 'symbolic-ref', 'refs/heads/current', 'refs/heads/work1');

    expect(
      await findStackedBranches(repo, {
        oldest: a,
        headBranch: 'current',
        defaultBranch: 'master',
      }),
    ).toMatchObject({
      moving: [{ name: 'low' }, { name: 'up' }],
      left: [{ name: 'main', why: 'default' }],
      defaultBranch: 'main',
    });
  });

  it('keeps a branch under rebase or bisect in another worktree in place', async () => {
    const { dir, repo, a } = stackedRepo();
    const rebasing = join(dir, 'rebasing');
    git(repo, 'worktree', 'add', '-q', rebasing, 'up');
    git(rebasing, '-c', 'sequence.editor=sed -i 1s/^pick/edit/', 'rebase', '-q', '-i', 'HEAD~1');
    const bisecting = join(dir, 'bisecting');
    git(repo, 'worktree', 'add', '-q', bisecting, '-b', 'bis', 'up');
    git(bisecting, 'bisect', 'start', 'bis', 'main');

    expect(git(bisecting, 'worktree', 'list', '--porcelain')).not.toContain('refs/heads/bis');
    expect(await find(repo, a)).toMatchObject({
      moving: [{ name: 'low' }],
      left: [
        { name: 'bis', why: 'operation' },
        { name: 'up', why: 'operation' },
      ],
    });
  });

  it('keeps a branch that a rebase with --update-refs in another worktree will move in place', async () => {
    const { dir, repo, a } = stackedRepo();
    const rebasing = join(dir, 'rebasing');
    git(repo, 'worktree', 'add', '-q', rebasing, '-b', 'top', 'up');
    commit(rebasing, 'top');
    git(
      rebasing,
      '-c',
      'sequence.editor=sed -i "s/^pick \\(.* top\\)$/edit \\1/"',
      'rebase',
      '-q',
      '-i',
      '--update-refs',
      'HEAD~2',
    );

    expect(await find(repo, a)).toMatchObject({
      moving: [{ name: 'low' }],
      left: [
        { name: 'top', why: 'operation' },
        { name: 'up', why: 'operation' },
      ],
    });
  });

  it('keeps a branch under rebase in the main worktree in place, read from a linked one', async () => {
    const { dir, repo, a } = stackedRepo();
    const linked = join(dir, 'linked');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'top', 'up');
    git(repo, 'checkout', '-q', 'up');
    git(repo, '-c', 'sequence.editor=sed -i 1s/^pick/edit/', 'rebase', '-q', '-i', 'HEAD~1');

    expect(
      await findStackedBranches(linked, { oldest: a, headBranch: 'top', defaultBranch: 'main' }),
    ).toMatchObject({
      moving: [{ name: 'low' }, { name: 'work1' }],
      left: [{ name: 'up', why: 'operation' }],
    });
  });

  it('names HEAD’s branch and the moving branches whose upstream holds the oldest commit', async () => {
    const { dir, repo, a, b } = stackedRepo();
    const remote = join(dir, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'work1', 'up', 'low');
    git(repo, 'branch', '-f', 'low', 'main');
    git(repo, 'branch', '--set-upstream-to=origin/low', 'low');

    expect((await find(repo, a)).pushed).toEqual(['up', 'work1']);
    expect((await find(repo, b)).pushed).toEqual(['up', 'work1']);
  });
});
