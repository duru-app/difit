import type {
  BaseMode,
  CommentThread,
  DiffCommentThread,
  DiffSelection,
  ReviewCommit,
  ReviewScope,
  ReviewView,
  ReviewViewAction,
} from '../types/diff.js';

export function normalizeBaseMode(baseMode?: BaseMode): BaseMode {
  return baseMode ?? 'direct';
}

export function createDiffSelection(
  baseCommitish: string,
  targetCommitish: string,
  baseMode?: BaseMode,
): DiffSelection {
  if (normalizeBaseMode(baseMode) === 'merge-base') {
    return {
      baseCommitish,
      targetCommitish,
      baseMode: 'merge-base',
    };
  }

  return {
    baseCommitish,
    targetCommitish,
  };
}

export function selectionAtCommit(current: DiffSelection, commit: string): DiffSelection {
  const reviewsOneCommit = current.baseCommitish === `${current.targetCommitish}^`;
  return createDiffSelection(
    reviewsOneCommit ? `${commit}^` : current.baseCommitish,
    commit,
    current.baseMode,
  );
}

export function diffSelectionsEqual(
  left: DiffSelection | null | undefined,
  right: DiffSelection | null | undefined,
): boolean {
  return (
    left?.baseCommitish === right?.baseCommitish &&
    left?.targetCommitish === right?.targetCommitish &&
    normalizeBaseMode(left?.baseMode) === normalizeBaseMode(right?.baseMode)
  );
}

export function getDiffSelectionKey(selection: DiffSelection): string {
  return `${selection.baseCommitish}:${selection.targetCommitish}:${normalizeBaseMode(selection.baseMode)}`;
}

export function getMergeBaseTargetRef(targetCommitish: string): string {
  if (targetCommitish === '.' || targetCommitish === 'staged' || targetCommitish === 'working') {
    return 'HEAD';
  }

  return targetCommitish;
}

export function isCommitTarget(targetCommitish: string): boolean {
  return !['.', 'staged', 'working', 'stdin'].includes(targetCommitish);
}

const HASH_PATTERN = /^[0-9a-f]{7,40}$/i;

export function isCommitHash(commitish: string): boolean {
  return HASH_PATTERN.test(commitish);
}

export function shortRef(ref: string): string {
  return ref.replace(/^([0-9a-f]{7})(?:[0-9a-f]{33}|[0-9a-f]{57})(?=\^?$)/i, '$1');
}

export function isSameCommit(a: string, b: string): boolean {
  if (!HASH_PATTERN.test(a) || !HASH_PATTERN.test(b)) return a === b;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.toLowerCase().startsWith(shorter.toLowerCase());
}

export function reviewCommitViewed(
  view: DiffSelection,
  commits: readonly ReviewCommit[],
): ReviewCommit | undefined {
  if (normalizeBaseMode(view.baseMode) === 'merge-base') return undefined;
  return commits.find(
    (commit) =>
      isSameCommit(commit.sha, view.targetCommitish) &&
      isSameCommit(commit.parentSha, view.baseCommitish),
  );
}

export function isSameView(a: DiffSelection, b: DiffSelection): boolean {
  return (
    isSameCommit(a.baseCommitish, b.baseCommitish) &&
    isSameCommit(a.targetCommitish, b.targetCommitish) &&
    normalizeBaseMode(a.baseMode) === normalizeBaseMode(b.baseMode)
  );
}

function commitsBetween(view: DiffSelection, commits: readonly ReviewCommit[]): ReviewCommit[] {
  if (normalizeBaseMode(view.baseMode) === 'merge-base') return [];
  const end = commits.findIndex((commit) => isSameCommit(commit.sha, view.targetCommitish));
  const start = commits
    .slice(0, end + 1)
    .findIndex((commit) => isSameCommit(commit.parentSha, view.baseCommitish));
  return end === -1 || start === -1 ? [] : commits.slice(start, end + 1);
}

export function commitsOfView(
  view: DiffSelection,
  review: Pick<ReviewScope, 'selection' | 'commits'>,
): ReviewCommit[] {
  return isSameView(view, review.selection) ? review.commits : commitsBetween(view, review.commits);
}

export function reviewViewShown(
  view: DiffSelection,
  review: Pick<ReviewScope, 'selection' | 'commits'>,
): ReviewView | undefined {
  if (diffSelectionsEqual(view, review.selection)) return { kind: 'all' };
  const run = commitsBetween(view, review.commits);
  const first = run[0];
  const last = run.at(-1);
  if (!first || !last) return undefined;
  return first === last
    ? { kind: 'commit', sha: last.sha }
    : { kind: 'range', startSha: first.sha, endSha: last.sha };
}

// The review itself, or the diff from just before one of its commits to that or a later one.
export function isViewOfReview(
  view: DiffSelection,
  review: Pick<ReviewScope, 'selection' | 'commits'>,
): boolean {
  return reviewViewShown(view, review) !== undefined;
}

export interface ReviewViewChoice {
  view: ReviewView;
  // Null while the shown diff stays as it is.
  selection: DiffSelection | null;
  anchor: string | null;
  // The long-pressed commit, while the other end of a run is still to be chosen.
  rangeStart?: string;
}

export function selectReviewView(
  review: Pick<ReviewScope, 'requested' | 'commits'>,
  current: Pick<ReviewViewChoice, 'view' | 'anchor' | 'rangeStart'>,
  action: ReviewViewAction,
): ReviewViewChoice | null {
  const { commits } = review;
  const indexOf = (sha: string) => commits.findIndex((commit) => isSameCommit(commit.sha, sha));
  const whole = (anchor: string | null): ReviewViewChoice => ({
    view: { kind: 'all' },
    selection: review.requested,
    anchor,
  });
  const runOf = (from: number, to: number, anchor: string): ReviewViewChoice | null => {
    const first = commits[Math.min(from, to)];
    const last = commits[Math.max(from, to)];
    if (!first || !last) return null;
    if (first === commits[0] && last === commits.at(-1)) return whole(anchor);
    return {
      view:
        first === last
          ? { kind: 'commit', sha: first.sha }
          : { kind: 'range', startSha: first.sha, endSha: last.sha },
      selection: createDiffSelection(first.parentSha, last.sha),
      anchor,
    };
  };
  const commitAt = (index: number) => {
    const commit = commits[index];
    return commit ? runOf(index, index, commit.sha) : null;
  };
  const { view, rangeStart } = current;

  switch (action.kind) {
    case 'all':
      return whole(null);
    case 'click':
      if (rangeStart !== undefined)
        return runOf(indexOf(rangeStart), indexOf(action.sha), rangeStart);
      if (view.kind === 'commit' && isSameCommit(view.sha, action.sha)) return whole(null);
      return commitAt(indexOf(action.sha));
    case 'long-press':
      if (indexOf(action.sha) === -1) return null;
      return { view, selection: null, anchor: current.anchor, rangeStart: action.sha };
    case 'cancel':
      return rangeStart === undefined ? null : { view, selection: null, anchor: current.anchor };
    case 'shift-click': {
      const anchor =
        current.anchor ??
        (view.kind === 'commit' ? view.sha : view.kind === 'range' ? view.startSha : null);
      if (anchor === null) return commitAt(indexOf(action.sha));
      return runOf(indexOf(anchor), indexOf(action.sha), anchor);
    }
    case 'drop':
      return runOf(indexOf(action.fromSha), indexOf(action.toSha), action.fromSha);
    case 'next':
      if (view.kind === 'all') return commitAt(0);
      return commitAt(indexOf(view.kind === 'commit' ? view.sha : view.endSha) + 1);
    case 'previous':
      if (view.kind === 'all') return commitAt(commits.length - 1);
      return commitAt(indexOf(view.kind === 'commit' ? view.sha : view.startSha) - 1);
  }
}

export interface ViewBinding {
  view?: DiffSelection;
  fixupTarget: string;
  snapshotCommit?: string;
}

export function bindingForView(
  review: Pick<ReviewScope, 'selection' | 'commits'>,
  view: DiffSelection,
  fixupTarget?: string,
): ViewBinding | undefined {
  if (isSameView(view, review.selection)) {
    return fixupTarget === undefined ? undefined : { fixupTarget };
  }
  const run = commitsBetween(view, review.commits);
  const first = run[0];
  const last = run.at(-1);
  if (!first || !last) return undefined;
  return {
    view: createDiffSelection(first.parentSha, last.sha),
    fixupTarget: fixupTarget ?? last.sha,
    snapshotCommit: last.sha,
  };
}

export function bindingForCommit(
  review: Pick<ReviewScope, 'selection' | 'commits'>,
  commit: Pick<ReviewCommit, 'sha' | 'parentSha'>,
): ViewBinding | undefined {
  return bindingForView(review, createDiffSelection(commit.parentSha, commit.sha), commit.sha);
}

// As the commit list or its 「전체」 entry requests it, so showing it records the same history entry.
export function madeViewElsewhere(
  thread: Pick<DiffCommentThread, 'view'>,
  shown: DiffSelection,
  review: Pick<ReviewScope, 'selection' | 'commits' | 'requested'>,
): DiffSelection | undefined {
  const made = thread.view ?? review.selection;
  if (isSameView(made, shown)) return undefined;
  if (isSameView(made, review.selection)) return review.requested;
  return commitsBetween(made, review.commits).length > 0 ? made : undefined;
}

export function fixupCommitOf(
  fixupTarget: string,
  commits: readonly ReviewCommit[],
): NonNullable<CommentThread['fixupCommit']> {
  const commit = commits.find(({ sha }) => isSameCommit(sha, fixupTarget));
  return commit
    ? { shortSha: commit.shortSha, subject: commit.subject }
    : { shortSha: fixupTarget.slice(0, 7) };
}
