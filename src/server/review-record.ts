import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';

import {
  COMMIT_MESSAGE_PATH,
  type DiffCommentThread,
  type DiffSelection,
  type ReviewDecision,
} from '../types/diff.js';
import { mergeCommentThreads } from '../utils/commentImports.js';
import { isOnCommit } from '../utils/commentPosition.js';
import {
  createDiffSelection,
  diffSelectionsEqual,
  isCommitTarget,
  isSameCommit,
  normalizeBaseMode,
} from '../utils/diffSelection.js';
import { mergeReviewDecisions, normalizeReviewDecisions } from '../utils/reviewDecisions.js';

import { runGit } from './run-git.js';
import { getDifitConfigDir, isPlainObject } from './user-config.js';
import { withRecordLock } from './viewed-record.js';

export interface StoredReview {
  selection: DiffSelection;
  // Every thread of the review, the ones on files its diff no longer has included.
  threads: DiffCommentThread[];
  decisions: ReviewDecision[];
}

export interface ReviewRecord {
  version: 1;
  lastModifiedAt: string;
  reviews: StoredReview[];
}

// Keyed by the .git directory the worktrees of a repository share, so every worktree reads the
// same record. Null outside a git repository.
export async function getReviewRecordPath(repositoryPath: string): Promise<string | null> {
  const run = await runGit(repositoryPath, ['rev-parse', '--git-common-dir']);
  const gitDir = run.code === 0 ? run.stdout.toString('utf8').trim() : '';
  if (gitDir === '') return null;
  const commonDir = await fs.realpath(resolve(repositoryPath, gitDir));
  const repositoryId = createHash('sha256').update(commonDir).digest('hex');
  return join(getDifitConfigDir(), 'reviews', `${repositoryId}.json`);
}

function toSelection(value: unknown): DiffSelection | null {
  if (
    !isPlainObject(value) ||
    typeof value.baseCommitish !== 'string' ||
    typeof value.targetCommitish !== 'string'
  ) {
    return null;
  }
  return createDiffSelection(
    value.baseCommitish,
    value.targetCommitish,
    value.baseMode === 'merge-base' ? 'merge-base' : undefined,
  );
}

function isThread(value: unknown): value is DiffCommentThread {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    Array.isArray(value.messages) &&
    isPlainObject(value.position) &&
    (typeof value.filePath === 'string' || value.position.scope === 'commit')
  );
}

function toReviews(items: unknown[]): StoredReview[] {
  return items.flatMap((item) => {
    if (!isPlainObject(item) || !Array.isArray(item.threads)) return [];
    const selection = toSelection(item.selection);
    if (!selection) return [];
    return [
      {
        selection,
        threads: item.threads.filter(isThread),
        decisions: normalizeReviewDecisions(item.decisions),
      },
    ];
  });
}

const emptyRecord = (): ReviewRecord => ({
  version: 1,
  lastModifiedAt: new Date(0).toISOString(),
  reviews: [],
});

export async function readReviewRecord(path: string): Promise<ReviewRecord> {
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
    throw new Error(`Unsupported review record version in ${path}`);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.reviews)) return emptyRecord();
  return {
    version: 1,
    lastModifiedAt:
      typeof parsed.lastModifiedAt === 'string' &&
      Number.isFinite(Date.parse(parsed.lastModifiedAt))
        ? parsed.lastModifiedAt
        : new Date(0).toISOString(),
    reviews: toReviews(parsed.reviews),
  };
}

async function writeReviewRecord(path: string, reviews: StoredReview[]): Promise<ReviewRecord> {
  const next: ReviewRecord = { version: 1, lastModifiedAt: new Date().toISOString(), reviews };
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(next), { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmpPath, path);
  } catch (error) {
    await fs.rm(tmpPath, { force: true });
    throw error;
  }
  return next;
}

// Applies the change to what is on disk now, so reviews another server wrote meanwhile stay.
export async function updateReviewRecord(
  path: string,
  change: (reviews: StoredReview[]) => StoredReview[],
): Promise<ReviewRecord> {
  return withRecordLock(path, async () => {
    const current = await readReviewRecord(path);
    const reviews = change(current.reviews);
    if (JSON.stringify(reviews) === JSON.stringify(current.reviews)) return current;
    return writeReviewRecord(path, reviews);
  });
}

export async function clearReviewRecord(path: string): Promise<void> {
  await withRecordLock(path, () => fs.rm(path, { force: true }));
}

export function saveReview(reviews: StoredReview[], review: StoredReview): StoredReview[] {
  const others = reviews.filter(
    (stored) => !diffSelectionsEqual(stored.selection, review.selection),
  );
  return review.threads.length === 0 && review.decisions.length === 0
    ? others
    : [...others, review];
}

// Reviews of the same base whose target is an ancestor of this one's target.
export async function reviewsBehind<Review extends { selection: DiffSelection }>(
  reviews: readonly Review[],
  selection: DiffSelection,
  isAncestor: (older: string, newer: string) => Promise<boolean>,
): Promise<Review[]> {
  if (!isCommitTarget(selection.targetCommitish)) return [];
  const sameBase = reviews.filter(
    (review) =>
      normalizeBaseMode(review.selection.baseMode) === normalizeBaseMode(selection.baseMode) &&
      isSameCommit(review.selection.baseCommitish, selection.baseCommitish) &&
      isCommitTarget(review.selection.targetCommitish) &&
      !isSameCommit(review.selection.targetCommitish, selection.targetCommitish),
  );
  const behind = await Promise.all(
    sameBase.map((review) =>
      isAncestor(review.selection.targetCommitish, selection.targetCommitish),
    ),
  );
  return sameBase.filter((_, index) => behind[index]);
}

// Moves the threads and decisions of the superseded reviews into the review of `selection`, in
// the order given, and drops those reviews.
export function takeOverReviews(
  reviews: StoredReview[],
  selection: DiffSelection,
  superseded: readonly DiffSelection[],
): StoredReview[] {
  const isSuperseded = (review: StoredReview) =>
    superseded.some((behind) => diffSelectionsEqual(behind, review.selection));
  const sources = [
    ...superseded.flatMap((behind) =>
      reviews.filter((review) => diffSelectionsEqual(behind, review.selection)),
    ),
    ...reviews.filter((review) => diffSelectionsEqual(review.selection, selection)),
  ];
  const [first, ...rest] = sources;
  if (!first) return reviews;
  const merged: StoredReview = {
    selection,
    threads: rest.reduce(
      (threads, review) => mergeCommentThreads(threads, review.threads).threads,
      first.threads,
    ),
    decisions: rest.reduce(
      (decisions, review) => mergeReviewDecisions(decisions, review.decisions),
      first.decisions,
    ),
  };
  return saveReview(
    reviews.filter((review) => !isSuperseded(review)),
    merged,
  );
}

export function isLeftOut(thread: DiffCommentThread, filesInDiff: ReadonlySet<string>): boolean {
  return (
    !isOnCommit(thread) &&
    thread.filePath !== COMMIT_MESSAGE_PATH &&
    !filesInDiff.has(thread.filePath)
  );
}
