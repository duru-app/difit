import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { commitDirectReword } from './direct-edit';
import { GitDiffParser } from './git-diff';

const runGitCalls = vi.hoisted(() => [] as string[][]);
vi.mock('./run-git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run-git.js')>();
  return {
    ...actual,
    runGit: (...args: Parameters<typeof actual.runGit>) => {
      runGitCalls.push(args[1]);
      return actual.runGit(...args);
    },
  };
});

// Runs against real repositories because the risk is in how git prints many commits in one go.
let home: string;
const savedEnv = { ...process.env };
const repos: string[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-fixups-home-'));
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
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixups-'));
  repos.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'checkout', '-q', '-b', 'main');
  return repo;
}

function commit(
  repo: string,
  message: string,
  files: Record<string, string | Buffer | null> = {},
): string {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(repo, path);
    if (content === null) {
      rmSync(fullPath);
    } else {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content);
    }
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function merge(repo: string, branch: string, message: string, strategy?: string): string {
  git(repo, 'merge', '-q', '--no-ff', ...(strategy ? ['-s', strategy] : []), '-m', message, branch);
  return git(repo, 'rev-parse', 'HEAD');
}

function diffAgainstFirstParent(parser: GitDiffParser, repo: string, sha: string) {
  const raw = execFileSync('git', ['diff', `${sha}^`, sha, '--no-ext-diff', '--color=never'], {
    cwd: repo,
    encoding: 'utf8',
  });
  return parser.parseStdinDiff(raw).files.map(({ path, oldPath, status, chunks, isGenerated }) => ({
    path,
    oldPath,
    status,
    chunks,
    isGenerated,
  }));
}

function countGitCalls(parser: GitDiffParser): string[] {
  const calls: string[] = [];
  const target = (parser as any).git;
  (parser as any).git = new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return value.apply(object, args);
      };
    },
  });
  return calls;
}

const lines = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join('\n') + '\n';

describe('listThreadFixups against a real repository', () => {
  it('reads every fixup the same as a separate git diff against its first parent', async () => {
    const repo = createRepo();
    git(repo, 'config', 'color.ui', 'always');
    git(repo, 'config', 'diff.external', 'echo external diff');
    const binary = Buffer.from([0, 1, 2, 3, 255, 0, 7]);
    commit(repo, 'base', {
      '.gitattributes': '*.raw diff\n',
      'f.txt': lines(10, 'f'),
      'g.txt': lines(10, 'g'),
      'old-name.txt': lines(20, 'moved'),
      'bin.dat': binary,
      'nul.raw': 'plain\n',
      'side.txt': lines(3, 's'),
    });
    const target = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'checkout', '-q', '-b', 'side');
    commit(repo, 'side work', { 'side.txt': lines(3, 's') + 'from side\n' });
    git(repo, 'checkout', '-q', 'main');

    commit(repo, 'two files\n\nReview-Thread: t-multi', {
      'f.txt': lines(10, 'f').replace('f2\n', 'f2 fixed\n'),
      'g.txt': lines(10, 'g') + 'g11\n',
    });
    commit(repo, 'no trailer', { 'f.txt': lines(10, 'f') });
    commit(repo, 'rename\n\nreview-thread: t-rename', {
      'old-name.txt': null,
      'new-name.txt': lines(20, 'moved').replace('moved20', 'moved twenty'),
    });
    commit(repo, 'binary and text\n\nReview-Thread: t-binary', {
      'bin.dat': Buffer.concat([binary, Buffer.from([9])]),
      'f.txt': 'f0\n' + lines(10, 'f'),
    });
    commit(repo, 'nothing changed\n\nReview-Thread: t-empty');
    commit(
      repo,
      [
        'diff --git a/f.txt b/f.txt',
        '',
        'diff --git a/fake.txt b/fake.txt',
        '--- a/fake.txt',
        '+++ b/fake.txt',
        '@@ -1 +1 @@',
        '-fake',
        '+fake',
        '',
        'Review-Thread: t-tricky',
        'Review-Thread: t-tricky-2',
      ].join('\n'),
      { 'g.txt': lines(10, 'g') },
    );
    const fakeHeader = `\u0000${target}\u0000${target}\u00002026-01-01T00:00:00+00:00\u0000fake\u0000t-fake\u0000`;
    commit(repo, 'text holding the separator\n\nReview-Thread: t-nul', {
      'nul.raw': `plain\nx\r${fakeHeader}\ny\u2028${fakeHeader}\nz\u2029${fakeHeader}\ndiff --git a/nul.raw b/nul.raw\n`,
    });
    const merged = merge(repo, 'side', 'merge side\n\nReview-Thread: t-merge');
    git(repo, 'checkout', '-q', '-b', 'side-ours', target);
    commit(repo, 'dropped work', { 'side.txt': 'dropped\n' });
    git(repo, 'checkout', '-q', 'main');
    const oursMerge = merge(repo, 'side-ours', 'keep ours\n\nReview-Thread: t-ours', 'ours');

    const parser = new GitDiffParser(repo);
    const fixups = await parser.listThreadFixups({
      targetCommitish: target,
      baseCommitish: target,
    });

    expect(fixups.map((fixup) => [fixup.subject, fixup.threadIds])).toEqual([
      ['two files', ['t-multi']],
      ['rename', ['t-rename']],
      ['binary and text', ['t-binary']],
      ['nothing changed', ['t-empty']],
      ['diff --git a/f.txt b/f.txt', ['t-tricky', 't-tricky-2']],
      ['text holding the separator', ['t-nul']],
      ['merge side', ['t-merge']],
      ['keep ours', ['t-ours']],
    ]);
    for (const fixup of fixups) {
      expect(fixup.files, fixup.subject).toEqual(diffAgainstFirstParent(parser, repo, fixup.sha));
      expect(fixup.shortSha).toBe(fixup.sha.slice(0, 7));
      expect(fixup.authoredAt).toBe(git(repo, 'log', '-1', '--format=%aI', fixup.sha));
    }

    const bySubject = new Map(fixups.map((fixup) => [fixup.subject, fixup]));
    expect(bySubject.get('two files')?.files.map((file) => file.path)).toEqual(['f.txt', 'g.txt']);
    expect(bySubject.get('rename')?.files[0]).toMatchObject({
      path: 'new-name.txt',
      oldPath: 'old-name.txt',
      status: 'renamed',
    });
    expect(bySubject.get('binary and text')?.files.map((file) => file.path)).toEqual([
      'bin.dat',
      'f.txt',
    ]);
    expect(bySubject.get('nothing changed')?.files).toEqual([]);
    expect(bySubject.get('nothing changed')?.patchId).toBe(bySubject.get('nothing changed')?.sha);
    expect(bySubject.get('diff --git a/f.txt b/f.txt')?.files.map((file) => file.path)).toEqual([
      'g.txt',
    ]);
    expect(
      bySubject
        .get('text holding the separator')
        ?.files[0].chunks.flatMap((chunk) => chunk.lines.map((line) => line.content)),
    ).toEqual(
      expect.arrayContaining([`x\r${fakeHeader}`, `y\u2028${fakeHeader}`, `z\u2029${fakeHeader}`]),
    );
    expect(bySubject.get('merge side')?.sha).toBe(merged);
    expect(bySubject.get('merge side')?.files.map((file) => file.path)).toEqual(['side.txt']);
    expect(bySubject.get('keep ours')?.sha).toBe(oursMerge);
    expect(bySubject.get('keep ours')?.files).toEqual([]);
  });

  it('marks the generated files a fixup changed', async () => {
    const repo = createRepo();
    commit(repo, 'base', { 'f.txt': lines(3, 'f'), 'pnpm-lock.yaml': lines(3, 'lock') });
    const target = git(repo, 'rev-parse', 'HEAD');
    commit(repo, 'with lockfile\n\nReview-Thread: t-lock', {
      'f.txt': lines(4, 'f'),
      'pnpm-lock.yaml': lines(4, 'lock'),
    });

    const [fixup] = await new GitDiffParser(repo).listThreadFixups({
      targetCommitish: target,
      baseCommitish: target,
    });

    expect(fixup?.files.map((file) => [file.path, file.isGenerated])).toEqual([
      ['f.txt', false],
      ['pnpm-lock.yaml', true],
    ]);
  });

  it('spawns the same number of git processes however many fixups there are', async () => {
    const repo = createRepo();
    commit(repo, 'base', { 'f.txt': lines(40, 'f') });
    const target = git(repo, 'rev-parse', 'HEAD');
    let text = lines(40, 'f');
    const fixup = (index: number) => {
      text = text.replace(`f${index}\n`, `f${index} fixed\n`);
      return commit(repo, `fixup ${index}\n\nReview-Thread: t${index}`, { 'f.txt': text });
    };
    const mergedFixup = (index: number) => {
      git(repo, 'checkout', '-q', '-b', `side${index}`, target);
      commit(repo, `side ${index}`, { [`side${index}.txt`]: `${index}\n` });
      git(repo, 'checkout', '-q', 'main');
      merge(repo, `side${index}`, `merge ${index}\n\nReview-Thread: m${index}`);
    };
    const listAndCount = async () => {
      const parser = new GitDiffParser(repo);
      const calls = countGitCalls(parser);
      const fixups = await parser.listThreadFixups({
        targetCommitish: target,
        baseCommitish: target,
      });
      return { fixups, calls };
    };

    fixup(1);
    mergedFixup(1);
    const few = await listAndCount();

    for (let index = 2; index <= 12; index++) fixup(index);
    mergedFixup(2);
    mergedFixup(3);
    const many = await listAndCount();

    expect(few.fixups).toHaveLength(2);
    expect(many.fixups).toHaveLength(15);
    expect(many.calls).toEqual(few.calls);
    expect(many.calls.length).toBeLessThanOrEqual(4);
  });

  it('reads one fixup the same as the list does', async () => {
    const repo = createRepo();
    commit(repo, 'base', { 'f.txt': lines(5, 'f') });
    const target = git(repo, 'rev-parse', 'HEAD');
    commit(repo, 'first\n\nReview-Thread: t1', { 'f.txt': lines(5, 'f') + 'f6\n' });
    const second = commit(repo, 'second\n\nReview-Thread: t2', {
      'f.txt': lines(5, 'f').replace('f2\n', 'f2 fixed\n') + 'f6\n',
    });

    const parser = new GitDiffParser(repo);
    const listed = await parser.listThreadFixups({
      targetCommitish: target,
      baseCommitish: target,
    });

    expect(await parser.readThreadFixup(second)).toEqual(listed.find((f) => f.sha === second));
  });

  it('reads fixups that are not merges with a single git log', async () => {
    const repo = createRepo();
    commit(repo, 'base', { 'f.txt': 'a\n' });
    const target = git(repo, 'rev-parse', 'HEAD');
    for (let index = 1; index <= 5; index++) {
      commit(repo, `fixup ${index}\n\nReview-Thread: t${index}`, { 'f.txt': `a\n${index}\n` });
    }

    const parser = new GitDiffParser(repo);
    const calls = countGitCalls(parser);
    const fixups = await parser.listThreadFixups({
      targetCommitish: target,
      baseCommitish: target,
    });

    expect(fixups).toHaveLength(5);
    expect(calls).toEqual(['revparse', 'revparse', 'raw']);
  });

  it('follows a rename even when the repository turns diff.renames off', async () => {
    const repo = createRepo();
    git(repo, 'config', 'diff.renames', 'false');
    commit(repo, 'base', { 'other.ts': lines(10, 'o') });
    const original = lines(100, 'line ');
    const target = commit(repo, 'feat: add storage', { 'Old.java': original });
    const renamed = original.replace('line 30\n', 'line 30 renamed\n');
    git(repo, 'mv', 'Old.java', 'New.java');
    commit(repo, 'fixup! feat\n\nReview-Thread: t1', { 'New.java': renamed });
    commit(repo, 'fixup! feat\n\nReview-Thread: t2', {
      'New.java': renamed.replace('line 87\n', 'line 87 renamed\n'),
    });

    const parser = new GitDiffParser(repo);
    const fixups = await parser.listThreadFixups({
      targetCommitish: target,
      baseCommitish: target,
    });
    const filesOf = (index: number) =>
      fixups[index]?.files.map(({ path, oldPath, status }) => ({ path, oldPath, status }));

    expect(fixups.map((fixup) => fixup.threadIds)).toEqual([['t1'], ['t2']]);
    expect(filesOf(0)).toEqual([{ path: 'New.java', oldPath: 'Old.java', status: 'renamed' }]);
    expect(filesOf(1)).toEqual([{ path: 'New.java', oldPath: undefined, status: 'modified' }]);
    expect(await parser.readThreadFixup(fixups[0]!.sha)).toEqual(fixups[0]);
  });

  it('follows a rename a merging fixup brings in when diff.renames is off', async () => {
    const repo = createRepo();
    git(repo, 'config', 'diff.renames', 'false');
    commit(repo, 'base', { 'other.ts': lines(10, 'o') });
    const original = lines(100, 'line ');
    const target = commit(repo, 'feat: add storage', { 'Old.java': original });
    git(repo, 'checkout', '-q', '-b', 'side');
    git(repo, 'mv', 'Old.java', 'New.java');
    commit(repo, 'rename on side', {
      'New.java': original.replace('line 30\n', 'line 30 renamed\n'),
    });
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 'main work', { 'other.ts': lines(11, 'o') });
    merge(repo, 'side', 'merge side\n\nReview-Thread: t-merge');

    const fixups = await new GitDiffParser(repo).listThreadFixups({
      targetCommitish: target,
      baseCommitish: target,
    });

    expect(
      fixups[0]?.files.map(({ path, oldPath, status }) => ({ path, oldPath, status })),
    ).toEqual([{ path: 'New.java', oldPath: 'Old.java', status: 'renamed' }]);
  });
});

describe('plain changes before each fixup against a real repository', () => {
  it('reads how commits answering no thread moved lines since the target or the fixup before', async () => {
    const repo = createRepo();
    const original = lines(60, 'line ');
    const target = commit(repo, 'target', { 'a.ts': original, 'old.ts': lines(5, 'o') });
    const moved = lines(10, 'top ') + original;
    commit(repo, 'plain', { 'a.ts': moved, 'old.ts': null, 'new.ts': lines(5, 'o') });
    commit(repo, 'first\n\nReview-Thread: t1', {
      'a.ts': moved.replace('line 40\n', 'line forty\n'),
    });
    commit(repo, 'second\n\nReview-Thread: t2', {
      'new.ts': lines(5, 'o').replace('o2\n', 'two\n'),
    });
    const parser = new GitDiffParser(repo);
    const selection = { targetCommitish: target, baseCommitish: target };

    const screen = await parser.listFixupsForScreen(selection);

    expect(screen.map((fixup) => fixup.plainChangesBefore)).toEqual([
      [
        { path: 'a.ts', shifts: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 10 }] },
        { path: 'new.ts', oldPath: 'old.ts', shifts: [] },
      ],
      [],
    ]);

    const raw = vi.spyOn((parser as any).git, 'raw');
    await parser.listFixupsForScreen(selection);
    expect(raw.mock.calls.filter(([args]) => (args as string[])[0] === 'diff')).toEqual([]);
    raw.mockRestore();
  });
});

describe('listFixupsForScreen against a real repository', () => {
  function screenRepo() {
    const repo = createRepo();
    const original = lines(60, 'line ');
    const target = commit(repo, 'target', { 'a.ts': original });
    const moved = lines(10, 'top ') + original;
    commit(repo, 'plain', { 'a.ts': moved });
    commit(repo, 'answer\n\nReview-Thread: t1', {
      'a.ts': moved.replace('line 40\n', 'line forty\n'),
    });
    return { repo, target };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the target once for listing and for the commits before each fixup', async () => {
    const { repo, target } = screenRepo();
    const parser = new GitDiffParser(repo);
    const calls = countGitCalls(parser);

    const [fixup] = await parser.listFixupsForScreen({
      targetCommitish: target,
      baseCommitish: target,
    });

    expect(fixup?.files[0]?.chunks[0]?.changeKind).toBeDefined();
    expect(fixup?.plainChangesBefore).toEqual([
      { path: 'a.ts', shifts: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 10 }] },
    ]);
    expect(calls.filter((call) => call === 'revparse')).toHaveLength(2);
  });

  it('gives each fixup its own commits before it whatever order the classified fixups come in', async () => {
    const { repo, target } = screenRepo();
    commit(repo, 'second\n\nReview-Thread: t2', {
      'a.ts': (lines(10, 'top ') + lines(60, 'line '))
        .replace('line 40\n', 'line forty\n')
        .replace('line 50\n', 'line fifty\n'),
    });
    const parser = new GitDiffParser(repo);
    vi.spyOn(parser, 'classifyFixups').mockImplementation(async (fixups) => [...fixups].reverse());

    const screen = await parser.listFixupsForScreen({
      targetCommitish: target,
      baseCommitish: target,
    });

    expect(screen.map((fixup) => [fixup.subject, fixup.plainChangesBefore])).toEqual([
      ['second', []],
      [
        'answer',
        [{ path: 'a.ts', shifts: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 10 }] }],
      ],
    ]);
  });

  it('reads the commits before each fixup while the fixups are being classified', async () => {
    const { repo, target } = screenRepo();
    const parser = new GitDiffParser(repo);
    const events: string[] = [];
    let release = () => {};
    const classification = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(parser, 'classifyFixups').mockImplementation(async (fixups) => {
      events.push('classify started');
      await classification;
      events.push('classify finished');
      return fixups;
    });
    const git = (parser as any).git;
    const raw = git.raw.bind(git);
    vi.spyOn(git, 'raw').mockImplementation(async (args) => {
      const output = await raw(args);
      if ((args as string[])[0] === 'diff') events.push('diff finished');
      return output;
    });

    const screen = parser.listFixupsForScreen({ targetCommitish: target, baseCommitish: target });

    await vi.waitFor(() => expect(events).toContain('diff finished'));
    expect(events).toEqual(['classify started', 'diff finished']);
    release();
    expect((await screen)[0]?.plainChangesBefore).toHaveLength(1);
  });
});

describe('fixup files that match the review base against a real repository', () => {
  function revertRepo() {
    const repo = createRepo();
    const original = lines(20, 'f ');
    const base = commit(repo, 'base', { 'F.ts': original, 'G.ts': lines(5, 'g ') });
    const target = commit(repo, 'A: change F and G, add N', {
      'F.ts': original.replace('f 10\n', 'changed 10\n'),
      'G.ts': lines(6, 'g '),
      'N.ts': lines(3, 'n '),
    });
    return { repo, base, target, original };
  }

  it('marks a file a fixup brought back to the review base, and a file it removed that the base lacks', async () => {
    const { repo, base, target, original } = revertRepo();
    commit(repo, 'fixup! A\n\nReview-Thread: t1', {
      'F.ts': original,
      'G.ts': lines(7, 'g '),
      'N.ts': null,
    });

    const [fixup] = await new GitDiffParser(repo).listFixupsForScreen({
      targetCommitish: target,
      baseCommitish: base,
    });

    expect(fixup?.files.map(({ path, matchesReviewBase }) => [path, matchesReviewBase])).toEqual([
      ['F.ts', true],
      ['G.ts', undefined],
      ['N.ts', true],
    ]);
  });

  it('leaves a file unmarked when git finds it on neither side', async () => {
    const { repo, base } = revertRepo();
    commit(repo, 'add odd name', { 'a\\b.ts': lines(3, 'x ') });
    const reviewTarget = git(repo, 'rev-parse', 'HEAD');
    commit(repo, 'fixup! odd\n\nReview-Thread: t1', { 'a\\b.ts': lines(4, 'x ') });

    const [fixup] = await new GitDiffParser(repo).listFixupsForScreen({
      targetCommitish: reviewTarget,
      baseCommitish: base,
    });

    expect(fixup?.files.map(({ path, matchesReviewBase }) => [path, matchesReviewBase])).toEqual([
      ['a\\b.ts', undefined],
    ]);
  });

  it('compares with the base the review starts from, not the target', async () => {
    const { repo, target, original } = revertRepo();
    commit(repo, 'fixup! A\n\nReview-Thread: t1', { 'F.ts': original });

    const [fixup] = await new GitDiffParser(repo).listFixupsForScreen({
      targetCommitish: target,
      baseCommitish: target,
    });

    expect(fixup?.files[0]?.matchesReviewBase).toBeUndefined();
  });

  it('asks git about every fixup file with one process however many fixups there are', async () => {
    const { repo, base, target, original } = revertRepo();
    const list = async () => {
      runGitCalls.length = 0;
      await new GitDiffParser(repo).listFixupsForScreen({
        targetCommitish: target,
        baseCommitish: base,
      });
      return runGitCalls.filter((args) => args.some((arg) => arg.startsWith('--batch-check')));
    };

    commit(repo, 'fixup! A\n\nReview-Thread: t1', { 'F.ts': original });
    const few = await list();
    for (let index = 2; index <= 6; index++) {
      commit(repo, `fixup! A\n\nReview-Thread: t${index}`, { 'G.ts': lines(5 + index, 'g ') });
    }
    const many = await list();

    expect(few).toHaveLength(1);
    expect(many).toHaveLength(1);
  });
});

describe('the commit each fixup folds into against a real repository', () => {
  it('finds it by subject or id the way autosquash does, and leaves it out outside the range', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.txt': 'a\n' });
    const first = commit(repo, 'add a', { 'a.txt': 'a\n' });
    const target = commit(repo, 'add b', { 'b.txt': 'b\n' });
    commit(repo, 'fixup! add a\n\nReview-Thread: t1', { 'a.txt': 'A\n' });
    commit(repo, `fixup! ${target.slice(0, 10)}\n\nReview-Thread: t1`, { 'b.txt': 'B\n' });
    commit(repo, 'fixup! base\n\nReview-Thread: t2', { 'f.txt': 'F\n' });

    const fixups = await new GitDiffParser(repo).listFixupsForScreen({
      targetCommitish: target,
      baseCommitish: base,
    });

    expect(fixups.map((fixup) => fixup.foldTargetSha)).toEqual([first, target, undefined]);
  });

  it('follows a fixup of a fixup to the reviewed commit, and leaves out a commit after the review', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.txt': 'a\n' });
    const target = commit(repo, 'add a', { 'a.txt': 'a\n' });
    const answer = commit(repo, 'fixup! add a\n\nReview-Thread: t1', { 'a.txt': 'A\n' });
    commit(repo, `fixup! ${answer}\n\nReview-Thread: t1`, { 'a.txt': 'AA\n' });
    const later = commit(repo, 'later', { 'l.txt': 'l\n' });
    commit(repo, `fixup! ${later}\n\nReview-Thread: t2`, { 'l.txt': 'L\n' });

    const fixups = await new GitDiffParser(repo).listFixupsForScreen({
      targetCommitish: target,
      baseCommitish: base,
    });

    expect(fixups.map((fixup) => fixup.foldTargetSha)).toEqual([target, target, undefined]);
  });
});

describe('messages of amend! commits against a real repository', () => {
  it('gives an amend! commit the message of the commit it amends and the one folding leaves, without thread trailers', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.txt': 'a\n' });
    commit(repo, 'add feture\n\nExplains it.', { 'g.txt': 'g\n' });
    const target = commit(repo, 'next', { 'h.txt': 'h\n' });
    commit(repo, 'amend! add feture\n\nadd feature\n\nExplains it.\n\nReview-Thread: t1');
    commit(repo, `fixup! ${target}\n\nReview-Thread: t2`, { 'h.txt': 'i\n' });

    const [amend, fixup] = await new GitDiffParser(repo).listFixupsForScreen({
      targetCommitish: target,
      baseCommitish: base,
    });

    expect(amend?.files).toEqual([]);
    expect(amend?.amendedMessage).toEqual({
      before: 'add feture\n\nExplains it.',
      after: 'add feature\n\nExplains it.',
    });
    expect(fixup?.amendedMessage).toBeUndefined();
  });

  it('finds the amended commit by its id', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.txt': 'a\n' });
    const target = commit(repo, 'wrong', { 'g.txt': 'g\n' });
    commit(repo, `amend! ${target.slice(0, 12)}\n\nright\n\nReview-Thread: t1`);

    const [amend] = await new GitDiffParser(repo).listFixupsForScreen({
      targetCommitish: target,
      baseCommitish: base,
    });

    expect(amend?.amendedMessage).toEqual({ before: 'wrong', after: 'right' });
  });
  it('takes each amend! from the message the one before it leaves', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.txt': 'a\n' });
    const target = commit(repo, 'add feture', { 'g.txt': 'g\n' });
    commit(repo, 'amend! add feture\n\nadd featur\n\nReview-Thread: t1');
    commit(repo, 'amend! add feture\n\nadd feature\n\nReview-Thread: t2');

    const [first, second] = await new GitDiffParser(repo).listFixupsForScreen({
      targetCommitish: target,
      baseCommitish: base,
    });

    expect(first?.amendedMessage).toEqual({ before: 'add feture', after: 'add featur' });
    expect(second?.amendedMessage).toEqual({ before: 'add featur', after: 'add feature' });
  });

  it('drops the whole first paragraph of an amend! commit, as git does', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.txt': 'a\n' });
    const target = commit(repo, 'add feture', { 'g.txt': 'g\n' });
    commit(repo, 'amend! add\nfeture\n\nadd feature\n\nReview-Thread: t1');

    const [amend] = await new GitDiffParser(repo).listFixupsForScreen({
      targetCommitish: target,
      baseCommitish: base,
    });

    expect(amend?.amendedMessage?.after).toBe('add feature');
  });

  it('leaves the message out after a squash! and for an amend! with nothing past its subject', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.txt': 'a\n' });
    const first = commit(repo, 'add a', { 'a.txt': 'a\n' });
    const target = commit(repo, 'add b', { 'b.txt': 'b\n' });
    commit(repo, 'squash! add a\n\nmore');
    commit(repo, 'amend! add a\n\nadd A\n\nReview-Thread: t1');
    commit(repo, 'amend! add b');
    commit(repo, 'amend! add b\n\nadd B\n\nReview-Thread: t2');

    const fixups = await new GitDiffParser(repo).listFixupsForScreen({
      targetCommitish: target,
      baseCommitish: base,
    });

    expect(fixups.map((fixup) => fixup.foldTargetSha)).toEqual([first, target]);
    expect(fixups.map((fixup) => fixup.amendedMessage)).toEqual([undefined, undefined]);
  });
});

describe('amend! commits made by commitDirectReword', () => {
  it('reads the message the reviewer wrote, with other trailers kept', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.txt': 'a\n' });
    const target = commit(repo, 'add feture', { 'g.txt': 'g\n' });
    const result = await commitDirectReword(repo, target, {
      commit: target,
      message: 'add feature\n\nCo-Authored-By: someone <s@example.com>',
      threadId: 't1',
    });

    const [amend] = await new GitDiffParser(repo).listFixupsForScreen({
      targetCommitish: target,
      baseCommitish: base,
    });

    expect(amend).toMatchObject({
      sha: result.ok ? result.sha : '',
      threadIds: ['t1'],
      files: [],
      foldTargetSha: target,
      amendedMessage: {
        before: 'add feture',
        after: 'add feature\n\nCo-Authored-By: someone <s@example.com>',
      },
    });
  });
});

describe('findNewerTarget against a real repository', () => {
  it('stays quiet while only fixups follow the target', async () => {
    const repo = createRepo();
    const target = commit(repo, 'base', { 'f.txt': 'a\n' });
    commit(repo, `fixup! ${target}`, { 'f.txt': 'b\n' });
    commit(repo, 'squash! base', { 'f.txt': 'c\n' });
    commit(repo, 'amend! base', { 'f.txt': 'd\n' });
    commit(repo, 'answer\n\nreview-thread: t1', { 'f.txt': 'e\n' });

    const parser = new GitDiffParser(repo);

    expect(await parser.findNewerTarget(target, 'HEAD', target)).toBeNull();
  });

  it('counts commits autosquash would not fold, and reopens at the newest of them', async () => {
    const repo = createRepo();
    const target = commit(repo, 'base', { 'f.txt': 'a\n' });
    commit(repo, 'Fixup! capitalised', { 'g.txt': 'g\n' });
    commit(repo, 'Revert "fixup! x"', { 'g.txt': 'i\n' });
    const newest = commit(repo, 'next feature\n\nfixup! quoted in the body', { 'g.txt': 'h\n' });
    commit(repo, `fixup! ${target}`, { 'f.txt': 'b\n' });

    const parser = new GitDiffParser(repo);

    expect(await parser.findNewerTarget(target, 'refs/heads/main', target)).toEqual({
      ref: 'main',
      commit: newest,
      commitCount: 3,
    });
  });

  it('leaves out commits the ref already held at launch', async () => {
    const repo = createRepo();
    const older = commit(repo, 'older', { 'f.txt': 'a\n' });
    commit(repo, 'middle', { 'f.txt': 'b\n' });
    const launch = commit(repo, 'launch', { 'f.txt': 'c\n' });

    const parser = new GitDiffParser(repo);

    expect(await parser.findNewerTarget(older, 'HEAD', launch)).toBeNull();

    const later = commit(repo, 'later', { 'f.txt': 'd\n' });

    expect(await parser.findNewerTarget(older, 'HEAD', launch)).toEqual({
      ref: 'HEAD',
      commit: later,
      commitCount: 1,
    });
  });

  it('points at the folded history after the target is rewritten', async () => {
    const repo = createRepo();
    commit(repo, 'root', { 'f.txt': 'a\n' });
    const target = commit(repo, 'base', { 'f.txt': 'b\n' });
    commit(repo, `fixup! ${target}`, { 'f.txt': 'c\n' });
    git(repo, 'reset', '-q', '--soft', 'HEAD~2');
    const folded = commit(repo, 'base');

    const parser = new GitDiffParser(repo);

    expect(await parser.findNewerTarget(target, 'HEAD', target)).toEqual({
      ref: 'HEAD',
      commit: folded,
      commitCount: 1,
    });
  });

  it('stays quiet when the ref is gone or still on the target', async () => {
    const repo = createRepo();
    const target = commit(repo, 'base', { 'f.txt': 'a\n' });

    const parser = new GitDiffParser(repo);

    expect(await parser.findNewerTarget(target, 'HEAD', target)).toBeNull();
    expect(await parser.findNewerTarget(target, 'refs/heads/deleted', target)).toBeNull();
  });
});

describe('listReviewCommits against a real repository', () => {
  const entry = (sha: string, parentSha: string, subject: string) => ({
    sha,
    shortSha: sha.slice(0, 7),
    parentSha,
    subject,
  });
  const mergedEntry = (sha: string, subject: string) => ({
    sha,
    shortSha: sha.slice(0, 7),
    subject,
  });

  it('lists the commits of the range oldest first, leaving out fixups', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.txt': 'a\n' });
    const first = commit(repo, 'first', { 'f.txt': 'b\n' });
    commit(repo, `fixup! ${first}`, { 'f.txt': 'c\n' });
    const answer = commit(repo, 'answer\n\nreview-thread: t1', { 'f.txt': 'd\n' });
    const second = commit(repo, 'second', { 'f.txt': 'e\n' });

    const parser = new GitDiffParser(repo);

    expect(
      await parser.listReviewCommits({ baseCommitish: base.slice(0, 7), targetCommitish: second }),
    ).toEqual([entry(first, base, 'first'), entry(second, answer, 'second')]);
  });

  it('keeps a merge as one commit against its first parent', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.txt': 'a\n' });
    git(repo, 'checkout', '-q', '-b', 'side');
    const sideWork = commit(repo, 'side work', { 'g.txt': 'g\n' });
    git(repo, 'checkout', '-q', 'main');
    const mainWork = commit(repo, 'main work', { 'f.txt': 'b\n' });
    const merged = merge(repo, 'side', 'merge side');

    const parser = new GitDiffParser(repo);

    expect(
      await parser.listReviewCommits({ baseCommitish: base, targetCommitish: merged }),
    ).toEqual([
      entry(mainWork, base, 'main work'),
      {
        ...entry(merged, mainWork, 'merge side'),
        merged: [mergedEntry(sideWork, 'side work')],
        isMerge: true,
      },
    ]);
  });

  it('marks a merge that brings in no commit of its own', async () => {
    const repo = createRepo();
    commit(repo, 'root', { 'f.txt': 'a\n' });
    git(repo, 'checkout', '-q', '-b', 'side');
    commit(repo, 'side work', { 'g.txt': 'g\n' });
    git(repo, 'checkout', '-q', 'main');
    const mainWork = commit(repo, 'main work', { 'f.txt': 'b\n' });
    const merged = merge(repo, 'side', 'merge side');

    const parser = new GitDiffParser(repo);

    expect(
      await parser.listReviewCommits({ baseCommitish: 'side', targetCommitish: merged }),
    ).toEqual([
      entry(mainWork, git(repo, 'rev-parse', 'HEAD~1~1'), 'main work'),
      {
        ...entry(merged, mainWork, 'merge side'),
        isMerge: true,
      },
    ]);
  });

  it('gives each merge the commits only it brings in, oldest first', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.txt': 'a\n' });
    git(repo, 'checkout', '-q', '-b', 'one');
    const oneFirst = commit(repo, 'one first', { 'one.txt': '1\n' });
    const oneSecond = commit(repo, 'one second', { 'one.txt': '2\n' });
    git(repo, 'checkout', '-q', '-b', 'two');
    const twoWork = commit(repo, 'two work', { 'two.txt': '1\n' });
    git(repo, 'checkout', '-q', 'main');
    const mergeOne = merge(repo, 'one', 'merge one');
    const mergeTwo = merge(repo, 'two', 'merge two');
    const after = commit(repo, 'after', { 'f.txt': 'b\n' });

    const parser = new GitDiffParser(repo);

    expect(await parser.listReviewCommits({ baseCommitish: base, targetCommitish: after })).toEqual(
      [
        {
          ...entry(mergeOne, base, 'merge one'),
          merged: [mergedEntry(oneFirst, 'one first'), mergedEntry(oneSecond, 'one second')],
          isMerge: true,
        },
        {
          ...entry(mergeTwo, mergeOne, 'merge two'),
          merged: [mergedEntry(twoWork, 'two work')],
          isMerge: true,
        },
        entry(after, mergeTwo, 'after'),
      ],
    );
  });

  it('keeps the newest commits a merge brings in and counts the rest', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.txt': 'a\n' });
    git(repo, 'checkout', '-q', '-b', 'side');
    const side = Array.from({ length: 22 }, (_, index) =>
      commit(repo, `side ${index + 1}`, { 'g.txt': `${index}\n` }),
    );
    git(repo, 'checkout', '-q', 'main');
    const merged = merge(repo, 'side', 'merge side');

    const parser = new GitDiffParser(repo);
    const [mergeEntry] = await parser.listReviewCommits({
      baseCommitish: base,
      targetCommitish: merged,
    });

    expect(mergeEntry?.merged?.map(({ sha }) => sha)).toEqual(side.slice(2));
    expect(mergeEntry?.mergedOmitted).toBe(2);
  });

  it('reads the range from the merge base when the review asks for it', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.txt': 'a\n' });
    git(repo, 'checkout', '-q', '-b', 'feature');
    const work = commit(repo, 'work', { 'g.txt': 'g\n' });
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 'main moves on', { 'f.txt': 'b\n' });

    const parser = new GitDiffParser(repo);

    expect(
      await parser.listReviewCommits({
        baseCommitish: 'main',
        targetCommitish: work,
        baseMode: 'merge-base',
      }),
    ).toEqual([entry(work, base, 'work')]);
  });

  it('lists nothing for the working tree or the staging area', async () => {
    const repo = createRepo();
    commit(repo, 'base', { 'f.txt': 'a\n' });

    const parser = new GitDiffParser(repo);

    expect(
      await parser.listReviewCommits({ baseCommitish: 'HEAD', targetCommitish: 'working' }),
    ).toEqual([]);
    expect(
      await parser.listReviewCommits({ baseCommitish: 'HEAD', targetCommitish: 'staged' }),
    ).toEqual([]);
  });
});

describe('change kinds against a real repository', () => {
  const source = (comment: string, value: number) =>
    `${lines(8, '// filler ')}// ${comment}\nexport const value = ${value};\n`;

  it('marks the chunks of each fixup by what they change', async () => {
    const repo = createRepo();
    const target = commit(repo, 'base', {
      'a.ts': source('old', 1),
      'b.ts': source('old', 1),
      'dist/a.js': source('old', 1),
    });
    commit(repo, 'comment only\n\nReview-Thread: t-comment', { 'a.ts': source('new', 1) });
    commit(repo, 'comment and its build\n\nReview-Thread: t-build', {
      'a.ts': source('newer', 1),
      'dist/a.js': source('newer', 1),
    });
    commit(repo, 'code\n\nReview-Thread: t-code', { 'b.ts': source('old', 2) });
    commit(repo, 'renamed comment\n\nReview-Thread: t-rename', {
      'b.ts': null,
      'c.ts': source('renamed', 2),
    });
    commit(repo, 'plain text\n\nReview-Thread: t-text', { 'notes.txt': 'a\n' });

    const parser = new GitDiffParser(repo);
    const fixups = await parser.classifyFixups(
      await parser.listThreadFixups({
        targetCommitish: target,
        baseCommitish: target,
      }),
    );
    const kinds = new Map(
      fixups.map((fixup) => [
        fixup.subject,
        fixup.files.map((file) => file.chunks.map((chunk) => chunk.changeKind)),
      ]),
    );

    expect(kinds.get('comment only')).toEqual([['comment']]);
    expect(kinds.get('comment and its build')).toEqual([['comment'], ['comment']]);
    expect(
      fixups
        .find((fixup) => fixup.subject === 'comment and its build')
        ?.files.map((file) => [file.path, file.isGenerated]),
    ).toEqual([
      ['a.ts', false],
      ['dist/a.js', true],
    ]);
    expect(kinds.get('code')).toEqual([['code']]);
    expect(kinds.get('renamed comment')).toEqual([['comment']]);
    expect(kinds.get('plain text')).toEqual([[undefined]]);

    const listed = await parser.listThreadFixups({
      targetCommitish: target,
      baseCommitish: target,
    });
    expect(
      listed.flatMap((fixup) => fixup.files.flatMap((file) => file.chunks)),
    ).not.toContainEqual(expect.objectContaining({ changeKind: expect.anything() }));
  });

  it('reads the files of every fixup with one git call and keeps only finished results', async () => {
    const repo = createRepo();
    const target = commit(repo, 'base', { 'a.ts': source('old', 1), 'b.ts': source('old', 1) });
    commit(repo, 'first\n\nReview-Thread: t1', { 'a.ts': source('new', 1) });
    commit(repo, 'second\n\nReview-Thread: t2', { 'b.ts': source('new', 1) });
    commit(repo, 'third\n\nReview-Thread: t3', { 'a.ts': source('newer', 1) });
    const selection = { targetCommitish: target, baseCommitish: target };
    const parser = new GitDiffParser(repo);
    const kindsOf = (fixups: Awaited<ReturnType<GitDiffParser['listThreadFixups']>>) =>
      fixups.map((fixup) => fixup.files[0]?.chunks[0]?.changeKind);

    const readTexts = vi
      .spyOn(parser as any, 'readTexts')
      .mockRejectedValueOnce(new Error('cat-file failed'));
    expect(kindsOf(await parser.classifyFixups(await parser.listThreadFixups(selection)))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    readTexts.mockRestore();

    runGitCalls.length = 0;
    expect(kindsOf(await parser.classifyFixups(await parser.listThreadFixups(selection)))).toEqual([
      'comment',
      'comment',
      'comment',
    ]);
    expect(runGitCalls.filter((args) => args[0] === 'cat-file')).toHaveLength(1);

    runGitCalls.length = 0;
    await parser.classifyFixups(await parser.listThreadFixups(selection));
    expect(runGitCalls).toEqual([]);
  });

  it('makes progress on every listing when the time budget runs out', async () => {
    const repo = createRepo();
    const target = commit(repo, 'base', { 'a.ts': source('old', 1), 'b.ts': source('old', 1) });
    commit(repo, 'first\n\nReview-Thread: t1', { 'a.ts': source('new', 1) });
    commit(repo, 'second\n\nReview-Thread: t2', { 'b.ts': source('new', 1) });
    commit(repo, 'third\n\nReview-Thread: t3', { 'a.ts': source('newer', 1) });
    const selection = { targetCommitish: target, baseCommitish: target };
    const parser = new GitDiffParser(repo);
    const kinds = async () =>
      (await parser.classifyFixups(await parser.listThreadFixups(selection))).map(
        (fixup) => fixup.files[0]?.chunks[0]?.changeKind,
      );
    const budget = (GitDiffParser as any).CHANGE_KIND_BUDGET_MS;
    (GitDiffParser as any).CHANGE_KIND_BUDGET_MS = -1;
    try {
      expect(await kinds()).toEqual(['comment', undefined, undefined]);
      expect(await kinds()).toEqual(['comment', 'comment', undefined]);
      expect(await kinds()).toEqual(['comment', 'comment', 'comment']);
      runGitCalls.length = 0;
      await kinds();
      expect(runGitCalls).toEqual([]);
    } finally {
      (GitDiffParser as any).CHANGE_KIND_BUDGET_MS = budget;
    }
  });

  it('judges a file even when the first one could not be read and the budget is gone', async () => {
    const repo = createRepo();
    const target = commit(repo, 'base', { 'a.ts': source('old', 1), 'b.ts': source('old', 1) });
    commit(repo, 'first\n\nReview-Thread: t1', { 'a.ts': source('new', 1) });
    commit(repo, 'second\n\nReview-Thread: t2', { 'b.ts': source('new', 1) });
    const parser = new GitDiffParser(repo);
    const readTexts = (parser as any).readTexts.bind(parser);
    vi.spyOn(parser as any, 'readTexts').mockImplementation(async (requests: unknown) => {
      const texts = await readTexts(requests);
      return [null, null, ...texts.slice(2)];
    });
    const budget = (GitDiffParser as any).CHANGE_KIND_BUDGET_MS;
    (GitDiffParser as any).CHANGE_KIND_BUDGET_MS = -1;
    try {
      const fixups = await parser.classifyFixups(
        await parser.listThreadFixups({
          targetCommitish: target,
          baseCommitish: target,
        }),
      );
      expect(fixups.map((fixup) => fixup.files[0]?.chunks[0]?.changeKind)).toEqual([
        undefined,
        'comment',
      ]);
    } finally {
      (GitDiffParser as any).CHANGE_KIND_BUDGET_MS = budget;
    }
  });

  it('classifies a file of the reviewed diff for commits and for the working tree', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'a.ts': source('old', 1) });
    const target = commit(repo, 'target', { 'a.ts': source('new', 1) });
    const parser = new GitDiffParser(repo);

    const committed = { baseCommitish: base, targetCommitish: target };
    const [file] = (await parser.parseDiff(committed)).files;
    expect(file?.chunks[0]?.changeKind).toBeUndefined();
    const classified = await parser.classifyDiffFile(committed, file!);
    expect(classified.chunks.map((chunk) => chunk.changeKind)).toEqual(['comment']);

    writeFileSync(join(repo, 'a.ts'), source('new', 3));
    const working = { baseCommitish: 'HEAD', targetCommitish: '.' };
    const [workingFile] = (await parser.parseDiff(working)).files;
    const classifiedWorking = await parser.classifyDiffFile(working, workingFile!);
    expect(classifiedWorking.chunks.map((chunk) => chunk.changeKind)).toEqual(['code']);
  });
});
