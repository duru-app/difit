import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { readRewriteState, rewriteHistory } from './history-rewrite';

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
      'if [ "$1" = update-ref ] && [ -n "$BEFORE_UPDATE_REF" ]; then sh -c "$BEFORE_UPDATE_REF"; fi',
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
      await rewriteHistory(repo, {
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
      await rewriteHistory(repo, { base, messages: new Map([[amendedSecond, 'use it']]) }),
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

    expectOk(await rewriteHistory(repo, { base, messages: new Map([[first, 'add feature']]) }));

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
    ]) {
      const path = join(repo, '.git', 'hooks', hook);
      writeFileSync(path, `#!/bin/sh\necho ${hook} >> '${marker}'\n`);
      chmodSync(path, 0o755);
    }

    expectOk(await rewriteHistory(repo, { base, messages: new Map([[first, 'add feature']]) }));

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
      await rewriteHistory(repo, { base, messages: new Map([[first, 'add feature']]) }),
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

    expectOk(await rewriteHistory(repo, { base, messages: new Map([[first, 'add feature']]) }));
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
      await rewriteHistory(repo, {
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
      await rewriteHistory(repo, { base, messages: new Map([[first, 'add feature']]) }),
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

      const result = await rewriteHistory(repo, {
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

    const result = await rewriteHistory(repo, {
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

      const result = await rewriteHistory(repo, {
        base,
        messages: new Map([[first, 'add feature']]),
      });

      expect(result).toMatchObject({ ok: false, reason: 'head-moved' });
      expect(subjects(repo, `${base}..HEAD`)).toEqual(['add feture', 'use feature', 'landed']);
    });
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

    const state = await readRewriteState(repo, second, first);

    expect(state.rewritesPushedCommit).toBe(false);
  });

  it('calls a commit pushed when the upstream holds it, and a later one not', async () => {
    const { repo, first, second } = createRepo();
    remoteOf(repo);
    git(repo, 'push', '-q', '-u', 'origin', 'feature');
    const later = commit(repo, 'not pushed yet', { 'd.ts': 'd\n' });

    expect((await readRewriteState(repo, later, first)).rewritesPushedCommit).toBe(true);
    expect((await readRewriteState(repo, later, second)).rewritesPushedCommit).toBe(true);
    expect((await readRewriteState(repo, later, later)).rewritesPushedCommit).toBe(false);
  });
});
