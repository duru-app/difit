import {
  REVIEWER_AUTHOR,
  REVIEWER_EDIT_AUTHOR,
  type CommitCommentThread,
  type DiffCommentThread,
  type FileCommentThread,
  type ReviewDecision,
  type ThreadAwaitingAgent,
  type ThreadFixup,
  type ThreadReviewState,
} from '../types/diff.js';

import { isOnCommit } from './commentPosition.js';

const REVIEW_DECISION_KINDS: ReviewDecision['kind'][] = [
  'rejected',
  'approved',
  'unapproved',
  'folded',
  'resolved',
  'unresolved',
  'handed',
  'deleted',
];

const REVIEW_STATE_LABEL: Record<ThreadReviewState, string> = {
  'awaiting-fix': '답변 대기',
  answered: '답변 완료',
  choosing: '선택 대기',
  'fix-pending': '수정 중',
  'awaiting-approval': '승인 대기',
  approved: '승인됨',
  folded: '접힘',
  rejected: '다시 수정 중',
  withdrawn: '되돌림',
  deleted: '지움',
};

export function reviewStateLabel(state: ThreadReviewState): string {
  return REVIEW_STATE_LABEL[state];
}

// Timestamps come from different writers and formats, so they are compared as instants.
const decidedAt = (decision: ReviewDecision) => Date.parse(decision.at) || 0;

const decisionKey = (decision: ReviewDecision) =>
  `${decision.threadId}|${decision.kind}|${decision.fixupSha}`;

export function mergeReviewDecisions(
  current: ReviewDecision[],
  incoming: ReviewDecision[],
): ReviewDecision[] {
  const byKey = new Map<string, ReviewDecision>();
  for (const decision of [...current, ...incoming]) {
    const key = decisionKey(decision);
    const kept = byKey.get(key);
    if (!kept || decidedAt(kept) <= decidedAt(decision)) byKey.set(key, decision);
  }
  return [...byKey.values()].sort((a, b) => decidedAt(a) - decidedAt(b));
}

const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';

function toReviewDecision(item: unknown): ReviewDecision | null {
  if (typeof item !== 'object' || item === null) return null;
  const { threadId, kind, fixupSha, patchId, targetSha, at } = item as Record<string, unknown>;
  if (
    typeof threadId !== 'string' ||
    !REVIEW_DECISION_KINDS.includes(kind as ReviewDecision['kind']) ||
    typeof fixupSha !== 'string' ||
    typeof at !== 'string' ||
    !isOptionalString(patchId) ||
    !isOptionalString(targetSha)
  ) {
    return null;
  }
  return {
    threadId,
    kind: kind as ReviewDecision['kind'],
    fixupSha,
    ...(patchId === undefined ? {} : { patchId: patchId as string }),
    ...(targetSha === undefined ? {} : { targetSha: targetSha as string }),
    at,
  };
}

export function normalizeReviewDecisions(value: unknown): ReviewDecision[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => toReviewDecision(item) ?? []);
}

type FixupIdentity = { sha: string; patchId?: string };

function matcherFor(decisions: ReviewDecision[]): (fixup: FixupIdentity) => boolean {
  const shas = new Set(decisions.map((decision) => decision.fixupSha));
  const patchIds = new Set(decisions.flatMap((decision) => decision.patchId ?? []));
  return ({ sha, patchId }) => shas.has(sha) || (patchId !== undefined && patchIds.has(patchId));
}

function rejectionCheckFor(
  threadId: string,
  decisions: ReviewDecision[],
): (fixup: ThreadFixup) => boolean {
  return matcherFor(
    decisions.filter((decision) => decision.threadId === threadId && decision.kind === 'rejected'),
  );
}

function latestOf(
  own: ReviewDecision[],
  kinds: readonly ReviewDecision['kind'][],
): ReviewDecision | undefined {
  return own
    .filter((decision) => kinds.includes(decision.kind))
    .reduce<ReviewDecision | undefined>(
      (latest, decision) => (latest && decidedAt(latest) > decidedAt(decision) ? latest : decision),
      undefined,
    );
}

export function isThreadResolved(
  threadId: string,
  decisions: ReviewDecision[],
  fixups: ThreadFixup[] = [],
): boolean {
  const own = decisions.filter((decision) => decision.threadId === threadId);
  const mark = latestOf(own, ['resolved', 'unresolved']);
  const judgedAt = replacementJudgedAt(threadId, fixups, decisions);
  return mark?.kind === 'resolved' && (judgedAt === undefined || decidedAt(mark) > judgedAt);
}

type ThreadMessages = {
  messages?: ReadonlyArray<{
    author?: string;
    createdAt?: string;
    choices?: unknown[];
    fixPending?: boolean;
  }>;
};

export function isThreadFolded(threadId: string, decisions: ReviewDecision[]): boolean {
  return decisions.some((decision) => decision.threadId === threadId && decision.kind === 'folded');
}

export function isThreadDeleted(threadId: string, decisions: ReviewDecision[]): boolean {
  return decisions.some(
    (decision) => decision.threadId === threadId && decision.kind === 'deleted',
  );
}

export function isOpenedByEdit(thread: ThreadMessages): boolean {
  return thread.messages?.[0]?.author === REVIEWER_EDIT_AUTHOR;
}

export const isAgentMessage = (message: { author?: string }) =>
  message.author !== REVIEWER_AUTHOR && message.author !== REVIEWER_EDIT_AUTHOR;

export function promisedFixBeforeAnswer(
  later: ReadonlyArray<{ author?: string; fixPending?: boolean }>,
): boolean {
  const answeredAt = later.findIndex((message) => !isAgentMessage(message));
  return (answeredAt < 0 ? later : later.slice(0, answeredAt)).some(
    (message) => message.fixPending === true,
  );
}

function openChoicesAt(
  messages: ReadonlyArray<{ author?: string; choices?: unknown[]; fixPending?: boolean }>,
): number {
  const at = messages.reduce(
    (latest, message, index) =>
      isAgentMessage(message) && message.choices?.length ? index : latest,
    -1,
  );
  const after = messages.slice(at + 1);
  return at >= 0 && after.every(isAgentMessage) && !promisedFixBeforeAnswer(after) ? at : -1;
}

// The fixups under judgment are approved together, so the latest approval and those recorded at
// the same instant form one approval, undone by a later undo or a later rejection of any of them.
function standingApproval(own: ReviewDecision[]): ReviewDecision[] {
  const latest = latestOf(own, ['approved', 'unapproved']);
  if (latest?.kind !== 'approved') return [];
  const approved = own.filter(
    (decision) => decision.kind === 'approved' && decidedAt(decision) === decidedAt(latest),
  );
  const isApproved = matcherFor(approved);
  const rejectedSince = own.some(
    (decision) =>
      decision.kind === 'rejected' &&
      decidedAt(decision) >= decidedAt(latest) &&
      isApproved({ sha: decision.fixupSha, patchId: decision.patchId }),
  );
  return rejectedSince ? [] : approved;
}

// The reviewer has not seen what the agent put in place of an approved fixup, by an amend say, so
// that approval no longer holds, and a resolution holds only once made after the reviewer judged
// every replacing fixup. Undefined when nothing replaced the approval; Infinity while a replacing
// fixup still waits for judgment.
function replacementJudgedAt(
  threadId: string,
  fixups: ThreadFixup[],
  decisions: ReviewDecision[],
): number | undefined {
  if (isThreadFolded(threadId, decisions)) return undefined;
  const own = decisions.filter((decision) => decision.threadId === threadId);
  const approved = standingApproval(own);
  if (approved[0] === undefined) return undefined;
  const approvedAt = decidedAt(approved[0]);
  const rejections = own.filter((decision) => decision.kind === 'rejected');
  const rejectedBefore = matcherFor(
    rejections.filter((decision) => decidedAt(decision) < approvedAt),
  );
  const standing = fixups.filter((fixup) => !rejectedBefore(fixup));
  const isApproved = matcherFor(approved);
  const replacing = standing.filter((fixup) => !isApproved(fixup));
  const approvalLeft = approved.some((approval) => !standing.some(matcherFor([approval])));
  if (!approvalLeft || replacing.length === 0) return undefined;
  const judgedAt = replacing.map((fixup) => {
    const rejectedAt = rejections
      .filter((decision) => matcherFor([decision])(fixup))
      .map((decision) => decidedAt(decision));
    return rejectedAt.length > 0 ? Math.max(...rejectedAt) : Infinity;
  });
  return Math.max(...judgedAt);
}

export function awaitsJudgmentOfReplacement(
  threadId: string,
  fixups: ThreadFixup[],
  decisions: ReviewDecision[],
): boolean {
  return replacementJudgedAt(threadId, fixups, decisions) === Infinity;
}

// The standing approval when it covers every fixup still under judgment. With no fixup left, the
// approved ones are being folded and the fold record has not landed yet.
function approvalCovering(
  threadId: string,
  fixups: ThreadFixup[],
  decisions: ReviewDecision[],
): ReviewDecision | undefined {
  if (replacementJudgedAt(threadId, fixups, decisions) !== undefined) return undefined;
  const approved = standingApproval(decisions.filter((decision) => decision.threadId === threadId));
  const isApproved = matcherFor(approved);
  const covered = pendingFixupsFor(threadId, fixups, decisions).every(isApproved);
  return covered ? approved[0] : undefined;
}

// Whether the card shows the thread as resolved: the later of an approval or fold and the
// reviewer's own resolve or reopen decides. What goes to the agent reads isThreadResolved instead.
export function appearsResolved(
  threadId: string,
  fixups: ThreadFixup[],
  decisions: ReviewDecision[],
): boolean {
  if (replacementJudgedAt(threadId, fixups, decisions) !== undefined) {
    return isThreadResolved(threadId, decisions, fixups);
  }
  const own = decisions.filter((decision) => decision.threadId === threadId);
  const mark = latestOf(own, ['resolved', 'unresolved']);
  const closings = [latestOf(own, ['folded']), approvalCovering(threadId, fixups, decisions)];
  const closedAfterMark = closings.some(
    (closing) => closing !== undefined && (!mark || decidedAt(closing) > decidedAt(mark)),
  );
  return closedAfterMark || mark?.kind === 'resolved';
}

export function deriveThreadReviewState(
  threadId: string,
  fixups: ThreadFixup[],
  decisions: ReviewDecision[],
  thread: ThreadMessages = {},
): ThreadReviewState {
  const own = decisions.filter((decision) => decision.threadId === threadId);
  if (isThreadFolded(threadId, decisions)) return 'folded';
  if (own.some((decision) => decision.kind === 'deleted')) return 'deleted';

  if (approvalCovering(threadId, fixups, decisions)) return 'approved';
  if (pendingFixupsFor(threadId, fixups, decisions).length > 0) return 'awaiting-approval';
  if (!own.some((decision) => decision.kind === 'rejected')) {
    const messages = thread.messages ?? [];
    const last = messages.at(-1);
    const agentReplied =
      last !== undefined && isAgentMessage(last) && !messages.every(isAgentMessage);
    if (!agentReplied) return 'awaiting-fix';
    if (openChoicesAt(messages) >= 0) return 'choosing';
    return last.fixPending === true ? 'fix-pending' : 'answered';
  }
  return isOpenedByEdit(thread) ? 'withdrawn' : 'rejected';
}

// States with no fixup under judgment, where an edit in the viewer can still answer the thread.
export function isAnswerableByEdit(state: ThreadReviewState): boolean {
  return (
    state === 'awaiting-fix' ||
    state === 'answered' ||
    state === 'choosing' ||
    state === 'fix-pending' ||
    state === 'rejected'
  );
}

// States whose fixups are on the card, where an edit on the card stacks a fixup on them.
export function isEditableOnCard(state: ThreadReviewState): boolean {
  return state === 'awaiting-approval' || state === 'approved';
}

// Unresolved threads the agent still owes an answer: no answer yet, or the last answer was rejected.
export function selectOpenThreads<T extends { id: string } & ThreadMessages>(
  threads: T[],
  fixupsByThread: ReadonlyMap<string, ThreadFixup[]>,
  decisions: ReviewDecision[],
): T[] {
  return threads.filter((thread) => {
    const fixups = fixupsByThread.get(thread.id) ?? [];
    if (isThreadResolved(thread.id, decisions, fixups)) return false;
    const state = deriveThreadReviewState(thread.id, fixups, decisions, thread);
    return state === 'awaiting-fix' || state === 'rejected';
  });
}

// open: the agent's move. fixing: the agent's, after it said a fixup follows. answered and
// choosing: the reviewer's move. resolved: nobody's.
export type CommentPanelStatus = 'open' | 'fixing' | 'answered' | 'choosing' | 'resolved';

const COMMENT_PANEL_STATUS: Record<ThreadReviewState, CommentPanelStatus | null> = {
  'awaiting-fix': 'open',
  rejected: 'open',
  answered: 'answered',
  choosing: 'choosing',
  'fix-pending': 'fixing',
  'awaiting-approval': 'answered',
  // Resolved until the reviewer reopens it; reopened, it stays out of the open count.
  approved: 'answered',
  folded: 'answered',
  withdrawn: 'resolved',
  deleted: null,
};

// Null for a deleted thread, which the comments panel never lists.
export function commentPanelStatus(
  thread: { id: string } & ThreadMessages,
  fixups: ThreadFixup[],
  decisions: ReviewDecision[],
): CommentPanelStatus | null {
  const status =
    COMMENT_PANEL_STATUS[deriveThreadReviewState(thread.id, fixups, decisions, thread)];
  if (status !== null && appearsResolved(thread.id, fixups, decisions)) return 'resolved';
  return status;
}

type ThreadForAgent =
  | Pick<FileCommentThread, 'id' | 'filePath' | 'position' | 'messages' | 'fixupTarget'>
  | Pick<CommitCommentThread, 'id' | 'position' | 'messages' | 'fixupTarget'>;

type ThreadTurn = Pick<DiffCommentThread, 'id' | 'messages'>;

// A rejection stays the agent's turn until a new fixup lands, the rejected one is dropped
// (withdrawn only), or the agent has the last word after it.
function rejectionAwaitingAgent(
  thread: ThreadTurn,
  fixups: ThreadFixup[],
  decisions: ReviewDecision[],
  state: 'rejected' | 'withdrawn',
): string[] | null {
  const rejections = decisions.filter(
    (decision) => decision.threadId === thread.id && decision.kind === 'rejected',
  );
  const latest = rejections.reduce((a, b) => (decidedAt(a) >= decidedAt(b) ? a : b));
  const last = thread.messages.at(-1);
  if (last && isAgentMessage(last) && (Date.parse(last.createdAt) || 0) >= decidedAt(latest)) {
    return null;
  }
  const leftInRange = fixups.filter(matcherFor(rejections)).map(({ sha }) => sha);
  if (state === 'withdrawn' && leftInRange.length === 0) return null;
  return leftInRange;
}

type FixupsToDrop = Pick<ThreadAwaitingAgent, 'rejectedFixupSha' | 'rejectedFixupShas'>;

const fixupsToDrop = (shas: string[]): FixupsToDrop =>
  shas[0] === undefined ? {} : { rejectedFixupSha: shas[0], rejectedFixupShas: shas };

// When the agent's current turn on the thread began: its last message, latest rejection or deletion.
function turnStartOf(thread: ThreadTurn, decisions: ReviewDecision[]): number {
  const own = decisions.filter((decision) => decision.threadId === thread.id);
  const restart = latestOf(own, ['rejected', 'deleted']);
  return Math.max(
    Date.parse(thread.messages.at(-1)?.createdAt ?? '') || 0,
    restart ? decidedAt(restart) : 0,
  );
}

// A deleted thread is the agent's turn while its fixup is still in the range, or once, to stop work
// it was handed and had not answered.
function deletionTurnOn(
  thread: ThreadTurn,
  fixupsByThread: ReadonlyMap<string, ThreadFixup[]> | undefined,
  decisions: ReviewDecision[],
  deletion: ReviewDecision,
): (Pick<ThreadAwaitingAgent, 'state' | 'label'> & FixupsToDrop) | null {
  const turn = { state: 'deleted' as const, label: reviewStateLabel('deleted') };
  const leftInRange = (fixupsByThread?.get(thread.id) ?? []).map(({ sha }) => sha);
  if (leftInRange.length > 0) return { ...turn, ...fixupsToDrop(leftInRange) };
  const own = decisions.filter((decision) => decision.threadId === thread.id);
  const handover = latestOf(own, ['handed']);
  if (!handover || decidedAt(handover) >= decidedAt(deletion)) return null;
  const turnBefore = turnStartOf(
    thread,
    own.filter((decision) => decision.kind !== 'deleted'),
  );
  return decidedAt(handover) >= turnBefore ? turn : null;
}

// The reviewer replied to the fixup under judgment: the last word is theirs and came after every
// fixup still standing was written.
function reviewerRepliedToFixup(
  thread: ThreadTurn,
  fixups: ThreadFixup[],
  decisions: ReviewDecision[],
): boolean {
  const last = thread.messages.at(-1);
  if (last?.author !== REVIEWER_AUTHOR) return false;
  const repliedAt = Date.parse(last.createdAt) || 0;
  const isRejected = rejectionCheckFor(thread.id, decisions);
  return fixups
    .filter((fixup) => !isRejected(fixup))
    .every((fixup) => repliedAt > (Date.parse(fixup.authoredAt) || 0));
}

function reviewerRepliedAfterApproval(thread: ThreadTurn, decisions: ReviewDecision[]): boolean {
  const last = thread.messages.at(-1);
  if (last?.author !== REVIEWER_AUTHOR) return false;
  const own = decisions.filter((decision) => decision.threadId === thread.id);
  const approval = latestOf(own, ['approved']);
  return approval !== undefined && (Date.parse(last.createdAt) || 0) > decidedAt(approval);
}

// The approved fixup is still in the range and the reviewer's reply came after it, whether before
// or after the approval.
function reviewerRepliedToApprovedFixup(
  thread: ThreadTurn,
  fixups: ThreadFixup[],
  decisions: ReviewDecision[],
): boolean {
  const isRejected = rejectionCheckFor(thread.id, decisions);
  return (
    fixups.some((fixup) => !isRejected(fixup)) && reviewerRepliedToFixup(thread, fixups, decisions)
  );
}

// Null when the next move on the thread is not the agent's. Without fixups (a review with no pinned
// commit) it is the agent's whenever the reviewer spoke last.
function agentTurnOn(
  thread: ThreadTurn,
  fixupsByThread: ReadonlyMap<string, ThreadFixup[]> | undefined,
  decisions: ReviewDecision[],
): (Pick<ThreadAwaitingAgent, 'state' | 'label'> & FixupsToDrop) | null {
  const deletion = latestOf(
    decisions.filter((decision) => decision.threadId === thread.id),
    ['deleted'],
  );
  if (deletion) return deletionTurnOn(thread, fixupsByThread, decisions, deletion);
  if (isThreadResolved(thread.id, decisions, fixupsByThread?.get(thread.id))) return null;
  const reviewerSpokeLast = thread.messages.at(-1)?.author === REVIEWER_AUTHOR;
  if (!fixupsByThread) return reviewerSpokeLast ? {} : null;

  const fixups = fixupsByThread.get(thread.id) ?? [];
  const state = deriveThreadReviewState(thread.id, fixups, decisions, thread);
  if (state === 'awaiting-fix') {
    return reviewerSpokeLast ? { state, label: reviewStateLabel(state) } : null;
  }
  if (state === 'awaiting-approval' || state === 'approved') {
    const replied =
      state === 'approved'
        ? reviewerRepliedAfterApproval(thread, decisions) ||
          reviewerRepliedToApprovedFixup(thread, fixups, decisions)
        : reviewerRepliedToFixup(thread, fixups, decisions);
    return replied ? { state, label: reviewStateLabel(state) } : null;
  }
  if (state !== 'rejected' && state !== 'withdrawn') return null;
  const rejectedFixupShas = rejectionAwaitingAgent(thread, fixups, decisions, state);
  if (rejectedFixupShas === null) return null;
  return { state, label: reviewStateLabel(state), ...fixupsToDrop(rejectedFixupShas) };
}

export function selectThreadsAwaitingAgent(
  threads: ThreadForAgent[],
  fixupsByThread: ReadonlyMap<string, ThreadFixup[]> | undefined,
  decisions: ReviewDecision[],
): ThreadAwaitingAgent[] {
  return threads.flatMap((thread): ThreadAwaitingAgent[] => {
    const turn = agentTurnOn(thread, fixupsByThread, decisions);
    if (!turn) return [];
    const last = thread.messages.at(-1);
    return [
      {
        threadId: thread.id,
        ...(isOnCommit(thread)
          ? { position: thread.position }
          : { filePath: thread.filePath, position: thread.position }),
        message: last?.body ?? '',
        ...(last?.answer ? { answer: { ...last.answer } } : {}),
        ...(last?.fixupLines ? { fixupLines: last.fixupLines } : {}),
        ...(thread.fixupTarget === undefined ? {} : { fixupTarget: thread.fixupTarget }),
        ...turn,
      },
    ];
  });
}

// An edit's fixup is the last one authored by the time of its message. Only the newest standing
// fixup is offered: one written after it may build on it, and the ones under it, which an edit on
// the card approved, go back to awaiting approval when it is reverted.
export function reviewerEditFixups(
  thread: { id: string } & ThreadMessages,
  fixups: ThreadFixup[],
  decisions: ReviewDecision[],
): ThreadFixup[] {
  const authoredAt = (fixup: ThreadFixup) => Date.parse(fixup.authoredAt) || 0;
  const written = new Set(
    (thread.messages ?? [])
      .filter(({ author }) => author === REVIEWER_EDIT_AUTHOR)
      .flatMap(({ createdAt }) => {
        const editedAt = Date.parse(createdAt ?? '') || 0;
        const latest = fixups
          .filter((fixup) => authoredAt(fixup) <= editedAt)
          .reduce<ThreadFixup | undefined>(
            (last, fixup) => (last && authoredAt(last) > authoredAt(fixup) ? last : fixup),
            undefined,
          );
        return latest ? [latest] : [];
      }),
  );
  const newest = pendingFixupsFor(thread.id, fixups, decisions).at(-1);
  return newest && written.has(newest) ? [newest] : [];
}

export function pendingFixupsFor(
  threadId: string,
  fixups: ThreadFixup[],
  decisions: ReviewDecision[],
): ThreadFixup[] {
  const isRejected = rejectionCheckFor(threadId, decisions);
  return fixups.filter((fixup) => !isRejected(fixup));
}

// Handed over since the agent's turn began, by the last message or rejection, and not answered yet.
export function isAgentResponding(
  thread: ThreadTurn,
  fixupsByThread: ReadonlyMap<string, ThreadFixup[]> | undefined,
  decisions: ReviewDecision[],
): boolean {
  const own = decisions.filter((decision) => decision.threadId === thread.id);
  const handover = latestOf(own, ['handed']);
  if (!handover) return false;
  if (!agentTurnOn(thread, fixupsByThread, decisions)) return false;
  return decidedAt(handover) >= turnStartOf(thread, own);
}
