import type {
  DiffCommentMessage,
  DiffCommentThread,
  DiffSelection,
  ReviewDecision,
  RewrittenShas,
} from '../types/diff.js';

import { createDiffSelection } from './diffSelection.js';

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

interface PlacedOnCommits {
  view?: DiffSelection;
  fixupTarget?: string;
  codeSnapshot?: { commit?: string };
}

export function movedPlace<T extends PlacedOnCommits>(item: T, rewritten: RewrittenShas): T {
  const { view, fixupTarget, codeSnapshot } = item;
  return {
    ...item,
    ...(view ? { view: movedSelection(view, rewritten) } : {}),
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
): DiffCommentThread {
  return {
    ...movedPlace(thread, rewritten),
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
