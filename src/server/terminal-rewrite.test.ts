import { execFileSync } from 'child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  findTerminalRewrite,
  type LineCommit,
  pairRewrittenCommits,
  tiedCommits,
} from './terminal-rewrite';

let home: string;
const savedEnv = { ...process.env };
const repos: string[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-terminal-rewrite-home-'));
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

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

const line = (sha: string, author: string, subject = sha, isFixup = false): LineCommit => ({
  sha,
  author,
  subject,
  isFixup,
});

describe('pairRewrittenCommits', () => {
  it('pairs by author date, keeps a kept commit and leaves a lost one alone', () => {
    const pairs = pairRewrittenCommits(
      [line('a', 't1'), line('b', 't2'), line('c', 't3')],
      [line('a', 't1'), line('c2', 't3', 'c reworded'), line('x', 't9')],
    );
    expect([...pairs]).toEqual([
      ['a', 'a'],
      ['c', 'c2'],
    ]);
  });

  it('breaks a tie on the author date by patch id, then by subject', () => {
    const before = [line('a', 't', 'A'), line('b', 't', 'B'), line('c', 't', 'C')];
    const after = [line('b2', 't', 'B'), line('a2', 't', 'A changed'), line('c2', 't', 'C')];
    expect(tiedCommits(before, after).sort()).toEqual(['a', 'a2', 'b', 'b2', 'c', 'c2']);
    const pairs = pairRewrittenCommits(
      before,
      after,
      new Map([
        ['a', 'p'],
        ['a2', 'p'],
      ]),
    );
    expect(Object.fromEntries(pairs)).toEqual({ a: 'a2', b: 'b2', c: 'c2' });
  });

  it('leaves commits without a partner when nothing tells them apart', () => {
    const pairs = pairRewrittenCommits(
      [line('a', 't', 'same'), line('b', 't', 'same')],
      [line('a2', 't', 'same'), line('b2', 't', 'same')],
    );
    expect(pairs.size).toBe(0);
  });

  it('leaves a commit split in two without a partner', () => {
    const pairs = pairRewrittenCommits(
      [line('a', 't', 'A')],
      [line('a1', 't', 'A part'), line('a2', 't', 'A rest')],
    );
    expect(pairs.size).toBe(0);
  });
});

function git(repo: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
}

function tryGit(repo: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  try {
    git(repo, args, env);
  } catch {
    // A stop on a conflict exits non-zero; the test resolves it next.
  }
}

function stack() {
  const repo = mkdtempSync(join(tmpdir(), 'difit-terminal-rewrite-'));
  repos.push(repo);
  let when = 1_700_000_000;
  const commit = (message: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
    git(repo, ['add', '-A']);
    const date = `@${when} +0000`;
    when += 60;
    git(repo, ['commit', '-q', '-m', message], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    return git(repo, ['rev-parse', 'HEAD']);
  };
  git(repo, ['init', '-q', '-b', 'main']);
  const base = commit('base', { 'a.txt': 'x\n' });
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const a = commit('A: x to 1', { 'a.txt': '1\n' });
  const b = commit('B: 1 to 2', { 'a.txt': '2\n' });
  const c = commit('C: add c', { 'c.txt': 'c\n' });
  const d = commit('D: add d', { 'd.txt': 'd\n' });
  const parents = new Map([
    [a, base],
    [b, a],
    [c, b],
    [d, c],
  ]);
  const review = (target: string) => ({
    target,
    commits: [...parents]
      .slice(0, [...parents.keys()].indexOf(target) + 1)
      .map(([sha, parentSha]) => ({ sha, parentSha })),
  });
  return { repo, base, a, b, c, d, commit, review };
}

function script(repo: string, body: string): string {
  const path = join(repo, '..', `${repo.split('/').at(-1)}-${repos.length}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  repos.push(path);
  return path;
}

function rebaseInteractive(repo: string, upstream: string, todo: string[]): void {
  const lines = todo.map((entry) => {
    const [action, prefix] = entry.split(' ');
    return `grep ' ${prefix} ' "$1" | sed 's/^pick/${action}/'`;
  });
  const editor = script(repo, `{\n${lines.join('\n')}\n} > "$1.new"\nmv "$1.new" "$1"`);
  tryGit(repo, ['rebase', '-i', upstream], { GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: 'true' });
}

const subjects = (repo: string, range: string) =>
  git(repo, ['log', '--reverse', '--format=%H %s', range])
    .split('\n')
    .map((entry) => entry.split(' '));

describe('findTerminalRewrite', () => {
  it('follows a reorder whose conflicts were resolved by hand, changed content included', async () => {
    const { repo, base, a, b, c, d, review } = stack();
    rebaseInteractive(repo, base, ['pick B:', 'pick A:', 'reword C:', 'pick D:']);
    writeFileSync(join(repo, 'a.txt'), '2\n');
    git(repo, ['add', 'a.txt']);
    tryGit(repo, ['rebase', '--continue'], { GIT_EDITOR: 'true' });
    writeFileSync(join(repo, 'a.txt'), '2 and 1\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['rebase', '--continue'], {
      GIT_EDITOR: script(repo, `sed -i '1s/^C: add c$/C: add c (reworded)/' "$1"`),
    });
    const after = subjects(repo, `${base}..HEAD`);
    expect(after.map(([, prefix]) => prefix)).toEqual(['B:', 'A:', 'C:', 'D:']);
    const [[newB], [newA], [newC], [newD]] = after as [[string], [string], [string], [string]];

    expect(await findTerminalRewrite(repo, review(d))).toEqual({
      rewritten: { [a]: newA, [b]: newB, [c]: newC, [d]: newD },
      target: newD,
      left: [],
    });
  });

  it('names the commit the resolution left empty, which git drops', async () => {
    const { repo, base, a, b, c, d, review } = stack();
    rebaseInteractive(repo, base, ['pick B:', 'pick A:', 'pick C:', 'pick D:']);
    writeFileSync(join(repo, 'a.txt'), '2\n');
    git(repo, ['add', 'a.txt']);
    tryGit(repo, ['rebase', '--continue'], { GIT_EDITOR: 'true' });
    writeFileSync(join(repo, 'a.txt'), '2\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['rebase', '--continue'], { GIT_EDITOR: 'true' });
    const [[newB], [newC], [newD]] = subjects(repo, `${base}..HEAD`) as [
      [string],
      [string],
      [string],
    ];

    expect(await findTerminalRewrite(repo, review(d))).toEqual({
      rewritten: { [b]: newB, [c]: newC, [d]: newD },
      target: newD,
      left: [a],
    });
  });

  it('keeps a split commit inside the review and names the old one', async () => {
    const { repo, base, c, d, review } = stack();
    rebaseInteractive(repo, base, ['pick A:', 'pick B:', 'edit C:', 'pick D:']);
    git(repo, ['reset', '-q', 'HEAD^']);
    writeFileSync(join(repo, 'c2.txt'), 'c2\n');
    git(repo, ['add', 'c.txt']);
    git(repo, ['commit', '-q', '-m', 'C: add c, first half'], {
      GIT_AUTHOR_DATE: '@1800000000 +0000',
    });
    git(repo, ['add', 'c2.txt']);
    git(repo, ['commit', '-q', '-m', 'C: second half'], { GIT_AUTHOR_DATE: '@1800000060 +0000' });
    git(repo, ['rebase', '--continue'], { GIT_EDITOR: 'true' });
    const newD = git(repo, ['rev-parse', 'HEAD']);

    const found = await findTerminalRewrite(repo, review(d));
    expect(found).toMatchObject({ target: newD, left: [c] });
    expect(found?.rewritten[d]).toBe(newD);
  });

  it('keeps a commit made after the review above it', async () => {
    const { repo, base, b, commit, review } = stack();
    git(repo, ['reset', '-q', '--hard', b]);
    const later = commit('E: later', { 'e.txt': 'e\n' });
    rebaseInteractive(repo, base, ['pick B:', 'pick A:', 'pick E:']);
    writeFileSync(join(repo, 'a.txt'), '2\n');
    git(repo, ['add', 'a.txt']);
    tryGit(repo, ['rebase', '--continue'], { GIT_EDITOR: 'true' });
    writeFileSync(join(repo, 'a.txt'), '2 and 1\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['rebase', '--continue'], { GIT_EDITOR: 'true' });
    const [, [newA], [newLater]] = subjects(repo, `${base}..HEAD`) as [
      [string],
      [string],
      [string],
    ];

    const found = await findTerminalRewrite(repo, review(b));
    expect(found?.target).toBe(newA);
    expect(found?.rewritten[later]).toBe(newLater);
  });

  it('leaves alone a review still on HEAD, a rebase still going, and a line moved onto newer main', async () => {
    const { repo, base, d, commit, review } = stack();
    expect(await findTerminalRewrite(repo, review(d))).toBeNull();

    rebaseInteractive(repo, base, ['pick B:', 'pick A:', 'pick C:', 'pick D:']);
    expect(await findTerminalRewrite(repo, review(d))).toBeNull();
    git(repo, ['rebase', '--abort']);

    git(repo, ['checkout', '-q', 'main']);
    commit('main moves on', { 'm.txt': 'm\n' });
    git(repo, ['checkout', '-q', 'feature']);
    git(repo, ['rebase', '-q', 'main']);
    expect(subjects(repo, `${base}..HEAD`)).toHaveLength(5);
    expect(await findTerminalRewrite(repo, review(d))).toBeNull();
  });

  it('leaves alone a review whose branch HEAD no longer stands on', async () => {
    const { repo, base, d, review } = stack();
    rebaseInteractive(repo, base, ['pick A:', 'pick B:', 'reword C:', 'pick D:']);
    git(repo, ['checkout', '-q', '--detach']);
    expect(await findTerminalRewrite(repo, review(d))).toBeNull();
  });
});
