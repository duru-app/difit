import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiffCommentThread, ReviewDecision } from '../types/diff.js';
import { createDiffSelection } from '../utils/diffSelection.js';

import {
  clearReviewRecord,
  getReviewRecordPath,
  isLeftOut,
  readReviewRecord,
  reviewsBehind,
  saveReview,
  takeOverReviews,
  updateReviewRecord,
  type StoredReview,
} from './review-record.js';

function thread(id: string, filePath = 'a.ts', body = `note ${id}`): DiffCommentThread {
  return {
    id,
    filePath,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    position: { side: 'new', line: 2 },
    codeSnapshot: { content: 'const a = 1;', commit: 'aaaaaaa' },
    messages: [
      {
        id,
        body,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

const resolved = (threadId: string): ReviewDecision => ({
  threadId,
  kind: 'resolved',
  fixupSha: '',
  at: '2026-01-02T00:00:00.000Z',
});

function review(base: string, target: string, threads: DiffCommentThread[] = []): StoredReview {
  return { selection: createDiffSelection(base, target), threads, decisions: [] };
}

describe('review-record', () => {
  let dir: string;
  let recordPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'difit-review-record-'));
    recordPath = join(dir, 'config', 'reviews', 'record.json');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('getReviewRecordPath', () => {
    beforeEach(() => {
      // A test run started from a commit hook would otherwise point every git call at that commit.
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
      }
      for (const role of ['AUTHOR', 'COMMITTER']) {
        vi.stubEnv(`GIT_${role}_NAME`, 'difit');
        vi.stubEnv(`GIT_${role}_EMAIL`, 'difit@example.com');
      }
    });

    const git = (cwd: string, args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' });

    it('gives every worktree of a repository the same record under the config directory', async () => {
      vi.stubEnv('DIFIT_CONFIG_DIR', join(dir, 'config'));
      const repo = join(dir, 'repo');
      await fs.mkdir(join(repo, 'nested'), { recursive: true });
      git(repo, ['init', '-q']);
      git(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
      git(repo, ['worktree', 'add', '-q', join(dir, 'other'), '-b', 'other']);

      const path = await getReviewRecordPath(repo);

      expect(path).toMatch(
        new RegExp(`^${join(dir, 'config', 'reviews')}/[0-9a-f]{64}\\.json$`.replace(/\./g, '.')),
      );
      expect(await getReviewRecordPath(join(dir, 'other'))).toBe(path);
      expect(await getReviewRecordPath(join(repo, 'nested'))).toBe(path);
    });

    it('gives another repository another record', async () => {
      vi.stubEnv('DIFIT_CONFIG_DIR', join(dir, 'config'));
      const [one, two] = [join(dir, 'one'), join(dir, 'two')];
      for (const repo of [one, two]) {
        await fs.mkdir(repo);
        git(repo, ['init', '-q']);
      }

      expect(await getReviewRecordPath(one)).not.toBe(await getReviewRecordPath(two));
    });

    it('has no record outside a git repository', async () => {
      vi.stubEnv('GIT_CEILING_DIRECTORIES', dir);
      const plain = join(dir, 'plain');
      await fs.mkdir(plain);

      expect(await getReviewRecordPath(plain)).toBeNull();
    });
  });

  describe('readReviewRecord', () => {
    it('reads a missing or broken file as an empty record', async () => {
      expect((await readReviewRecord(recordPath)).reviews).toEqual([]);

      await fs.mkdir(join(dir, 'config', 'reviews'), { recursive: true });
      await fs.writeFile(recordPath, '{"version":1,"reviews":[');
      expect((await readReviewRecord(recordPath)).reviews).toEqual([]);
    });

    it('refuses a record written by a newer format', async () => {
      await fs.mkdir(join(dir, 'config', 'reviews'), { recursive: true });
      await fs.writeFile(recordPath, JSON.stringify({ version: 2, reviews: [] }));

      await expect(readReviewRecord(recordPath)).rejects.toThrow('Unsupported review record');
    });

    it('drops entries that are not reviews or threads', async () => {
      await fs.mkdir(join(dir, 'config', 'reviews'), { recursive: true });
      await fs.writeFile(
        recordPath,
        JSON.stringify({
          version: 1,
          reviews: [
            { selection: { baseCommitish: 'a' }, threads: [] },
            {
              selection: { baseCommitish: 'a', targetCommitish: 'b' },
              threads: [thread('t1'), { id: 't2' }, 'x'],
              decisions: [resolved('t1'), { kind: 'resolved' }],
            },
          ],
        }),
      );

      expect((await readReviewRecord(recordPath)).reviews).toEqual([
        {
          selection: createDiffSelection('a', 'b'),
          threads: [thread('t1')],
          decisions: [resolved('t1')],
        },
      ]);
    });
  });

  describe('updateReviewRecord', () => {
    it('keeps threads, replies, decisions and the original code across a write and a read', async () => {
      const stored: StoredReview = {
        selection: createDiffSelection('aaaaaaa', 'bbbbbbb', 'merge-base'),
        threads: [
          {
            ...thread('t1'),
            messages: [
              ...thread('t1').messages,
              {
                id: 'r1',
                body: 'reply',
                author: 'agent',
                createdAt: '2026-01-01T00:01:00.000Z',
                updatedAt: '2026-01-01T00:01:00.000Z',
              },
            ],
          },
        ],
        decisions: [resolved('t1')],
      };

      await updateReviewRecord(recordPath, (reviews) => saveReview(reviews, stored));

      expect((await readReviewRecord(recordPath)).reviews).toEqual([stored]);
      expect((await fs.stat(recordPath)).mode & 0o777).toBe(0o600);
      expect(await fs.readdir(join(dir, 'config', 'reviews'))).toEqual(['record.json']);
    });

    it('keeps the reviews another writer saved meanwhile', async () => {
      await Promise.all(
        ['b', 'c', 'd', 'e'].map((target) =>
          updateReviewRecord(recordPath, (reviews) =>
            saveReview(reviews, review('a', target, [thread(`t-${target}`)])),
          ),
        ),
      );

      const { reviews } = await readReviewRecord(recordPath);
      expect(reviews.map(({ selection }) => selection.targetCommitish).sort()).toEqual([
        'b',
        'c',
        'd',
        'e',
      ]);
    });

    it('does not rewrite the file when nothing changes', async () => {
      const first = await updateReviewRecord(recordPath, (reviews) =>
        saveReview(reviews, review('a', 'b', [thread('t1')])),
      );
      const second = await updateReviewRecord(recordPath, (reviews) =>
        saveReview(reviews, review('a', 'b', [thread('t1')])),
      );

      expect(second.lastModifiedAt).toBe(first.lastModifiedAt);
    });
  });

  it('clearReviewRecord removes every stored review', async () => {
    await updateReviewRecord(recordPath, (reviews) =>
      saveReview(reviews, review('a', 'b', [thread('t1')])),
    );

    await clearReviewRecord(recordPath);
    await clearReviewRecord(recordPath);

    expect((await readReviewRecord(recordPath)).reviews).toEqual([]);
  });

  describe('saveReview', () => {
    it('replaces the review of the same range and keeps the others', () => {
      const other = review('a', 'c', [thread('t9')]);
      const next = saveReview(
        [review('a', 'b', [thread('t1')]), other],
        review('a', 'b', [thread('t2')]),
      );

      expect(next).toEqual([other, review('a', 'b', [thread('t2')])]);
    });

    it('drops a review left with no thread and no decision', () => {
      expect(saveReview([review('a', 'b', [thread('t1')])], review('a', 'b'))).toEqual([]);
    });
  });

  describe('reviewsBehind', () => {
    const ancestors = new Set(['1111111>3333333', '2222222>3333333']);
    const isAncestor = (older: string, newer: string) =>
      Promise.resolve(ancestors.has(`${older}>${newer}`));
    const now = createDiffSelection('aaaaaaa', '3333333');

    it('finds reviews of the same base whose target is an ancestor of the new target', async () => {
      const behind = review('aaaaaaa', '1111111');
      const alsoBehind = review('aaaaaaa', '2222222');
      const reviews = [
        behind,
        alsoBehind,
        review('aaaaaaa', '3333333'),
        review('aaaaaaa', '4444444'),
        review('bbbbbbb', '1111111'),
        {
          ...review('aaaaaaa', '1111111'),
          selection: createDiffSelection('aaaaaaa', '1111111', 'merge-base'),
        },
      ];

      expect(await reviewsBehind(reviews, now, isAncestor)).toEqual([behind, alsoBehind]);
    });

    it('matches a base stored as a longer hash of the same commit', async () => {
      const behind = review('aaaaaaa0000', '1111111');

      expect(await reviewsBehind([behind], now, isAncestor)).toEqual([behind]);
    });

    it('never crosses over to or from uncommitted changes', async () => {
      const always = () => Promise.resolve(true);

      expect(await reviewsBehind([review('aaaaaaa', '.')], now, always)).toEqual([]);
      expect(
        await reviewsBehind(
          [review('aaaaaaa', '1111111')],
          createDiffSelection('aaaaaaa', '.'),
          always,
        ),
      ).toEqual([]);
    });
  });

  describe('takeOverReviews', () => {
    it('moves threads and decisions of the reviews behind into the new review', () => {
      const old = {
        ...review('a', 'b', [thread('t1'), thread('t2')]),
        decisions: [resolved('t1')],
      };
      const unrelated = review('x', 'y', [thread('t9')]);
      const next = takeOverReviews(
        [old, unrelated, review('a', 'c', [thread('t3')])],
        createDiffSelection('a', 'c'),
        [old.selection],
      );

      expect(next).toEqual([
        unrelated,
        {
          selection: createDiffSelection('a', 'c'),
          threads: [thread('t1'), thread('t2'), thread('t3')],
          decisions: [resolved('t1')],
        },
      ]);
    });

    it('keeps two threads of one review that say the same at the same place', () => {
      const twins = [thread('t1', 'a.ts', 'same'), thread('t2', 'a.ts', 'same')];
      const next = takeOverReviews([review('a', 'b', twins)], createDiffSelection('a', 'c'), [
        createDiffSelection('a', 'b'),
      ]);

      expect(next).toEqual([review('a', 'c', twins)]);
    });

    it('keeps one copy of a thread both reviews hold', () => {
      const next = takeOverReviews(
        [review('a', 'b', [thread('t1')]), review('a', 'c', [thread('t1')])],
        createDiffSelection('a', 'c'),
        [createDiffSelection('a', 'b')],
      );

      expect(next).toEqual([review('a', 'c', [thread('t1')])]);
    });
  });

  describe('isLeftOut', () => {
    it('leaves out a thread on a file the diff does not have', () => {
      expect(isLeftOut(thread('t1', 'gone.ts'), new Set(['a.ts']))).toBe(true);
      expect(isLeftOut(thread('t1', 'a.ts'), new Set(['a.ts']))).toBe(false);
    });

    it('keeps a thread on a commit', () => {
      const onCommit: DiffCommentThread = {
        id: 't1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        position: { scope: 'commit' },
        fixupTarget: 'abc1234',
        messages: [],
      };

      expect(isLeftOut(onCommit, new Set())).toBe(false);
    });
  });
});
