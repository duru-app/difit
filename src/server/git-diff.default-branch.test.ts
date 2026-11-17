import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { GitDiffParser } from './git-diff';

let home: string;
const savedEnv = { ...process.env };
const dirs: string[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-default-branch-home-'));
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

function repoOn(branch: string) {
  const dir = mkdtempSync(join(tmpdir(), 'difit-default-branch-'));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', branch, repo]);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  return { dir, repo };
}

function withOrigin(dir: string, repo: string, remoteBranch: string) {
  const remote = join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', `HEAD:${remoteBranch}`);
  git(repo, 'remote', 'set-head', 'origin', remoteBranch);
}

const defaultBranchOf = (repo: string) => new GitDiffParser(repo).getDefaultBranch();

describe('getDefaultBranch', () => {
  it('names the local branch called like the one origin/HEAD points at', async () => {
    const { dir, repo } = repoOn('develop');
    git(repo, 'branch', 'main');
    withOrigin(dir, repo, 'develop');

    await expect(defaultBranchOf(repo)).resolves.toBe('develop');
  });

  it('names the local branch tracking origin/HEAD’s branch when none is called like it', async () => {
    const { dir, repo } = repoOn('master');
    withOrigin(dir, repo, 'main');
    git(repo, 'branch', '-q', '-u', 'origin/main', 'master');
    git(repo, 'checkout', '-q', '-b', 'feature');

    await expect(defaultBranchOf(repo)).resolves.toBe('master');
  });

  it('falls back to main or master without origin/HEAD, and to nothing without either', async () => {
    const { repo } = repoOn('master');
    git(repo, 'checkout', '-q', '-b', 'feature');

    await expect(defaultBranchOf(repo)).resolves.toBe('master');
    git(repo, 'branch', '-q', '-m', 'master', 'trunk');
    await expect(defaultBranchOf(repo)).resolves.toBeNull();
  });
});
