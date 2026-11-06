import type {
  DiffCommentMessage,
  DiffCommentThread,
  DiffSelection,
  HistoryMove,
  ReviewDecision,
  RewrittenShas,
} from '../types/diff.js';

import { commitsBetween, createDiffSelection, isSameCommit } from './diffSelection.js';

const NAMED_COMMIT = /^([0-9a-f]{7,40})(\^?)$/i;

function newSha(sha: string, rewritten: RewrittenShas): string | undefined {
  if (Object.hasOwn(rewritten, sha)) return rewritten[sha];
  if (sha.length === 40) return undefined;
  const match = Object.keys(rewritten).find((old) => old.startsWith(sha.toLowerCase()));
  return match === undefined ? undefined : rewritten[match];
}

// A hash with the `^` a one-commit review's base carries; other names stay. An abbreviated hash stays
// as long as it was, because a review and a browser record are keyed by the form the diff reports.
export function movedCommitish(commitish: string, rewritten: RewrittenShas): string {
  const [, sha, suffix = ''] = NAMED_COMMIT.exec(commitish) ?? [];
  if (sha === undefined) return commitish;
  const moved = newSha(sha, rewritten);
  return moved === undefined ? commitish : `${moved.slice(0, sha.length)}${suffix}`;
}

export function movedSelection(selection: DiffSelection, rewritten: RewrittenShas): DiffSelection {
  return createDiffSelection(
    movedCommitish(selection.baseCommitish, rewritten),
    movedCommitish(selection.targetCommitish, rewritten),
    selection.baseMode,
  );
}

// After a reorder a view shows the same commits, plus any that now stand between them.
function selectionAfterMove(selection: DiffSelection, move: HistoryMove): DiffSelection {
  const moved = movedSelection(selection, move.rewritten);
  if (!move.reorder) return moved;
  const { before, after } = move.reorder;
  const places = commitsBetween(selection, before).map(({ sha }) =>
    after.findIndex((commit) => commit.sha === (move.rewritten[sha] ?? sha)),
  );
  const first = after[Math.min(...places)];
  const last = after[Math.max(...places)];
  const { baseCommitish, targetCommitish, baseMode } = selection;
  if (first && last && !places.includes(-1)) {
    return createDiffSelection(
      first.parentSha.slice(0, baseCommitish.length),
      last.sha.slice(0, targetCommitish.length),
      baseMode,
    );
  }
  const oldTop = before.at(-1);
  const newTop = after.at(-1);
  return oldTop && newTop && isSameCommit(targetCommitish, oldTop.sha)
    ? createDiffSelection(
        moved.baseCommitish,
        newTop.sha.slice(0, targetCommitish.length),
        baseMode,
      )
    : moved;
}

export function selectionAfterMoves(
  selection: DiffSelection,
  moves: readonly HistoryMove[],
): DiffSelection {
  return moves.reduce(selectionAfterMove, selection);
}

interface PlacedOnCommits {
  view?: DiffSelection;
  fixupTarget?: string;
  codeSnapshot?: { commit?: string };
}

export function movedPlace<T extends PlacedOnCommits>(
  item: T,
  rewritten: RewrittenShas,
  moves: readonly HistoryMove[] = [{ rewritten }],
): T {
  const { view, fixupTarget, codeSnapshot } = item;
  return {
    ...item,
    ...(view ? { view: selectionAfterMoves(view, moves) } : {}),
    ...(fixupTarget === undefined ? {} : { fixupTarget: movedCommitish(fixupTarget, rewritten) }),
    ...(codeSnapshot?.commit === undefined
      ? {}
      : {
          codeSnapshot: {
            ...codeSnapshot,
            commit: movedCommitish(codeSnapshot.commit, rewritten),
          },
        }),
  };
}

// A commit that changes no file has its own SHA for a patch id, so the id moves with the SHA.
function movedMessage(message: DiffCommentMessage, rewritten: RewrittenShas): DiffCommentMessage {
  const { fixupLines } = message;
  if (!fixupLines) return message;
  return {
    ...message,
    fixupLines: {
      ...fixupLines,
      fixupSha: movedCommitish(fixupLines.fixupSha, rewritten),
      patchId: movedCommitish(fixupLines.patchId, rewritten),
    },
  };
}

export function movedThread(
  thread: DiffCommentThread,
  rewritten: RewrittenShas,
  moves?: readonly HistoryMove[],
): DiffCommentThread {
  return {
    ...movedPlace(thread, rewritten, moves),
    messages: thread.messages.map((message) => movedMessage(message, rewritten)),
  };
}

export function movedDecision(decision: ReviewDecision, rewritten: RewrittenShas): ReviewDecision {
  const { fixupSha, patchId, targetSha } = decision;
  return {
    ...decision,
    fixupSha: movedCommitish(fixupSha, rewritten),
    ...(patchId === undefined ? {} : { patchId: movedCommitish(patchId, rewritten) }),
    ...(targetSha === undefined ? {} : { targetSha: movedCommitish(targetSha, rewritten) }),
  };
}

// Each old SHA leads straight to the commit that stands for it now.
export function afterRewrite(earlier: RewrittenShas, later: RewrittenShas): RewrittenShas {
  const followed = Object.entries(earlier).map(
    ([old, moved]) => [old, later[moved] ?? moved] as const,
  );
  return { ...Object.fromEntries(followed), ...later };
}
