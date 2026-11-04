import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { setTimeout as delay } from 'timers/promises';

import type { SharedViewedRecord, ViewedHashIndexEntry, ViewedHashRemoval } from '../types/diff.js';
import {
  isMarkedAfterUnmark,
  MAX_VIEWED_INDEX_ENTRIES,
  viewedEntryKey,
} from '../utils/viewedRecord.js';

import { getDifitConfigDir, isPlainObject } from './user-config.js';

export type ViewedRecordUpdate = Pick<SharedViewedRecord, 'entries' | 'removed'>;

const REPOSITORY_ID_PATTERN = /^[0-9a-f]{64}$/;
const LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 10_000;

export function getViewedRecordPath(repositoryId: string): string | null {
  return REPOSITORY_ID_PATTERN.test(repositoryId)
    ? join(getDifitConfigDir(), 'viewed', `${repositoryId}.json`)
    : null;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function hasFileAndHash(
  value: unknown,
): value is Record<string, unknown> & { filePath: string; diffContentHash: string } {
  return (
    isPlainObject(value) &&
    typeof value.filePath === 'string' &&
    value.filePath !== '' &&
    typeof value.diffContentHash === 'string' &&
    value.diffContentHash !== ''
  );
}

function toEntries(items: unknown[]): ViewedHashIndexEntry[] {
  return items.flatMap((item) => {
    if (!hasFileAndHash(item) || item.hashVersion !== 1 || !isIsoDate(item.viewedAt)) return [];
    const { filePath, diffContentHash, viewedAt } = item;
    return [{ filePath, diffContentHash, hashVersion: 1 as const, viewedAt }];
  });
}

function toRemovals(items: unknown[]): ViewedHashRemoval[] {
  return items.flatMap((item) => {
    if (!hasFileAndHash(item) || !isIsoDate(item.removedAt)) return [];
    const { filePath, diffContentHash, removedAt } = item;
    return [{ filePath, diffContentHash, removedAt }];
  });
}

export function parseViewedRecordUpdate(body: unknown): ViewedRecordUpdate | null {
  if (!isPlainObject(body) || !Array.isArray(body.entries) || !Array.isArray(body.removed)) {
    return null;
  }
  return { entries: toEntries(body.entries), removed: toRemovals(body.removed) };
}

const emptyRecord = (): SharedViewedRecord => ({
  version: 1,
  lastModifiedAt: new Date(0).toISOString(),
  entries: [],
  removed: [],
});

// A merge overwrites what this returns, so only a missing or corrupt file reads as empty.
export async function readViewedRecord(path: string): Promise<SharedViewedRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path, 'utf-8'));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyRecord();
    }
    throw error;
  }
  if (!isPlainObject(parsed)) return emptyRecord();
  if (typeof parsed.version === 'number' && parsed.version !== 1) {
    throw new Error(`Unsupported viewed record version in ${path}`);
  }
  const update = parseViewedRecordUpdate(parsed);
  if (parsed.version !== 1 || !update) return emptyRecord();
  return {
    version: 1,
    lastModifiedAt: isIsoDate(parsed.lastModifiedAt)
      ? parsed.lastModifiedAt
      : new Date(0).toISOString(),
    ...update,
  };
}

function newest<T>(items: T[], timeOf: (item: T) => number): T[] {
  if (items.length <= MAX_VIEWED_INDEX_ENTRIES) return items;
  return [...items].sort((a, b) => timeOf(b) - timeOf(a)).slice(0, MAX_VIEWED_INDEX_ENTRIES);
}

const viewedTime = (entry: ViewedHashIndexEntry) => Date.parse(entry.viewedAt);
const removedTime = (removal: ViewedHashRemoval) => Date.parse(removal.removedAt);

function applyUpdate(current: ViewedRecordUpdate, update: ViewedRecordUpdate): ViewedRecordUpdate {
  const entries = new Map(current.entries.map((entry) => [viewedEntryKey(entry), entry]));
  const removed = new Map(current.removed.map((removal) => [viewedEntryKey(removal), removal]));

  for (const entry of update.entries) {
    const key = viewedEntryKey(entry);
    const removal = removed.get(key);
    if (removal && !isMarkedAfterUnmark(entry.viewedAt, removal.removedAt)) continue;
    removed.delete(key);
    const known = entries.get(key);
    if (!known || viewedTime(known) < viewedTime(entry)) entries.set(key, entry);
  }
  for (const removal of update.removed) {
    const key = viewedEntryKey(removal);
    const entry = entries.get(key);
    if (entry && isMarkedAfterUnmark(entry.viewedAt, removal.removedAt)) continue;
    entries.delete(key);
    const known = removed.get(key);
    if (!known || removedTime(known) < removedTime(removal)) removed.set(key, removal);
  }

  return {
    entries: newest([...entries.values()], viewedTime),
    removed: newest([...removed.values()], removedTime),
  };
}

async function removeLockIfStale(lockPath: string): Promise<void> {
  try {
    const { mtimeMs } = await fs.stat(lockPath);
    if (Date.now() - mtimeMs > LOCK_STALE_MS) await fs.rm(lockPath, { force: true });
  } catch {}
}

async function withRecordLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await fs.open(lockPath, 'wx', 0o600)).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockPath}`);
    await removeLockIfStale(lockPath);
    await delay(LOCK_RETRY_MS);
  }
  try {
    return await work();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}

export async function mergeViewedRecord(
  path: string,
  update: ViewedRecordUpdate,
): Promise<SharedViewedRecord> {
  if (update.entries.length === 0 && update.removed.length === 0) {
    return readViewedRecord(path);
  }
  return withRecordLock(path, async () => {
    const current = await readViewedRecord(path);
    const merged = applyUpdate(current, update);
    if (
      JSON.stringify([merged.entries, merged.removed]) ===
      JSON.stringify([current.entries, current.removed])
    ) {
      return current;
    }

    const next: SharedViewedRecord = {
      version: 1,
      lastModifiedAt: new Date().toISOString(),
      ...merged,
    };
    const tmpPath = `${path}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(next), { encoding: 'utf-8', mode: 0o600 });
      await fs.rename(tmpPath, path);
    } catch (error) {
      await fs.rm(tmpPath, { force: true });
      throw error;
    }
    return next;
  });
}

export async function clearViewedRecord(path: string): Promise<void> {
  await withRecordLock(path, () => fs.rm(path, { force: true }));
}
