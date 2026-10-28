import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { chooseFixupTarget, type FixupTargetQuery } from './fixup-target';

let home: string;
const savedEnv = { ...process.env };
const repos: string[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-fixup-target-home-'));
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

function commit(repo: string, message: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(repo, path), content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

const lines = (...content: string[]) => [...content, ''].join('\n');

function pinThenFix() {
  const repo = mkdtempSync(join(tmpdir(), 'difit-fixup-target-'));
  repos.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'checkout', '-q', '-b', 'main');
  const base = commit(repo, 'base', {
    'discount.js': lines('export function discount(price) {', '  return price * 0.1;', '}'),
  });
  const pin = commit(repo, 'test: pin current discount', {
    'discount.test.js': lines(
      "test('discount', () => {",
      '  expect(discount(105)).toBe(10.5);',
      '});',
    ),
  });
  const fix = commit(repo, 'fix: round discount down', {
    'discount.js': lines(
      'export function discount(price) {',
      '  return Math.floor(price * 0.1);',
      '}',
    ),
    'discount.test.js': lines(
      "test('discount', () => {",
      '  expect(discount(105)).toBe(10);',
      '});',
    ),
  });
  return { repo, base, pin, fix };
}

function query(overrides: Partial<FixupTargetQuery> & Pick<FixupTargetQuery, 'view'>) {
  const startLine = overrides.startLine ?? 1;
  return {
    filePath: 'discount.test.js',
    startLine,
    endLine: startLine,
    side: 'new' as const,
    ...overrides,
  };
}

describe('chooseFixupTarget', () => {
  it('chooses the commit itself on a one-commit view, whichever line it is', async () => {
    const { repo, pin } = pinThenFix();
    const view = { base: `${pin}^`, target: pin };

    await expect(chooseFixupTarget(repo, query({ view }))).resolves.toBe(pin);
    await expect(
      chooseFixupTarget(repo, query({ view, filePath: 'discount.js', side: 'old', startLine: 2 })),
    ).resolves.toBe(pin);
  });

  it('chooses the commit in the range that last changed the lines', async () => {
    const { repo, base, pin, fix } = pinThenFix();
    const view = { base, target: fix };

    await expect(chooseFixupTarget(repo, query({ view, startLine: 2, endLine: 2 }))).resolves.toBe(
      fix,
    );
    await expect(chooseFixupTarget(repo, query({ view, startLine: 1, endLine: 1 }))).resolves.toBe(
      pin,
    );
  });

  it('chooses the last commit of the range for lines the range left as they were', async () => {
    const { repo, base, fix } = pinThenFix();

    await expect(
      chooseFixupTarget(
        repo,
        query({ view: { base, target: fix }, filePath: 'discount.js', startLine: 1, endLine: 1 }),
      ),
    ).resolves.toBe(fix);
  });

  it('chooses the last commit of the range for lines on the old side', async () => {
    const { repo, base, pin, fix } = pinThenFix();

    await expect(
      chooseFixupTarget(
        repo,
        query({ view: { base, target: pin }, filePath: 'discount.js', side: 'old', startLine: 2 }),
      ),
    ).resolves.toBe(pin);
    await expect(
      chooseFixupTarget(
        repo,
        query({ view: { base, target: fix }, filePath: 'discount.js', side: 'old', startLine: 2 }),
      ),
    ).resolves.toBe(fix);
  });

  it('chooses the latest commit when the lines came from several commits', async () => {
    const { repo, base, fix } = pinThenFix();

    await expect(
      chooseFixupTarget(repo, query({ view: { base, target: fix }, startLine: 1, endLine: 3 })),
    ).resolves.toBe(fix);
  });

  it('blames every range of a comment on several ranges at once', async () => {
    const { repo, base, pin, fix } = pinThenFix();
    const view = { base, target: fix };

    await expect(chooseFixupTarget(repo, query({ view, startLine: 3 }))).resolves.toBe(pin);
    await expect(
      chooseFixupTarget(repo, query({ view, startLine: 3, extraRanges: [{ start: 1, end: 1 }] })),
    ).resolves.toBe(pin);
    await expect(
      chooseFixupTarget(
        repo,
        query({
          view,
          startLine: 3,
          extraRanges: [
            { start: 1, end: 1 },
            { start: 2, end: 2 },
          ],
        }),
      ),
    ).resolves.toBe(fix);
  });

  it('blames only the new-side ranges of a comment on deleted and kept lines', async () => {
    const { repo, base, pin, fix } = pinThenFix();
    const view = { base, target: fix };

    await expect(
      chooseFixupTarget(
        repo,
        query({ view, startLine: 1, extraRanges: [{ side: 'old', start: 2, end: 2 }] }),
      ),
    ).resolves.toBe(pin);
    await expect(
      chooseFixupTarget(
        repo,
        query({
          view,
          side: 'old',
          startLine: 2,
          extraRanges: [{ side: 'new', start: 1, end: 1 }],
        }),
      ),
    ).resolves.toBe(pin);
    await expect(
      chooseFixupTarget(
        repo,
        query({ view, side: 'old', startLine: 2, extraRanges: [{ start: 1, end: 1 }] }),
      ),
    ).resolves.toBe(fix);
  });

  it('passes over commits it is not given, down to the given commit underneath', async () => {
    const { repo, base, pin, fix } = pinThenFix();
    const unlisted = commit(repo, 'fixup! test: pin current discount', {
      'discount.test.js': lines(
        "test('takes ten percent', () => {",
        '  expect(discount(105)).toBe(10);',
        '});',
      ),
    });
    const view = { base, target: unlisted };
    const given = { view, commits: [pin, fix] };

    await expect(chooseFixupTarget(repo, query({ view }))).resolves.toBe(unlisted);
    await expect(chooseFixupTarget(repo, query(given))).resolves.toBe(pin);
    await expect(chooseFixupTarget(repo, query({ ...given, startLine: 2 }))).resolves.toBe(fix);
    await expect(
      chooseFixupTarget(repo, query({ ...given, filePath: 'discount.js', startLine: 1 })),
    ).resolves.toBe(fix);
    await expect(
      chooseFixupTarget(repo, query({ ...given, filePath: 'discount.js', side: 'old' })),
    ).resolves.toBe(fix);
  });

  it('answers with full SHAs when the view names its commits by ref', async () => {
    const { repo, base, fix } = pinThenFix();
    git(repo, 'tag', 'start', base);

    await expect(
      chooseFixupTarget(repo, query({ view: { base: 'start', target: 'main' }, startLine: 2 })),
    ).resolves.toBe(fix);
    await expect(
      chooseFixupTarget(
        repo,
        query({ view: { base: 'start', target: 'main' }, filePath: 'discount.js', side: 'old' }),
      ),
    ).resolves.toBe(fix);
  });

  describe('for a comment on the whole file', () => {
    const wholeFile = (
      view: FixupTargetQuery['view'],
      filePath: string,
      extra: Partial<FixupTargetQuery> = {},
    ): FixupTargetQuery => ({ view, filePath, side: 'new', ...extra });

    it('chooses the last commit of the range that changed the file', async () => {
      const { repo, base, pin, fix } = pinThenFix();
      const unchanged = commit(repo, 'docs: notes', { 'notes.md': lines('notes') });
      const view = { base, target: unchanged };

      await expect(chooseFixupTarget(repo, wholeFile(view, 'discount.test.js'))).resolves.toBe(fix);
      await expect(
        chooseFixupTarget(repo, wholeFile({ base, target: pin }, 'discount.test.js')),
      ).resolves.toBe(pin);
      await expect(
        chooseFixupTarget(repo, wholeFile(view, 'discount.js', { side: 'old' })),
      ).resolves.toBe(fix);
    });

    it('chooses the last commit of the range for a file the range did not change', async () => {
      const { repo, base, pin } = pinThenFix();

      await expect(
        chooseFixupTarget(repo, wholeFile({ base, target: pin }, 'discount.js')),
      ).resolves.toBe(pin);
    });

    it('reads a file name with brackets as written, not as a pattern', async () => {
      const { repo, base } = pinThenFix();
      const page = commit(repo, 'feat: id page', { '[id].tsx': lines('page') });
      const other = commit(repo, 'feat: i page', { 'i.tsx': lines('other') });

      await expect(
        chooseFixupTarget(repo, wholeFile({ base, target: other }, '[id].tsx')),
      ).resolves.toBe(page);
    });

    it('passes over commits it is not given', async () => {
      const { repo, base, pin, fix } = pinThenFix();
      const unlisted = commit(repo, 'fixup! test: pin current discount', {
        'discount.test.js': lines('test.todo("discount");'),
        'notes.md': lines('notes'),
      });
      const view = { base, target: unlisted };

      await expect(
        chooseFixupTarget(repo, wholeFile(view, 'discount.test.js', { commits: [pin] })),
      ).resolves.toBe(pin);
      await expect(
        chooseFixupTarget(repo, wholeFile(view, 'notes.md', { commits: [pin, fix] })),
      ).resolves.toBe(fix);
    });
  });
});
