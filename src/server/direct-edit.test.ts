import { execFileSync, spawnSync } from 'child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { commitDirectEdit, type DirectEdit } from './direct-edit';

const hasSshKeygen = spawnSync('ssh-keygen', ['-?']).error === undefined;

let home: string;
const savedEnv = { ...process.env };
const repos: string[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-direct-edit-home-'));
  // A test run started from a commit hook would otherwise point every git call at that commit.
  process.env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  // Lets a test run a script at the moment the edit moves HEAD, as another git client would.
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

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'difit-direct-edit-'));
  repos.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'checkout', '-q', '-b', 'main');
  return repo;
}

function write(repo: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(repo, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

function commit(repo: string, message: string, files: Record<string, string> = {}): string {
  write(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function read(repo: string, path: string): string {
  return readFileSync(join(repo, path), 'utf8');
}

function installPreCommitHook(repo: string, script: string) {
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\n${script}\n`);
  chmodSync(hook, 0o755);
}

function edit(overrides: Partial<DirectEdit>): DirectEdit {
  return {
    filePath: 'f.ts',
    startLine: 1,
    endLine: 1,
    original: [],
    replacement: [],
    threadId: 'thread-1',
    ...overrides,
  };
}

const BEFORE = ['const a = 1;', 'const b = 2;', 'const c = 3;', ''].join('\n');
const WITH_COMMENT = [
  'const a = 10;',
  '// explains b, which the name already says',
  'const b = 2;',
  'const c = 3;',
  '',
].join('\n');

function repoWithLaterCommit() {
  const repo = createRepo();
  const base = commit(repo, 'base', { 'f.ts': BEFORE });
  const target = commit(repo, 'add b comment', { 'f.ts': WITH_COMMENT });
  const later = commit(repo, 'rename c', {
    'f.ts': WITH_COMMENT.replace('const c = 3;', 'const cee = 3;'),
  });
  return { repo, base, target, later };
}

const deleteComment = edit({
  startLine: 2,
  endLine: 2,
  original: ['// explains b, which the name already says'],
  replacement: [],
});

describe('commitDirectEdit', () => {
  it('commits the edit as a fixup naming the reviewed commit on top of later commits', async () => {
    const { repo, base, target, later } = repoWithLaterCommit();

    const result = await commitDirectEdit(repo, { base: base, target: target }, deleteComment);

    expect(result).toMatchObject({ ok: true, fixupTarget: target });
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(result.ok && result.sha).toBe(head);
    expect(git(repo, 'rev-parse', 'HEAD^')).toBe(later);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe(`fixup! ${target}`);
    expect(git(repo, 'log', '-1', '--format=%b')).toContain('add b comment');
    expect(git(repo, 'log', '-1', '--format=%(trailers:key=Review-Thread,valueonly)')).toBe(
      'thread-1',
    );
    const withoutComment = BEFORE.replace('const a = 1;', 'const a = 10;');
    expect(read(repo, 'f.ts')).toBe(withoutComment.replace('const c = 3;', 'const cee = 3;'));
    expect(git(repo, 'status', '--porcelain')).toBe('');

    execFileSync('git', ['rebase', '-q', '-i', '--autosquash', `${target}^`], {
      cwd: repo,
      env: { ...process.env, GIT_SEQUENCE_EDITOR: ':' },
    });
    expect(git(repo, 'show', 'HEAD~1:f.ts') + '\n').toBe(withoutComment);
    expect(git(repo, 'log', '--format=%s')).toBe(['rename c', 'add b comment', 'base'].join('\n'));
  });

  it.skipIf(!hasSshKeygen)(
    'copies only the subject of a signed commit when git shows signatures in logs',
    async () => {
      const repo = createRepo();
      const base = commit(repo, 'base', { 'f.ts': BEFORE });
      const key = join(repo, '.git', 'signing-key');
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
      writeFileSync(
        join(repo, '.git', 'allowed-signers'),
        `difit@example.com ${readFileSync(`${key}.pub`, 'utf8')}`,
      );
      git(repo, 'config', 'gpg.format', 'ssh');
      git(repo, 'config', 'user.signingkey', `${key}.pub`);
      git(repo, 'config', 'gpg.ssh.allowedSignersFile', join(repo, '.git', 'allowed-signers'));
      git(repo, 'config', 'log.showSignature', 'true');
      write(repo, { 'f.ts': WITH_COMMENT });
      git(repo, 'commit', '-qS', '-am', 'signed target');
      const target = git(repo, 'rev-parse', 'HEAD');
      const plainLog = execFileSync('git', ['log', '-1', '--format=%s'], {
        cwd: repo,
        encoding: 'utf8',
      });
      expect(plainLog.trim().split('\n').length).toBeGreaterThan(1);

      const result = await commitDirectEdit(repo, { base, target }, deleteComment);

      expect(result.ok).toBe(true);
      expect(git(repo, 'log', '-1', '--no-show-signature', '--format=%b')).toBe(
        ['signed target', '', 'Review-Thread: thread-1'].join('\n'),
      );
    },
  );

  it('copies a subject intact when the repository logs and commits in another encoding', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.ts': BEFORE });
    const target = commit(repo, '주석 추가', { 'f.ts': WITH_COMMENT });
    git(repo, 'config', 'i18n.logOutputEncoding', 'EUC-KR');
    git(repo, 'config', 'i18n.commitEncoding', 'EUC-KR');

    const result = await commitDirectEdit(repo, { base, target }, deleteComment);

    expect(result.ok).toBe(true);
    expect(git(repo, 'log', '-1', '--encoding=UTF-8', '--format=%b')).toBe(
      ['주석 추가', '', 'Review-Thread: thread-1'].join('\n'),
    );
  });

  it('replaces lines with new text and keeps the rest of the file byte for byte', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.ts': 'a\r\nb\r\nc' });
    const target = commit(repo, 'target', { 'f.ts': 'a\r\nb\r\nlast' });

    const result = await commitDirectEdit(
      repo,
      { base: base, target: target },
      edit({ startLine: 2, endLine: 3, original: ['b', 'last'], replacement: ['B', 'x', 'LAST'] }),
    );

    expect(result.ok).toBe(true);
    expect(read(repo, 'f.ts')).toBe('a\r\nB\r\nx\r\nLAST');
  });

  it('matches a last line that ends in a lone carriage return', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.ts': 'a\r\n' });
    const target = commit(repo, 'target', { 'f.ts': 'a\r\nlast\r' });

    const result = await commitDirectEdit(
      repo,
      { base: base, target: target },
      edit({ startLine: 2, endLine: 2, original: ['last'], replacement: ['LAST'] }),
    );

    expect(result.ok).toBe(true);
    expect(read(repo, 'f.ts')).toBe('a\r\nLAST\r');
  });

  it('ends new lines the way the file does when the edited last line has a lone carriage return', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.ts': 'a\r\n' });
    const target = commit(repo, 'target', { 'f.ts': 'a\r\nlast\r' });

    const result = await commitDirectEdit(
      repo,
      { base, target },
      edit({ startLine: 2, endLine: 2, original: ['last'], replacement: ['X\r', 'Y'] }),
    );

    expect(result.ok).toBe(true);
    expect(read(repo, 'f.ts')).toBe('a\r\nX\r\nY\r');
  });

  it('keeps a lone carriage return on a last line the edit leaves as it was', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.ts': 'a\r\n' });
    const target = commit(repo, 'target', { 'f.ts': 'a\r\nlast\r' });

    const result = await commitDirectEdit(
      repo,
      { base: base, target: target },
      edit({ startLine: 1, endLine: 2, original: ['a', 'last'], replacement: ['A', 'last'] }),
    );

    expect(result.ok).toBe(true);
    expect(read(repo, 'f.ts')).toBe('A\r\nlast\r');
  });

  it('matches lines sent with the carriage return still on them', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.ts': 'a\r\n' });
    const target = commit(repo, 'target', { 'f.ts': 'a\r\n// b\r\nc\r\n' });

    const result = await commitDirectEdit(
      repo,
      { base: base, target: target },
      edit({ startLine: 2, endLine: 2, original: ['// b\r'] }),
    );

    expect(result.ok).toBe(true);
    expect(read(repo, 'f.ts')).toBe('a\r\nc\r\n');
  });

  it('edits a line added by a commit without a message', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.ts': 'a\n' });
    write(repo, { 'f.ts': 'a\n// b\nc\n' });
    git(repo, 'commit', '-qam', '', '--allow-empty-message');
    const target = git(repo, 'rev-parse', 'HEAD');

    const result = await commitDirectEdit(
      repo,
      { base, target },
      edit({ startLine: 2, endLine: 2, original: ['// b'] }),
    );

    expect(result).toMatchObject({ ok: true, fixupTarget: target });
    execFileSync('git', ['rebase', '-q', '-i', '--autosquash', base], {
      cwd: repo,
      env: { ...process.env, GIT_SEQUENCE_EDITOR: ':' },
    });
    expect(git(repo, 'rev-list', '--count', `${base}..HEAD`)).toBe('1');
    expect(git(repo, 'show', 'HEAD:f.ts')).toBe('a\nc');
  });

  it('refuses a reviewed commit that the checked-out branch does not contain', async () => {
    const { repo, base, target } = repoWithLaterCommit();
    git(repo, 'checkout', '-q', '-b', 'elsewhere', base);
    commit(repo, 'other line', { 'f.ts': WITH_COMMENT });
    const head = git(repo, 'rev-parse', 'HEAD');

    const result = await commitDirectEdit(repo, { base: base, target: target }, deleteComment);

    expect(result).toEqual({ ok: false, reason: 'target-not-in-head' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('refuses when the lines sent are not what the reviewed commit holds', async () => {
    const { repo, base, target } = repoWithLaterCommit();
    const head = git(repo, 'rev-parse', 'HEAD');

    const result = await commitDirectEdit(
      repo,
      { base: base, target: target },
      edit({ startLine: 2, endLine: 2, original: ['const b = 2;'], replacement: [] }),
    );

    expect(result).toEqual({ ok: false, reason: 'stale-view' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  it.each([
    ['unstaged', (repo: string) => write(repo, { 'f.ts': WITH_COMMENT + 'more\n' })],
    [
      'staged',
      (repo: string) => {
        write(repo, { 'f.ts': WITH_COMMENT + 'more\n' });
        git(repo, 'add', 'f.ts');
      },
    ],
  ])('refuses a file with %s changes and leaves it alone', async (_label, dirty) => {
    const { repo, base, target } = repoWithLaterCommit();
    dirty(repo);
    const before = read(repo, 'f.ts');
    const status = git(repo, 'status', '--porcelain');

    const result = await commitDirectEdit(repo, { base: base, target: target }, deleteComment);

    expect(result).toEqual({ ok: false, reason: 'dirty-file' });
    expect(read(repo, 'f.ts')).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe(status);
  });

  it('commits only the edited file and leaves changes to other files where they were', async () => {
    const { repo, base, target } = repoWithLaterCommit();
    commit(repo, 'others', { 'staged.txt': 'one\n', 'unstaged.txt': 'one\n' });
    write(repo, { 'staged.txt': 'two\n', 'unstaged.txt': 'two\n' });
    git(repo, 'add', 'staged.txt');

    const result = await commitDirectEdit(repo, { base: base, target: target }, deleteComment);

    expect(result.ok).toBe(true);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('f.ts');
    expect(git(repo, 'status', '--porcelain')).toBe(
      ['M  staged.txt', ' M unstaged.txt'].join('\n'),
    );
  });

  it('refuses when a later commit changed the same lines', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.ts': BEFORE });
    const target = commit(repo, 'add b comment', { 'f.ts': WITH_COMMENT });
    commit(repo, 'reword comment', {
      'f.ts': WITH_COMMENT.replace('explains b', 'describes b'),
    });
    const head = git(repo, 'rev-parse', 'HEAD');

    const result = await commitDirectEdit(repo, { base: base, target: target }, deleteComment);

    expect(result).toEqual({ ok: false, reason: 'conflict' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('refuses when a later commit already made the same edit', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.ts': BEFORE });
    const target = commit(repo, 'add b comment', { 'f.ts': WITH_COMMENT });
    commit(repo, 'drop comment', {
      'f.ts': WITH_COMMENT.replace('// explains b, which the name already says\n', ''),
    });

    const result = await commitDirectEdit(repo, { base: base, target: target }, deleteComment);

    expect(result).toEqual({ ok: false, reason: 'no-change' });
  });

  it('refuses when the file is gone at HEAD', async () => {
    const { repo, base, target } = repoWithLaterCommit();
    git(repo, 'rm', '-q', 'f.ts');
    git(repo, 'commit', '-q', '-m', 'remove');

    const result = await commitDirectEdit(repo, { base: base, target: target }, deleteComment);

    expect(result).toEqual({ ok: false, reason: 'missing-at-head' });
  });

  it('refuses while a cherry-pick is stopped halfway', async () => {
    const { repo, base, target } = repoWithLaterCommit();
    commit(repo, 'other', { 'other.txt': 'main\n' });
    git(repo, 'checkout', '-q', '-b', 'side', base);
    const side = commit(repo, 'side', { 'other.txt': 'side\n' });
    git(repo, 'checkout', '-q', 'main');
    expect(() => git(repo, 'cherry-pick', side)).toThrow();

    const result = await commitDirectEdit(repo, { base: base, target: target }, deleteComment);

    expect(result).toEqual({ ok: false, reason: 'operation-in-progress' });
  });

  it('keeps the bytes of selected lines the edit left as they were', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.ts': 'x\n' });
    const target = commit(repo, 'target', { 'f.ts': 'a\r\nb\nc\nd\r\ne\n' });

    const result = await commitDirectEdit(
      repo,
      { base, target },
      edit({
        startLine: 1,
        endLine: 5,
        original: ['a', 'b', 'c', 'd', 'e'],
        replacement: ['a', 'b', 'C', 'd', 'e'],
      }),
    );

    expect(result.ok).toBe(true);
    expect(read(repo, 'f.ts')).toBe('a\r\nb\nC\nd\r\ne\n');
  });

  it('commits LF lines and leaves CRLF in the working file when git converts line endings', async () => {
    const { repo, base, target } = repoWithLaterCommit();
    git(repo, 'config', 'core.autocrlf', 'true');
    rmSync(join(repo, 'f.ts'));
    git(repo, 'checkout', '--', 'f.ts');
    expect(read(repo, 'f.ts')).toContain('\r\n');

    const result = await commitDirectEdit(repo, { base, target }, deleteComment);

    expect(result.ok).toBe(true);
    const expected = ['const a = 10;', 'const b = 2;', 'const cee = 3;', ''];
    expect(
      execFileSync('git', ['cat-file', 'blob', 'HEAD:f.ts'], { cwd: repo, encoding: 'utf8' }),
    ).toBe(expected.join('\n'));
    expect(read(repo, 'f.ts')).toBe(expected.join('\r\n'));
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('refuses while HEAD is not on a branch', async () => {
    const { repo, base, target } = repoWithLaterCommit();
    git(repo, 'checkout', '-q', '--detach');
    const head = git(repo, 'rev-parse', 'HEAD');

    const result = await commitDirectEdit(repo, { base, target }, deleteComment);

    expect(result).toEqual({ ok: false, reason: 'detached-head' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('refuses a symbolic link', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'real.ts': 'x\n' });
    symlinkSync('real.ts', join(repo, 'f.ts'));
    const target = commit(repo, 'link');

    const result = await commitDirectEdit(
      repo,
      { base, target },
      edit({ startLine: 1, endLine: 1, original: ['real.ts'], replacement: ['other.ts'] }),
    );

    expect(result).toEqual({ ok: false, reason: 'not-a-file' });
  });

  it('refuses a file that is not UTF-8', async () => {
    const repo = createRepo();
    const base = commit(repo, 'base', { 'f.ts': 'x\n' });
    writeFileSync(join(repo, 'f.ts'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const target = commit(repo, 'latin-1');

    const result = await commitDirectEdit(
      repo,
      { base, target },
      edit({ startLine: 1, endLine: 1, original: ['caf\ufffd'], replacement: ['cafe'] }),
    );

    expect(result).toEqual({ ok: false, reason: 'not-utf8' });
    expect(readFileSync(join(repo, 'f.ts'))).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  });

  it('reports why git could not write the commit and leaves everything as it was', async () => {
    const { repo, base, target } = repoWithLaterCommit();
    git(repo, 'config', 'user.useConfigOnly', 'true');
    const head = git(repo, 'rev-parse', 'HEAD');
    const before = read(repo, 'f.ts');
    const withIdentity = process.env;
    process.env = Object.fromEntries(
      Object.entries(withIdentity).filter(
        ([key]) => !/^(GIT_(AUTHOR|COMMITTER)_|EMAIL$)/.test(key),
      ),
    );

    const result = await commitDirectEdit(repo, { base, target }, deleteComment).finally(() => {
      process.env = withIdentity;
    });

    expect(result).toMatchObject({ ok: false, reason: 'commit-failed' });
    expect(!result.ok && result.output).toContain('user.email');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(read(repo, 'f.ts')).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('does not run commit hooks', async () => {
    const { repo, base, target } = repoWithLaterCommit();
    installPreCommitHook(repo, 'exit 1');
    const commitMsg = join(repo, '.git', 'hooks', 'commit-msg');
    writeFileSync(commitMsg, '#!/bin/sh\necho rewritten > "$1"\n');
    chmodSync(commitMsg, 0o755);

    const result = await commitDirectEdit(repo, { base, target }, deleteComment);

    expect(result.ok).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe(`fixup! ${target}`);
  });

  describe.skipIf(process.platform === 'win32')('a commit landing while the fixup is made', () => {
    const once = (script: string) =>
      `[ -e .git/landed ] || { touch .git/landed; ${script}; } >/dev/null 2>&1`;

    it('stacks the fixup on that commit without undoing it', async () => {
      const { repo, base, target } = repoWithLaterCommit();
      process.env.BEFORE_UPDATE_REF = once(
        "sed -i 's/const cee = 3;/const cee = 30;/' f.ts && echo agent > agent.txt && git add -A && git commit -qm agent",
      );

      const result = await commitDirectEdit(repo, { base, target }, deleteComment);

      expect(result).toMatchObject({ ok: true, fixupTarget: target });
      expect(git(repo, 'log', '-1', '--format=%s', 'HEAD^')).toBe('agent');
      expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('f.ts');
      const fixup = git(repo, 'diff', 'HEAD^', 'HEAD', '--', 'f.ts');
      expect(fixup).toContain('-// explains b, which the name already says');
      expect(fixup).not.toMatch(/^[-+]const cee/m);
      expect(read(repo, 'f.ts')).toBe(
        ['const a = 10;', 'const b = 2;', 'const cee = 30;', ''].join('\n'),
      );
      expect(git(repo, 'status', '--porcelain')).toBe('');
    });

    it('gives up when HEAD keeps moving', async () => {
      const { repo, base, target } = repoWithLaterCommit();
      process.env.BEFORE_UPDATE_REF = 'git commit -q --allow-empty -m busy';

      const result = await commitDirectEdit(repo, { base, target }, deleteComment);

      expect(result).toMatchObject({ ok: false, reason: 'head-moved' });
      expect(git(repo, 'log', '--format=%s', '-4')).toBe(
        ['busy', 'busy', 'busy', 'rename c'].join('\n'),
      );
      expect(git(repo, 'status', '--porcelain')).toBe('');
    });

    it('leaves the working file alone when someone changed it meanwhile', async () => {
      const { repo, base, target } = repoWithLaterCommit();
      process.env.BEFORE_UPDATE_REF = once("echo '// in progress' >> f.ts");
      const theirs = read(repo, 'f.ts') + '// in progress\n';

      const result = await commitDirectEdit(repo, { base, target }, deleteComment);

      expect(result.ok).toBe(true);
      expect(read(repo, 'f.ts')).toBe(theirs);
      expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
      expect(git(repo, 'diff', '--name-only')).toBe('f.ts');
    });

    it('reports a failed update that retrying cannot fix instead of blaming a moving HEAD', async () => {
      const { repo, base, target } = repoWithLaterCommit();
      const head = git(repo, 'rev-parse', 'HEAD');
      process.env.BEFORE_UPDATE_REF = 'touch .git/refs/heads/main.lock';

      const result = await commitDirectEdit(repo, { base, target }, deleteComment);

      expect(result).toMatchObject({ ok: false, reason: 'commit-failed' });
      expect(!result.ok && result.output).toContain('main.lock');
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    });
  });

  describe('a review spanning several commits', () => {
    function rangeRepo() {
      const repo = createRepo();
      const lines = ['x', 'y', 'z', ''];
      const base = commit(repo, 'base', { 'f.ts': lines.join('\n') });
      const one = commit(repo, 'one', { 'f.ts': ['x', '// x', 'y', 'z', ''].join('\n') });
      const two = commit(repo, 'two', {
        'f.ts': ['x', '// x', 'y', '// y', 'z', ''].join('\n'),
      });
      commit(repo, 'later', { 'g.ts': 'later\n' });
      return { repo, base, one, two };
    }

    it('aims the fixup at the commit that added the edited lines', async () => {
      const { repo, base, one, two } = rangeRepo();

      const result = await commitDirectEdit(
        repo,
        { base: base, target: two },
        edit({ startLine: 2, endLine: 2, original: ['// x'] }),
      );

      expect(result).toMatchObject({ ok: true, fixupTarget: one });
      expect(git(repo, 'log', '-1', '--format=%s')).toBe(`fixup! ${one}`);
    });

    it('aims lines the range did not change at the reviewed commit', async () => {
      const { repo, base, two } = rangeRepo();

      const result = await commitDirectEdit(
        repo,
        { base: base, target: two },
        edit({ startLine: 5, endLine: 5, original: ['z'], replacement: ['zed'] }),
      );

      expect(result).toMatchObject({ ok: true, fixupTarget: two });
    });

    it('folds into the older of two commits with the same subject when that one added the lines', async () => {
      const repo = createRepo();
      const base = commit(repo, 'base', { 'f.ts': 'x\n' });
      const first = commit(repo, 'wip', { 'f.ts': 'x\n// x\ny\n' });
      const second = commit(repo, 'wip', { 'g.ts': 'g\n' });

      const result = await commitDirectEdit(
        repo,
        { base, target: second },
        edit({ startLine: 2, endLine: 2, original: ['// x'] }),
      );

      expect(result).toMatchObject({ ok: true, fixupTarget: first });
      execFileSync('git', ['rebase', '-q', '-i', '--autosquash', base], {
        cwd: repo,
        env: { ...process.env, GIT_SEQUENCE_EDITOR: ':' },
      });
      expect(git(repo, 'log', '--format=%s')).toBe(['wip', 'wip', 'base'].join('\n'));
      expect(git(repo, 'show', 'HEAD~1:f.ts')).toBe('x\ny');
      expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('g.ts');
    });

    it('folds into the newer of two commits with the same subject when that one added the lines', async () => {
      const repo = createRepo();
      const base = commit(repo, 'base', { 'f.ts': 'x\n' });
      commit(repo, 'wip', { 'g.ts': 'g\n' });
      const second = commit(repo, 'wip', { 'f.ts': 'x\n// x\ny\n' });

      const result = await commitDirectEdit(
        repo,
        { base: base, target: second },
        edit({ startLine: 2, endLine: 2, original: ['// x'] }),
      );

      expect(result).toMatchObject({ ok: true, fixupTarget: second });
      expect(git(repo, 'log', '-1', '--format=%s')).toBe(`fixup! ${second}`);
      execFileSync('git', ['rebase', '-q', '-i', '--autosquash', base], {
        cwd: repo,
        env: { ...process.env, GIT_SEQUENCE_EDITOR: ':' },
      });
      expect(git(repo, 'log', '--format=%s')).toBe(['wip', 'wip', 'base'].join('\n'));
      expect(git(repo, 'show', '--name-only', '--format=', 'HEAD~1')).toBe('g.ts');
      expect(git(repo, 'show', 'HEAD:f.ts')).toBe('x\ny');
    });

    it('folds into the reviewed commit even when an older commit before the review has its subject', async () => {
      const repo = createRepo();
      commit(repo, 'base', { 'f.ts': 'x\n' });
      git(repo, 'checkout', '-q', '-b', 'feature');
      const older = commit(repo, 'wip', { 'g.ts': 'g\n' });
      const reviewed = commit(repo, 'wip', { 'f.ts': 'x\n// x\ny\n' });

      const result = await commitDirectEdit(
        repo,
        { base: older, target: reviewed },
        edit({ startLine: 2, endLine: 2, original: ['// x'] }),
      );

      expect(result).toMatchObject({ ok: true, fixupTarget: reviewed });
      execFileSync('git', ['rebase', '-q', '-i', '--autosquash', 'main'], {
        cwd: repo,
        env: { ...process.env, GIT_SEQUENCE_EDITOR: ':' },
      });
      expect(git(repo, 'show', '--name-only', '--format=', 'HEAD~1')).toBe('g.ts');
      expect(git(repo, 'show', 'HEAD:f.ts')).toBe('x\ny');
    });

    it('aims at the latest commit when the edited lines came from different commits', async () => {
      const { repo, base, two } = rangeRepo();

      const result = await commitDirectEdit(
        repo,
        { base: base, target: two },
        edit({ startLine: 2, endLine: 4, original: ['// x', 'y', '// y'], replacement: ['y'] }),
      );

      expect(result).toMatchObject({ ok: true, fixupTarget: two });
    });

    it('looks only at the lines the edit changed when choosing the commit', async () => {
      const { repo, base, two } = rangeRepo();

      const result = await commitDirectEdit(
        repo,
        { base, target: two },
        edit({
          startLine: 2,
          endLine: 4,
          original: ['// x', 'y', '// y'],
          replacement: ['// x', 'y', '// y!'],
        }),
      );

      expect(result).toMatchObject({ ok: true, fixupTarget: two });
    });
  });

  describe('a fixup that would conflict when folded', () => {
    const ADDED = ['a', '// c', 'b', ''].join('\n');
    const NEARBY = ['a', '// c', 'B', ''].join('\n');
    const removeComment = edit({ startLine: 2, endLine: 2, original: ['// c'] });

    it('moves to the earliest later commit it folds into cleanly', async () => {
      const repo = createRepo();
      const base = commit(repo, 'base', { 'f.ts': 'a\nb\n' });
      commit(repo, 'add comment', { 'f.ts': ADDED });
      commit(repo, 'touch next line', { 'f.ts': NEARBY });
      const restored = commit(repo, 'restore next line', { 'f.ts': ADDED });

      const result = await commitDirectEdit(repo, { base, target: restored }, removeComment);

      expect(result).toMatchObject({ ok: true, fixupTarget: restored });
      execFileSync('git', ['rebase', '-q', '-i', '--autosquash', base], {
        cwd: repo,
        env: { ...process.env, GIT_SEQUENCE_EDITOR: ':' },
      });
      expect(git(repo, 'show', 'HEAD:f.ts')).toBe('a\nb');
      expect(git(repo, 'rev-list', '--count', `${base}..HEAD`)).toBe('3');
    });

    it('orders earlier fixups the way autosquash will when choosing the commit', async () => {
      const repo = createRepo();
      const base = commit(repo, 'base', { 'f.ts': 'p\nq\n' });
      commit(repo, 'add comment', { 'f.ts': 'p\n// x\nq\n' });
      commit(repo, 'two', { 'g.ts': 'g\n' });
      const three = commit(repo, 'three', { 'f.ts': 'p\n// x\nQ\n' });
      const target = commit(repo, 'fixup! two', { 'f.ts': 'P\n// x\nQ\n' });

      const result = await commitDirectEdit(
        repo,
        { base, target },
        edit({ startLine: 2, endLine: 2, original: ['// x'] }),
      );

      expect(result).toMatchObject({ ok: true, fixupTarget: three });
      execFileSync('git', ['rebase', '-q', '-i', '--autosquash', base], {
        cwd: repo,
        env: { ...process.env, GIT_SEQUENCE_EDITOR: ':' },
      });
      expect(git(repo, 'show', 'HEAD:f.ts')).toBe('P\nQ');
      expect(git(repo, 'log', '--format=%s')).toBe(
        ['three', 'two', 'add comment', 'base'].join('\n'),
      );
    });

    it('refuses when no commit of the range takes it cleanly', async () => {
      const repo = createRepo();
      const base = commit(repo, 'base', { 'f.ts': 'a\nb\n' });
      const target = commit(repo, 'add comment', { 'f.ts': ADDED });
      commit(repo, 'touch next line', { 'f.ts': NEARBY });
      commit(repo, 'restore next line', { 'f.ts': ADDED });
      const head = git(repo, 'rev-parse', 'HEAD');

      const result = await commitDirectEdit(repo, { base, target }, removeComment);

      expect(result).toEqual({ ok: false, reason: 'fold-conflict' });
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    });
  });

  describe('made on part of the review', () => {
    const autosquash = (repo: string, onto: string) =>
      execFileSync('git', ['rebase', '-q', '-i', '--autosquash', onto], {
        cwd: repo,
        env: { ...process.env, GIT_SEQUENCE_EDITOR: ':' },
      });

    function stackedRepo() {
      const repo = createRepo();
      const base = commit(repo, 'base', { 'f.ts': 'a\nb\nc\n' });
      const one = commit(repo, 'add note', { 'f.ts': 'a\n// note\nb\nc\n' });
      const two = commit(repo, 'add header', { 'f.ts': '// header\na\n// note\nb\nc\n' });
      const three = commit(repo, 'rename c', { 'f.ts': '// header\na\n// note\nb\ncee\n' });
      commit(repo, 'after review', { 'g.ts': 'g\n' });
      return { repo, base, one, two, three };
    }

    it('fixes a line of one commit in the middle of the review, on top of later commits', async () => {
      const { repo, base, one, three } = stackedRepo();

      const result = await commitDirectEdit(
        repo,
        { base, target: three },
        edit({ startLine: 2, endLine: 2, original: ['// note'], replacement: ['// better'] }),
        { base, target: one, commits: [one] },
      );

      expect(result).toMatchObject({ ok: true, fixupTarget: one });
      expect(read(repo, 'f.ts')).toBe('// header\na\n// better\nb\ncee\n');
      autosquash(repo, base);
      expect(git(repo, 'log', '--format=%s')).toBe(
        ['after review', 'rename c', 'add header', 'add note', 'base'].join('\n'),
      );
      expect(git(repo, 'show', 'HEAD~3:f.ts')).toBe('a\n// better\nb\nc');
    });

    it('fixes a line the commit left as it was into that commit', async () => {
      const { repo, base, one, two, three } = stackedRepo();

      const result = await commitDirectEdit(
        repo,
        { base, target: three },
        edit({ startLine: 2, endLine: 2, original: ['a'], replacement: ['A'] }),
        { base: one, target: two, commits: [two] },
      );

      expect(result).toMatchObject({ ok: true, fixupTarget: two });
      expect(read(repo, 'f.ts')).toBe('// header\nA\n// note\nb\ncee\n');
    });

    it('fixes a line of a run of commits into the one that last changed it', async () => {
      const { repo, base, one, two, three } = stackedRepo();

      const result = await commitDirectEdit(
        repo,
        { base, target: three },
        edit({ startLine: 3, endLine: 3, original: ['// note'], replacement: ['// noted'] }),
        { base, target: two, commits: [one, two] },
      );

      expect(result).toMatchObject({ ok: true, fixupTarget: one });
      expect(read(repo, 'f.ts')).toBe('// header\na\n// noted\nb\ncee\n');
      autosquash(repo, base);
      expect(git(repo, 'show', 'HEAD~3:f.ts')).toBe('a\n// noted\nb\nc');
    });

    it('refuses an edit on a commit still on the branch once the review target has left it', async () => {
      const { repo, base, one, three } = stackedRepo();
      git(repo, 'reset', '-q', '--hard', one);
      commit(repo, 'other work', { 'g.ts': 'other\n' });
      const head = git(repo, 'rev-parse', 'HEAD');

      const result = await commitDirectEdit(
        repo,
        { base, target: three },
        edit({ startLine: 2, endLine: 2, original: ['// note'], replacement: ['// better'] }),
        { base, target: one, commits: [one] },
      );

      expect(result).toEqual({ ok: false, reason: 'target-not-in-head' });
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    });

    it('passes over a commit the view does not list, as an earlier round of fixups', async () => {
      const repo = createRepo();
      const base = commit(repo, 'base', { 'f.ts': 'a\n' });
      const one = commit(repo, 'add note', { 'f.ts': 'a\n// note\n' });
      const fixup = commit(repo, `fixup! ${one}`, { 'f.ts': 'a\n// note!\n' });

      const result = await commitDirectEdit(
        repo,
        { base, target: fixup },
        edit({ startLine: 2, endLine: 2, original: ['// note!'], replacement: ['// noted'] }),
        { base, target: fixup, commits: [one] },
      );

      expect(result).toMatchObject({ ok: true, fixupTarget: one });
      autosquash(repo, base);
      expect(git(repo, 'log', '--format=%s')).toBe(['add note', 'base'].join('\n'));
      expect(git(repo, 'show', 'HEAD:f.ts')).toBe('a\n// noted');
    });
  });
});
