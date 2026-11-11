import { describe, expect, it } from 'vitest';

import { REVIEWER_AUTHOR, type DiffCommentMessage, type ThreadFixup } from '../../types/diff';

import { newReviewerTurns, reviewerTurnOf } from './replyNotifications';

const message = (id: string, author: string, extra: Partial<DiffCommentMessage> = {}) =>
  ({
    id,
    body: `body ${id}`,
    author,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  }) as DiffCommentMessage;

const reviewer = message('m1', REVIEWER_AUTHOR);
const agent = (id: string, extra: Partial<DiffCommentMessage> = {}) =>
  message(id, 'agent:claude', extra);
const fixup = (sha: string): ThreadFixup =>
  ({ sha, patchId: sha, threadIds: ['t'] }) as ThreadFixup;

describe('reviewerTurnOf', () => {
  it('has no turn while the agent has not replied', () => {
    expect(reviewerTurnOf({ id: 't', messages: [reviewer] }, [], [])).toBeNull();
  });

  it('turns a spoken reply into an answered turn keyed by its message', () => {
    const turn = reviewerTurnOf(
      { id: 't', file: 'a.ts', messages: [reviewer, agent('m2')] },
      [],
      [],
    );
    expect(turn).toMatchObject({ threadId: 't', key: 'answered:m2', body: 'a.ts · body m2' });
  });

  it('turns a reply with choices into a choosing turn', () => {
    const choices = [{ id: 'c', name: 'x', description: 'd' }] as DiffCommentMessage['choices'];
    const turn = reviewerTurnOf(
      { id: 't', messages: [reviewer, agent('m2', { choices })] },
      [],
      [],
    );
    expect(turn?.key).toBe('choosing:m2');
  });

  it('turns an arrived fixup into an awaiting-approval turn keyed by its sha', () => {
    const turn = reviewerTurnOf(
      { id: 't', messages: [reviewer, agent('m2', { fixPending: true })] },
      [fixup('abc')],
      [],
    );
    expect(turn?.key).toBe('awaiting-approval:abc');
  });

  it('has no turn while the agent says a fix is coming', () => {
    expect(
      reviewerTurnOf({ id: 't', messages: [reviewer, agent('m2', { fixPending: true })] }, [], []),
    ).toBeNull();
  });
});

describe('newReviewerTurns', () => {
  const turn = (key: string) => ({ threadId: 't', key, title: '', body: '' });

  it('keeps turns whose key was not seen', () => {
    expect(newReviewerTurns(new Map(), [turn('a')])).toHaveLength(1);
    expect(newReviewerTurns(new Map([['t', 'a']]), [turn('a')])).toHaveLength(0);
    expect(newReviewerTurns(new Map([['t', 'a']]), [turn('b')])).toHaveLength(1);
  });
});
