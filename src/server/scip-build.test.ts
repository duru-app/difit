import { execFileSync, spawnSync } from 'child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { readScipIndex } from './scip-index';
import {
  type ScipBuildState,
  ScipIndexBuilder,
  commitIndexability,
  findScipJava,
  indexStateForClient,
  plainLogText,
  readBuildLog,
  scipIndexCacheRoot,
  selectEvictions,
  toolSpawnSpec,
} from './scip-build';

const reads = vi.hoisted(() => ({
  before: undefined as ((path: string) => Promise<void>) | undefined,
}));
vi.mock('./scip-index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scip-index')>();
  return {
    ...actual,
    readScipIndex: async (path: string) => {
      await reads.before?.(path);
      return actual.readScipIndex(path);
    },
  };
});
const FIXTURE = join(__dirname, 'scip-index-fixture', 'index.scip');
const IMPL_FIXTURE_DIR = join(__dirname, 'scip-index-impl-fixture');
const STORED_WITHOUT_RELATIONS = join(IMPL_FIXTURE_DIR, 'index.lookup.v1.gz');
const posixOnly = process.platform === 'win32' ? it.skip : it;

let home: string;
const savedEnv = { ...process.env };
const temps: string[] = [];
const builders: ScipIndexBuilder[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-scip-build-home-'));
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
  reads.before = undefined;
  await Promise.all(builders.splice(0).map((builder) => builder.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function commit(repo: string, files: Record<string, string>): string {
  writeFiles(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'change');
  return git(repo, 'rev-parse', 'HEAD');
}

const JAVA_PROJECT = {
  'build.gradle': "plugins { id 'java' }\n",
  'src/main/java/demo/Port.java': 'package demo;\ninterface Port {}\n',
};

function createRepo(): string {
  const repo = tempDir('difit-scip-build-repo-');
  git(repo, 'init', '-q');
  git(repo, 'checkout', '-q', '-b', 'main');
  return repo;
}

// A stand-in for scip-java: `index --output <path>` runs `body` in the extracted tree,
// where $OUT is the output path and $LOG a file outside the cache for the test to read.
function fakeScipJava(body: string): { path: string; log: string } {
  const dir = tempDir('difit-fake-scip-java-');
  const path = join(dir, 'scip-java');
  const log = join(dir, 'calls.log');
  writeFileSync(
    path,
    `#!/bin/sh\nOUT="$3"\nLOG='${log}'\necho "run $1 $2 $(pwd)" >> "$LOG"\n${body}\n`,
  );
  chmodSync(path, 0o755);
  return { path, log };
}

const WRITES_INDEX = `[ -f build.gradle ] || exit 7\ncp '${FIXTURE}' "$OUT"`;
const WRITES_IMPL_INDEX = `[ -f build.gradle ] || exit 7\ncp '${join(IMPL_FIXTURE_DIR, 'index.scip')}' "$OUT"`;

function storeWithoutRelations(cache: string, sha: string): void {
  mkdirSync(join(cache, sha), { recursive: true });
  copyFileSync(STORED_WITHOUT_RELATIONS, join(cache, sha, 'index.lookup.gz'));
}

function calls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
}

function newBuilder(repo: string, tool: string | undefined, cacheRoot: string, timeoutMs?: number) {
  const builder = new ScipIndexBuilder({
    repoPath: repo,
    cacheRoot,
    env: { DIFIT_SCIP_JAVA: tool, PATH: '' },
    timeoutMs,
  });
  builders.push(builder);
  const events: Array<[string, ScipBuildState['status']]> = [];
  builder.onChange((sha, state) => events.push([sha, state.status]));
  return { builder, events };
}

function isAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // A zombie waiting for its parent to reap it is already dead.
    return !/^\d+ \(.*\) Z/.test(stat);
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('findScipJava', () => {
  posixOnly('prefers DIFIT_SCIP_JAVA, then looks on PATH', async () => {
    const configured = fakeScipJava('exit 0').path;
    const pathDir = tempDir('difit-scip-path-');
    const onPath = join(pathDir, 'scip-java');
    writeFileSync(onPath, '#!/bin/sh\n');
    chmodSync(onPath, 0o755);

    await expect(findScipJava({ DIFIT_SCIP_JAVA: configured, PATH: pathDir })).resolves.toBe(
      configured,
    );
    await expect(findScipJava({ PATH: `/nonexistent:${pathDir}` })).resolves.toBe(onPath);
    await expect(
      findScipJava({ DIFIT_SCIP_JAVA: join(pathDir, 'missing'), PATH: pathDir }),
    ).resolves.toBe(onPath);
  });

  posixOnly(
    'skips files that are not executable and returns null when nothing is found',
    async () => {
      const pathDir = tempDir('difit-scip-path-');
      writeFileSync(join(pathDir, 'scip-java'), 'not executable');
      await expect(findScipJava({ PATH: pathDir })).resolves.toBeNull();
      await expect(findScipJava({})).resolves.toBeNull();
    },
  );

  it('tries the PATHEXT extensions on Windows, with a case-insensitive Path variable', async () => {
    const pathDir = tempDir('difit-scip-path-');
    writeFileSync(join(pathDir, 'scip-java.cmd'), '@echo off\n');
    await expect(findScipJava({ Path: pathDir, PathExt: '.EXE;.CMD' }, 'win32')).resolves.toBe(
      join(pathDir, 'scip-java.cmd'),
    );
  });
});

describe('toolSpawnSpec', () => {
  it('runs .bat and .cmd tools through the shell on Windows, quoting each part', () => {
    expect(
      toolSpawnSpec(
        'C:\\Tools Dir\\scip-java.cmd',
        ['index', '--output', 'C:\\a b\\index.scip'],
        'win32',
      ),
    ).toEqual({
      command: '"C:\\Tools Dir\\scip-java.cmd" "index" "--output" "C:\\a b\\index.scip"',
      args: [],
      shell: true,
    });
    expect(toolSpawnSpec('C:\\Tools\\scip-java.exe', ['index'], 'win32')).toEqual({
      command: 'C:\\Tools\\scip-java.exe',
      args: ['index'],
      shell: false,
    });
    expect(toolSpawnSpec('/usr/bin/scip-java', ['index'], 'linux').shell).toBe(false);
  });
});

describe('scipIndexCacheRoot', () => {
  it('sits in the difit config directory', () => {
    const saved = process.env.DIFIT_CONFIG_DIR;
    process.env.DIFIT_CONFIG_DIR = '/tmp/difit-config';
    try {
      expect(scipIndexCacheRoot()).toBe(join('/tmp/difit-config', 'scip-index'));
    } finally {
      if (saved === undefined) delete process.env.DIFIT_CONFIG_DIR;
      else process.env.DIFIT_CONFIG_DIR = saved;
    }
  });
});

describe('commitIndexability', () => {
  it('needs Java sources and a build file at the root of the tree', async () => {
    const repo = createRepo();
    const docsOnly = commit(repo, { 'README.md': 'hi\n', 'build.gradle': '' });
    const nestedBuild = commit(repo, {
      'build.gradle': '',
      'sub/pom.xml': '<project/>\n',
      'sub/A.java': 'class A {}\n',
    });
    git(repo, 'rm', '-q', 'build.gradle');
    git(repo, 'commit', '-q', '-m', 'drop root build file');
    const noRootBuild = git(repo, 'rev-parse', 'HEAD');
    const maven = commit(repo, { 'pom.xml': '<project/>\n' });

    await expect(commitIndexability(repo, docsOnly)).resolves.toBe('no-java');
    await expect(commitIndexability(repo, nestedBuild)).resolves.toBe('indexable');
    await expect(commitIndexability(repo, noRootBuild)).resolves.toBe('no-build-file');
    await expect(commitIndexability(repo, maven)).resolves.toBe('indexable');
    await expect(commitIndexability(repo, '0'.repeat(40))).resolves.toBe('no-java');
  });
});

describe('plainLogText', () => {
  it('drops terminal codes and keeps what a carriage return left on the line', () => {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    const log = [
      `${esc}[90m2026.10.27 12:00:01${esc}[0m ${esc}[1;31mERROR${esc}[m Cannot run program "gradle"`,
      `${esc}]0;gradle${bel}> Task :compileJava\r`,
      `  10% EXECUTING\r  87% EXECUTING\r> Task :jar`,
      `${esc}[2K${esc}[1A${esc}7done`,
    ].join('\n');

    expect(plainLogText(log).split('\n')).toEqual([
      '2026.10.27 12:00:01 ERROR Cannot run program "gradle"',
      '> Task :compileJava',
      '> Task :jar',
      'done',
    ]);
  });
});

describe('indexStateForClient', () => {
  it('says whether a failed build left a log without giving its path', () => {
    const failed: ScipBuildState = {
      status: 'failed',
      reason: 'exit-code',
      exitCode: 1,
      detail: 'scip-java exited with code 1',
      logPath: '/cache/sha/build.log',
    };
    expect(indexStateForClient(failed)).toEqual({
      status: 'failed',
      reason: 'exit-code',
      exitCode: 1,
      detail: 'scip-java exited with code 1',
      hasLog: true,
    });
    expect(indexStateForClient({ ...failed, logPath: null })).toMatchObject({ hasLog: false });
    expect(indexStateForClient({ status: 'queued', after: 'a' })).toEqual({
      status: 'queued',
      after: 'a',
    });
  });
});

describe('ScipIndexBuilder', () => {
  it('builds nothing when scip-java is missing, and says so', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const cache = tempDir('difit-scip-cache-');
    const { builder, events } = newBuilder(repo, undefined, cache);

    const missing = { status: 'unavailable', reason: 'no-scip-java' };
    await expect(builder.request(sha)).resolves.toEqual(missing);
    expect(builder.state(sha)).toEqual(missing);
    expect(events).toEqual([[sha, 'unavailable']]);
    expect(readdirSync(cache)).toEqual([]);
  });

  it('tells a commit without Java from one without scip-java', async () => {
    const repo = createRepo();
    const sha = commit(repo, { 'README.md': 'hi\n' });
    const { builder } = newBuilder(repo, undefined, tempDir('difit-scip-cache-'));

    await expect(builder.request(sha)).resolves.toEqual({
      status: 'unavailable',
      reason: 'no-java',
    });
  });

  posixOnly('leaves commits without Java or a root build file alone', async () => {
    const repo = createRepo();
    const sha = commit(repo, { 'README.md': 'hi\n' });
    const noBuildFile = commit(repo, { 'src/A.java': 'class A {}\n' });
    const fake = fakeScipJava(WRITES_INDEX);
    const { builder, events } = newBuilder(repo, fake.path, tempDir('difit-scip-cache-'));

    await expect(builder.request(sha)).resolves.toEqual({
      status: 'unavailable',
      reason: 'no-java',
    });
    await expect(builder.request(noBuildFile)).resolves.toEqual({
      status: 'unavailable',
      reason: 'no-build-file',
    });
    await expect(builder.request('HEAD')).resolves.toEqual({ status: 'none' });
    expect(events).toEqual([
      [sha, 'unavailable'],
      [noBuildFile, 'unavailable'],
    ]);
    expect(calls(fake.log)).toEqual([]);
  });

  posixOnly('builds only for a full lowercase hash', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const fake = fakeScipJava(WRITES_INDEX);
    const { builder, events } = newBuilder(repo, fake.path, tempDir('difit-scip-cache-'));

    for (const name of ['HEAD', 'main', sha.slice(0, 7), sha.toUpperCase(), `${sha}~0`]) {
      await expect(builder.request(name)).resolves.toEqual({ status: 'none' });
    }
    expect(events).toEqual([]);
    await expect(builder.request(sha)).resolves.toEqual({ status: 'ready' });
    expect(events).toEqual([
      [sha, 'building'],
      [sha, 'ready'],
    ]);
    expect(calls(fake.log)).toHaveLength(1);
  });

  posixOnly('builds a commit once and reuses the stored index in a later run', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const cache = tempDir('difit-scip-cache-');
    const fake = fakeScipJava(WRITES_INDEX);
    const { builder, events } = newBuilder(repo, fake.path, cache);

    expect(builder.state(sha)).toEqual({ status: 'none' });
    await expect(builder.request(sha)).resolves.toEqual({ status: 'ready' });
    expect(events).toEqual([
      [sha, 'building'],
      [sha, 'ready'],
    ]);

    const [call] = calls(fake.log);
    expect(call).toMatch(new RegExp(`^run index --output ${join(cache, sha)}/work-`));
    // Only the stored lookup form stays: the extracted tree, raw index and log are gone.
    expect(readdirSync(join(cache, sha))).toEqual(['index.lookup.v2.gz']);

    const index = await builder.getIndex(sha);
    expect(index?.hasDocument('src/main/java/demo/Service.java')).toBe(true);

    const later = newBuilder(repo, fake.path, cache);
    await expect(later.builder.request(sha)).resolves.toEqual({ status: 'ready' });
    const reloaded = await later.builder.getIndex(sha);
    expect(reloaded?.hasDocument('src/main/java/demo/Service.java')).toBe(true);
    expect(calls(fake.log)).toHaveLength(1);
  });

  posixOnly(
    'indexes again a commit stored without implementations while that index answers',
    async () => {
      const repo = createRepo();
      const sha = commit(repo, JAVA_PROJECT);
      const cache = tempDir('difit-scip-cache-');
      storeWithoutRelations(cache, sha);
      const fake = fakeScipJava(`sleep 0.3\n${WRITES_IMPL_INDEX}`);
      const { builder, events } = newBuilder(repo, fake.path, cache);

      await expect(builder.useStored(sha)).resolves.toBe(true);
      expect((await builder.getIndex(sha))?.knowsRelations).toBe(false);
      await waitFor(() => calls(fake.log).length > 0);
      expect(builder.state(sha)).toEqual({ status: 'ready', withoutRelations: true });
      expect((await builder.getIndex(sha))?.knowsRelations).toBe(false);

      await waitFor(() => events.length === 2);
      expect(events).toEqual([
        [sha, 'ready'],
        [sha, 'ready'],
      ]);
      expect((await builder.getIndex(sha))?.knowsRelations).toBe(true);
      await expect(builder.request(sha)).resolves.toEqual({ status: 'ready' });
      const later = newBuilder(repo, fake.path, cache);
      await later.builder.useStored(sha);
      expect((await later.builder.getIndex(sha))?.knowsRelations).toBe(true);
      expect(calls(fake.log)).toHaveLength(1);
      expect(readdirSync(join(cache, sha)).sort()).toEqual([
        'index.lookup.gz',
        'index.lookup.v2.gz',
      ]);
      expect((await readScipIndex(join(cache, sha, 'index.lookup.gz')))?.knowsRelations).toBe(
        false,
      );
    },
  );

  posixOnly(
    'builds a commit asked for later ahead of one waiting to be indexed again',
    async () => {
      const repo = createRepo();
      const running = commit(repo, JAVA_PROJECT);
      const stale = commit(repo, { 'src/main/java/demo/B.java': 'package demo;\nclass B {}\n' });
      const later = commit(repo, { 'src/main/java/demo/C.java': 'package demo;\nclass C {}\n' });
      const cache = tempDir('difit-scip-cache-');
      storeWithoutRelations(cache, stale);
      const gate = join(tempDir('difit-scip-gate-'), 'open');
      const fake = fakeScipJava(
        `while [ ! -f '${gate}' ]; do sleep 0.05; done\n${WRITES_IMPL_INDEX}`,
      );
      const { builder, events } = newBuilder(repo, fake.path, cache);

      const first = builder.request(running);
      await waitFor(() => calls(fake.log).length === 1);
      await builder.useStored(stale);
      await builder.getIndex(stale);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = builder.request(later);
      await waitFor(() => builder.state(later).status === 'queued');
      expect(builder.state(later)).toEqual({ status: 'queued', after: running });
      writeFileSync(gate, '');
      await Promise.all([first, second]);
      await waitFor(() => events.filter(([sha]) => sha === stale).length === 2);

      const order = calls(fake.log).map((call) =>
        [running, stale, later].find((sha) => call.includes(`/${sha}/work-`)),
      );
      expect(order).toEqual([running, later, stale]);
    },
  );

  posixOnly(
    'answers from the index built again when a read of the older one ends after it',
    async () => {
      const repo = createRepo();
      const sha = commit(repo, JAVA_PROJECT);
      const cache = tempDir('difit-scip-cache-');
      storeWithoutRelations(cache, sha);
      const gate = join(tempDir('difit-scip-gate-'), 'open');
      const fake = fakeScipJava(
        `while [ ! -f '${gate}' ]; do sleep 0.05; done\n${WRITES_IMPL_INDEX}`,
      );
      const builder = new ScipIndexBuilder({
        repoPath: repo,
        cacheRoot: cache,
        env: { DIFIT_SCIP_JAVA: fake.path, PATH: '' },
        maxLoaded: 0,
      });
      builders.push(builder);
      const events: ScipBuildState[] = [];
      builder.onChange((_, state) => events.push(state));

      await builder.useStored(sha);
      expect((await builder.getIndex(sha))?.knowsRelations).toBe(false);
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      let holding = false;
      reads.before = async (path) => {
        if (!path.endsWith('index.lookup.gz')) return;
        holding = true;
        await held;
      };
      const late = builder.getIndex(sha);
      await waitFor(() => holding);
      reads.before = undefined;
      writeFileSync(gate, '');
      await waitFor(() => events.length === 2);
      release();

      expect(events[1]).toEqual({ status: 'ready' });
      expect((await late)?.knowsRelations).toBe(true);
    },
  );

  posixOnly(
    'keeps the index stored without implementations when indexing again fails',
    async () => {
      const repo = createRepo();
      const sha = commit(repo, JAVA_PROJECT);
      const cache = tempDir('difit-scip-cache-');
      storeWithoutRelations(cache, sha);
      const fake = fakeScipJava('exit 3');
      const { builder, events } = newBuilder(repo, fake.path, cache);

      await builder.useStored(sha);
      await builder.getIndex(sha);
      await waitFor(() => calls(fake.log).length > 0);
      await waitFor(() => !readdirSync(join(cache, sha)).some((name) => name.startsWith('work-')));
      expect((await builder.getIndex(sha))?.knowsRelations).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(calls(fake.log)).toHaveLength(1);
      expect(builder.state(sha)).toEqual({ status: 'ready', withoutRelations: true });
      expect(events).toEqual([[sha, 'ready']]);
    },
  );

  posixOnly('shares one build between requests for the same commit', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const fake = fakeScipJava(`sleep 0.3\n${WRITES_INDEX}`);
    const { builder, events } = newBuilder(repo, fake.path, tempDir('difit-scip-cache-'));

    const results = await Promise.all([builder.request(sha), builder.request(sha)]);
    await expect(builder.request(sha)).resolves.toEqual({ status: 'ready' });
    expect(results).toEqual([{ status: 'ready' }, { status: 'ready' }]);
    expect(calls(fake.log)).toHaveLength(1);
    expect(events.map(([, status]) => status)).toEqual(['building', 'ready']);
  });

  posixOnly('runs builds for different commits one after another', async () => {
    const repo = createRepo();
    const first = commit(repo, JAVA_PROJECT);
    const second = commit(repo, {
      'src/main/java/demo/Other.java': 'package demo;\nclass Other {}\n',
    });
    const fake = fakeScipJava(
      `echo start >> "$LOG"\nsleep 0.3\necho end >> "$LOG"\n${WRITES_INDEX}`,
    );
    const { builder, events } = newBuilder(repo, fake.path, tempDir('difit-scip-cache-'));

    const one = builder.request(first);
    await waitFor(() => calls(fake.log).length > 0);
    const both = Promise.all([one, builder.request(second)]);
    await waitFor(() => builder.state(second).status === 'queued');
    expect(builder.state(first)).toEqual({ status: 'building', startedAt: expect.any(Number) });
    expect(builder.state(second)).toEqual({ status: 'queued', after: first });
    await expect(both).resolves.toEqual([{ status: 'ready' }, { status: 'ready' }]);
    expect(events.filter(([sha]) => sha === second).map(([, status]) => status)).toEqual([
      'queued',
      'building',
      'ready',
    ]);
    expect(calls(fake.log).filter((line) => !line.startsWith('run'))).toEqual([
      'start',
      'end',
      'start',
      'end',
    ]);
  });

  posixOnly('builds a commit someone waits on before the ones queued earlier', async () => {
    const repo = createRepo();
    const running = commit(repo, JAVA_PROJECT);
    const queued = commit(repo, { 'src/main/java/demo/B.java': 'package demo;\nclass B {}\n' });
    const later = commit(repo, { 'src/main/java/demo/C.java': 'package demo;\nclass C {}\n' });
    const other = commit(repo, { 'src/main/java/demo/E.java': 'package demo;\nclass E {}\n' });
    const waited = commit(repo, { 'src/main/java/demo/D.java': 'package demo;\nclass D {}\n' });
    const gate = join(tempDir('difit-scip-gate-'), 'open');
    const fake = fakeScipJava(`while [ ! -f '${gate}' ]; do sleep 0.02; done\n${WRITES_INDEX}`);
    const cache = tempDir('difit-scip-cache-');
    const { builder } = newBuilder(repo, fake.path, cache);

    const first = builder.request(running);
    await waitFor(() => calls(fake.log).length > 0);
    const rest: Array<Promise<unknown>> = [];
    for (const sha of [queued, later, other]) {
      rest.push(builder.request(sha));
      await waitFor(() => builder.state(sha).status === 'queued');
    }
    rest.push(builder.request(waited, { urgent: true }));
    await waitFor(() => builder.state(waited).status === 'queued');
    expect(builder.state(waited)).toEqual({ status: 'queued', after: running });
    void builder.request(later, { urgent: true });
    expect(builder.state(other)).toEqual({ status: 'queued', after: queued });
    expect(await builder.start(other, { urgent: true })).toEqual({
      status: 'queued',
      after: later,
    });
    expect(builder.state(later)).toEqual({ status: 'queued', after: waited });
    expect(builder.state(queued)).toEqual({ status: 'queued', after: other });
    writeFileSync(gate, '');
    await Promise.all([first, ...rest]);

    const order = calls(fake.log).map((line) => /\/([0-9a-f]{40})\/work-/.exec(line)?.[1]);
    expect(order).toEqual([running, waited, later, other, queued]);
  });

  posixOnly('tells whether a commit is ready, being built or not buildable', async () => {
    const repo = createRepo();
    const plain = commit(repo, { 'README.md': 'hi\n' });
    const sha = commit(repo, JAVA_PROJECT);
    const gate = join(tempDir('difit-scip-gate-'), 'open');
    const fake = fakeScipJava(`while [ ! -f '${gate}' ]; do sleep 0.02; done\n${WRITES_INDEX}`);
    const { builder } = newBuilder(repo, fake.path, tempDir('difit-scip-cache-'));

    await expect(builder.start(plain)).resolves.toEqual({
      status: 'unavailable',
      reason: 'no-java',
    });
    await expect(builder.start(sha)).resolves.toMatchObject({ status: 'building' });
    await expect(builder.start(sha)).resolves.toMatchObject({ status: 'building' });
    writeFileSync(gate, '');
    await builder.request(sha);
    await expect(builder.start(sha)).resolves.toEqual({ status: 'ready' });
    expect(calls(fake.log)).toHaveLength(1);
  });

  posixOnly('uses an index an earlier run stored without building one', async () => {
    const repo = createRepo();
    const stored = commit(repo, JAVA_PROJECT);
    const missing = commit(repo, {
      'src/main/java/demo/B.java': 'package demo;\nclass B {}\n',
    });
    const cache = tempDir('difit-scip-cache-');
    const fake = fakeScipJava(WRITES_INDEX);
    await newBuilder(repo, fake.path, cache).builder.request(stored);

    const { builder, events } = newBuilder(repo, fake.path, cache);
    await expect(builder.useStored(missing)).resolves.toBe(false);
    await expect(builder.useStored(stored)).resolves.toBe(true);

    expect(builder.state(stored)).toEqual({ status: 'ready' });
    expect(builder.state(missing)).toEqual({ status: 'none' });
    expect(await builder.getIndex(stored)).not.toBeNull();
    expect(events).toEqual([[stored, 'ready']]);
    expect(calls(fake.log)).toHaveLength(1);
  });

  posixOnly('reports a failed build and keeps the tail of its log', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const cache = tempDir('difit-scip-cache-');
    const fake = fakeScipJava('echo "FAILURE: Build failed with an exception."\nexit 1');
    const { builder, events } = newBuilder(repo, fake.path, cache);

    const logPath = join(cache, sha, 'build.log');
    const failed = {
      status: 'failed',
      reason: 'exit-code',
      exitCode: 1,
      detail: 'scip-java exited with code 1',
      logPath,
    };
    await expect(builder.request(sha)).resolves.toEqual(failed);
    expect(builder.state(sha)).toEqual(failed);
    expect(events.map(([, status]) => status)).toEqual(['building', 'failed']);
    expect(readFileSync(logPath, 'utf8')).toContain('FAILURE: Build failed with an exception.');
    expect(readdirSync(join(cache, sha))).toEqual(['build.log']);
    await expect(builder.getIndex(sha)).resolves.toBeNull();

    // A failure is not retried within the same run.
    await expect(builder.request(sha)).resolves.toEqual(failed);
    expect(calls(fake.log)).toHaveLength(1);
  });

  posixOnly('tells a build that found no Gradle from other failures', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const esc = String.fromCharCode(27);
    const cache = tempDir('difit-scip-cache-');
    const fake = fakeScipJava(
      `printf '${esc}[90mjava.io.IOException: Cannot run program "gradle": error=2${esc}[0m\\n'\nexit 1`,
    );
    const { builder } = newBuilder(repo, fake.path, cache);

    const result = await builder.request(sha);

    expect(result).toEqual({
      status: 'failed',
      reason: 'no-gradle',
      exitCode: 1,
      detail: 'scip-java exited with code 1',
      logPath: join(cache, sha, 'build.log'),
    });
    if (result.status !== 'failed' || !result.logPath) throw new Error('expected a log');
    expect(readFileSync(result.logPath, 'utf8')).toContain(esc);
    expect((await readBuildLog(result.logPath)).split('\n').filter(Boolean)).toEqual([
      'java.io.IOException: Cannot run program "gradle": error=2',
      '[difit] scip-java exited with code 1',
    ]);
  });

  posixOnly('fails a build whose tool writes no index or runs past the time limit', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const silent = newBuilder(repo, fakeScipJava('exit 0').path, tempDir('difit-scip-cache-'));
    await expect(silent.builder.request(sha)).resolves.toMatchObject({
      status: 'failed',
      reason: 'no-output',
      detail: 'scip-java wrote no index.scip',
    });

    const slow = newBuilder(
      repo,
      fakeScipJava('echo compiling\nsleep 30').path,
      tempDir('difit-scip-cache-'),
      300,
    );
    const result = await slow.builder.request(sha);
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'timeout',
      detail: 'scip-java timed out',
    });
    if (result.status !== 'failed' || !result.logPath) throw new Error('expected a log');
    expect(readFileSync(result.logPath, 'utf8')).toMatch(/compiling[\s\S]*scip-java timed out/);
  });

  posixOnly('fails instead of hanging when tar stops while git still has output', async () => {
    const repo = createRepo();
    // Far more than a pipe buffer, so git archive is still writing when tar exits.
    const sha = commit(repo, { ...JAVA_PROJECT, 'big.txt': 'x'.repeat(4 * 1024 * 1024) });
    const binDir = tempDir('difit-fake-tar-');
    writeFileSync(join(binDir, 'tar'), '#!/bin/sh\necho "tar: boom" >&2\nexit 2\n');
    chmodSync(join(binDir, 'tar'), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath ?? ''}`;
    try {
      const fake = fakeScipJava(WRITES_INDEX);
      const cache = tempDir('difit-scip-cache-');
      mkdirSync(join(cache, sha));
      writeFileSync(join(cache, sha, 'build.log'), 'output of an earlier run\n');
      const { builder } = newBuilder(repo, fake.path, cache);
      await expect(builder.request(sha)).resolves.toMatchObject({
        status: 'failed',
        reason: 'error',
        detail: expect.stringMatching(/^tar exited with code 2: .*tar: boom/),
        logPath: null,
      });
      expect(calls(fake.log)).toEqual([]);
      expect(readdirSync(join(cache, sha))).toEqual(['build.log']);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  posixOnly('removes a work tree the build left read-only', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const cache = tempDir('difit-scip-cache-');
    const fake = fakeScipJava(
      `mkdir -p build/ro && touch build/ro/f && chmod 555 build/ro\n${WRITES_INDEX}`,
    );
    const { builder, events } = newBuilder(repo, fake.path, cache);

    await expect(builder.request(sha)).resolves.toEqual({ status: 'ready' });
    expect(events.map(([, status]) => status)).toEqual(['building', 'ready']);
    expect(readdirSync(join(cache, sha))).toEqual(['index.lookup.v2.gz']);
  });

  posixOnly('removes work trees left by difit processes that are gone', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const other = '1'.repeat(40);
    const cache = tempDir('difit-scip-cache-');
    const deadPid = spawnSync('true').pid;
    const stale = join(cache, other, `work-${deadPid}-abc`);
    // pid 1 is alive, so its directory may still be in use.
    const live = join(cache, other, 'work-1-abc');
    writeFiles(stale, { 'src/A.java': 'class A {}\n' });
    writeFiles(live, { 'src/A.java': 'class A {}\n' });
    const staleTemp = join(cache, other, `index.lookup.gz.${deadPid}.tmp`);
    const liveTemp = join(cache, other, 'index.lookup.gz.1.tmp');
    writeFileSync(staleTemp, 'x');
    writeFileSync(liveTemp, 'x');
    const { builder } = newBuilder(repo, fakeScipJava(WRITES_INDEX).path, cache);

    await expect(builder.request(sha)).resolves.toEqual({ status: 'ready' });
    // The sweep runs beside the build; stop() waits for it.
    await builder.stop();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(staleTemp)).toBe(false);
    expect(existsSync(liveTemp)).toBe(true);
  });

  posixOnly('kills what the tool left running in its process group', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const fake = fakeScipJava(
      `( exec sleep 60 ) > /dev/null 2>&1 &\necho "pids $!" >> "$LOG"\n${WRITES_INDEX}`,
    );
    const { builder } = newBuilder(repo, fake.path, tempDir('difit-scip-cache-'));

    await expect(builder.request(sha)).resolves.toEqual({ status: 'ready' });
    const pid = Number(
      (calls(fake.log).find((line) => line.startsWith('pids')) ?? '').split(' ')[1],
    );
    try {
      await waitFor(() => !isAlive(pid), 3000);
    } finally {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  posixOnly('rebuilds when the stored index is damaged', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const cache = tempDir('difit-scip-cache-');
    const fake = fakeScipJava(WRITES_INDEX);
    const { builder, events } = newBuilder(repo, fake.path, cache);
    await builder.request(sha);

    const later = newBuilder(repo, fake.path, cache);
    await later.builder.request(sha);
    writeFileSync(join(cache, sha, 'index.lookup.v2.gz'), 'garbage');
    await expect(later.builder.getIndex(sha)).resolves.toBeNull();
    expect(later.builder.state(sha)).toEqual({ status: 'none' });
    await expect(later.builder.request(sha)).resolves.toEqual({ status: 'ready' });
    expect(calls(fake.log)).toHaveLength(2);
    expect(events.map(([, status]) => status)).toEqual(['building', 'ready']);
  });

  posixOnly('keeps at most the configured number of indexes in memory', async () => {
    const repo = createRepo();
    const shas = [
      commit(repo, JAVA_PROJECT),
      commit(repo, { 'src/main/java/demo/B.java': 'package demo;\nclass B {}\n' }),
      commit(repo, { 'src/main/java/demo/C.java': 'package demo;\nclass C {}\n' }),
    ];
    const cache = tempDir('difit-scip-cache-');
    const fake = fakeScipJava(WRITES_INDEX);
    const builder = new ScipIndexBuilder({
      repoPath: repo,
      cacheRoot: cache,
      env: { DIFIT_SCIP_JAVA: fake.path },
      maxLoaded: 2,
    });
    builders.push(builder);
    for (const sha of shas) await builder.request(sha);

    const [first, second, third] = shas as [string, string, string];
    // Each build leaves its index loaded, so the last two are in memory now.
    const secondIndex = await builder.getIndex(second);
    const thirdIndex = await builder.getIndex(third);
    expect(await builder.getIndex(second)).toBe(secondIndex);
    expect(await builder.getIndex(first)).not.toBeNull();
    // Reading the first one pushed out the least recently used, the third.
    expect(await builder.getIndex(second)).toBe(secondIndex);
    expect(await builder.getIndex(third)).not.toBe(thirdIndex);
  });

  posixOnly('stop() kills the running tool with the processes it started', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const cache = tempDir('difit-scip-cache-');
    // The grandchild ignores SIGTERM, as a busy JVM may, so only SIGKILL ends it.
    const fake = fakeScipJava(
      `sh -c 'trap "" TERM; while :; do sleep 1; done' &\necho "pids $$ $!" >> "$LOG"\nsleep 300`,
    );
    const { builder } = newBuilder(repo, fake.path, cache);

    const request = builder.request(sha);
    await waitFor(() => calls(fake.log).some((line) => line.startsWith('pids')));
    const pids = (calls(fake.log).find((line) => line.startsWith('pids')) ?? '')
      .split(' ')
      .slice(1)
      .map(Number);
    expect(pids.every(isAlive)).toBe(true);

    try {
      await builder.stop();
      await builder.stop();
      await expect(request).resolves.toEqual({ status: 'none' });
      await waitFor(() => !pids.some(isAlive), 3000);
      expect(readdirSync(join(cache, sha)).filter((name) => name.startsWith('work-'))).toEqual([]);
      await expect(builder.request(sha)).resolves.toEqual({ status: 'none' });
    } finally {
      for (const pid of pids.filter(isAlive)) process.kill(pid, 'SIGKILL');
    }
  });

  posixOnly('kills the running tool when difit exits without stopping it', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const fake = fakeScipJava(
      `sh -c 'trap "" TERM; while :; do sleep 1; done' &\necho "pids $$ $!" >> "$LOG"\nsleep 300`,
    );
    const { builder } = newBuilder(repo, fake.path, tempDir('difit-scip-cache-'));
    const listening = () => [
      process.listenerCount('exit'),
      process.listenerCount('SIGTERM'),
      process.listenerCount('SIGHUP'),
    ];
    const before = listening();
    const exitListeners = process.listeners('exit');

    const request = builder.request(sha);
    await waitFor(() => calls(fake.log).some((line) => line.startsWith('pids')));
    const pids = (calls(fake.log).find((line) => line.startsWith('pids')) ?? '')
      .split(' ')
      .slice(1)
      .map(Number);

    try {
      expect(listening()).toEqual(before.map((count) => count + 1));
      const onExit = process
        .listeners('exit')
        .find((listener) => !exitListeners.includes(listener));
      // An 'exit' listener gets no later event-loop turn, so the kill must be sent before it
      // returns. The loop below never yields, and the grandchild ignores SIGTERM.
      onExit?.(0);
      const deadline = Date.now() + 1000;
      while (pids.some(isAlive) && Date.now() < deadline);
      expect(pids.some(isAlive)).toBe(false);

      await expect(request).resolves.toMatchObject({ status: 'failed' });
      expect(listening()).toEqual(before);
    } finally {
      for (const pid of pids.filter(isAlive)) process.kill(pid, 'SIGKILL');
    }
  });

  posixOnly('leaves the repository work tree, index, refs and worktrees as they were', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    git(repo, 'checkout', '-q', '-b', 'topic');
    commit(repo, { 'src/main/java/demo/Later.java': 'package demo;\nclass Later {}\n' });
    writeFiles(repo, { 'src/main/java/demo/Port.java': 'package demo;\ninterface Port { }\n' });
    git(repo, 'add', 'src/main/java/demo/Port.java');
    writeFiles(repo, { 'notes.txt': 'untracked\n', 'build.gradle': '// edited\n' });

    const snapshot = () => ({
      status: git(repo, 'status', '--porcelain=v2', '--branch', '--untracked-files=all'),
      refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
      worktrees: git(repo, 'worktree', 'list', '--porcelain'),
      index: readFileSync(join(repo, '.git', 'index')).toString('hex'),
      head: readFileSync(join(repo, '.git', 'HEAD'), 'utf8'),
      edited: readFileSync(join(repo, 'build.gradle'), 'utf8'),
    });
    const before = snapshot();
    const fake = fakeScipJava(`grep -q "id 'java'" build.gradle || exit 9\n${WRITES_INDEX}`);
    const { builder } = newBuilder(repo, fake.path, tempDir('difit-scip-cache-'));

    // The fake fails unless it sees the committed build.gradle, not the edited one.
    await expect(builder.request(sha)).resolves.toEqual({ status: 'ready' });
    expect(snapshot()).toEqual(before);
  });
});

describe('selectEvictions', () => {
  const entry = (sha: string, bytes: number, lastUsedMs: number) => ({ sha, bytes, lastUsedMs });

  it('picks the least recently used until the rest fits under the limit', () => {
    const entries = [entry('c', 40, 300), entry('a', 40, 100), entry('b', 40, 200)];
    expect(selectEvictions(entries, 120, new Set())).toEqual([]);
    expect(selectEvictions(entries, 80, new Set())).toEqual(['a']);
    expect(selectEvictions(entries, 79, new Set())).toEqual(['a', 'b']);
  });

  it('skips kept entries but still counts their size', () => {
    const entries = [entry('a', 40, 100), entry('b', 40, 200), entry('c', 40, 300)];
    expect(selectEvictions(entries, 40, new Set(['a']))).toEqual(['b', 'c']);
    expect(selectEvictions(entries, 0, new Set(['a', 'b', 'c']))).toEqual([]);
  });
});

describe('ScipIndexBuilder cache limit', () => {
  const [A, B, C, D, E, F] = ['a', 'b', 'c', 'd', 'e', 'f'].map((ch) => ch.repeat(40)) as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  function seed(cache: string, sha: string, files: Record<string, number>, usedAt: number): void {
    for (const [name, bytes] of Object.entries(files)) {
      const path = join(cache, sha, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.alloc(bytes));
      utimesSync(path, usedAt, usedAt);
    }
  }

  function stored(cache: string): string[] {
    return readdirSync(cache)
      .filter((sha) => readdirSync(join(cache, sha)).length > 0)
      .sort();
  }

  function limitedBuilder(
    cache: string,
    limit: { bytes: number },
    options: { repo?: string; tool?: string; inUse?: () => Promise<string[]> } = {},
  ) {
    const builder = new ScipIndexBuilder({
      repoPath: options.repo ?? tempDir('difit-scip-build-repo-'),
      cacheRoot: cache,
      env: { DIFIT_SCIP_JAVA: options.tool, PATH: '' },
      cacheLimitBytes: async () => limit.bytes,
      inUse: options.inUse ?? (async () => []),
    });
    builders.push(builder);
    const events: Array<[string, ScipBuildState['status']]> = [];
    builder.onChange((sha, state) => events.push([sha, state.status]));
    return { builder, events };
  }

  it('removes the least recently used indexes until the cache fits under the limit', async () => {
    const cache = tempDir('difit-scip-cache-');
    seed(cache, A, { 'index.lookup.gz': 400 }, 100);
    seed(cache, B, { 'index.lookup.gz': 400 }, 200);
    seed(cache, C, { 'index.lookup.gz': 400 }, 300);
    const { builder } = limitedBuilder(cache, { bytes: 1000 });

    await expect(builder.request(C)).resolves.toEqual({ status: 'ready', withoutRelations: true });

    expect(stored(cache)).toEqual([B, C]);
  });

  it('counts an index as used when a review opens it', async () => {
    const cache = tempDir('difit-scip-cache-');
    seed(cache, A, { 'index.lookup.gz': 400 }, 100);
    seed(cache, B, { 'index.lookup.gz': 400 }, 200);
    seed(cache, C, { 'index.lookup.gz': 400 }, 300);
    const { builder } = limitedBuilder(cache, { bytes: 1000 });

    await builder.request(A);

    expect(stored(cache)).toEqual([A, C]);
    expect(statSync(join(cache, A, 'index.lookup.gz')).mtimeMs).toBeGreaterThan(300_000);
  });

  posixOnly(
    'keeps indexes in use and builds in progress, and removes failed build logs',
    async () => {
      const cache = tempDir('difit-scip-cache-');
      seed(cache, A, { 'index.lookup.gz': 400 }, 100);
      // pid 1 is alive, so another difit process may be building this commit.
      seed(cache, B, { 'build.log': 400, 'work-1-abc/index.scip': 400 }, 200);
      seed(cache, C, { 'index.lookup.gz': 400 }, 300);
      seed(cache, D, { 'build.log': 400 }, 400);
      seed(cache, E, { 'index.lookup.gz.1.tmp': 400 }, 500);
      seed(cache, F, { 'index.lookup.gz': 400 }, 600);
      const { builder, events } = limitedBuilder(cache, { bytes: 0 }, { inUse: async () => [A] });

      await builder.request(F);

      expect(stored(cache)).toEqual([A, B, E, F]);
      expect(readdirSync(join(cache, B)).sort()).toEqual(['build.log', 'work-1-abc']);
      expect(readdirSync(join(cache, E))).toEqual(['index.lookup.gz.1.tmp']);
      // Nothing of these was known to this process, so there is nothing to announce.
      expect(events).toEqual([[F, 'ready']]);
    },
  );

  posixOnly('removes the log of a failed build without trying the build again', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const cache = tempDir('difit-scip-cache-');
    const fake = fakeScipJava('exit 1');
    const { builder } = limitedBuilder(cache, { bytes: 0 }, { repo, tool: fake.path });
    const failed = await builder.request(sha);
    seed(cache, A, { 'index.lookup.gz': 400 }, 100);
    seed(cache, B, { 'index.lookup.gz': 400 }, 200);

    await builder.request(A);

    expect(stored(cache)).toEqual([A]);
    await expect(builder.request(sha)).resolves.toEqual(failed);
    expect(builder.state(sha)).toEqual(failed);
    expect(calls(fake.log)).toHaveLength(1);
  });

  it('reads the limit again at every cleanup', async () => {
    const cache = tempDir('difit-scip-cache-');
    seed(cache, A, { 'index.lookup.gz': 400 }, 100);
    seed(cache, B, { 'index.lookup.gz': 400 }, 200);
    const limit = { bytes: 10_000 };
    const { builder } = limitedBuilder(cache, limit);

    await builder.request(B);
    expect(stored(cache)).toEqual([A, B]);

    limit.bytes = 500;
    await builder.request(B);
    expect(stored(cache)).toEqual([B]);
  });

  it('reads the limit from the difit config file at every cleanup', async () => {
    const configDir = tempDir('difit-config-');
    const saved = process.env.DIFIT_CONFIG_DIR;
    process.env.DIFIT_CONFIG_DIR = configDir;
    try {
      const cache = tempDir('difit-scip-cache-');
      seed(cache, A, { 'index.lookup.gz': 400 }, 100);
      seed(cache, B, { 'index.lookup.gz': 400 }, 200);
      const builder = new ScipIndexBuilder({
        repoPath: tempDir('difit-scip-build-repo-'),
        cacheRoot: cache,
        env: { PATH: '' },
      });
      builders.push(builder);

      await builder.request(B);
      expect(stored(cache)).toEqual([A, B]);

      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({ version: 1, client: {}, scipIndexCacheLimitMiB: 0 }),
      );
      await builder.request(B);
      expect(stored(cache)).toEqual([B]);
    } finally {
      if (saved === undefined) delete process.env.DIFIT_CONFIG_DIR;
      else process.env.DIFIT_CONFIG_DIR = saved;
    }
  });

  function slowFirstInUse(shown: () => string[]) {
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const inUse = async () => {
      const commits = shown();
      if (calls++ === 0) await released;
      return commits;
    };
    return { inUse, started: () => calls > 0, release };
  }

  it('keeps a commit that a request opens while a cleanup is running', async () => {
    const cache = tempDir('difit-scip-cache-');
    seed(cache, A, { 'index.lookup.gz': 400 }, 100);
    seed(cache, B, { 'index.lookup.gz': 400 }, 50);
    const cleanup = slowFirstInUse(() => []);
    const { builder, events } = limitedBuilder(cache, { bytes: 500 }, { inUse: cleanup.inUse });

    const first = builder.request(A);
    await waitFor(cleanup.started);
    const second = builder.request(B);
    await waitFor(() => builder.state(B).status === 'ready');
    cleanup.release();
    await Promise.all([first, second]);

    expect(stored(cache)).toEqual([B]);
    expect(builder.state(B)).toEqual({ status: 'ready', withoutRelations: true });
    expect(events).not.toContainEqual([B, 'none']);
  });

  it('keeps a commit that becomes shown while a cleanup is running', async () => {
    const cache = tempDir('difit-scip-cache-');
    seed(cache, A, { 'index.lookup.gz': 400 }, 100);
    seed(cache, B, { 'index.lookup.gz': 400 }, 50);
    let shown: string[] = [];
    const cleanup = slowFirstInUse(() => shown);
    const { builder } = limitedBuilder(cache, { bytes: 500 }, { inUse: cleanup.inUse });

    const first = builder.request(A);
    await waitFor(cleanup.started);
    shown = [B];
    cleanup.release();
    await first;

    expect(stored(cache)).toEqual([A, B]);
  });

  posixOnly('counts an index as used when a lookup reads it', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const cache = tempDir('difit-scip-cache-');
    const limit = { bytes: 1e9 };
    const { builder } = limitedBuilder(cache, limit, {
      repo,
      tool: fakeScipJava(WRITES_INDEX).path,
    });
    await builder.request(sha);
    const indexPath = join(cache, sha, 'index.lookup.v2.gz');
    utimesSync(indexPath, 100, 100);
    seed(cache, A, { 'index.lookup.gz': 400 }, 200);
    seed(cache, B, { 'index.lookup.gz': 1 }, 300);

    expect(await builder.getIndex(sha)).not.toBeNull();
    await waitFor(() => statSync(indexPath).mtimeMs > 300_000);
    limit.bytes = statSync(indexPath).size + 1;
    await builder.request(B);

    expect(stored(cache)).toEqual([B, sha].sort());
  });

  posixOnly('counts an index as used when a lookup loads it from disk', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const cache = tempDir('difit-scip-cache-');
    const unlimited = { bytes: 1e9 };
    const built = limitedBuilder(cache, unlimited, { repo, tool: fakeScipJava(WRITES_INDEX).path });
    await built.builder.request(sha);
    const { builder } = limitedBuilder(cache, unlimited, { repo });
    await expect(builder.request(sha)).resolves.toEqual({ status: 'ready' });
    const indexPath = join(cache, sha, 'index.lookup.v2.gz');
    utimesSync(indexPath, 100, 100);

    expect(await builder.getIndex(sha)).not.toBeNull();
    await waitFor(() => statSync(indexPath).mtimeMs > 100_000, 2000);
  });

  posixOnly('removes indexes over the limit once a commit is indexed again', async () => {
    const repo = createRepo();
    const sha = commit(repo, JAVA_PROJECT);
    const cache = tempDir('difit-scip-cache-');
    storeWithoutRelations(cache, sha);
    seed(cache, A, { 'index.lookup.gz': 400 }, 100);
    const limit = { bytes: statSync(join(cache, sha, 'index.lookup.gz')).size + 400 };
    const { builder, events } = limitedBuilder(cache, limit, {
      repo,
      tool: fakeScipJava(WRITES_IMPL_INDEX).path,
    });

    await builder.useStored(sha);
    await builder.getIndex(sha);
    await waitFor(() => events.length === 2);

    await waitFor(() => stored(cache).length === 1);
    expect(stored(cache)).toEqual([sha]);
    expect(readdirSync(join(cache, sha)).sort()).toEqual(['index.lookup.gz', 'index.lookup.v2.gz']);
  });

  posixOnly('does not index again a commit the cleanup removed while it waited', async () => {
    const repo = createRepo();
    const running = commit(repo, JAVA_PROJECT);
    const stale = commit(repo, { 'src/main/java/demo/B.java': 'package demo;\nclass B {}\n' });
    const cache = tempDir('difit-scip-cache-');
    storeWithoutRelations(cache, stale);
    seed(cache, A, { 'index.lookup.v2.gz': 400 }, 100);
    const gate = join(tempDir('difit-scip-gate-'), 'open');
    const fake = fakeScipJava(
      `while [ ! -f '${gate}' ]; do sleep 0.05; done\n${WRITES_IMPL_INDEX}`,
    );
    const { builder, events } = limitedBuilder(cache, { bytes: 0 }, { repo, tool: fake.path });

    const first = builder.request(running);
    await waitFor(() => calls(fake.log).length === 1);
    await builder.useStored(stale);
    await builder.getIndex(stale);
    await builder.request(A);
    expect(builder.state(stale).status).toBe('none');
    writeFileSync(gate, '');
    await first;
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(calls(fake.log)).toHaveLength(1);
    expect(events.filter(([sha]) => sha === stale)).toEqual([
      [stale, 'ready'],
      [stale, 'none'],
    ]);
  });

  posixOnly('builds again a commit whose index the cleanup removed', async () => {
    const repo = createRepo();
    const first = commit(repo, JAVA_PROJECT);
    const second = commit(repo, {
      'src/main/java/demo/Other.java': 'package demo;\nclass Other {}\n',
    });
    const cache = tempDir('difit-scip-cache-');
    const fake = fakeScipJava(WRITES_INDEX);
    const { builder, events } = limitedBuilder(cache, { bytes: 0 }, { repo, tool: fake.path });

    await expect(builder.request(first)).resolves.toEqual({ status: 'ready' });
    await expect(builder.request(second)).resolves.toEqual({ status: 'ready' });
    expect(stored(cache)).toEqual([second]);
    expect(builder.state(first)).toEqual({ status: 'none' });
    await expect(builder.getIndex(first)).resolves.toBeNull();

    await expect(builder.request(first)).resolves.toEqual({ status: 'ready' });
    expect(calls(fake.log)).toHaveLength(3);
    expect(stored(cache)).toEqual([first]);
    expect(events).toEqual([
      [first, 'building'],
      [first, 'ready'],
      [second, 'building'],
      [second, 'ready'],
      [first, 'none'],
      [first, 'building'],
      [first, 'ready'],
      [second, 'none'],
    ]);
  });
});
