import { execFileSync, spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  type HistoryRewrite,
  readRewriteState,
  removeAbandonedRewrites,
  rewriteHistory,
} from './history-rewrite';

let home: string;
const savedEnv = { ...process.env };
const repos: string[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-history-rewrite-home-'));
  // A test run started from a commit hook would otherwise point every git call at that commit.
  process.env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  // Lets a test run a script at the moment the rewrite moves the branch, as another git client would.
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      'case " $* " in *" update-ref "*) [ -z "$BEFORE_UPDATE_REF" ] || sh -c "$BEFORE_UPDATE_REF" ;; esac',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'git'), 0o755);
  Object.assign(process.env, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
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
  delete process.env.BEFORE_UPDATE_REF;
  delete process.env.TMPDIR;
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(repo: string, message: string, files: Record<string, string> = {}): string {
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(repo, path), content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function createRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'difit-history-rewrite-'));
  repos.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'checkout', '-q', '-b', 'feature');
  const base = commit(repo, 'base', { 'a.ts': '1\n2\n3\n4\n5\n' });
  const first = commit(repo, 'add feture', { 'b.ts': 'b\n' });
  const second = commit(repo, 'use feature', { 'c.ts': 'c\n' });
  return { repo, base, first, second };
}

const rewrite = (
  repo: string,
  request: Omit<HistoryRewrite, 'defaultBranch'> & Partial<HistoryRewrite>,
) => rewriteHistory(repo, { defaultBranch: null, ...request });
const subjects = (repo: string, range: string) =>
  git(repo, 'log', '--reverse', '--format=%s', range).split('\n');
const expectOk = (result: Awaited<ReturnType<typeof rewriteHistory>>) => {
  if (!result.ok) throw new Error(`rewrite refused: ${result.reason}: ${result.output ?? ''}`);
  return result;
};

describe('rewriteHistory', () => {
  it('changes the message in place, without an amend!, and maps the old SHAs to the new', async () => {
    const { repo, base, first, second } = createRepo();

    const result = expectOk(
      await rewrite(repo, {
        base,
        messages: new Map([[first, 'add feature\n\nExplains it.']]),
      }),
    );

    expect(subjects(repo, `${base}..HEAD`)).toEqual(['add feature', 'use feature']);
    expect(git(repo, 'log', '-1', '--format=%B', 'HEAD~1')).toBe('add feature\n\nExplains it.');
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(result.head).toBe(head);
    expect(result.rewritten).toEqual({
      [first]: git(repo, 'rev-parse', 'HEAD~1'),
      [second]: head,
    });
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
  });

  it('keeps the SHA of commits before the one reworded, and the author of the one reworded', async () => {
    const { repo, base, first, second } = createRepo();
    git(repo, 'commit', '-q', '--amend', '--no-edit', '--author', 'Someone <s@example.com>');
    const amendedSecond = git(repo, 'rev-parse', 'HEAD');
    const third = commit(repo, 'third', { 'd.ts': 'd\n' });

    const result = expectOk(
      await rewrite(repo, { base, messages: new Map([[amendedSecond, 'use it']]) }),
    );

    expect(git(repo, 'rev-parse', 'HEAD~2')).toBe(first);
    expect(Object.keys(result.rewritten).sort()).toEqual([amendedSecond, third].sort());
    expect(result.rewritten[second]).toBeUndefined();
    expect(git(repo, 'log', '-1', '--format=%an %s', 'HEAD~1')).toBe('Someone use it');
  });

  it('leaves the working tree, the index and an unrelated change exactly as they were', async () => {
    const { repo, base, first } = createRepo();
    writeFileSync(join(repo, 'a.ts'), 'work in progress\n');
    writeFileSync(join(repo, 'b.ts'), 'staged\n');
    git(repo, 'add', 'b.ts');
    writeFileSync(join(repo, 'untracked.ts'), 'new\n');
    const before = git(repo, 'status', '--porcelain');

    expectOk(await rewrite(repo, { base, messages: new Map([[first, 'add feature']]) }));

    expect(git(repo, 'status', '--porcelain')).toBe(before);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(repo, 'for-each-ref', 'refs/rewritten')).toBe('');
  });

  it('runs no hook of the repository', async () => {
    const { repo, base, first } = createRepo();
    const marker = join(repo, 'hook-ran');
    for (const hook of [
      'pre-rebase',
      'pre-commit',
      'commit-msg',
      'post-commit',
      'post-checkout',
      'post-rewrite',
      'reference-transaction',
    ]) {
      const path = join(repo, '.git', 'hooks', hook);
      writeFileSync(path, `#!/bin/sh\necho ${hook} >> '${marker}'\n`);
      chmodSync(path, 0o755);
    }

    expectOk(await rewrite(repo, { base, messages: new Map([[first, 'add feature']]) }));

    expect(existsSync(marker)).toBe(false);
  });

  it('keeps unfolded fixups, pointing their subjects and trailers at the new SHAs', async () => {
    const { repo, base, first, second } = createRepo();
    const bySha = commit(repo, `fixup! ${first}\n\nadd feture\n\nReview-Thread: t1`, {
      'b.ts': 'b2\n',
    });
    commit(repo, `fixup! use feature\n\nReview-Thread: t2`, { 'c.ts': 'c2\n' });
    const ofFixup = commit(repo, `fixup! ${bySha}\n\nReview-Thread: t3`, { 'b.ts': 'b3\n' });
    const noted = commit(repo, `later\n\nFollows-Up: ${first}\nReview-Thread: t4`, {
      'd.ts': 'd\n',
    });

    const { rewritten } = expectOk(
      await rewrite(repo, { base, messages: new Map([[first, 'add feature']]) }),
    );

    expect(git(repo, 'log', '--reverse', '--format=%s', `${base}..HEAD`).split('\n')).toEqual([
      'add feature',
      'use feature',
      `fixup! ${rewritten[first]}`,
      `fixup! ${rewritten[second]}`,
      `fixup! ${rewritten[bySha]}`,
      'later',
    ]);
    expect(git(repo, 'log', '-1', '--format=%B', rewritten[bySha]!)).toBe(
      `fixup! ${rewritten[first]}\n\nadd feture\n\nReview-Thread: t1`,
    );
    expect(git(repo, 'log', '-1', '--format=%(trailers:key=Review-Thread,valueonly)', 'HEAD')).toBe(
      't4',
    );
    expect(git(repo, 'log', '-1', '--format=%(trailers:key=Follows-Up,valueonly)', 'HEAD')).toBe(
      rewritten[first],
    );
    expect(rewritten[ofFixup]).toBeDefined();
    expect(rewritten[noted]).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('leaves fixups that still fold into their targets through autosquash', async () => {
    const { repo, base, first } = createRepo();
    commit(repo, `fixup! ${first}\n\nReview-Thread: t1`, { 'b.ts': 'b2\n' });
    commit(repo, 'fixup! use feature\n\nReview-Thread: t2', { 'c.ts': 'c2\n' });
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}');

    expectOk(await rewrite(repo, { base, messages: new Map([[first, 'add feature']]) }));
    git(repo, '-c', 'sequence.editor=true', 'rebase', '-q', '-i', '--autosquash', base);

    expect(subjects(repo, `${base}..HEAD`)).toEqual(['add feature', 'use feature']);
    expect(git(repo, 'rev-parse', 'HEAD^{tree}')).toBe(tree);
  });

  it('keeps a pending amend! and folds it to the message just saved', async () => {
    const { repo, base, first } = createRepo();
    const amend = commit(
      repo,
      `amend! ${first}\n\nadd featur\n\nExplains it.\n\nReview-Thread: t1`,
    );

    const { rewritten } = expectOk(
      await rewrite(repo, {
        base,
        messages: new Map([[first, 'add feature\n\nExplains it better.']]),
      }),
    );

    expect(git(repo, 'log', '-1', '--format=%B')).toBe(
      `amend! ${rewritten[first]}\n\nadd feature\n\nExplains it better.\n\nReview-Thread: t1`,
    );
    expect(rewritten[amend]).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(git(repo, 'diff', '--name-only', 'HEAD~1', 'HEAD')).toBe('');

    git(repo, '-c', 'sequence.editor=true', 'rebase', '-q', '-i', '--autosquash', base);

    expect(git(repo, 'log', '--reverse', '--format=%B', `${base}..HEAD`).split('\n')[0]).toBe(
      'add feature',
    );
    expect(git(repo, 'log', '-1', '--format=%B', 'HEAD~1')).toBe(
      'add feature\n\nExplains it better.\n\nReview-Thread: t1',
    );
  });

  it('rewrites around a merge in the range and keeps the merge', async () => {
    const { repo, base, first, second } = createRepo();
    git(repo, 'checkout', '-q', '-b', 'side', second);
    const sideCommit = commit(repo, 'side work', { 's.ts': 's\n' });
    git(repo, 'checkout', '-q', 'feature');
    commit(repo, 'next', { 'n.ts': 'n\n' });
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    const merge = git(repo, 'rev-parse', 'HEAD');
    const tip = commit(repo, 'tip', { 't.ts': 't\n' });
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}');

    const { rewritten } = expectOk(
      await rewrite(repo, { base, messages: new Map([[first, 'add feature']]) }),
    );

    expect(git(repo, 'rev-parse', 'HEAD^{tree}')).toBe(tree);
    expect(git(repo, 'log', '--merges', '--format=%s', `${base}..HEAD`)).toBe('merge side');
    const newMerge = git(repo, 'rev-parse', 'HEAD~1');
    expect(rewritten[merge]).toBe(newMerge);
    expect(rewritten[tip]).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(git(repo, 'rev-parse', `${newMerge}^2`)).toBe(rewritten[sideCommit]);
    expect(git(repo, 'log', '-1', '--format=%s', `${rewritten[second]}~1`)).toBe('add feature');
    expect(git(repo, 'merge-base', '--is-ancestor', rewritten[second]!, `${newMerge}^2`)).toBe('');
  });

  describe('a merge whose conflict was resolved by hand', () => {
    function repoWithResolvedMerge() {
      const { repo, base, first, second } = createRepo();
      git(repo, 'checkout', '-q', '-b', 'side', second);
      commit(repo, 'side edit', { 'a.ts': '1\n2\nside\n4\n5\n' });
      git(repo, 'checkout', '-q', 'feature');
      commit(repo, 'main edit', { 'a.ts': '1\n2\nmain\n4\n5\n' });
      try {
        git(repo, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      } catch {}
      writeFileSync(join(repo, 'a.ts'), '1\n2\nresolved\n4\n5\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '--no-edit');
      return { repo, base, first };
    }

    it('gives the rewrite up and leaves everything as it was', async () => {
      const { repo, base, first } = repoWithResolvedMerge();
      writeFileSync(join(repo, 'b.ts'), 'work in progress\n');
      const head = git(repo, 'rev-parse', 'HEAD');
      const status = git(repo, 'status', '--porcelain');

      const result = await rewrite(repo, {
        base,
        messages: new Map([[first, 'add feature']]),
      });

      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(!result.ok && result.output).toContain('CONFLICT');
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(repo, 'status', '--porcelain')).toBe(status);
      expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false);
      expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
      expect(git(repo, 'for-each-ref', 'refs/rewritten')).toBe('');
    });
  });

  it('gives the rewrite up when a merge would lose changes made inside it', async () => {
    const { repo, base, first, second } = createRepo();
    git(repo, 'checkout', '-q', '-b', 'side', second);
    commit(repo, 'side work', { 's.ts': 's\n' });
    git(repo, 'checkout', '-q', 'feature');
    commit(repo, 'next', { 'n.ts': 'n\n' });
    git(repo, 'merge', '-q', '--no-ff', '--no-commit', 'side');
    writeFileSync(join(repo, 'made-in-merge.ts'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'merge side');
    const head = git(repo, 'rev-parse', 'HEAD');

    const result = await rewrite(repo, {
      base,
      messages: new Map([[first, 'add feature']]),
    });

    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  describe.skipIf(process.platform === 'win32')('HEAD moving during the rewrite', () => {
    it('fails without changing the history', async () => {
      const { repo, base, first } = createRepo();
      process.env.BEFORE_UPDATE_REF = 'git commit -q --allow-empty -m landed';

      const result = await rewrite(repo, {
        base,
        messages: new Map([[first, 'add feature']]),
      });

      expect(result).toMatchObject({ ok: false, reason: 'head-moved' });
      expect(subjects(repo, `${base}..HEAD`)).toEqual(['add feture', 'use feature', 'landed']);
    });
  });

  describe('local branches stacked on the rewritten commits', { timeout: 15_000 }, () => {
    function stackedRepo() {
      const { repo, base, first, second } = createRepo();
      git(repo, 'branch', 'main', base);
      git(repo, 'branch', 'low', first);
      git(repo, 'checkout', '-q', '-b', 'up');
      const third = commit(repo, 'third', { 'd.ts': 'd\n' });
      git(repo, 'checkout', '-q', 'feature');
      return { repo, base, first, second, third };
    }
    const reword = (repo: string, base: string, sha: string, defaultBranch: string | null = null) =>
      rewrite(repo, { base, defaultBranch, messages: new Map([[sha, 'add feature']]) });
    const tip = (repo: string, ref: string) => git(repo, 'rev-parse', ref);
    const tree = (repo: string, ref: string) => git(repo, 'rev-parse', `${ref}^{tree}`);
    const lastReflog = (repo: string, ref: string) =>
      git(repo, 'reflog', 'show', '-1', '--format=%gs', ref);
    const refs = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');

    it('moves a branch above HEAD onto the new commits with the same files', async () => {
      const { repo, base, first, third } = stackedRepo();
      const upTree = tree(repo, 'up');

      const result = expectOk(await reword(repo, base, first));

      expect(git(repo, 'rev-parse', 'up~1')).toBe(result.head);
      expect(subjects(repo, `${base}..up`)).toEqual(['add feature', 'use feature', 'third']);
      expect(tree(repo, 'up')).toBe(upTree);
      expect(result.rewritten[third]).toBe(tip(repo, 'up'));
      expect(result.branches).toEqual({ moved: ['low', 'up'], left: [] });
      for (const ref of ['up', 'feature', 'HEAD']) {
        expect(lastReflog(repo, ref)).toBe('difit: rewrite history');
      }
    });

    it('moves a branch below HEAD to the commit its tip became', async () => {
      const { repo, base, first } = stackedRepo();

      const result = expectOk(await reword(repo, base, first));

      expect(tip(repo, 'low')).toBe(result.rewritten[first]);
      expect(tip(repo, 'low')).toBe(git(repo, 'rev-parse', 'HEAD~1'));
    });

    it('replays commits that two stacked branches share once, and keeps forks off HEAD’s tip apart', async () => {
      const { repo, base, first, second } = stackedRepo();
      git(repo, 'checkout', '-q', '-b', 'up2', 'up');
      commit(repo, 'fourth', { 'e.ts': 'e\n' });
      for (const name of ['fork1', 'fork2']) {
        git(repo, 'checkout', '-q', '-b', name, second);
        commit(repo, name, { [`${name}.ts`]: `${name}\n` });
      }
      git(repo, 'checkout', '-q', 'feature');
      const trees = Object.fromEntries(
        ['up', 'up2', 'fork1', 'fork2'].map((name) => [name, tree(repo, name)]),
      );

      const result = expectOk(await reword(repo, base, first));

      expect(git(repo, 'rev-parse', 'up2~1')).toBe(tip(repo, 'up'));
      expect(git(repo, 'rev-parse', 'fork1~1')).toBe(result.head);
      expect(git(repo, 'rev-parse', 'fork2~1')).toBe(result.head);
      for (const [name, before] of Object.entries(trees)) expect(tree(repo, name)).toBe(before);
      expect(result.branches.moved).toEqual(['fork1', 'fork2', 'low', 'up', 'up2']);
    });

    it('moves a branch that forks from a commit in the middle', async () => {
      const { repo, base, first, second } = stackedRepo();
      const third = commit(repo, 'after second', { 'f.ts': 'f\n' });
      git(repo, 'checkout', '-q', '-b', 'mid', second);
      commit(repo, 'mid work', { 'm.ts': 'm\n' });
      git(repo, 'checkout', '-q', 'feature');
      const midTree = tree(repo, 'mid');

      const result = expectOk(await reword(repo, base, first));

      expect(git(repo, 'rev-parse', 'mid~1')).toBe(result.rewritten[second]);
      expect(git(repo, 'rev-parse', 'HEAD~1')).toBe(result.rewritten[second]);
      expect(result.rewritten[third]).toBe(result.head);
      expect(tree(repo, 'mid')).toBe(midTree);
    });

    it('moves a branch above a merge of HEAD, and one that holds a merge of its own', async () => {
      const { repo, base, first, second } = createRepo();
      git(repo, 'checkout', '-q', '-b', 'side', first);
      commit(repo, 'side work', { 's.ts': 's\n' });
      git(repo, 'checkout', '-q', 'feature');
      git(repo, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      git(repo, 'checkout', '-q', '-b', 'above');
      commit(repo, 'above merge', { 'u.ts': 'u\n' });
      git(repo, 'checkout', '-q', '-b', 'side2', second);
      commit(repo, 'side2 work', { 's2.ts': 's2\n' });
      git(repo, 'checkout', '-q', '-b', 'merging', second);
      commit(repo, 'merging work', { 'w.ts': 'w\n' });
      git(repo, 'merge', '-q', '--no-ff', '-m', 'merge side2', 'side2');
      commit(repo, 'after merge', { 'x.ts': 'x\n' });
      git(repo, 'checkout', '-q', 'feature');
      const trees = Object.fromEntries(
        ['above', 'merging', 'side', 'side2'].map((name) => [name, tree(repo, name)]),
      );

      const result = expectOk(await reword(repo, base, first));

      expect(git(repo, 'rev-parse', 'above~1')).toBe(result.head);
      expect(git(repo, 'log', '-1', '--format=%s', 'HEAD')).toBe('merge side');
      expect(git(repo, 'rev-parse', 'HEAD^2')).toBe(tip(repo, 'side'));
      expect(git(repo, 'log', '-1', '--format=%s', 'merging~1')).toBe('merge side2');
      expect(git(repo, 'rev-parse', 'merging~1^2')).toBe(tip(repo, 'side2'));
      expect(git(repo, 'rev-parse', 'side2~1')).toBe(result.rewritten[second]);
      for (const [name, before] of Object.entries(trees)) expect(tree(repo, name)).toBe(before);
      expect(result.branches.moved).toEqual(['above', 'merging', 'side', 'side2']);
    });

    it('retitles a fixup in a stacked branch to its target’s new SHA', async () => {
      const { repo, base, first } = stackedRepo();
      git(repo, 'checkout', '-q', 'up');
      commit(repo, `fixup! ${first}\n\nReview-Thread: t1`, { 'b.ts': 'b2\n' });
      git(repo, 'checkout', '-q', 'feature');

      const { rewritten } = expectOk(await reword(repo, base, first));

      expect(git(repo, 'log', '-1', '--format=%B', 'up')).toBe(
        `fixup! ${rewritten[first]}\n\nReview-Thread: t1`,
      );
    });

    it('leaves the default branch on the old commits, even when it holds the reworded one', async () => {
      const { repo, base, first, second } = stackedRepo();
      git(repo, 'branch', '-f', 'main', second);

      const result = expectOk(await reword(repo, base, first, 'main'));

      expect(tip(repo, 'main')).toBe(second);
      expect(result.branches).toEqual({
        moved: ['low', 'up'],
        left: [{ name: 'main', why: 'default' }],
      });
    });

    it('keeps the default branch in place when a symbolic name points at it', async () => {
      const { repo, base, first, second } = stackedRepo();
      git(repo, 'branch', '-f', 'main', second);
      git(repo, 'symbolic-ref', 'refs/heads/master', 'refs/heads/main');

      const result = expectOk(await reword(repo, base, first, 'main'));

      expect(tip(repo, 'main')).toBe(second);
      expect(git(repo, 'symbolic-ref', 'refs/heads/master')).toBe('refs/heads/main');
      expect(result.branches).toEqual({
        moved: ['low', 'up'],
        left: [{ name: 'main', why: 'default' }],
      });
    });

    it('keeps a branch open in another worktree in place when a symbolic name points at it', async () => {
      const { repo, base, first, third } = stackedRepo();
      const other = mkdtempSync(join(tmpdir(), 'difit-history-rewrite-other-'));
      repos.push(other);
      git(repo, 'worktree', 'add', '-q', join(other, 'wt'), 'up');
      git(repo, 'symbolic-ref', 'refs/heads/up-alias', 'refs/heads/up');

      const result = expectOk(await reword(repo, base, first));

      expect(tip(repo, 'up')).toBe(third);
      expect(git(join(other, 'wt'), 'rev-parse', 'HEAD')).toBe(third);
      expect(result.branches).toEqual({ moved: ['low'], left: [{ name: 'up', why: 'worktree' }] });
    });

    it('rewrites when symbolic names point at HEAD’s branch and at a moving branch', async () => {
      const { repo, base, first } = stackedRepo();
      git(repo, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/feature');
      git(repo, 'symbolic-ref', 'refs/heads/up-alias', 'refs/heads/up');

      const result = expectOk(await reword(repo, base, first));

      expect(tip(repo, 'alias')).toBe(result.head);
      expect(tip(repo, 'up-alias')).toBe(tip(repo, 'up'));
      expect(git(repo, 'rev-parse', 'up~1')).toBe(result.head);
      expect(git(repo, 'symbolic-ref', 'refs/heads/alias')).toBe('refs/heads/feature');
      expect(result.branches).toEqual({ moved: ['low', 'up'], left: [] });
    });

    it('leaves a branch checked out in another worktree, and says so', async () => {
      const { repo, base, first, third } = stackedRepo();
      const other = mkdtempSync(join(tmpdir(), 'difit-history-rewrite-other-'));
      repos.push(other);
      git(repo, 'worktree', 'add', '-q', join(other, 'wt'), 'up');

      const result = expectOk(await reword(repo, base, first));

      expect(tip(repo, 'up')).toBe(third);
      expect(git(join(other, 'wt'), 'status', '--porcelain')).toBe('');
      expect(result.branches).toEqual({ moved: ['low'], left: [{ name: 'up', why: 'worktree' }] });
    });

    it('leaves a branch under rebase or bisect in another worktree, and the rebase can still be aborted', async () => {
      const { repo, base, first, third } = stackedRepo();
      const other = mkdtempSync(join(tmpdir(), 'difit-history-rewrite-other-'));
      repos.push(other);
      const rebasing = join(other, 'rebasing');
      git(repo, 'worktree', 'add', '-q', rebasing, 'up');
      git(rebasing, '-c', 'sequence.editor=sed -i 1s/^pick/edit/', 'rebase', '-q', '-i', 'HEAD~1');
      const bisecting = join(other, 'bisecting');
      git(repo, 'worktree', 'add', '-q', bisecting, '-b', 'bis', 'up');
      git(bisecting, 'bisect', 'start', 'bis', base);

      const result = expectOk(await reword(repo, base, first));

      expect(tip(repo, 'up')).toBe(third);
      expect(tip(repo, 'bis')).toBe(third);
      expect(result.branches.left).toEqual([
        { name: 'bis', why: 'operation' },
        { name: 'up', why: 'operation' },
      ]);
      git(rebasing, 'rebase', '--abort');
      expect(git(rebasing, 'rev-parse', 'HEAD')).toBe(third);
      expect(git(rebasing, 'symbolic-ref', '--short', 'HEAD')).toBe('up');
    });

    it('moves nothing when replaying a stacked branch fails, and says which branch', async () => {
      const { repo, base, first } = stackedRepo();
      git(repo, 'checkout', '-q', '-b', 'side', 'up');
      commit(repo, 'side edit', { 'a.ts': '1\n2\nside\n4\n5\n' });
      git(repo, 'checkout', '-q', '-b', 'resolved', 'up');
      commit(repo, 'own edit', { 'a.ts': '1\n2\nmain\n4\n5\n' });
      try {
        git(repo, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      } catch {}
      writeFileSync(join(repo, 'a.ts'), '1\n2\nresolved\n4\n5\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '--no-edit');
      git(repo, 'checkout', '-q', 'feature');
      writeFileSync(join(repo, 'b.ts'), 'work in progress\n');
      const before = { refs: refs(repo), status: git(repo, 'status', '--porcelain') };

      const result = await reword(repo, base, first);

      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(!result.ok && result.output).toMatch(/^Moving branch resolved: .*CONFLICT/s);
      expect({ refs: refs(repo), status: git(repo, 'status', '--porcelain') }).toEqual(before);
      expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature');
      expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
      expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false);
    });

    describe.skipIf(process.platform === 'win32')(
      'a stacked branch moving during the rewrite',
      () => {
        it('moves no ref at all', async () => {
          const { repo, base, first } = stackedRepo();
          const before = refs(repo);
          process.env.BEFORE_UPDATE_REF = 'git branch -f up HEAD';
          const head = tip(repo, 'HEAD');

          const result = await reword(repo, base, first);

          expect(result).toMatchObject({ ok: false, reason: 'branch-moved' });
          expect(!result.ok && result.output).toContain('refs/heads/up');
          expect(refs(repo)).toBe(before.replace(/^refs\/heads\/up .*$/m, `refs/heads/up ${head}`));
        });
      },
    );
  });
});

describe.skipIf(process.platform === 'win32')('a rewrite cut short', { timeout: 30_000 }, () => {
  const worktrees = (repo: string) => git(repo, 'worktree', 'list').split('\n');
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'difit-history-rewrite-scratch-'));
    repos.push(dir);
    return dir;
  };

  it('removes its worktree and temporary folder when the server is told to stop', async () => {
    const { repo, base, first } = createRepo();
    git(repo, 'checkout', '-q', '-b', 'up');
    for (let i = 0; i < 60; i += 1) git(repo, 'commit', '-q', '--allow-empty', '-m', `up ${i}`);
    git(repo, 'checkout', '-q', 'feature');
    const state = () => ({
      refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
      head: git(repo, 'symbolic-ref', 'HEAD'),
      status: git(repo, 'status', '--porcelain'),
    });
    const before = state();
    const temp = scratch();
    process.env.TMPDIR = temp;
    const keepRunning = () => {};
    process.on('SIGHUP', keepRunning);
    try {
      let settled = false;
      const running = rewrite(repo, { base, messages: new Map([[first, 'add feature']]) }).then(
        (result) => result,
        (error: unknown) => error,
      );
      void running.finally(() => {
        settled = true;
      });
      const midRebase = join(repo, '.git', 'worktrees', 'worktree', 'rebase-merge');
      while (!settled && !existsSync(midRebase)) await new Promise((r) => setTimeout(r, 5));
      expect(settled).toBe(false);

      process.emit('SIGHUP', 'SIGHUP');
      const result = await running;

      expect(result).toMatchObject({ name: 'AbortError' });
      expect(state()).toEqual(before);
      expect(worktrees(repo)).toHaveLength(1);
      expect(readdirSync(temp)).toEqual([]);
    } finally {
      process.off('SIGHUP', keepRunning);
    }
  });

  it('removes at startup a rewrite whose server is gone, and leaves one whose server runs', async () => {
    const { repo } = createRepo();
    const temp = scratch();
    const rewriteDir = (owner: number) => {
      const dir = mkdtempSync(join(temp, 'difit-history-rewrite-'));
      writeFileSync(join(dir, 'owner'), `${owner}\n`);
      git(repo, 'worktree', 'add', '-q', '--detach', join(dir, 'worktree'), 'HEAD');
      return dir;
    };
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    const abandoned = rewriteDir(gone);
    const live = rewriteDir(process.pid);
    const unowned = mkdtempSync(join(temp, 'difit-history-rewrite-'));
    git(repo, 'worktree', 'add', '-q', '--detach', join(unowned, 'worktree'), 'HEAD');

    await removeAbandonedRewrites(repo);

    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(join(live, 'worktree'))).toBe(true);
    expect(existsSync(join(unowned, 'worktree'))).toBe(true);
    expect(worktrees(repo)).toHaveLength(3);
  });
});

describe('readRewriteState', () => {
  const remoteOf = (repo: string) => {
    const remote = mkdtempSync(join(tmpdir(), 'difit-history-rewrite-remote-'));
    repos.push(remote);
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
  };

  it('calls nothing pushed when the branch has no upstream', async () => {
    const { repo, first, second } = createRepo();
    remoteOf(repo);
    git(repo, 'push', '-q', 'origin', 'feature');

    const state = await readRewriteState(repo, second, first, null);

    expect(state.rewritesPushedCommit).toBe(false);
  });

  it('calls a commit pushed when the upstream holds it, and a later one not', async () => {
    const { repo, first, second } = createRepo();
    remoteOf(repo);
    git(repo, 'push', '-q', '-u', 'origin', 'feature');
    const later = commit(repo, 'not pushed yet', { 'd.ts': 'd\n' });

    expect((await readRewriteState(repo, later, first, null)).rewritesPushedCommit).toBe(true);
    expect((await readRewriteState(repo, later, second, null)).rewritesPushedCommit).toBe(true);
    expect((await readRewriteState(repo, later, later, null)).rewritesPushedCommit).toBe(false);
  });
});

describe('rewriteHistory with a new order', () => {
  function createStack() {
    const repo = mkdtempSync(join(tmpdir(), 'difit-history-rewrite-'));
    repos.push(repo);
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'feature');
    const base = commit(repo, 'base', { 'a.ts': 'a\n' });
    const first = commit(repo, 'first', { 'first.ts': '1\n' });
    const second = commit(repo, 'second', { 'second.ts': '2\n' });
    const third = commit(repo, 'third', { 'third.ts': '3\n' });
    return { repo, base, first, second, third };
  }
  const reorder = (repo: string, base: string, order: string[]) =>
    rewrite(repo, { base, messages: new Map(), order });

  it('puts the commits in that order, keeps the end tree and maps every replaced commit', async () => {
    const { repo, base, first, second, third } = createStack();
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}');

    const result = expectOk(await reorder(repo, base, [third, first, second]));

    expect(subjects(repo, `${base}..HEAD`)).toEqual(['third', 'first', 'second']);
    expect(git(repo, 'rev-parse', 'HEAD^{tree}')).toBe(tree);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
    expect(result.head).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(result.rewritten).toEqual({
      [third]: git(repo, 'rev-parse', 'HEAD~2'),
      [first]: git(repo, 'rev-parse', 'HEAD~1'),
      [second]: git(repo, 'rev-parse', 'HEAD'),
    });
  });

  it('keeps the SHA of the commits before the first one that moves', async () => {
    const { repo, base, first, second, third } = createStack();

    const result = expectOk(await reorder(repo, base, [first, third, second]));

    expect(git(repo, 'rev-parse', 'HEAD~2')).toBe(first);
    expect(Object.keys(result.rewritten).sort()).toEqual([second, third].sort());
  });

  it('leaves an uncommitted change exactly as it was', async () => {
    const { repo, base, first, second, third } = createStack();
    writeFileSync(join(repo, 'a.ts'), 'a\nuncommitted\n');

    expectOk(await reorder(repo, base, [second, first, third]));

    expect(git(repo, 'status', '--porcelain')).toBe('M a.ts');
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('keeps a fixup above the reviewed commits there, naming the new SHA of its target', async () => {
    const { repo, base, first, second, third } = createStack();
    commit(repo, `fixup! ${first}\n\nReview-Thread: t1`, { 'first.ts': 'one\n' });
    commit(repo, 'after the review', { 'later.ts': 'x\n' });

    const result = expectOk(await reorder(repo, base, [second, third, first]));

    const movedFirst = result.rewritten[first] ?? '';
    expect(subjects(repo, `${base}..HEAD`)).toEqual([
      'second',
      'third',
      'first',
      `fixup! ${movedFirst}`,
      'after the review',
    ]);
    expect(git(repo, 'log', '-1', '--format=%B', 'HEAD~1')).toContain('Review-Thread: t1');
  });

  function createStackWithFixup(place: 'after-target' | 'after-next') {
    const repo = mkdtempSync(join(tmpdir(), 'difit-history-rewrite-'));
    repos.push(repo);
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'feature');
    const base = commit(repo, 'base', { 'a.ts': 'a\n' });
    const first = commit(repo, 'first', { 'first.ts': '1\n' });
    const fixup = () => commit(repo, `fixup! ${first}`, { 'first.ts': 'one\n' });
    if (place === 'after-target') fixup();
    const second = commit(repo, 'second', { 'second.ts': '2\n' });
    if (place === 'after-next') fixup();
    const third = commit(repo, 'third', { 'third.ts': '3\n' });
    return { repo, base, first, second, third };
  }

  it('moves a fixup sitting between commits along with the commit before it', async () => {
    const { repo, base, first, second, third } = createStackWithFixup('after-target');

    const result = expectOk(await reorder(repo, base, [third, first, second]));

    expect(subjects(repo, `${base}..HEAD`)).toEqual([
      'third',
      'first',
      `fixup! ${result.rewritten[first] ?? ''}`,
      'second',
    ]);
  });

  it('keeps a fixup behind its target when the target moves past it', async () => {
    const { repo, base, first, second, third } = createStackWithFixup('after-next');

    const result = expectOk(await reorder(repo, base, [second, third, first]));

    expect(subjects(repo, `${base}..HEAD`)).toEqual([
      'second',
      'third',
      'first',
      `fixup! ${result.rewritten[first] ?? ''}`,
    ]);
  });

  it('gives up on a conflict and leaves HEAD and the working tree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'difit-history-rewrite-'));
    repos.push(repo);
    git(repo, 'init', '-q');
    git(repo, 'checkout', '-q', '-b', 'feature');
    const base = commit(repo, 'base', { 'a.ts': 'a\n' });
    const adds = commit(repo, 'adds a line', { 'a.ts': 'a\nb\n' });
    const edits = commit(repo, 'edits that line', { 'a.ts': 'a\nB\n' });

    const result = await reorder(repo, base, [edits, adds]);

    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(edits);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('refuses when HEAD moved while the rebase ran', async () => {
    const { repo, base, first, second, third } = createStack();
    process.env.BEFORE_UPDATE_REF = `git -C '${repo}' commit -q --allow-empty -m 'came in meanwhile'`;

    const result = await reorder(repo, base, [second, first, third]);

    expect(result).toMatchObject({ ok: false, reason: 'head-moved' });
    expect(subjects(repo, `${base}..HEAD`)).toEqual([
      'first',
      'second',
      'third',
      'came in meanwhile',
    ]);
  });

  it('refuses an order naming a commit that is not on the line of the range', async () => {
    const { repo, base, first, second, third } = createStack();

    const result = await reorder(repo, base, [second, first, third, 'f'.repeat(40)]);

    expect(result).toMatchObject({ ok: false });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(third);
  });

  describe('local branches on the commits that change places', { timeout: 15_000 }, () => {
    const tip = (repo: string, ref: string) => git(repo, 'rev-parse', ref);
    const tree = (repo: string, ref: string) => git(repo, 'rev-parse', `${ref}^{tree}`);
    const refs = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');

    it('starts a branch with commits of its own again on the new tip when no commit holds the files it grew from', async () => {
      const { repo, base, first, second, third } = createStack();
      git(repo, 'checkout', '-q', '-b', 'next', second);
      commit(repo, 'next work', { 'next.ts': 'n\n' });
      git(repo, 'checkout', '-q', 'feature');

      const result = expectOk(await reorder(repo, base, [third, first, second]));

      expect(tip(repo, 'next~1')).toBe(result.head);
      expect(subjects(repo, `${base}..next`)).toEqual(['third', 'first', 'second', 'next work']);
      expect(result.branches).toEqual({ moved: ['next'], left: [] });
    });

    it('leaves a branch with no commits of its own where it is when no commit holds its files, and names it', async () => {
      const { repo, base, first, second, third } = createStack();
      git(repo, 'branch', 'reviewed', second);

      const result = expectOk(await reorder(repo, base, [third, first, second]));

      expect(tip(repo, 'reviewed')).toBe(second);
      expect(result.branches).toEqual({
        moved: [],
        left: [{ name: 'reviewed', why: 'order-changed' }],
      });
    });

    it('moves a branch to the commit now holding the same files, at its old place in the line', async () => {
      const { repo, base, first, second, third } = createStack();
      const fourth = commit(repo, 'fourth', { 'fourth.ts': '4\n' });
      git(repo, 'branch', 'above', third);
      git(repo, 'branch', 'after-both', second);
      git(repo, 'branch', 'at-tip', fourth);
      const names = ['above', 'after-both', 'at-tip'];
      const trees = names.map((name) => tree(repo, name));

      const result = expectOk(await reorder(repo, base, [second, first, third, fourth]));

      expect(tip(repo, 'after-both')).toBe(result.rewritten[first]);
      expect(tip(repo, 'above')).toBe(result.rewritten[third]);
      expect(tip(repo, 'at-tip')).toBe(result.head);
      expect(names.map((name) => tree(repo, name))).toEqual(trees);
      expect(result.branches).toEqual({ moved: names, left: [] });
    });

    it('keeps branches on the old tip on the new tip when the tip commit itself changed places', async () => {
      const { repo, base, first, second, third } = createStack();
      git(repo, 'branch', 'same', third);
      git(repo, 'checkout', '-q', '-b', 'up');
      commit(repo, 'up work', { 'up.ts': 'u\n' });
      git(repo, 'checkout', '-q', 'feature');
      const upTree = tree(repo, 'up');

      const result = expectOk(await reorder(repo, base, [third, first, second]));

      expect(tip(repo, 'same')).toBe(result.head);
      expect(tip(repo, 'up~1')).toBe(result.head);
      expect(tree(repo, 'up')).toBe(upTree);
      expect(result.branches).toEqual({ moved: ['same', 'up'], left: [] });
    });

    it('moves nothing when a branch cannot start again on the new tip, and says which branch', async () => {
      const { repo, base, first, second, third } = createStack();
      git(repo, 'checkout', '-q', '-b', 'next', second);
      commit(repo, 'next work', { 'third.ts': 'another third\n' });
      git(repo, 'checkout', '-q', 'feature');
      const before = refs(repo);

      const result = await reorder(repo, base, [third, first, second]);

      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(!result.ok && result.output).toMatch(/^Moving branch next: /);
      expect(refs(repo)).toBe(before);
      expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    });
  });

  describe('with a merge in the range', () => {
    function createMerge() {
      const repo = mkdtempSync(join(tmpdir(), 'difit-history-rewrite-'));
      repos.push(repo);
      git(repo, 'init', '-q');
      git(repo, 'checkout', '-q', '-b', 'feature');
      const base = commit(repo, 'base', { 'a.ts': 'a\n' });
      const before = commit(repo, 'before the side branch', { 'before.ts': 'b\n' });
      git(repo, 'checkout', '-q', '-b', 'side');
      const onSide = commit(repo, 'on the side', { 'side.ts': 's\n' });
      git(repo, 'checkout', '-q', 'feature');
      const beside = commit(repo, 'beside the side branch', { 'beside.ts': 'b\n' });
      git(repo, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      const merge = git(repo, 'rev-parse', 'HEAD');
      const after = commit(repo, 'after the merge', { 'after.ts': 'a\n' });
      return { repo, base, before, onSide, beside, merge, after };
    }
    const mergeShape = (repo: string, range: string) =>
      git(repo, 'log', '--first-parent', '--reverse', '--format=%s', range).split('\n');

    it('moves a commit from above the merge to below it and keeps the merge and its branch', async () => {
      const { repo, base, before, beside, merge, after, onSide } = createMerge();
      const tree = git(repo, 'rev-parse', 'HEAD^{tree}');

      const result = expectOk(await reorder(repo, base, [before, beside, after, merge]));

      expect(mergeShape(repo, `${base}..HEAD`)).toEqual([
        'before the side branch',
        'beside the side branch',
        'after the merge',
        'merge side',
      ]);
      expect(git(repo, 'log', '--merges', '--format=%s', `${base}..HEAD`)).toBe('merge side');
      expect(git(repo, 'log', '--format=%s', 'HEAD^2', '-1')).toBe('on the side');
      expect(git(repo, 'rev-parse', 'HEAD^{tree}')).toBe(tree);
      expect(result.rewritten[onSide]).toBeUndefined();
    });

    it('moves a commit older than the fork past the fork, with the side branch still growing from it', async () => {
      const { repo, base, before, beside, merge, after, onSide } = createMerge();

      const result = expectOk(await reorder(repo, base, [beside, before, merge, after]));

      expect(mergeShape(repo, `${base}..HEAD`)).toEqual([
        'beside the side branch',
        'before the side branch',
        'merge side',
        'after the merge',
      ]);
      expect(git(repo, 'log', '--merges', '--format=%s', `${base}..HEAD`)).toBe('merge side');
      expect(git(repo, 'rev-parse', 'side')).toBe(onSide);
      expect(result.branches.left).toEqual([{ name: 'side', why: 'order-changed' }]);
    });

    it('leaves the history when the commit the side branch grows from moves past its merge', async () => {
      const { repo, base, before, beside, merge, after } = createMerge();

      const result = await reorder(repo, base, [beside, merge, before, after]);

      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(after);
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    });
  });
});
