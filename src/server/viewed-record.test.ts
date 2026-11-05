import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ViewedHashIndexEntry, ViewedHashRemoval } from '../types/diff.js';

import {
  clearViewedRecord,
  getViewedRecordPath,
  mergeViewedRecord,
  parseViewedRecordUpdate,
  readViewedRecord,
} from './viewed-record.js';

const REPOSITORY_ID = 'a'.repeat(64);

function viewed(filePath: string, viewedAt: string, diffContentHash = 'h1'): ViewedHashIndexEntry {
  return { filePath, diffContentHash, hashVersion: 1, viewedAt };
}

function removed(filePath: string, removedAt: string, diffContentHash = 'h1'): ViewedHashRemoval {
  return { filePath, diffContentHash, removedAt };
}

describe('viewed-record', () => {
  let configDir: string;
  let recordPath: string;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(join(tmpdir(), 'difit-viewed-record-'));
    recordPath = join(configDir, 'viewed', `${REPOSITORY_ID}.json`);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  describe('getViewedRecordPath', () => {
    it('places the record under the config directory', () => {
      vi.stubEnv('DIFIT_CONFIG_DIR', configDir);
      expect(getViewedRecordPath(REPOSITORY_ID)).toBe(recordPath);
    });

    it('defaults to ~/.difit/viewed', () => {
      vi.stubEnv('DIFIT_CONFIG_DIR', '');
      expect(getViewedRecordPath(REPOSITORY_ID)).toBe(
        join(homedir(), '.difit', 'viewed', `${REPOSITORY_ID}.json`),
      );
    });

    it.each([
      ['parent traversal', '../../etc/passwd'],
      ['traversal padded to the right length', `../${'a'.repeat(61)}`],
      ['path separator', `${'a'.repeat(32)}/${'a'.repeat(31)}`],
      ['too short', 'abc123'],
      ['uppercase hex', 'A'.repeat(64)],
      ['trailing newline', `${REPOSITORY_ID}\n`],
      ['empty', ''],
    ])('rejects %s', (_name, repositoryId) => {
      expect(getViewedRecordPath(repositoryId)).toBeNull();
    });
  });

  describe('parseViewedRecordUpdate', () => {
    it('rejects a body without both lists', () => {
      expect(parseViewedRecordUpdate(null)).toBeNull();
      expect(parseViewedRecordUpdate('text')).toBeNull();
      expect(parseViewedRecordUpdate({ entries: [] })).toBeNull();
      expect(parseViewedRecordUpdate({ entries: {}, removed: [] })).toBeNull();
    });

    it('drops malformed items and keeps the rest', () => {
      const good = viewed('a.txt', '2026-01-01T00:00:00.000Z');
      expect(
        parseViewedRecordUpdate({
          entries: [
            good,
            { ...good, hashVersion: 2 },
            { ...good, viewedAt: 'not a date' },
            { ...good, filePath: 7 },
            null,
          ],
          removed: [{ filePath: 'a.txt', diffContentHash: 'h1' }],
        }),
      ).toEqual({ entries: [good], removed: [] });
    });

    it('keeps only paths, hashes and timestamps', () => {
      expect(
        parseViewedRecordUpdate({
          entries: [{ ...viewed('a.txt', '2026-01-01T00:00:00.000Z'), extra: 'x' }],
          removed: [{ ...removed('b.txt', '2026-01-01T00:00:00.000Z'), extra: 'x' }],
        }),
      ).toEqual({
        entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')],
        removed: [removed('b.txt', '2026-01-01T00:00:00.000Z')],
      });
    });
  });

  describe('mergeViewedRecord', () => {
    it('keeps entries from separate writes', async () => {
      await mergeViewedRecord(recordPath, {
        entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')],
        removed: [],
      });
      const record = await mergeViewedRecord(recordPath, {
        entries: [viewed('b.txt', '2026-01-02T00:00:00.000Z')],
        removed: [],
      });

      expect(record.entries.map((entry) => entry.filePath).sort()).toEqual(['a.txt', 'b.txt']);
      expect((await readViewedRecord(recordPath)).entries).toHaveLength(2);
    });

    it('holds separate hashes of one file independently', async () => {
      await mergeViewedRecord(recordPath, {
        entries: [
          viewed('a.txt', '2026-01-01T00:00:00.000Z', 'h1'),
          viewed('a.txt', '2026-01-01T00:00:00.000Z', 'h2'),
        ],
        removed: [],
      });
      const record = await mergeViewedRecord(recordPath, {
        entries: [],
        removed: [removed('a.txt', '2026-01-02T00:00:00.000Z', 'h1')],
      });

      expect(record.entries.map((entry) => entry.diffContentHash)).toEqual(['h2']);
    });

    it('does not bring back an unmarked entry from an older local copy', async () => {
      await mergeViewedRecord(recordPath, {
        entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')],
        removed: [],
      });
      await mergeViewedRecord(recordPath, {
        entries: [],
        removed: [removed('a.txt', '2026-01-02T00:00:00.000Z')],
      });
      const record = await mergeViewedRecord(recordPath, {
        entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')],
        removed: [],
      });

      expect(record.entries).toEqual([]);
      expect(record.removed).toEqual([removed('a.txt', '2026-01-02T00:00:00.000Z')]);
    });

    it('lets a later mark replace an earlier unmark', async () => {
      await mergeViewedRecord(recordPath, {
        entries: [],
        removed: [removed('a.txt', '2026-01-02T00:00:00.000Z')],
      });
      const record = await mergeViewedRecord(recordPath, {
        entries: [viewed('a.txt', '2026-01-03T00:00:00.000Z')],
        removed: [],
      });

      expect(record.entries).toEqual([viewed('a.txt', '2026-01-03T00:00:00.000Z')]);
      expect(record.removed).toEqual([]);
    });

    it('ignores an unmark older than the mark, whichever request lands first', async () => {
      await mergeViewedRecord(recordPath, {
        entries: [viewed('a.txt', '2026-01-03T00:00:00.000Z')],
        removed: [],
      });
      const record = await mergeViewedRecord(recordPath, {
        entries: [],
        removed: [removed('a.txt', '2026-01-02T00:00:00.000Z')],
      });

      expect(record.entries).toHaveLength(1);
      expect(record.removed).toEqual([]);
    });

    it('keeps every entry when writers overlap', async () => {
      const writes = Array.from({ length: 10 }, (_, i) =>
        mergeViewedRecord(recordPath, {
          entries: [viewed(`f${i}.txt`, '2026-01-01T00:00:00.000Z')],
          removed: [],
        }),
      );
      await Promise.all(writes);

      expect((await readViewedRecord(recordPath)).entries).toHaveLength(10);
      expect((await fs.readdir(join(configDir, 'viewed'))).sort()).toEqual([
        `${REPOSITORY_ID}.json`,
      ]);
    });

    it('takes over a lock left behind by a crashed writer', async () => {
      await fs.mkdir(join(configDir, 'viewed'), { recursive: true });
      const lockPath = `${recordPath}.lock`;
      await fs.writeFile(lockPath, '');
      const longAgo = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, longAgo, longAgo);

      const record = await mergeViewedRecord(recordPath, {
        entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')],
        removed: [],
      });

      expect(record.entries).toHaveLength(1);
    });

    it('fails rather than overwrite while another writer holds the lock', async () => {
      await fs.mkdir(join(configDir, 'viewed'), { recursive: true });
      await fs.writeFile(`${recordPath}.lock`, '');

      await expect(
        mergeViewedRecord(recordPath, {
          entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')],
          removed: [],
        }),
      ).rejects.toThrow();
      expect((await readViewedRecord(recordPath)).entries).toEqual([]);
    });

    it('keeps the newest entries and unmarks once the cap is passed', async () => {
      const entries = Array.from({ length: 5002 }, (_, i) =>
        viewed(`f${i}.txt`, new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()),
      );
      const removals = Array.from({ length: 5002 }, (_, i) =>
        removed(`g${i}.txt`, new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()),
      );

      const record = await mergeViewedRecord(recordPath, { entries, removed: removals });

      expect(record.entries).toHaveLength(5000);
      expect(record.entries.map((entry) => entry.filePath)).not.toContain('f0.txt');
      expect(record.entries.map((entry) => entry.filePath)).toContain('f5001.txt');
      expect(record.removed).toHaveLength(5000);
      expect(record.removed.map((entry) => entry.filePath)).not.toContain('g1.txt');
    });

    it('creates the directory and the file for the owner only', async () => {
      await mergeViewedRecord(recordPath, {
        entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')],
        removed: [],
      });

      expect((await fs.stat(recordPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(join(configDir, 'viewed'))).mode & 0o777).toBe(0o700);
    });

    it('does not rewrite the file when nothing changes', async () => {
      const update = { entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')], removed: [] };
      await mergeViewedRecord(recordPath, update);
      const stored = await fs.readFile(recordPath, 'utf-8');
      await new Promise((resolve) => setTimeout(resolve, 5));

      await mergeViewedRecord(recordPath, update);

      expect(await fs.readFile(recordPath, 'utf-8')).toBe(stored);
    });
  });

  describe('readViewedRecord', () => {
    it.each([
      ['broken JSON', '{"version":1,"entries":['],
      ['a JSON array', '[]'],
    ])('reads %s as an empty record', async (_name, content) => {
      await fs.mkdir(join(configDir, 'viewed'), { recursive: true });
      await fs.writeFile(recordPath, content);

      expect(await readViewedRecord(recordPath)).toMatchObject({ entries: [], removed: [] });
    });

    it('reads a missing file as an empty record', async () => {
      expect(await readViewedRecord(recordPath)).toMatchObject({ entries: [], removed: [] });
    });

    it('refuses a newer format and leaves the file alone', async () => {
      await fs.mkdir(join(configDir, 'viewed'), { recursive: true });
      const newer = '{"version":2,"entries":[],"removed":[],"extra":1}';
      await fs.writeFile(recordPath, newer);

      await expect(
        mergeViewedRecord(recordPath, {
          entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')],
          removed: [],
        }),
      ).rejects.toThrow('version');
      expect(await fs.readFile(recordPath, 'utf-8')).toBe(newer);
    });

    it.skipIf(process.getuid?.() === 0)(
      'refuses a file it cannot read and leaves the file alone',
      async () => {
        await mergeViewedRecord(recordPath, {
          entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')],
          removed: [],
        });
        await fs.chmod(recordPath, 0o000);

        try {
          await expect(
            mergeViewedRecord(recordPath, {
              entries: [viewed('b.txt', '2026-01-01T00:00:00.000Z')],
              removed: [],
            }),
          ).rejects.toThrow();
        } finally {
          await fs.chmod(recordPath, 0o600);
        }
        expect((await readViewedRecord(recordPath)).entries).toHaveLength(1);
      },
    );

    it('recovers from a corrupt file on the next write', async () => {
      await fs.mkdir(join(configDir, 'viewed'), { recursive: true });
      await fs.writeFile(recordPath, 'garbage');

      await mergeViewedRecord(recordPath, {
        entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')],
        removed: [],
      });

      expect((await readViewedRecord(recordPath)).entries).toHaveLength(1);
    });
  });

  describe('clearViewedRecord', () => {
    it('turns every mark into an unmark and keeps earlier unmarks', async () => {
      await mergeViewedRecord(recordPath, {
        entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')],
        removed: [removed('b.txt', '2026-01-01T00:00:00.000Z')],
      });

      await clearViewedRecord(recordPath);

      const record = await readViewedRecord(recordPath);
      expect(record.entries).toEqual([]);
      expect(record.removed.map(({ filePath }) => filePath).sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('refuses a mark made before the clear and takes one made after it', async () => {
      await mergeViewedRecord(recordPath, {
        entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')],
        removed: [],
      });
      await clearViewedRecord(recordPath);

      const refused = await mergeViewedRecord(recordPath, {
        entries: [viewed('a.txt', '2026-01-01T00:00:00.000Z')],
        removed: [],
      });
      expect(refused.entries).toEqual([]);

      const later = new Date(Date.now() + 60_000).toISOString();
      const taken = await mergeViewedRecord(recordPath, {
        entries: [viewed('a.txt', later)],
        removed: [],
      });
      expect(taken.entries).toEqual([viewed('a.txt', later)]);
    });

    it('accepts a missing record', async () => {
      await expect(clearViewedRecord(recordPath)).resolves.toBeUndefined();
    });
  });
});
