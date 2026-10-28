import { execFileSync } from 'child_process';
import { once } from 'events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';

import { fetch } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { startServer } from './server.js';
import type {
  SymbolCallersResponse,
  SymbolIndexLogResponse,
  SymbolSearchResponse,
} from '../types/diff.js';
import { createDiffSelection } from '../utils/diffSelection.js';

// The repository under review holds the Java sources the fixture index.scip was made from, so a
// fake scip-java that copies the fixture indexes it faithfully.
const FIXTURE_DIR = join(__dirname, 'scip-index-fixture');
const FIXTURE = join(FIXTURE_DIR, 'index.scip');
const SERVICE = 'src/main/java/demo/Service.java';
const PORT = 'src/main/java/demo/Port.java';
const JAVA_SOURCES = ['Cache', 'MemberRepository', 'Port', 'Service'].map(
  (name) => `src/main/java/demo/${name}.java`,
);
const posixOnly = process.platform === 'win32' ? it.skip : it;

let home: string;
let repo: string;
let base: string;
let head: string;
const savedEnv = { ...process.env };
const cleanups: Array<() => Promise<void> | void> = [];

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function sourceLine(path: string, line: number): string {
  return readFileSync(join(FIXTURE_DIR, path), 'utf8').split('\n')[line - 1] ?? '';
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'difit-symbol-index-home-'));
  // A test run started from a commit hook would otherwise point every git call at that commit.
  process.env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: home,
    DIFIT_CONFIG_DIR: join(home, 'difit'),
    PATH: (process.env.PATH ?? '')
      .split(delimiter)
      .filter((dir) => dir !== '' && !existsSync(join(dir, 'scip-java')))
      .join(delimiter),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'difit',
    GIT_AUTHOR_EMAIL: 'difit@example.com',
    GIT_COMMITTER_NAME: 'difit',
    GIT_COMMITTER_EMAIL: 'difit@example.com',
  });

  repo = mkdtempSync(join(tmpdir(), 'difit-symbol-index-repo-'));
  git('init', '-q');
  git('checkout', '-q', '-b', 'main');
  write('build.gradle', "plugins { id 'java' }\n");
  write('README.md', 'Call findById to look a member up.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  for (const path of JAVA_SOURCES) write(path, readFileSync(join(FIXTURE_DIR, path), 'utf8'));
  git('add', '-A');
  git('commit', '-q', '-m', 'members');
  head = git('rev-parse', 'HEAD');
});

afterAll(() => {
  process.env = savedEnv;
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(join(home, 'difit'), { recursive: true, force: true });
});

// A stand-in for `scip-java index --output <path>`; `body` replaces copying the fixture index.
function fakeScipJava(
  gate?: string,
  { failFirst = false, body }: { failFirst?: boolean; body?: string } = {},
): { calls: string; pids: () => number[] } {
  const dir = mkdtempSync(join(tmpdir(), 'difit-fake-scip-java-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const tool = join(dir, 'scip-java');
  const calls = join(dir, 'calls.log');
  const wait = gate ? `while [ ! -f '${gate}' ]; do sleep 0.05; done\n` : '';
  const failed = join(dir, 'failed');
  const fail = failFirst ? `if [ ! -f '${failed}' ]; then : > '${failed}'; exit 1; fi\n` : '';
  const work = body ?? `cp '${FIXTURE}' "$3"`;
  writeFileSync(tool, `#!/bin/sh\necho $$ >> '${calls}'\n${wait}${fail}${work}\n`);
  chmodSync(tool, 0o755);
  process.env.DIFIT_SCIP_JAVA = tool;
  return {
    calls,
    pids: () =>
      existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(Number) : [],
  };
}

async function openReview(options: Parameters<typeof startServer>[0] = {}) {
  const started = await startServer({
    selection: createDiffSelection(base, head),
    repoPath: repo,
    preferredPort: 9330,
    openBrowser: false,
    // A page closed during cleanup must not start the shutdown that ends the test process.
    keepAlive: true,
    ...options,
  });
  const { port, server, stopSymbolIndex, settleSymbolIndex } = started;
  cleanups.push(async () => {
    await stopSymbolIndex?.();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });
  const api = (path: string) => `http://localhost:${port}${path}`;
  const peek = async (query: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const response = await fetch(api(`/api/symbol?${params.toString()}`));
    return { status: response.status, body: (await response.json()) as SymbolSearchResponse };
  };
  // Opening the diff is the other way a review asks for a build.
  const settle = async () => {
    expect((await fetch(api('/api/diff'))).ok).toBe(true);
    await settleSymbolIndex?.();
  };
  const openPage = async (until: (received: string) => boolean) => {
    const socket = new WebSocket(`ws://localhost:${port}/api/live`);
    cleanups.push(() => socket.terminate());
    let received = '';
    const heard = new Promise<string>((resolve) => {
      socket.on('message', (data: Buffer) => {
        received += `${data.toString('utf8')}\n`;
        if (until(received)) resolve(received);
      });
    });
    await once(socket, 'open');
    return { heard };
  };
  return { api, peek, stopSymbolIndex, settle, settleSymbolIndex, openPage };
}

const IN_FIND = 'semanticdb maven . . demo/Service#이름찾기().';
const IN_TWICE = 'semanticdb maven . . demo/Service#twice().';

const FIND_BY_ID = {
  name: 'findById',
  from: SERVICE,
  line: 17,
  column: sourceLine(SERVICE, 17).indexOf('findById'),
};

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  // A zombie awaits only its parent's wait.
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] === 'Z';
  } catch {
    return true;
  }
}

describe('symbol peek of a commit review', () => {
  posixOnly('answers a click on a Java name from the commit index once it is built', async () => {
    const tool = fakeScipJava();
    const { peek } = await openReview();

    const answer = await waitFor(async () => {
      const { body } = await peek({ ...FIND_BY_ID, ref: head.slice(0, 7) });
      return body.source === 'index' ? body : undefined;
    });

    expect(answer).toEqual({
      name: 'findById',
      ref: head.slice(0, 7),
      definitions: [{ path: PORT, line: 6, text: sourceLine(PORT, 6) }],
      references: [{ path: SERVICE, line: 17, text: sourceLine(SERVICE, 17), caller: IN_FIND }],
      truncated: false,
      source: 'index',
    });
    expect((await peek({ ...FIND_BY_ID, ref: head })).body.source).toBe('index');
    expect(tool.pids()).toHaveLength(1);
  });

  posixOnly('lists the callers of the method a use sits in', async () => {
    fakeScipJava();
    const { api, peek } = await openReview();
    const answer = await waitFor(async () => {
      const { body } = await peek({ ...FIND_BY_ID, ref: head });
      return body.source === 'index' ? body : undefined;
    });
    expect(answer.references[0]?.caller).toBe(IN_FIND);

    const callers = (ref: string, symbol: string) =>
      fetch(api(`/api/symbol-callers?${new URLSearchParams({ ref, symbol }).toString()}`));
    const found = await callers(head, IN_FIND);
    expect(found.status).toBe(200);
    expect((await found.json()) as SymbolCallersResponse).toEqual({
      callers: [{ path: SERVICE, line: 21, text: sourceLine(SERVICE, 21), caller: IN_TWICE }],
      truncated: false,
    });
    expect((await callers(head, '')).status).toBe(400);
    expect((await callers('-x', IN_FIND)).status).toBe(400);
    expect((await callers(base, IN_FIND)).status).toBe(404);
    expect((await callers(head, 'semanticdb maven . . demo/Missing#nothing().')).status).toBe(404);
  });

  posixOnly('names the library of a declaration outside the repository', async () => {
    fakeScipJava();
    const { peek } = await openReview();
    const orElse = { ...FIND_BY_ID, name: 'orElse', column: FIND_BY_ID.column + 13, ref: head };
    expect(sourceLine(SERVICE, 17).slice(orElse.column).startsWith('orElse')).toBe(true);

    const answer = await waitFor(async () => {
      const { body } = await peek(orElse);
      return body.source === 'index' ? body : undefined;
    });

    expect(answer.definitions).toEqual([]);
    expect(answer.library).toBe('java.util.Optional#orElse()');
    expect(answer.references.map((match) => match.line)).toEqual([17]);
  });

  posixOnly('searches by name where the index cannot answer', async () => {
    fakeScipJava();
    const { peek } = await openReview();
    await waitFor(async () => {
      const { body } = await peek({ ...FIND_BY_ID, ref: head });
      return body.source === 'index' ? true : undefined;
    });

    const searches = [
      [{ name: 'findById', ref: head, from: SERVICE }, {}],
      [
        { name: 'findById', ref: head, from: 'README.md', line: 1, column: 5 },
        { unindexed: 'not-java' },
      ],
      [
        { ...FIND_BY_ID, ref: base },
        { index: { commit: base, status: 'unavailable', reason: 'no-java' } },
      ],
      [{ ...FIND_BY_ID, ref: 'working' }, { unindexed: 'not-commit' }],
    ] as const;
    for (const [query, why] of searches) {
      const { status, body } = await peek(query);
      expect(status).toBe(200);
      expect(body.source).toBe('name');
      expect({ index: body.index, unindexed: body.unindexed }).toEqual({
        index: undefined,
        unindexed: undefined,
        ...why,
      });
    }
    const byName = await peek({ name: 'findById', ref: head, from: SERVICE });
    expect(byName.body.references.map((match) => match.path)).toContain('README.md');
  });

  posixOnly('says the index is being built, and announces when it is done', async () => {
    const gate = join(home, 'gate');
    cleanups.push(() => rmSync(gate, { force: true }));
    fakeScipJava(gate);
    const { api, peek, openPage } = await openReview();

    const asked = Date.now();
    const building = await waitFor(async () => {
      const { body } = await peek({ ...FIND_BY_ID, ref: head });
      return body.index?.status === 'building' ? body : undefined;
    });
    expect(building.source).toBe('name');
    expect(building.index).toEqual({
      commit: head,
      status: 'building',
      startedAt: expect.any(Number),
    });
    if (building.index?.status !== 'building') throw new Error('expected a build');
    expect(building.index.startedAt).toBeGreaterThan(asked - 60_000);
    expect(building.index.startedAt).toBeLessThanOrEqual(Date.now());
    expect(building.definitions.map((match) => match.path)).toContain(PORT);
    expect(
      (await peek({ name: 'findById', ref: head, from: 'README.md', line: 1, column: 5 })).body
        .index,
    ).toBeUndefined();
    expect((await peek({ name: 'findById', ref: head, from: SERVICE })).body.index).toBeUndefined();

    const started = Date.now();
    const diff = await fetch(api('/api/diff?ignoreWhitespace=true'));
    expect(diff.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await peek({ ...FIND_BY_ID, ref: head })).body.index?.status).toBe('building');

    const { heard } = await openPage((received) => received.includes('"status":"ready"'));
    writeFileSync(gate, '');

    const received = await heard;
    expect(received).toContain(
      `"type":"symbolIndexChanged","commit":"${head}","state":{"status":"ready"}`,
    );
    const done = await peek({ ...FIND_BY_ID, ref: head });
    expect(done.body.source).toBe('index');
    expect(done.body.index).toBeUndefined();
  });

  posixOnly('tells a page that connects later how the index stands', async () => {
    fakeScipJava();
    const { settle, openPage } = await openReview();
    await settle();

    const { heard } = await openPage((received) => received.includes('symbolIndexChanged'));
    const received = await heard;

    expect(received).toContain(
      `"type":"symbolIndexChanged","commit":"${head}","state":{"status":"ready"}`,
    );
  });

  posixOnly('says why a build failed and serves its log without color codes', async () => {
    const esc = String.fromCharCode(27);
    fakeScipJava(undefined, {
      body: `printf '${esc}[90mjava.io.IOException: Cannot run program "gradle"${esc}[0m\\n'\nexit 1`,
    });
    const { api, peek, settle, openPage } = await openReview();
    await settle();

    const failed = {
      status: 'failed',
      reason: 'no-gradle',
      exitCode: 1,
      detail: 'scip-java exited with code 1',
      hasLog: true,
    };
    const { body } = await peek({ ...FIND_BY_ID, ref: head });
    expect(body.source).toBe('name');
    expect(body.index).toEqual({ commit: head, ...failed });

    const { heard } = await openPage((received) => received.includes('"status":"failed"'));
    expect(await heard).toContain(`"commit":"${head}","state":${JSON.stringify(failed)}`);

    const log = await fetch(api(`/api/symbol-index/${head}/log`));
    expect(log.status).toBe(200);
    const { path, text } = (await log.json()) as SymbolIndexLogResponse;
    expect(path).toBe(join(home, 'difit', 'scip-index', head, 'build.log'));
    expect(readFileSync(path, 'utf8')).toContain(esc);
    expect(text.split('\n').filter(Boolean)).toEqual([
      'java.io.IOException: Cannot run program "gradle"',
      '[difit] scip-java exited with code 1',
    ]);

    for (const commit of [base, 'HEAD', '..%2F..%2Fetc']) {
      expect((await fetch(api(`/api/symbol-index/${commit}/log`))).status).toBe(404);
    }
  });

  posixOnly('follows a branch named like a short hash when it moves', async () => {
    fakeScipJava();
    const { peek, settle } = await openReview();
    await settle();
    git('branch', 'cafe123', head);
    cleanups.push(() => {
      git('branch', '-D', 'cafe123');
    });
    expect((await peek({ ...FIND_BY_ID, ref: 'cafe123' })).body.source).toBe('index');

    git('branch', '-f', 'cafe123', base);

    expect((await peek({ ...FIND_BY_ID, ref: 'cafe123' })).body.source).toBe('name');
  });

  posixOnly('ends a running build when difit stops', async () => {
    const tool = fakeScipJava(join(home, 'never'));
    const { stopSymbolIndex } = await openReview();
    const [pid] = await waitFor(async () => (tool.pids().length > 0 ? tool.pids() : undefined));
    expect(isDead(pid!)).toBe(false);

    await stopSymbolIndex?.();

    expect(isDead(pid!)).toBe(true);
  });

  posixOnly('finds a Korean name in the index', async () => {
    fakeScipJava();
    const { peek, settle } = await openReview();
    await settle();
    const line = 21;

    const { status, body } = await peek({
      name: '이름찾기',
      from: SERVICE,
      line,
      column: sourceLine(SERVICE, line).indexOf('이름찾기'),
      ref: head,
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      source: 'index',
      definitions: [{ path: SERVICE, line: 14 }],
      references: [{ path: SERVICE, line }],
    });
  });

  posixOnly('waits for the build a review asked for before it settles', async () => {
    const tool = fakeScipJava();
    const { settle } = await openReview();

    await settle();

    expect(tool.pids()).toHaveLength(1);
  });

  posixOnly(
    'keeps the shown review over the cache limit and builds an evicted one again',
    async () => {
      mkdirSync(join(home, 'difit'), { recursive: true });
      writeFileSync(
        join(home, 'difit', 'config.json'),
        JSON.stringify({ version: 1, client: {}, scipIndexCacheLimitMiB: 0 }),
      );
      const other = git('commit-tree', `${head}^{tree}`, '-p', base, '-m', 'other');
      const third = git('commit-tree', `${head}^{tree}`, '-p', other, '-m', 'third');
      const tool = fakeScipJava();
      const { api, peek, settleSymbolIndex } = await openReview();
      const show = async (from: string, target: string) => {
        expect((await fetch(api(`/api/diff?base=${from}&target=${target}`))).ok).toBe(true);
        await settleSymbolIndex?.();
      };
      const root = join(home, 'difit', 'scip-index');
      const cached = () =>
        readdirSync(root)
          .filter((sha) => readdirSync(join(root, sha)).length > 0)
          .sort();

      await show(base, head);
      expect(cached()).toEqual([head]);

      await show(base, other);
      expect(cached()).toEqual([other]);
      expect((await peek({ ...FIND_BY_ID, ref: other })).body.source).toBe('index');
      expect((await peek({ ...FIND_BY_ID, ref: head })).body.source).toBe('name');

      await show(other, third);
      expect(cached()).toEqual([other, third].sort());

      await show(base, head);
      expect(tool.pids()).toHaveLength(4);
      expect(cached()).toEqual([head]);
      expect((await peek({ ...FIND_BY_ID, ref: head })).body.source).toBe('index');
    },
  );

  posixOnly('keeps the merge base that a merge-base review shows as its base', async () => {
    const other = git('commit-tree', `${head}^{tree}`, '-p', base, '-m', 'other');
    const side = git('commit-tree', `${head}^{tree}`, '-p', head, '-m', 'side');
    const target = git('commit-tree', `${head}^{tree}`, '-p', head, '-m', 'target');
    fakeScipJava();
    const { api, settleSymbolIndex } = await openReview();
    const show = async (query: string) => {
      expect((await fetch(api(`/api/diff?${query}`))).ok).toBe(true);
      await settleSymbolIndex?.();
    };
    const root = join(home, 'difit', 'scip-index');
    const cached = () =>
      readdirSync(root)
        .filter((sha) => readdirSync(join(root, sha)).length > 0)
        .sort();

    // An already indexed target lets the cleanup start before the diff request ends.
    await show(`base=${base}&target=${head}`);
    await show(`base=${base}&target=${target}`);
    await show(`base=${base}&target=${other}`);
    expect(cached()).toEqual([head, other, target].sort());
    writeFileSync(
      join(home, 'difit', 'config.json'),
      JSON.stringify({ version: 1, client: {}, scipIndexCacheLimitMiB: 0 }),
    );

    await show(`base=${side}&target=${target}&baseMode=merge-base`);

    expect(cached()).toEqual([head, target].sort());
  });

  describe('on the base side of the diff', () => {
    const reviewOnTopOfHead = () => {
      const next = git('commit-tree', `${head}^{tree}`, '-p', head, '-m', 'next');
      const after = git('commit-tree', `${head}^{tree}`, '-p', next, '-m', 'after');
      return { next, after };
    };

    posixOnly('builds the base index once its side is clicked', async () => {
      const gate = join(home, 'gate');
      cleanups.push(() => rmSync(gate, { force: true }));
      const { next } = reviewOnTopOfHead();
      const tool = fakeScipJava(gate);
      const { peek, settleSymbolIndex } = await openReview({
        selection: createDiffSelection(head, next),
      });
      writeFileSync(gate, '');
      await settleSymbolIndex?.();
      expect(tool.pids()).toHaveLength(1);
      rmSync(gate);

      const first = await peek({ ...FIND_BY_ID, ref: head.slice(0, 7) });
      expect(first.body.source).toBe('name');
      expect(first.body.index).toMatchObject({ commit: head, status: 'building' });
      writeFileSync(gate, '');

      const answer = await waitFor(async () => {
        const { body } = await peek({ ...FIND_BY_ID, ref: head.slice(0, 7) });
        return body.source === 'index' ? body : undefined;
      });
      expect(answer.definitions).toEqual([{ path: PORT, line: 6, text: sourceLine(PORT, 6) }]);
      expect((await peek({ ...FIND_BY_ID, ref: next })).body.source).toBe('index');
      expect(tool.pids()).toHaveLength(2);
    });

    posixOnly('names the build a clicked base waits behind', async () => {
      const gate = join(home, 'gate');
      cleanups.push(() => rmSync(gate, { force: true }));
      const { next } = reviewOnTopOfHead();
      fakeScipJava(gate);
      const { peek } = await openReview({ selection: createDiffSelection(head, next) });
      await waitFor(async () => {
        const { body } = await peek({ ...FIND_BY_ID, ref: next });
        return body.index?.status === 'building' ? true : undefined;
      });

      const { body } = await peek({ ...FIND_BY_ID, ref: head });

      expect(body.index).toEqual({ commit: head, status: 'queued', after: next });
      writeFileSync(gate, '');
    });

    posixOnly('builds nothing for a commit that is not the base of the review', async () => {
      const { next, after } = reviewOnTopOfHead();
      const tool = fakeScipJava();
      const { peek, settleSymbolIndex } = await openReview({
        selection: createDiffSelection(next, after),
      });
      await settleSymbolIndex?.();

      const { body } = await peek({ ...FIND_BY_ID, ref: head });
      await settleSymbolIndex?.();

      expect(body.source).toBe('name');
      expect(body.index).toEqual({ commit: head, status: 'none' });
      expect(tool.pids()).toHaveLength(1);
    });

    posixOnly('answers from an index an earlier run stored, without building', async () => {
      const { next, after } = reviewOnTopOfHead();
      const tool = fakeScipJava();
      const earlier = await openReview({ selection: createDiffSelection(base, head) });
      await earlier.settleSymbolIndex?.();
      await earlier.stopSymbolIndex?.();
      expect(tool.pids()).toHaveLength(1);

      const asBase = await openReview({ selection: createDiffSelection(head, next) });
      expect((await asBase.peek({ ...FIND_BY_ID, ref: head })).body.source).toBe('index');
      const elsewhere = await openReview({ selection: createDiffSelection(next, after) });
      expect((await elsewhere.peek({ ...FIND_BY_ID, ref: head })).body.source).toBe('index');
      await asBase.settleSymbolIndex?.();
      await elsewhere.settleSymbolIndex?.();
      expect(tool.pids()).toHaveLength(3);
    });

    posixOnly(
      'builds nothing for the HEAD that uncommitted changes are compared with',
      async () => {
        const tool = fakeScipJava();
        const { peek, settle } = await openReview({ selection: createDiffSelection('HEAD', '.') });

        const { body } = await peek({ ...FIND_BY_ID, ref: head });
        await settle();

        expect(body.source).toBe('name');
        expect(body.index).toEqual({ commit: head, status: 'none' });
        expect(tool.pids()).toEqual([]);
      },
    );
  });

  describe('in a fixup commit on top of an indexed one', () => {
    const edited = `${sourceLine(SERVICE, 17)} // edited`;
    const fixupOfHead = () => {
      const lines = readFileSync(join(FIXTURE_DIR, SERVICE), 'utf8').split('\n');
      lines.splice(16, 1, edited);
      lines.splice(1, 0, '// one', '// two');
      git('checkout', '-q', '-b', 'fixups');
      write(SERVICE, lines.join('\n'));
      git('commit', '-q', '-am', 'fixup! members');
      const fixup = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      cleanups.push(() => {
        git('branch', '-D', '-q', 'fixups');
      });
      return fixup;
    };
    const RENAMED_CALLER = {
      name: '이름찾기',
      from: SERVICE,
      line: 16,
      column: sourceLine(SERVICE, 14).indexOf('이름찾기'),
    };

    posixOnly('answers from the index of the commit it fixes, without building', async () => {
      const fixup = fixupOfHead();
      const tool = fakeScipJava();
      const { api, peek, settle, settleSymbolIndex } = await openReview();
      await settle();
      expect((await fetch(api(`/api/diff?base=${head}&target=${fixup}`))).ok).toBe(true);
      await settleSymbolIndex?.();

      const unchanged = await peek({ ...RENAMED_CALLER, ref: fixup });
      expect(unchanged.body).toMatchObject({
        source: 'index',
        definitions: [{ path: SERVICE, line: 16 }],
        references: [{ path: SERVICE, line: 23 }],
      });
      const declaration = await peek({
        name: 'findById',
        from: PORT,
        line: 6,
        column: sourceLine(PORT, 6).indexOf('findById'),
        ref: fixup,
      });
      expect(declaration.body.source).toBe('index');
      expect(declaration.body.references).toEqual([
        { path: SERVICE, line: 19, text: edited, source: 'name' },
      ]);
      const changed = await peek({ ...FIND_BY_ID, line: 19, ref: fixup });
      expect(changed.body.source).toBe('name');
      expect(changed.body.index).toEqual({ commit: fixup, status: 'none' });
      expect(tool.pids()).toHaveLength(1);
    });

    posixOnly('lists callers on the lines of the fixup from the commit it fixes', async () => {
      const fixup = fixupOfHead();
      fakeScipJava();
      const { api, settle, settleSymbolIndex } = await openReview();
      await settle();
      expect((await fetch(api(`/api/diff?base=${head}&target=${fixup}`))).ok).toBe(true);
      await settleSymbolIndex?.();

      const query = new URLSearchParams({ ref: fixup, symbol: IN_FIND });
      const response = await fetch(api(`/api/symbol-callers?${query.toString()}`));
      expect((await response.json()) as SymbolCallersResponse).toEqual({
        callers: [{ path: SERVICE, line: 23, text: sourceLine(SERVICE, 21), caller: IN_TWICE }],
        truncated: false,
      });
    });

    posixOnly('waits for the index of the commit it fixes while it is built', async () => {
      const gate = join(home, 'gate');
      cleanups.push(() => rmSync(gate, { force: true }));
      const fixup = fixupOfHead();
      const tool = fakeScipJava(gate);
      const { peek } = await openReview({ selection: createDiffSelection(base, head) });
      await waitFor(async () => (tool.pids().length > 0 ? true : undefined));

      const waiting = await peek({ ...RENAMED_CALLER, ref: fixup });
      expect(waiting.body.source).toBe('name');
      expect(waiting.body.index).toMatchObject({ commit: head, status: 'building' });
      writeFileSync(gate, '');

      await waitFor(async () => {
        const { body } = await peek({ ...RENAMED_CALLER, ref: fixup });
        return body.source === 'index' ? true : undefined;
      });
      expect(tool.pids()).toHaveLength(1);
    });

    posixOnly('builds a fixup commit once the build of the commit it fixes fails', async () => {
      const gate = join(home, 'gate');
      cleanups.push(() => rmSync(gate, { force: true }));
      const fixup = fixupOfHead();
      const tool = fakeScipJava(gate, { failFirst: true });
      const { api, settleSymbolIndex } = await openReview();
      await waitFor(async () => (tool.pids().length > 0 ? true : undefined));
      expect((await fetch(api(`/api/diff?base=${head}&target=${fixup}`))).ok).toBe(true);

      writeFileSync(gate, '');
      await settleSymbolIndex?.();

      expect(tool.pids()).toHaveLength(2);
      expect(existsSync(join(home, 'difit', 'scip-index', head, 'index.lookup.gz'))).toBe(false);
      expect(existsSync(join(home, 'difit', 'scip-index', fixup, 'index.lookup.gz'))).toBe(true);
    });

    posixOnly(
      'answers from an indexed commit further down, and waits for a nearer one being built where that cannot answer',
      async () => {
        const gate = join(home, 'gate');
        cleanups.push(() => rmSync(gate, { force: true }));
        const fixed = fixupOfHead();
        const next = git('commit-tree', `${fixed}^{tree}`, '-p', head, '-m', 'next');
        const fixup = git('commit-tree', `${fixed}^{tree}`, '-p', next, '-m', 'fixup! next');
        writeFileSync(gate, '');
        const tool = fakeScipJava(gate);
        const { api, peek, settle, settleSymbolIndex } = await openReview();
        await settle();
        rmSync(gate);
        expect((await fetch(api(`/api/diff?base=${next}&target=${fixup}`))).ok).toBe(true);
        await settleSymbolIndex?.();
        expect((await peek({ ...FIND_BY_ID, ref: next })).body.index?.commit).toBe(next);
        await waitFor(async () => (tool.pids().length > 1 ? true : undefined));

        const unchanged = await peek({ ...RENAMED_CALLER, ref: fixup });

        expect(unchanged.body).toMatchObject({
          source: 'index',
          definitions: [{ path: SERVICE, line: 16 }],
          references: [{ path: SERVICE, line: 23 }],
        });
        expect(unchanged.body.index).toBeUndefined();
        const changed = await peek({ ...FIND_BY_ID, line: 19, ref: fixup });
        expect(changed.body.source).toBe('name');
        expect(changed.body.index?.commit).toBe(next);
        writeFileSync(gate, '');
      },
    );

    posixOnly('waits for a nearer commit whose build waits its turn', async () => {
      const gate = join(home, 'gate');
      cleanups.push(() => rmSync(gate, { force: true }));
      const fixed = fixupOfHead();
      const next = git('commit-tree', `${fixed}^{tree}`, '-p', head, '-m', 'next');
      const fixup = git('commit-tree', `${fixed}^{tree}`, '-p', next, '-m', 'fixup! next');
      const tool = fakeScipJava(gate);
      const { api, peek } = await openReview({ selection: createDiffSelection(base, head) });
      await waitFor(async () => (tool.pids().length > 0 ? true : undefined));
      expect((await fetch(api(`/api/diff?base=${next}&target=${fixup}`))).ok).toBe(true);
      const left = await peek({ ...FIND_BY_ID, ref: next });
      expect(left.body.index).toEqual({ commit: next, status: 'queued', after: head });

      const waiting = await peek({ ...RENAMED_CALLER, ref: fixup });

      expect(waiting.body.source).toBe('name');
      expect(waiting.body.index).toMatchObject({ commit: next, status: 'queued' });
      writeFileSync(gate, '');
    });

    posixOnly('builds a fixup commit that has no indexed commit under it', async () => {
      const fixup = fixupOfHead();
      const tool = fakeScipJava();
      const { settle } = await openReview({ selection: createDiffSelection(head, fixup) });

      await settle();

      expect(tool.pids()).toHaveLength(1);
      expect(existsSync(join(home, 'difit', 'scip-index', fixup, 'index.lookup.gz'))).toBe(true);
    });
  });

  it('builds nothing without scip-java, and says so', async () => {
    process.env.DIFIT_SCIP_JAVA = join(home, 'missing-scip-java');
    const { api, peek, settle } = await openReview();
    await settle();

    const { body } = await peek({ ...FIND_BY_ID, ref: head });

    expect(body.source).toBe('name');
    expect(body.index).toEqual({ commit: head, status: 'unavailable', reason: 'no-scip-java' });
    expect(existsSync(join(home, 'difit', 'scip-index', head))).toBe(false);
    expect((await fetch(api(`/api/symbol-index/${head}/log`))).status).toBe(404);
  });

  it('says nothing about an index in a repository it cannot index', async () => {
    process.env.DIFIT_SCIP_JAVA = join(home, 'missing-scip-java');
    const { peek, settle } = await openReview({ selection: createDiffSelection('HEAD', '.') });
    await settle();
    git('checkout', '-q', base);
    cleanups.push(() => {
      git('checkout', '-q', 'main');
    });

    for (const query of [
      { name: 'findById', ref: '.', from: 'README.md', line: 1, column: 5 },
      { ...FIND_BY_ID, ref: '.' },
      { name: 'findById', ref: base, from: 'README.md', line: 1, column: 5 },
    ]) {
      const { body } = await peek(query);
      expect(body.source).toBe('name');
      expect(body.index).toBeUndefined();
      expect(body.unindexed).toBeUndefined();
    }
  });

  posixOnly.each([
    ['HEAD', '.'],
    ['HEAD', 'staged'],
    ['staged', 'working'],
  ])('builds nothing for a review of %s against %s', async (from, target) => {
    const tool = fakeScipJava();
    const { peek, settle } = await openReview({ selection: createDiffSelection(from, target) });

    const { body } = await peek({ ...FIND_BY_ID, ref: target });
    await settle();

    expect(body.source).toBe('name');
    expect(body.index).toBeUndefined();
    expect(body.unindexed).toBe('not-commit');
    expect(tool.pids()).toEqual([]);
  });

  posixOnly('builds nothing for a review read from standard input', async () => {
    const tool = fakeScipJava();
    const { peek, settle } = await openReview({
      selection: undefined,
      stdinDiff: [
        'diff --git a/src/A.java b/src/A.java',
        '--- a/src/A.java',
        '+++ b/src/A.java',
        '@@ -1 +1 @@',
        '-class A {}',
        '+class B {}',
        '',
      ].join('\n'),
    });

    expect((await peek({ ...FIND_BY_ID, ref: head })).status).toBe(404);
    await settle();
    expect(tool.pids()).toEqual([]);
    expect(existsSync(join(home, 'difit', 'scip-index'))).toBe(false);
  });
});
