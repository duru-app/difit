import type { DiffCommentMessage, ReviewDecision, ThreadFixup } from '../../types/diff';
import {
  deriveThreadReviewState,
  pendingFixupsFor,
  reviewStateLabel,
} from '../../utils/reviewDecisions';

export interface ReviewerTurn {
  threadId: string;
  key: string;
  title: string;
  body: string;
}

interface TurnThread {
  id: string;
  messages: DiffCommentMessage[];
  file?: string;
}

const SNIPPET_LENGTH = 80;

export function reviewerTurnOf(
  thread: TurnThread,
  fixups: ThreadFixup[],
  decisions: ReviewDecision[],
): ReviewerTurn | null {
  const state = deriveThreadReviewState(thread.id, fixups, decisions, thread);
  if (state !== 'answered' && state !== 'choosing' && state !== 'awaiting-approval') return null;

  const last = thread.messages.at(-1);
  const key =
    state === 'awaiting-approval'
      ? `${state}:${pendingFixupsFor(thread.id, fixups, decisions)
          .map(({ sha }) => sha)
          .join(',')}`
      : `${state}:${last?.id ?? ''}`;
  const snippet = (last?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH);
  return {
    threadId: thread.id,
    key,
    title: reviewStateLabel(state),
    body: [thread.file, snippet].filter(Boolean).join(' · '),
  };
}

export function newReviewerTurns(
  seenKeys: ReadonlyMap<string, string>,
  turns: readonly ReviewerTurn[],
): ReviewerTurn[] {
  return turns.filter((turn) => seenKeys.get(turn.threadId) !== turn.key);
}

export function canNotify(): boolean {
  return typeof Notification !== 'undefined' && window.isSecureContext;
}

export function requestNotificationPermission(): void {
  if (!canNotify() || Notification.permission !== 'default') return;
  try {
    void Promise.resolve(Notification.requestPermission()).catch(() => {});
  } catch {
    // An old Safari or a blocked prompt: the next click asks again.
  }
}

export function showReplyNotification(turn: ReviewerTurn, onClick: () => void): void {
  if (!canNotify() || Notification.permission !== 'granted') return;
  const notification = new Notification(turn.title, { body: turn.body, tag: turn.threadId });
  notification.onclick = () => {
    window.focus();
    notification.close();
    onClick();
  };
}
