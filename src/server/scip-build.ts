import { type ChildProcess, spawn, spawnSync } from 'child_process';
import {
  access,
  chmod,
  constants,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'fs/promises';
import { join, resolve } from 'path';

import type {
  SymbolIndexFailure,
  SymbolIndexState,
  SymbolIndexUnavailableReason,
} from '../types/watch.js';

import { runGit } from './run-git.js';
import { type ScipIndex, convertScipIndex, readScipIndex, writeScipIndex } from './scip-index.js';
import { getDifitConfigDir, readScipIndexCacheLimitBytes } from './user-config.js';

// Builds a SCIP index of one commit with scip-java, outside the repository: the commit's
// tree is extracted with `git archive` into the cache, so the work tree, index, refs and
// worktree list are never touched.

export type ScipBuildState =
  | Exclude<SymbolIndexState, { status: 'failed' }>
  | {
      status: 'failed';
      reason: SymbolIndexFailure;
      exitCode?: number | null;
      detail: string;
      logPath: string | null;
    };

interface ScipIndexBuilderOptions {
  repoPath: string;
  // Where scip-java is looked up; defaults to process.env.
  env?: NodeJS.ProcessEnv;
  // Defaults to <DIFIT_CONFIG_DIR or ~/.difit>/scip-index.
  cacheRoot?: string;
  timeoutMs?: number;
  // Compact indexes kept in memory for lookups.
  maxLoaded?: number;
  // Read at every cleanup; defaults to the limit in the difit config file.
  cacheLimitBytes?: () => Promise<number>;
  // Commits whose indexes a cleanup keeps even over the limit.
  inUse?: () => Promise<Iterable<string>>;
}

const COMPACT_FILE = 'index.lookup.v2.gz';
// Versions of difit before format 2 keep reading and writing this file, so it is never removed
// for being older; it answers until the commit is indexed again.
const FORMAT_1_FILE = 'index.lookup.gz';
const LOG_FILE = 'build.log';
const LOG_TAIL_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_LOADED = 2;
const KILL_GRACE_MS = 2000;
// Signals that end difit without its 'exit' event; children in their own process group
// never receive them.
const ENDING_SIGNALS = ['SIGTERM', 'SIGHUP'] as const;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const WORK_DIR = /^work-(\d+)-/;
const TEMP_FILE = /\.(\d+)\.tmp$/;
// Printed by scip-java when the commit has no gradlew and no gradle is on PATH.
const NO_GRADLE = /Cannot run program "gradle"/;
const ROOT_BUILD_FILES = new Set([
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'pom.xml',
]);

export function scipIndexCacheRoot(): string {
  return join(getDifitConfigDir(), 'scip-index');
}

async function isExecutableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (platform !== 'win32') await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return env[name] ?? '';
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key ? (env[key] ?? '') : '';
}

// DIFIT_SCIP_JAVA (a path to the executable) first, then PATH.
export async function findScipJava(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const configured = env.DIFIT_SCIP_JAVA?.trim();
  if (configured && (await isExecutableFile(configured, platform))) return resolve(configured);

  const names =
    platform === 'win32'
      ? (envValue(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
          .map((ext) => `scip-java${ext.toLowerCase()}`)
      : ['scip-java'];
  const dirs = envValue(env, 'PATH', platform).split(platform === 'win32' ? ';' : ':');
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (await isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

export type Indexability = 'indexable' | Exclude<SymbolIndexUnavailableReason, 'no-scip-java'>;

export async function commitIndexability(repoPath: string, sha: string): Promise<Indexability> {
  const listing = await runGit(repoPath, ['ls-tree', '-r', '--name-only', '-z', sha]);
  if (listing.code !== 0) return 'no-java';
  let hasJava = false;
  let hasBuildFile = false;
  for (const path of listing.stdout.toString('utf8').split('\0')) {
    if (path.endsWith('.java')) hasJava = true;
    else if (ROOT_BUILD_FILES.has(path)) hasBuildFile = true;
    if (hasJava && hasBuildFile) return 'indexable';
  }
  return hasJava ? 'no-build-file' : 'no-java';
}

const ESC = '\u001b';
const BEL = '\u0007';
// CSI sequences (colors, cursor moves), OSC sequences (titles, links) and two-byte escapes.
const ANSI_ESCAPE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|[0-~])`,
  'g',
);

// Of a line that carriage returns overwrote, keeps what a terminal would show.
export function plainLogText(text: string): string {
  return text
    .replace(ANSI_ESCAPE, '')
    .split('\n')
    .map((line) => {
      const shown = line.replace(/\r+$/, '');
      return shown.slice(shown.lastIndexOf('\r') + 1);
    })
    .join('\n');
}

export async function readBuildLog(path: string): Promise<string> {
  return plainLogText((await readFile(path)).toString('utf8'));
}

export function indexStateForClient(state: ScipBuildState): SymbolIndexState {
  if (state.status !== 'failed') return state;
  const { logPath, ...rest } = state;
  return { ...rest, hasLog: logPath !== null };
}

interface SpawnSpec {
  command: string;
  args: string[];
  shell: boolean;
}

// Node refuses to spawn .bat/.cmd files without a shell on Windows.
export function toolSpawnSpec(tool: string, args: string[], platform: NodeJS.Platform): SpawnSpec {
  if (platform === 'win32' && /\.(?:bat|cmd)$/i.test(tool)) {
    return { command: [tool, ...args].map((part) => `"${part}"`).join(' '), args: [], shell: true };
  }
  return { command: tool, args, shell: false };
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

// Children are spawned in their own process group on POSIX, so the whole group goes,
// including Gradle and the compiler JVMs scip-java starts.
async function killProcessTree(child: ChildProcess, platform: NodeJS.Platform): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === 'win32') {
    if (hasExited(child)) return;
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => resolvePromise());
      killer.once('close', () => resolvePromise());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  await waitForExit(child, KILL_GRACE_MS);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone.
  }
}

function killProcessTreeNow(child: ChildProcess, platform: NodeJS.Platform): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === 'win32') {
    if (!hasExited(child)) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// The failed `rm` before this may still be removing entries, so missing ones are skipped.
async function makeWritable(dir: string): Promise<void> {
  try {
    await chmod(dir, 0o700);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeWritable(join(dir, entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

// Build outputs may include read-only directories, which `rm` alone cannot empty on POSIX.
// A tree that still cannot be removed is left for the sweep of a later run.
async function removeTree(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    return;
  } catch {
    // Retried below once the tree is writable.
  }
  try {
    await makeWritable(dir);
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
}

export interface CacheEntry {
  sha: string;
  bytes: number;
  lastUsedMs: number;
}

// Least recently used first, until the rest fits under the limit. Kept entries still count
// toward the limit.
export function selectEvictions(
  entries: readonly CacheEntry[],
  limitBytes: number,
  keep: ReadonlySet<string>,
): string[] {
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const evicted: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.lastUsedMs - b.lastUsedMs)) {
    if (total <= limitBytes) break;
    if (keep.has(entry.sha)) continue;
    evicted.push(entry.sha);
    total -= entry.bytes;
  }
  return evicted;
}

interface StoredEntry extends CacheEntry {
  files: string[];
  building: boolean;
}

class BuildError extends Error {
  constructor(
    readonly reason: SymbolIndexFailure,
    message: string,
    readonly exitCode?: number | null,
  ) {
    super(message);
  }
}

interface StoredIndex {
  // Null when the file is damaged or of a format this version does not read.
  index: ScipIndex | null;
  path: string;
}

interface QueuedBuild {
  sha: string;
  run: () => Promise<void>;
  // A commit indexed again while its older index keeps answering; its state stays `ready`.
  quiet: boolean;
}

export interface IndexRequestOptions {
  // Built ahead of queued builds nobody asked for.
  urgent?: boolean;
}

export class ScipIndexBuilder {
  private readonly repoPath: string;
  private readonly cacheRoot: string;
  private readonly timeoutMs: number;
  private readonly maxLoaded: number;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cacheLimitBytes: () => Promise<number>;
  private readonly inUse: () => Promise<Iterable<string>>;
  private readonly states = new Map<string, ScipBuildState>();
  private readonly jobs = new Map<string, Promise<ScipBuildState>>();
  private readonly loaded = new Map<string, ScipIndex>();
  private readonly loading = new Map<string, Promise<StoredIndex | null>>();
  private readonly listeners = new Set<(sha: string, state: ScipBuildState) => void>();
  private readonly requestedSinceTrimStarted = new Set<string>();
  private readonly children = new Set<ChildProcess>();
  private readonly abort = new AbortController();
  private tool: Promise<string | null> | null = null;
  private readonly waiting: QueuedBuild[] = [];
  private readonly urgent = new Set<string>();
  private readonly indexability = new Map<string, Promise<Indexability>>();
  private readonly reindexed = new Set<string>();
  private building: Promise<void> | null = null;
  private runningSha: string | null = null;
  private stopping: Promise<void> | null = null;
  private sweep: Promise<void> | null = null;
  private trimming: Promise<void> = Promise.resolve();
  private hooked = false;
  private readonly killOnExit = () => {
    for (const child of this.children) killProcessTreeNow(child, this.platform);
  };
  private readonly killOnSignal = (signal: NodeJS.Signals) => {
    this.killOnExit();
    this.unhookProcess();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };

  constructor(options: ScipIndexBuilderOptions) {
    this.repoPath = options.repoPath;
    this.cacheRoot = options.cacheRoot ?? scipIndexCacheRoot();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxLoaded = options.maxLoaded ?? DEFAULT_MAX_LOADED;
    this.platform = process.platform;
    this.env = options.env ?? process.env;
    this.cacheLimitBytes = options.cacheLimitBytes ?? (() => readScipIndexCacheLimitBytes());
    this.inUse = options.inUse ?? (() => Promise.resolve([]));
  }

  state(sha: string): ScipBuildState {
    return this.states.get(sha) ?? { status: 'none' };
  }

  onChange(listener: (sha: string, state: ScipBuildState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Starts indexing a full commit sha unless it is already indexed, and settles with the
  // final state. Builds run one at a time.
  async request(sha: string, options: IndexRequestOptions = {}): Promise<ScipBuildState> {
    this.requestedSinceTrimStarted.add(sha);
    if (options.urgent) this.markUrgent(sha);
    let job = this.jobs.get(sha);
    if (!job) {
      job = this.run(sha);
      this.jobs.set(sha, job);
    }
    const state = await job;
    this.urgent.delete(sha);
    if (state.status === 'ready') {
      await this.markUsed(sha);
      await this.trimCache(sha);
    }
    return state;
  }

  start(sha: string, options: IndexRequestOptions = {}): Promise<ScipBuildState> {
    if (options.urgent) this.hurry(sha);
    const current = this.state(sha);
    if (['queued', 'building', 'ready'].includes(current.status)) return Promise.resolve(current);
    return new Promise((resolvePromise) => {
      const settle = (state: ScipBuildState) => {
        stopListening();
        resolvePromise(state);
      };
      const stopListening = this.onChange((changed, state) => {
        if (changed === sha) settle(state);
      });
      this.request(sha, options).then(settle, () => settle(this.state(sha)));
    });
  }

  indexable(sha: string): Promise<Indexability> {
    let known = this.indexability.get(sha);
    if (!known) {
      known = commitIndexability(this.repoPath, sha);
      if (FULL_SHA.test(sha)) this.indexability.set(sha, known);
    }
    return known;
  }

  async useStored(sha: string): Promise<boolean> {
    if (this.state(sha).status === 'ready') {
      this.requestedSinceTrimStarted.add(sha);
      return true;
    }
    if (!FULL_SHA.test(sha) || this.jobs.has(sha)) return false;
    const ready = await this.storedState(sha);
    if (!ready || this.jobs.has(sha)) return false;
    this.requestedSinceTrimStarted.add(sha);
    this.jobs.set(sha, Promise.resolve(ready));
    this.setState(sha, ready);
    return true;
  }

  hurry(sha: string): void {
    const { status } = this.state(sha);
    if (status === 'queued' || status === 'building') this.markUrgent(sha);
  }

  // The commit's index once it is ready, or null.
  async getIndex(sha: string): Promise<ScipIndex | null> {
    const cached = this.loaded.get(sha);
    if (cached) {
      this.remember(sha, cached);
      void this.markUsed(sha);
      if (!cached.knowsRelations) this.reindex(sha);
      return cached;
    }
    if (this.state(sha).status !== 'ready') return null;
    let stored = await this.load(sha);
    const state = this.state(sha);
    if (
      stored?.index?.knowsRelations === false &&
      state.status === 'ready' &&
      !state.withoutRelations
    ) {
      stored = await this.load(sha);
    }
    const index = stored?.index ?? null;
    if (index) {
      if (this.state(sha).status === 'ready') {
        this.remember(sha, index);
        void this.markUsed(sha);
        if (!index.knowsRelations) this.reindex(sha);
      }
    } else if (this.state(sha).status === 'ready') {
      // Removed or damaged on disk; a later request builds it again.
      if (stored) await rm(stored.path, { force: true });
      this.jobs.delete(sha);
      this.setState(sha, { status: 'none' });
    }
    return index;
  }

  private load(sha: string): Promise<StoredIndex | null> {
    let load = this.loading.get(sha);
    if (!load) {
      load = this.readStored(sha).finally(() => this.loading.delete(sha));
      this.loading.set(sha, load);
    }
    return load;
  }

  // An index stored without implementations and callers keeps answering while the commit is
  // indexed again behind the other builds; listeners hear `ready` once the new one is in place.
  // A failure leaves the older index and is not retried in this run.
  private reindex(sha: string): void {
    if (this.reindexed.has(sha) || this.abort.signal.aborted) return;
    this.reindexed.add(sha);
    void (async () => {
      this.tool ??= findScipJava(this.env, this.platform);
      const tool = await this.tool;
      if (!tool || this.abort.signal.aborted) return;
      const result = await this.enqueue(
        sha,
        async () => {
          // Removed from the cache, or built again by a request, while this waited.
          const state = this.state(sha);
          if (state.status !== 'ready' || !state.withoutRelations) return { status: 'none' };
          return this.build(sha, tool, { replace: true });
        },
        { quiet: true },
      );
      if (result.status !== 'ready') return;
      this.loaded.delete(sha);
      if (this.state(sha).status !== 'ready') return;
      const ready: ScipBuildState = { status: 'ready' };
      this.jobs.set(sha, Promise.resolve(ready));
      this.setState(sha, ready);
      await this.trimCache(sha);
    })().catch((error: unknown) => {
      console.error('Error indexing a commit again:', error);
    });
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.abort.abort();
      await Promise.all([...this.children].map((child) => killProcessTree(child, this.platform)));
      await Promise.all([this.building, this.sweep, this.trimming]);
      this.unhookProcess();
    })();
    return this.stopping;
  }

  private hookProcess(): void {
    if (this.hooked) return;
    this.hooked = true;
    process.on('exit', this.killOnExit);
    for (const signal of ENDING_SIGNALS) process.on(signal, this.killOnSignal);
  }

  private unhookProcess(): void {
    if (!this.hooked) return;
    this.hooked = false;
    process.off('exit', this.killOnExit);
    for (const signal of ENDING_SIGNALS) process.off(signal, this.killOnSignal);
  }

  private compactPath(sha: string): string {
    return join(this.cacheRoot, sha, COMPACT_FILE);
  }

  private format1Path(sha: string): string {
    return join(this.cacheRoot, sha, FORMAT_1_FILE);
  }

  private async storedState(sha: string): Promise<ScipBuildState | null> {
    if (await this.exists(this.compactPath(sha))) return { status: 'ready' };
    if (await this.exists(this.format1Path(sha)))
      return { status: 'ready', withoutRelations: true };
    return null;
  }

  private async readStored(sha: string): Promise<StoredIndex | null> {
    for (const path of [this.compactPath(sha), this.format1Path(sha)]) {
      if (await this.exists(path)) return { index: await readScipIndex(path), path };
    }
    return null;
  }

  private setState(sha: string, state: ScipBuildState): void {
    this.states.set(sha, state);
    for (const listener of this.listeners) listener(sha, state);
  }

  private remember(sha: string, index: ScipIndex): void {
    this.loaded.delete(sha);
    this.loaded.set(sha, index);
    for (const oldest of this.loaded.keys()) {
      if (this.loaded.size <= this.maxLoaded) break;
      this.loaded.delete(oldest);
    }
  }

  // Access times are not kept reliably (relatime, noatime), so use is recorded as the index
  // file's modification time.
  private async markUsed(sha: string): Promise<void> {
    const now = new Date();
    for (const path of [this.compactPath(sha), this.format1Path(sha)]) {
      try {
        await utimes(path, now, now);
      } catch {}
    }
  }

  private trimCache(requested: string): Promise<void> {
    const run = this.trimming.then(() => this.evictOverLimit(requested));
    this.trimming = run.catch(() => undefined);
    return run;
  }

  private async evictOverLimit(requested: string): Promise<void> {
    if (this.abort.signal.aborted) return;
    this.requestedSinceTrimStarted.clear();
    let limit: number;
    const keep = new Set([requested]);
    try {
      limit = await this.cacheLimitBytes();
      for (const sha of await this.inUse()) keep.add(sha);
    } catch (error) {
      console.error('Error reading what the symbol index cache must keep:', error);
      return;
    }
    for (const [sha, state] of this.states) {
      if (state.status === 'building' || state.status === 'queued') keep.add(sha);
    }
    const entries = await this.storedEntries();
    for (const entry of entries) {
      if (entry.building) keep.add(entry.sha);
    }
    const bySha = new Map(entries.map((entry) => [entry.sha, entry]));
    for (const sha of selectEvictions(entries, limit, keep)) {
      const entry = bySha.get(sha);
      if (entry && (await this.stillUnused(sha))) await this.evict(entry);
    }
  }

  private async stillUnused(sha: string): Promise<boolean> {
    let shown: Iterable<string>;
    try {
      shown = await this.inUse();
    } catch {
      return false;
    }
    return !new Set(shown).has(sha) && !this.requestedSinceTrimStarted.has(sha);
  }

  // Each commit directory counts with its finished files; work trees and half-written files
  // belong to builds in progress.
  private async storedEntries(): Promise<StoredEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.cacheRoot);
    } catch {
      return [];
    }
    const entries: StoredEntry[] = [];
    for (const sha of names) {
      if (!FULL_SHA.test(sha)) continue;
      const dir = join(this.cacheRoot, sha);
      let children;
      try {
        children = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const entry: StoredEntry = { sha, bytes: 0, lastUsedMs: 0, files: [], building: false };
      for (const child of children) {
        const pid = Number(WORK_DIR.exec(child.name)?.[1] ?? NaN);
        if (child.isDirectory() && !Number.isNaN(pid) && isProcessAlive(pid)) {
          entry.building = true;
        }
        if (!child.isFile() || TEMP_FILE.test(child.name)) continue;
        try {
          const info = await stat(join(dir, child.name));
          entry.bytes += info.size;
          entry.lastUsedMs = Math.max(entry.lastUsedMs, info.mtimeMs);
          entry.files.push(join(dir, child.name));
        } catch {}
      }
      if (entry.files.length > 0) entries.push(entry);
    }
    return entries;
  }

  // Only the finished files go, so a build of the same commit by another difit process keeps
  // its work tree.
  private async evict(entry: StoredEntry): Promise<void> {
    const job = this.jobs.get(entry.sha);
    let removedAll = true;
    for (const file of entry.files) {
      try {
        await rm(file, { force: true });
      } catch {
        removedAll = false;
      }
    }
    // A failed build is not retried within this run, even once its log is gone.
    const status = this.state(entry.sha).status;
    if (!removedAll || ['failed', 'building', 'queued'].includes(status)) return;
    if (status === 'ready' || this.jobs.get(entry.sha) === job) this.jobs.delete(entry.sha);
    this.loaded.delete(entry.sha);
    if (status !== 'none') this.setState(entry.sha, { status: 'none' });
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private async run(sha: string): Promise<ScipBuildState> {
    try {
      return await this.prepareAndBuild(sha);
    } catch (error) {
      const detail = `index build failed: ${error instanceof Error ? error.message : String(error)}`;
      const state: ScipBuildState = this.abort.signal.aborted
        ? { status: 'none' }
        : { status: 'failed', reason: 'error', detail, logPath: null };
      this.setState(sha, state);
      return state;
    }
  }

  private async prepareAndBuild(sha: string): Promise<ScipBuildState> {
    if (!FULL_SHA.test(sha) || this.abort.signal.aborted) return { status: 'none' };
    this.sweep ??= this.sweepStaleWork();
    const stored = await this.storedState(sha);
    if (stored) {
      this.setState(sha, stored);
      return stored;
    }
    const indexability = await this.indexable(sha);
    if (this.abort.signal.aborted) return { status: 'none' };
    if (indexability !== 'indexable') return this.unavailable(sha, indexability);
    this.tool ??= findScipJava(this.env, this.platform);
    const tool = await this.tool;
    if (this.abort.signal.aborted) return { status: 'none' };
    if (!tool) return this.unavailable(sha, 'no-scip-java');

    const result = await this.enqueue(sha, () => this.build(sha, tool));
    this.setState(sha, result);
    return result;
  }

  private unavailable(sha: string, reason: SymbolIndexUnavailableReason): ScipBuildState {
    this.setState(sha, { status: 'unavailable', reason });
    return this.state(sha);
  }

  private enqueue(
    sha: string,
    build: () => Promise<ScipBuildState>,
    { quiet = false }: { quiet?: boolean } = {},
  ): Promise<ScipBuildState> {
    return new Promise((resolvePromise, reject) => {
      const queued: QueuedBuild = {
        sha,
        quiet,
        run: () => {
          this.runningSha = sha;
          if (!quiet) this.setState(sha, { status: 'building', startedAt: Date.now() });
          return build().then(resolvePromise, reject);
        },
      };
      const firstQuiet = this.waiting.findIndex((waiting) => waiting.quiet);
      if (this.urgent.has(sha)) this.waiting.splice(this.urgentCount(), 0, queued);
      else if (!quiet && firstQuiet !== -1) this.waiting.splice(firstQuiet, 0, queued);
      else this.waiting.push(queued);
      this.building ??= this.drain();
      this.announceQueue();
    });
  }

  private async drain(): Promise<void> {
    for (let next = this.waiting.shift(); next; next = this.waiting.shift()) await next.run();
    this.building = null;
    this.runningSha = null;
  }

  private announceQueue(): void {
    let ahead = this.runningSha;
    for (const { sha, quiet } of this.waiting) {
      const current = this.state(sha);
      if (!quiet && ahead && (current.status !== 'queued' || current.after !== ahead)) {
        this.setState(sha, { status: 'queued', after: ahead });
      }
      ahead = sha;
    }
  }

  private urgentCount(): number {
    const index = this.waiting.findIndex((queued) => !this.urgent.has(queued.sha));
    return index === -1 ? this.waiting.length : index;
  }

  private markUrgent(sha: string): void {
    if (this.urgent.has(sha)) return;
    const at = this.waiting.findIndex((queued) => queued.sha === sha);
    const [queued] = at === -1 ? [] : this.waiting.splice(at, 1);
    if (queued) this.waiting.splice(this.urgentCount(), 0, queued);
    this.urgent.add(sha);
    if (queued) this.announceQueue();
  }

  private async build(
    sha: string,
    tool: string,
    { replace = false }: { replace?: boolean } = {},
  ): Promise<ScipBuildState> {
    const dir = join(this.cacheRoot, sha);
    const compactPath = this.compactPath(sha);
    const logPath = join(dir, LOG_FILE);
    // Another difit process may have finished this commit while this one waited.
    const stored = replace ? null : await this.storedState(sha);
    if (stored) return stored;
    if (this.abort.signal.aborted) return { status: 'none' };

    let work: string | null = null;
    let indexStarted = false;
    try {
      await mkdir(dir, { recursive: true });
      work = await mkdtemp(join(dir, `work-${process.pid}-`));
      await this.extract(sha, work);
      await this.endChildren();
      const rawPath = join(work, 'index.scip');
      indexStarted = true;
      await this.index(tool, work, rawPath, logPath);
      await this.endChildren();
      if (!(await this.exists(rawPath))) {
        throw new BuildError('no-output', 'scip-java wrote no index.scip');
      }
      const index = await convertScipIndex(rawPath, { signal: this.abort.signal });
      await writeScipIndex(index, compactPath);
      this.remember(sha, index);
      await rm(logPath, { force: true });
      return { status: 'ready' };
    } catch (error) {
      if (this.abort.signal.aborted) return { status: 'none' };
      const failure =
        error instanceof BuildError
          ? error
          : new BuildError(
              'error',
              `index build failed: ${error instanceof Error ? error.message : String(error)}`,
            );
      const kept = indexStarted ? await this.keepLogTail(logPath, failure.message) : null;
      const reason =
        failure.reason === 'exit-code' && kept && NO_GRADLE.test(kept.tail)
          ? 'no-gradle'
          : failure.reason;
      return {
        status: 'failed',
        reason,
        ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
        detail: failure.message,
        logPath: kept?.path ?? null,
      };
    } finally {
      await this.endChildren();
      if (work) await removeTree(work);
    }
  }

  // Work directories and half-written indexes of difit processes that ended without cleaning
  // up after themselves.
  private async sweepStaleWork(): Promise<void> {
    let commits: string[];
    try {
      commits = await readdir(this.cacheRoot);
    } catch {
      return;
    }
    for (const commit of commits) {
      let entries: string[];
      try {
        entries = await readdir(join(this.cacheRoot, commit));
      } catch {
        continue;
      }
      for (const name of entries) {
        const pid = Number((WORK_DIR.exec(name) ?? TEMP_FILE.exec(name))?.[1] ?? NaN);
        if (Number.isNaN(pid) || pid === process.pid || isProcessAlive(pid)) continue;
        await removeTree(join(this.cacheRoot, commit, name));
      }
    }
  }

  private track(child: ChildProcess): void {
    this.children.add(child);
    this.hookProcess();
    // stop() may have run between the check before spawning and this call.
    if (this.abort.signal.aborted) void killProcessTree(child, this.platform);
  }

  private async endChildren(): Promise<void> {
    const children = [...this.children];
    await Promise.all(children.map((child) => killProcessTree(child, this.platform)));
    for (const child of children) this.children.delete(child);
    if (this.children.size === 0) this.unhookProcess();
  }

  private extract(sha: string, work: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const detached = this.platform !== 'win32';
      const git = spawn('git', ['archive', '--format=tar', sha], {
        cwd: this.repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      const tar = spawn('tar', ['-x', '-f', '-', '-C', work], {
        stdio: ['pipe', 'ignore', 'pipe'],
        detached,
        windowsHide: true,
      });
      this.track(git);
      this.track(tar);
      const errors: string[] = [];
      const collect = (chunk: Buffer) => {
        if (errors.join('').length < 4096) errors.push(chunk.toString('utf8'));
      };
      git.stderr.on('data', collect);
      tar.stderr.on('data', collect);
      tar.stdin.on('error', () => {});
      git.stdout.pipe(tar.stdin);

      let pending = 2;
      let failure: string | null = null;
      const settle = (name: string, code: number | null, error?: Error) => {
        const failed = failure !== null;
        if (error) failure ??= `${name} could not start: ${error.message}`;
        else if (code !== 0) failure ??= `${name} exited with code ${code}`;
        // Once tar is gone nothing reads git's output, so git would block on its next write.
        if (!failed && failure && pending > 1) {
          for (const child of [git, tar]) void killProcessTree(child, this.platform);
        }
        if (--pending > 0) return;
        if (failure) {
          const detail = errors.join('').trim().split('\n').slice(-3).join(' ');
          reject(new BuildError('error', detail ? `${failure}: ${detail}` : failure));
        } else {
          resolvePromise();
        }
      };
      for (const [name, child] of [
        ['git archive', git],
        ['tar', tar],
      ] as const) {
        let done = false;
        child.once('error', (error) => {
          if (done) return;
          done = true;
          settle(name, null, error);
        });
        child.once('close', (code) => {
          if (done) return;
          done = true;
          settle(name, code);
        });
      }
    });
  }

  private async index(tool: string, work: string, rawPath: string, logPath: string): Promise<void> {
    if (this.abort.signal.aborted) throw new BuildError('error', 'stopped');
    const log = await open(logPath, 'w');
    try {
      const spec = toolSpawnSpec(tool, ['index', '--output', rawPath], this.platform);
      const outcome = await new Promise<{ code: number | null; error?: Error; timedOut: boolean }>(
        (resolvePromise) => {
          const child = spawn(spec.command, spec.args, {
            cwd: work,
            stdio: ['ignore', log.fd, log.fd],
            shell: spec.shell,
            detached: this.platform !== 'win32',
            windowsHide: true,
          });
          this.track(child);
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            void killProcessTree(child, this.platform);
          }, this.timeoutMs);
          child.once('error', (error) => {
            clearTimeout(timer);
            resolvePromise({ code: null, error, timedOut });
          });
          child.once('close', (code) => {
            clearTimeout(timer);
            resolvePromise({ code, timedOut });
          });
        },
      );
      if (outcome.error) {
        throw new BuildError('error', `scip-java could not start: ${outcome.error.message}`);
      }
      if (outcome.timedOut) throw new BuildError('timeout', 'scip-java timed out');
      if (outcome.code !== 0) {
        throw new BuildError(
          'exit-code',
          `scip-java exited with code ${outcome.code ?? 'null'}`,
          outcome.code,
        );
      }
    } finally {
      await log.close();
    }
  }

  private async keepLogTail(
    logPath: string,
    reason: string,
  ): Promise<{ path: string; tail: string } | null> {
    try {
      let log: Buffer = Buffer.alloc(0);
      try {
        log = await readFile(logPath);
      } catch {}
      const tail = log.subarray(Math.max(0, log.length - LOG_TAIL_BYTES));
      await writeFile(logPath, Buffer.concat([tail, Buffer.from(`\n[difit] ${reason}\n`)]));
      return { path: logPath, tail: tail.toString('utf8') };
    } catch {
      return null;
    }
  }
}
