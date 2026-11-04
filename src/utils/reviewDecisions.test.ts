import { describe, expect, it } from 'vitest';

import {
  AGENT_AUTHOR,
  REVIEWER_AUTHOR,
  REVIEWER_EDIT_AUTHOR,
  type ReviewDecision,
  type ThreadFixup,
} from '../types/diff';

import {
  appearsResolved,
  awaitsJudgmentOfReplacement,
  commentPanelStatus,
  deriveThreadReviewState,
  isAgentResponding,
  isAnswerableByEdit,
  isThreadDeleted,
  isThreadResolved,
  mergeReviewDecisions,
  normalizeReviewDecisions,
  pendingFixupsFor,
  reviewerEditFixups,
  reviewStateLabel,
  selectOpenThreads,
  selectThreadsAwaitingAgent,
} from './reviewDecisions';

const fixup = (
  sha: string,
  threadIds = ['t1'],
  authoredAt = '2026-01-01T00:00:00Z',
): ThreadFixup => ({
  sha,
  shortSha: sha.slice(0, 7),
  patchId: `patch-${sha}`,
  authoredAt,
  subject: 'fixup! x',
  threadIds,
  files: [],
});

const decision = (
  kind: ReviewDecision['kind'],
  fixupSha: string,
  at = '2026-01-01T00:00:00Z',
  threadId = 't1',
): ReviewDecision => ({ threadId, kind, fixupSha, at });

const openedByEdit = { messages: [{ author: REVIEWER_EDIT_AUTHOR }] };

describe('deriveThreadReviewState', () => {
  it('follows the latest of an approval and its undo', () => {
    const fixups = [fixup('a'.repeat(40))];
    const approved = decision('approved', 'a'.repeat(40), '2026-01-01T00:00:00Z');
    const undone = decision('unapproved', 'a'.repeat(40), '2026-01-01T00:01:00Z');
    const reapproved = decision('approved', 'a'.repeat(40), '2026-01-01T00:02:00Z');

    expect(deriveThreadReviewState('t1', fixups, [approved, undone])).toBe('awaiting-approval');
    expect(
      deriveThreadReviewState('t1', fixups, mergeReviewDecisions([undone], [reapproved])),
    ).toBe('approved');
  });

  it('keeps a re-approval when an older copy of the same approval is merged back in', () => {
    const fixups = [fixup('a'.repeat(40))];
    const first = decision('approved', 'a'.repeat(40), '2026-01-01T00:00:00Z');
    const undone = decision('unapproved', 'a'.repeat(40), '2026-01-01T00:01:00Z');
    const again = decision('approved', 'a'.repeat(40), '2026-01-01T00:02:00Z');

    const merged = mergeReviewDecisions([undone, again], [first, undone]);

    expect(deriveThreadReviewState('t1', fixups, merged)).toBe('approved');
  });

  it('orders decisions by time even when their timestamps are written differently', () => {
    const fixups = [fixup('a'.repeat(40))];
    const approved = decision('approved', 'a'.repeat(40), '2026-09-23T10:00:00.500Z');
    const undone = decision('unapproved', 'a'.repeat(40), '2026-09-23T19:00:01+09:00');

    expect(deriveThreadReviewState('t1', fixups, [approved, undone])).toBe('awaiting-approval');
    expect(
      mergeReviewDecisions(
        [decision('approved', 'b', '2026-09-23T10:00:00.500Z')],
        [decision('approved', 'b', '2026-09-23T10:00:00Z')],
      )[0]?.at,
    ).toBe('2026-09-23T10:00:00.500Z');
  });

  it('does not revive an undone approval when a stale list is merged back in', () => {
    const fixups = [fixup('a'.repeat(40))];
    const approved = decision('approved', 'a'.repeat(40), '2026-01-01T00:00:00Z');
    const undone = decision('unapproved', 'a'.repeat(40), '2026-01-01T00:01:00Z');

    const merged = mergeReviewDecisions([approved, undone], [approved]);

    expect(deriveThreadReviewState('t1', fixups, merged)).toBe('awaiting-approval');
  });

  it('keeps a rejected fixup rejected after a rebase rewrites its sha', () => {
    const rejected = { ...fixup('a'.repeat(40)), patchId: 'same-change' };
    const rewritten = { ...fixup('b'.repeat(40)), patchId: 'same-change' };
    const decisions = [{ ...decision('rejected', rejected.sha), patchId: 'same-change' }];

    expect(deriveThreadReviewState('t1', [rewritten], decisions)).toBe('rejected');

    const answer = fixup('c'.repeat(40));
    expect(deriveThreadReviewState('t1', [rewritten, answer], decisions)).toBe('awaiting-approval');
    expect(pendingFixupsFor('t1', [rewritten, answer], decisions)).toEqual([answer]);
  });

  it('is awaiting-fix with no fixup and no decision', () => {
    expect(deriveThreadReviewState('t1', [], [])).toBe('awaiting-fix');
  });

  it('is awaiting-approval once a fixup arrives', () => {
    expect(deriveThreadReviewState('t1', [fixup('aaaa')], [])).toBe('awaiting-approval');
  });

  it('is rejected after rejecting the only fixup, then awaiting-approval when a new one arrives', () => {
    const rejected = [decision('rejected', 'aaaa')];
    expect(deriveThreadReviewState('t1', [fixup('aaaa')], rejected)).toBe('rejected');
    expect(deriveThreadReviewState('t1', [], rejected)).toBe('rejected');
    expect(deriveThreadReviewState('t1', [fixup('aaaa'), fixup('bbbb')], rejected)).toBe(
      'awaiting-approval',
    );
  });

  it('is approved while the record exists and folded once a fold record lands', () => {
    expect(deriveThreadReviewState('t1', [fixup('aaaa')], [decision('approved', 'aaaa')])).toBe(
      'approved',
    );
    expect(
      deriveThreadReviewState(
        't1',
        [],
        [decision('approved', 'aaaa'), decision('folded', 'aaaa', '2026-01-02T00:00:00Z')],
      ),
    ).toBe('folded');
  });

  it('asks for approval again when a fixup other than the approved one is waiting', () => {
    const approved = [decision('approved', 'aaaa')];

    expect(deriveThreadReviewState('t1', [fixup('bbbb')], approved)).toBe('awaiting-approval');
    expect(pendingFixupsFor('t1', [fixup('bbbb')], approved).map(({ sha }) => sha)).toEqual([
      'bbbb',
    ]);
    expect(deriveThreadReviewState('t1', [fixup('aaaa'), fixup('bbbb')], approved)).toBe(
      'awaiting-approval',
    );
  });

  it('is approved once every fixup still standing was approved together', () => {
    const fixups = [fixup('aaaa'), fixup('bbbb'), fixup('cccc')];
    const bundle = [
      decision('rejected', 'cccc', '2026-01-01T00:00:00Z'),
      decision('approved', 'aaaa', '2026-01-02T00:00:00Z'),
      decision('approved', 'bbbb', '2026-01-02T00:00:00Z'),
    ];

    expect(deriveThreadReviewState('t1', fixups, bundle)).toBe('approved');
  });

  it('asks again when only an earlier approval covers some of the fixups', () => {
    const fixups = [fixup('aaaa'), fixup('bbbb')];
    const earlier = decision('approved', 'aaaa', '2026-01-01T00:00:00Z');
    const later = decision('approved', 'bbbb', '2026-01-02T00:00:00Z');

    expect(deriveThreadReviewState('t1', fixups, [earlier])).toBe('awaiting-approval');
    expect(deriveThreadReviewState('t1', fixups, [earlier, later])).toBe('awaiting-approval');
  });

  it('drops the whole approval when one fixup of it is rejected later', () => {
    const fixups = [fixup('aaaa'), fixup('bbbb')];
    const decisions = [
      decision('approved', 'aaaa', '2026-01-01T00:00:00Z'),
      decision('approved', 'bbbb', '2026-01-01T00:00:00Z'),
      decision('rejected', 'aaaa', '2026-01-02T00:00:00Z'),
    ];

    expect(deriveThreadReviewState('t1', fixups, decisions)).toBe('awaiting-approval');
  });

  it('undoes the whole approval with one undo record', () => {
    const fixups = [fixup('aaaa'), fixup('bbbb')];
    const decisions = [
      decision('approved', 'aaaa', '2026-01-01T00:00:00Z'),
      decision('approved', 'bbbb', '2026-01-01T00:00:00Z'),
      decision('unapproved', 'bbbb', '2026-01-02T00:00:00Z'),
    ];

    expect(deriveThreadReviewState('t1', fixups, decisions)).toBe('awaiting-approval');
  });

  it('keeps an approval after a rebase rewrites the approved fixup’s sha', () => {
    const rewritten = { ...fixup('b'.repeat(40)), patchId: 'same-change' };
    const approved = [{ ...decision('approved', 'a'.repeat(40)), patchId: 'same-change' }];

    expect(deriveThreadReviewState('t1', [rewritten], approved)).toBe('approved');
  });

  it('keeps an approval while the approved fixup is folded and before the fold record lands', () => {
    expect(deriveThreadReviewState('t1', [], [decision('approved', 'aaaa')])).toBe('approved');
  });

  it('lets a rejection made after the approval of the same fixup win', () => {
    const approved = decision('approved', 'aaaa', '2026-01-01T00:00:00Z');
    const rejected = decision('rejected', 'aaaa', '2026-01-02T00:00:00Z');
    expect(deriveThreadReviewState('t1', [fixup('aaaa')], [approved, rejected])).toBe('rejected');
    expect(deriveThreadReviewState('t1', [fixup('aaaa')], [approved, rejected], openedByEdit)).toBe(
      'withdrawn',
    );
  });

  it('closes a thread the reviewer opened by editing once its fixup is rejected', () => {
    const rejected = [decision('rejected', 'aaaa')];
    expect(deriveThreadReviewState('t1', [fixup('aaaa')], rejected, openedByEdit)).toBe(
      'withdrawn',
    );
    expect(deriveThreadReviewState('t1', [], rejected, openedByEdit)).toBe('withdrawn');
    expect(deriveThreadReviewState('t1', [fixup('aaaa')], [], openedByEdit)).toBe(
      'awaiting-approval',
    );
  });

  it('hands a thread back to the reviewer once the agent answers it in words', () => {
    const asked = { messages: [{ author: REVIEWER_AUTHOR }] };
    const answered = { messages: [...asked.messages, { author: AGENT_AUTHOR }] };
    expect(deriveThreadReviewState('t1', [], [], asked)).toBe('awaiting-fix');
    expect(deriveThreadReviewState('t1', [], [], answered)).toBe('answered');
    expect(
      deriveThreadReviewState('t1', [], [], {
        messages: [...answered.messages, { author: REVIEWER_AUTHOR }],
      }),
    ).toBe('awaiting-fix');
    expect(deriveThreadReviewState('t1', [fixup('aaaa')], [], answered)).toBe('awaiting-approval');
  });

  it('waits for the reviewer to pick while the agent’s last reply offers choices', () => {
    const asked = { messages: [{ author: REVIEWER_AUTHOR }] };
    const offered = {
      messages: [...asked.messages, { author: AGENT_AUTHOR, choices: [{ id: 'A' }] }],
    };
    expect(deriveThreadReviewState('t1', [], [], offered)).toBe('choosing');
    expect(reviewStateLabel('choosing')).toBe('선택 대기');
    expect(
      deriveThreadReviewState('t1', [], [], {
        messages: [...offered.messages, { author: REVIEWER_AUTHOR }],
      }),
    ).toBe('awaiting-fix');
    expect(
      deriveThreadReviewState('t1', [], [], {
        messages: [...offered.messages, { author: REVIEWER_EDIT_AUTHOR }],
      }),
    ).toBe('awaiting-fix');
  });

  it('keeps waiting for the pick after a later agent reply without choices', () => {
    const offered = [
      { author: REVIEWER_AUTHOR },
      { author: AGENT_AUTHOR, choices: [{ id: 'A' }] },
      { author: AGENT_AUTHOR },
    ];
    expect(deriveThreadReviewState('t1', [], [], { messages: offered })).toBe('choosing');
    expect(
      deriveThreadReviewState('t1', [], [], {
        messages: [...offered.slice(0, 2), { author: REVIEWER_AUTHOR }, { author: AGENT_AUTHOR }],
      }),
    ).toBe('answered');
  });

  describe('a reply that says a fixup follows', () => {
    const promised = [{ author: REVIEWER_AUTHOR }, { author: AGENT_AUTHOR, fixPending: true }];

    it('shows the thread as being fixed, not answered', () => {
      expect(deriveThreadReviewState('t1', [], [], { messages: promised })).toBe('fix-pending');
      expect(reviewStateLabel('fix-pending')).toBe('수정 중');
      expect(isAnswerableByEdit('fix-pending')).toBe(true);
    });

    it('follows the agent’s latest reply: one without the mark takes it back', () => {
      expect(
        deriveThreadReviewState('t1', [], [], {
          messages: [...promised, { author: AGENT_AUTHOR }],
        }),
      ).toBe('answered');
      expect(
        deriveThreadReviewState('t1', [], [], {
          messages: [
            ...promised,
            { author: AGENT_AUTHOR },
            { author: AGENT_AUTHOR, fixPending: true },
          ],
        }),
      ).toBe('fix-pending');
    });

    it('closes choices the reviewer has not picked from yet', () => {
      expect(
        deriveThreadReviewState('t1', [], [], {
          messages: [
            { author: REVIEWER_AUTHOR },
            { author: AGENT_AUTHOR, choices: [{ id: 'A' }] },
            { author: AGENT_AUTHOR, fixPending: true },
          ],
        }),
      ).toBe('fix-pending');
    });

    it('moves on when the fixup arrives or the reviewer replies', () => {
      expect(deriveThreadReviewState('t1', [fixup('aaaa')], [], { messages: promised })).toBe(
        'awaiting-approval',
      );
      expect(
        deriveThreadReviewState('t1', [], [], {
          messages: [...promised, { author: REVIEWER_AUTHOR }],
        }),
      ).toBe('awaiting-fix');
    });

    it('does not carry a promise made before the reviewer’s latest reply', () => {
      expect(
        deriveThreadReviewState('t1', [], [], {
          messages: [...promised, { author: REVIEWER_AUTHOR }, { author: AGENT_AUTHOR }],
        }),
      ).toBe('answered');
    });
  });

  it('counts any author other than the reviewer and the reviewer’s edits as the agent', () => {
    expect(
      deriveThreadReviewState('t1', [], [], {
        messages: [{ author: REVIEWER_AUTHOR }, { author: 'claude' }],
      }),
    ).toBe('answered');
  });

  it('keeps a thread the agent opened itself waiting for a fix', () => {
    expect(deriveThreadReviewState('t1', [], [], { messages: [{ author: AGENT_AUTHOR }] })).toBe(
      'awaiting-fix',
    );
    expect(deriveThreadReviewState('t1', [], [], { messages: [{}] })).toBe('awaiting-fix');
  });

  it('ignores other threads’ decisions', () => {
    expect(
      deriveThreadReviewState(
        't1',
        [fixup('aaaa')],
        [decision('rejected', 'aaaa', undefined, 't2')],
      ),
    ).toBe('awaiting-approval');
  });
});

describe('reviewStateLabel', () => {
  it('names each state the way the screen chip does', () => {
    expect(reviewStateLabel('awaiting-fix')).toBe('답변 대기');
    expect(reviewStateLabel('awaiting-approval')).toBe('승인 대기');
    expect(reviewStateLabel('approved')).toBe('승인됨');
    expect(reviewStateLabel('folded')).toBe('접힘');
    expect(reviewStateLabel('rejected')).toBe('다시 수정 중');
    expect(reviewStateLabel('withdrawn')).toBe('되돌림');
    expect(reviewStateLabel('answered')).toBe('답변 완료');
  });

  it('tells a rejected thread apart from one still waiting for its first fixup', () => {
    const rejected = [decision('rejected', 'aaaa')];
    expect(reviewStateLabel(deriveThreadReviewState('t1', [], rejected))).toBe('다시 수정 중');
    expect(reviewStateLabel(deriveThreadReviewState('t1', [], []))).toBe('답변 대기');
  });
});

describe('isThreadResolved', () => {
  const resolved = (at: string) => decision('resolved', '', at);
  const reopened = (at: string) => decision('unresolved', '', at);

  it('follows the later of a resolution and a reopening', () => {
    expect(isThreadResolved('t1', [])).toBe(false);
    expect(isThreadResolved('t1', [resolved('2026-01-01T00:00:00Z')])).toBe(true);
    expect(
      isThreadResolved('t1', [resolved('2026-01-01T00:00:00Z'), reopened('2026-01-01T00:01:00Z')]),
    ).toBe(false);
  });

  it('keeps the last press after resolving and reopening several times', () => {
    let decisions: ReviewDecision[] = [];
    const presses = [resolved, reopened, resolved, reopened, resolved];
    presses.forEach((press, minute) => {
      decisions = mergeReviewDecisions(decisions, [press(`2026-01-01T00:0${minute}:00Z`)]);
    });
    expect(isThreadResolved('t1', decisions)).toBe(true);
    decisions = mergeReviewDecisions(decisions, [reopened('2026-01-01T00:09:00Z')]);
    expect(isThreadResolved('t1', decisions)).toBe(false);
  });

  it('ignores other threads’ resolutions', () => {
    expect(isThreadResolved('t1', [decision('resolved', '', undefined, 't2')])).toBe(false);
  });
});

describe('appearsResolved', () => {
  const at = (minute: number) => `2026-01-01T00:0${minute}:00Z`;
  const approved = (minute: number, sha = 'aaaa') => decision('approved', sha, at(minute));
  const mark = (kind: 'resolved' | 'unresolved', minute: number) => decision(kind, '', at(minute));

  it('follows the manual marks when nothing was approved or folded', () => {
    expect(appearsResolved('t1', [], [])).toBe(false);
    expect(appearsResolved('t1', [], [mark('resolved', 0)])).toBe(true);
    expect(appearsResolved('t1', [], [mark('resolved', 0), mark('unresolved', 1)])).toBe(false);
  });

  it('shows an approved thread as resolved without a manual mark', () => {
    expect(appearsResolved('t1', [fixup('aaaa')], [approved(0)])).toBe(true);
  });

  it('shows an approval of several fixups at once as resolved', () => {
    const bundle = [fixup('aaaa'), fixup('bbbb')];
    expect(appearsResolved('t1', bundle, [approved(0), approved(0, 'bbbb')])).toBe(true);
  });

  it('reopens an approved thread when the check is pressed after the approval, keeping the approval', () => {
    const decisions = [approved(0), mark('unresolved', 1)];
    expect(appearsResolved('t1', [fixup('aaaa')], decisions)).toBe(false);
    expect(deriveThreadReviewState('t1', [fixup('aaaa')], decisions)).toBe('approved');
    expect(appearsResolved('t1', [fixup('aaaa')], [...decisions, mark('resolved', 2)])).toBe(true);
  });

  it('shows the thread resolved again when it is approved after being reopened', () => {
    const decisions = [mark('resolved', 0), mark('unresolved', 1), approved(2)];
    expect(appearsResolved('t1', [fixup('aaaa')], decisions)).toBe(true);
  });

  it('falls back to the manual mark once the approval is undone', () => {
    const undone = [approved(1), decision('unapproved', '', at(2))];
    expect(appearsResolved('t1', [fixup('aaaa')], undone)).toBe(false);
    expect(appearsResolved('t1', [fixup('aaaa')], [mark('resolved', 0), ...undone])).toBe(true);
  });

  it('stops counting an approval that a later rejection voided', () => {
    const decisions = [approved(0), decision('rejected', 'aaaa', at(1))];
    expect(appearsResolved('t1', [fixup('aaaa')], decisions)).toBe(false);
  });

  it('keeps a thread open while a fixup the approval does not cover waits for judgment', () => {
    expect(appearsResolved('t1', [fixup('cccc')], [approved(0)])).toBe(false);
  });

  it('shows a folded thread as resolved until the check reopens it', () => {
    const folded = decision('folded', 'aaaa', at(0));
    expect(appearsResolved('t1', [], [folded])).toBe(true);
    expect(appearsResolved('t1', [], [folded, mark('unresolved', 1)])).toBe(false);
  });

  it('leaves the manual mark alone, so what is handed to the agent does not change', () => {
    expect(isThreadResolved('t1', [approved(0)])).toBe(false);
  });

  it('ignores other threads’ records', () => {
    expect(
      appearsResolved('t1', [fixup('aaaa')], [decision('approved', 'aaaa', at(0), 't2')]),
    ).toBe(false);
  });
});

describe('a fixup amended after its approval', () => {
  const at = (minute: number) => `2026-01-01T00:0${minute}:00Z`;
  const approvedA = { ...decision('approved', 'aaaa', at(0)), patchId: 'patch-aaaa' };
  const resolved = decision('resolved', '', at(1));
  const amended = fixup('bbbb');

  it('reopens on both sides even though the thread was resolved after the approval', () => {
    const decisions = [approvedA, resolved];
    expect(appearsResolved('t1', [fixup('aaaa')], decisions)).toBe(true);

    expect(appearsResolved('t1', [amended], decisions)).toBe(false);
    expect(isThreadResolved('t1', decisions, [amended])).toBe(false);
    expect(deriveThreadReviewState('t1', [amended], decisions)).toBe('awaiting-approval');
    expect(awaitsJudgmentOfReplacement('t1', [amended], decisions)).toBe(true);
  });

  it('stays open when the check is pressed again before the new fixup is judged', () => {
    const decisions = [approvedA, resolved, decision('resolved', '', at(3))];
    expect(appearsResolved('t1', [amended], decisions)).toBe(false);
  });

  it('closes again once the amended fixup is approved', () => {
    const decisions = [approvedA, resolved, decision('approved', 'bbbb', at(3))];
    expect(awaitsJudgmentOfReplacement('t1', [amended], decisions)).toBe(false);
    expect(appearsResolved('t1', [amended], decisions)).toBe(true);
    expect(isThreadResolved('t1', decisions, [amended])).toBe(true);
  });

  it('hands the reviewer’s rejection of the amended fixup to the agent', () => {
    const decisions = [approvedA, resolved, decision('rejected', 'bbbb', at(3))];
    expect(deriveThreadReviewState('t1', [amended], decisions)).toBe('rejected');
    const thread = {
      id: 't1',
      filePath: 'a.ts',
      position: { side: 'new' as const, line: 1 },
      messages: [
        { id: 'm1', body: 'fix', author: REVIEWER_AUTHOR, createdAt: at(0), updatedAt: at(0) },
      ],
    };
    expect(
      selectThreadsAwaitingAgent([thread], new Map([['t1', [amended]]]), decisions),
    ).toMatchObject([{ threadId: 't1', state: 'rejected', rejectedFixupSha: 'bbbb' }]);
  });

  it('hands the reviewer’s reply on the amended fixup to the agent', () => {
    const thread = {
      id: 't1',
      filePath: 'a.ts',
      position: { side: 'new' as const, line: 1 },
      messages: [
        { id: 'm1', body: 'fix', author: REVIEWER_AUTHOR, createdAt: at(0), updatedAt: at(0) },
        {
          id: 'm2',
          body: 'still off',
          author: REVIEWER_AUTHOR,
          createdAt: at(4),
          updatedAt: at(4),
        },
      ],
    };
    expect(
      selectThreadsAwaitingAgent([thread], new Map([['t1', [amended]]]), [approvedA, resolved]),
    ).toMatchObject([{ threadId: 't1', state: 'awaiting-approval' }]);
  });

  it('keeps the approval when only the message or the base changed', () => {
    const reworded = { ...fixup('cccc'), patchId: 'patch-aaaa' };
    const decisions = [approvedA, resolved];
    expect(awaitsJudgmentOfReplacement('t1', [reworded], decisions)).toBe(false);
    expect(appearsResolved('t1', [reworded], decisions)).toBe(true);
  });

  it('keeps a resolution made without any approval', () => {
    expect(appearsResolved('t1', [amended], [resolved])).toBe(true);
    expect(isThreadResolved('t1', [resolved], [amended])).toBe(true);
  });

  it('keeps the resolution once the approval was undone', () => {
    const undone = [
      approvedA,
      decision('unapproved', 'aaaa', at(2)),
      decision('resolved', '', at(3)),
    ];
    expect(appearsResolved('t1', [amended], undone)).toBe(true);
  });

  it('leaves an approved fixup that is being folded alone', () => {
    expect(awaitsJudgmentOfReplacement('t1', [], [approvedA, resolved])).toBe(false);
    expect(appearsResolved('t1', [], [approvedA, resolved])).toBe(true);
  });

  it('lets the reviewer resolve again once the amended fixup is rejected', () => {
    const rejected = [approvedA, resolved, decision('rejected', 'bbbb', at(3))];
    expect(awaitsJudgmentOfReplacement('t1', [amended], rejected)).toBe(false);
    expect(appearsResolved('t1', [amended], rejected)).toBe(false);

    const resolvedAgain = [...rejected, decision('resolved', '', at(4))];
    expect(appearsResolved('t1', [amended], resolvedAgain)).toBe(true);
    expect(isThreadResolved('t1', resolvedAgain, [amended])).toBe(true);
  });

  it('stays open when another fixup follows the rejected one', () => {
    const decisions = [
      approvedA,
      resolved,
      decision('rejected', 'bbbb', at(3)),
      decision('resolved', '', at(4)),
    ];
    const next = [amended, fixup('cccc')];
    expect(awaitsJudgmentOfReplacement('t1', next, decisions)).toBe(true);
    expect(appearsResolved('t1', next, decisions)).toBe(false);
  });

  it('leaves a folded thread to the fold record when a new fixup arrives', () => {
    const folded = [
      approvedA,
      decision('folded', 'aaaa', at(2)),
      decision('unresolved', '', at(3)),
    ];
    expect(awaitsJudgmentOfReplacement('t1', [fixup('dddd')], folded)).toBe(false);
    expect(
      appearsResolved('t1', [fixup('dddd')], [...folded, decision('resolved', '', at(4))]),
    ).toBe(true);
  });
});

describe('selectOpenThreads', () => {
  const threads = ['open', 'answered', 'rejected', 'retried', 'approved', 'folded'].map((id) => ({
    id,
  }));
  const fixupsByThread = new Map([
    ['answered', [fixup('aaaa', ['answered'])]],
    ['retried', [fixup('bbbb', ['retried']), fixup('cccc', ['retried'])]],
    ['approved', [fixup('dddd', ['approved'])]],
  ]);
  const decisions = [
    decision('rejected', 'zzzz', undefined, 'rejected'),
    decision('rejected', 'bbbb', undefined, 'retried'),
    decision('approved', 'dddd', undefined, 'approved'),
    decision('folded', 'eeee', undefined, 'folded'),
  ];

  it('keeps only threads still waiting for a fix or rejected without a new one', () => {
    expect(selectOpenThreads(threads, fixupsByThread, decisions).map((t) => t.id)).toEqual([
      'open',
      'rejected',
    ]);
  });

  it('leaves out a rejected thread the reviewer opened by editing', () => {
    const edited = {
      id: 'edited',
      messages: [{ author: REVIEWER_EDIT_AUTHOR }],
    };
    const edits = [decision('rejected', 'ffff', undefined, 'edited')];
    expect(selectOpenThreads([edited], new Map(), edits)).toEqual([]);
    expect(
      selectOpenThreads([{ ...edited, messages: [{ author: 'User' }] }], new Map(), edits),
    ).toHaveLength(1);
  });

  it('leaves out a resolved thread until it is reopened', () => {
    const resolution = decision('resolved', '', '2026-01-01T00:00:00Z', 'open');
    expect(
      selectOpenThreads(threads, fixupsByThread, [...decisions, resolution]).map((t) => t.id),
    ).toEqual(['rejected']);
    const reopening = decision('unresolved', '', '2026-01-01T00:01:00Z', 'open');
    expect(
      selectOpenThreads(threads, fixupsByThread, [...decisions, resolution, reopening]).map(
        (t) => t.id,
      ),
    ).toEqual(['open', 'rejected']);
  });

  it('leaves out a thread the agent answered in words until the reviewer speaks again', () => {
    const asked = { id: 'asked', messages: [{ author: REVIEWER_AUTHOR }] };
    const answered = { ...asked, messages: [...asked.messages, { author: AGENT_AUTHOR }] };
    expect(selectOpenThreads([answered], new Map(), [])).toEqual([]);
    expect(
      selectOpenThreads(
        [{ ...answered, messages: [...answered.messages, { author: REVIEWER_AUTHOR }] }],
        new Map(),
        [],
      ),
    ).toHaveLength(1);
  });

  it('returns nothing when every thread has been answered or settled', () => {
    const settled = threads.filter((t) => t.id !== 'open' && t.id !== 'rejected');
    expect(selectOpenThreads(settled, fixupsByThread, decisions)).toEqual([]);
    expect(selectOpenThreads([], fixupsByThread, decisions)).toEqual([]);
  });
});

describe('commentPanelStatus', () => {
  const asked = { messages: [{ author: REVIEWER_AUTHOR }] };
  const answeredInWords = { messages: [{ author: REVIEWER_AUTHOR }, { author: AGENT_AUTHOR }] };
  const status = (
    id: string,
    fixups: ThreadFixup[],
    decisions: ReviewDecision[],
    thread: { messages: { author?: string; choices?: unknown[]; fixPending?: boolean }[] } = asked,
  ) => commentPanelStatus({ id, ...thread }, fixups, decisions);

  it('shows it as the reviewer’s pick while the agent’s reply offers choices', () => {
    const offered = { messages: [...asked.messages, { author: AGENT_AUTHOR, choices: [{}] }] };
    expect(status('t1', [], [], offered)).toBe('choosing');
    expect(status('t1', [], [decision('resolved', '')], offered)).toBe('resolved');
  });

  it('shows it apart from open and answered once the agent said a fixup follows', () => {
    const promised = { messages: [...asked.messages, { author: AGENT_AUTHOR, fixPending: true }] };
    expect(status('t1', [], [], promised)).toBe('fixing');
    expect(status('t1', [], [decision('resolved', '')], promised)).toBe('resolved');
  });

  it('shows it as open when the move is the agent: no answer yet, or the fixup was rejected', () => {
    expect(status('t1', [], [])).toBe('open');
    expect(status('t1', [], [decision('rejected', 'aaaa')])).toBe('open');
  });

  it('shows it as answered when the move is the reviewer: a reply in words, or a fixup to approve', () => {
    expect(status('t1', [], [], answeredInWords)).toBe('answered');
    expect(status('t1', [fixup('aaaa')], [])).toBe('answered');
  });

  it('shows a settled thread as resolved: resolved, approved, folded or withdrawn', () => {
    expect(status('t1', [], [decision('resolved', '')])).toBe('resolved');
    expect(status('t1', [fixup('aaaa')], [decision('approved', 'aaaa')])).toBe('resolved');
    expect(status('t1', [], [decision('folded', 'aaaa')])).toBe('resolved');
    expect(status('t1', [], [decision('rejected', 'aaaa')], openedByEdit)).toBe('resolved');
  });

  it('shows a resolved thread as resolved whatever its fixup state, until it is reopened', () => {
    const resolution = decision('resolved', '', '2026-01-01T00:00:00Z');
    expect(status('t1', [fixup('aaaa')], [resolution])).toBe('resolved');
    const reopening = decision('unresolved', '', '2026-01-01T00:01:00Z');
    expect(status('t1', [fixup('aaaa')], [resolution, reopening])).toBe('answered');
  });

  it('shows an approved or folded thread reopened with the check as the reviewer’s move', () => {
    const reopening = decision('unresolved', '', '2026-01-01T00:01:00Z');
    expect(status('t1', [fixup('aaaa')], [decision('approved', 'aaaa'), reopening])).toBe(
      'answered',
    );
    expect(status('t1', [], [decision('folded', 'aaaa'), reopening])).toBe('answered');
  });

  it('gives a deleted thread no status, so the panel leaves it out', () => {
    expect(status('t1', [], [decision('deleted', '')])).toBeNull();
  });

  it('counts as open exactly the threads the open count holds', () => {
    const threads = [
      { id: 'a', ...asked },
      { id: 'b', ...answeredInWords },
      { id: 'c', ...asked },
      { id: 'd', ...asked },
      { id: 'e', ...asked },
    ];
    const fixupsByThread = new Map([['c', [fixup('cccc', ['c'])]]]);
    const decisions = [
      decision('rejected', 'dddd', undefined, 'd'),
      decision('resolved', '', undefined, 'e'),
    ];
    const open = threads.filter(
      (thread) =>
        commentPanelStatus(thread, fixupsByThread.get(thread.id) ?? [], decisions) === 'open',
    );
    expect(open).toEqual(selectOpenThreads(threads, fixupsByThread, decisions));
    expect(open.map(({ id }) => id)).toEqual(['a', 'd']);
  });
});

describe('reviewerEditFixups', () => {
  const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
  const reviewerEdit = (minute: number) => ({
    author: REVIEWER_EDIT_AUTHOR,
    createdAt: at(minute),
  });
  const shas = (fixups: ThreadFixup[]) => fixups.map(({ sha }) => sha);

  it('takes the fixup the edit wrote just before its message', () => {
    const thread = {
      id: 't1',
      messages: [{ author: REVIEWER_AUTHOR, createdAt: at(0) }, reviewerEdit(1)],
    };
    const edited = fixup('eeee', ['t1'], '2026-01-01T00:01:00Z');

    expect(shas(reviewerEditFixups(thread, [edited], []))).toEqual(['eeee']);
    expect(
      shas(
        reviewerEditFixups(
          { id: 't1', messages: [{ author: REVIEWER_AUTHOR, createdAt: at(0) }] },
          [edited],
          [],
        ),
      ),
    ).toEqual([]);
  });

  it('leaves out an agent fixup that answered after the edit was reverted', () => {
    const thread = {
      id: 't1',
      messages: [{ author: REVIEWER_AUTHOR, createdAt: at(0) }, reviewerEdit(1)],
    };
    const edited = fixup('eeee', ['t1'], '2026-01-01T00:01:00Z');
    const agents = fixup('bbbb', ['t1'], '2026-01-01T00:05:00Z');
    const decisions = [decision('rejected', 'eeee', at(2)), decision('approved', 'bbbb', at(6))];

    expect(reviewerEditFixups(thread, [edited, agents], decisions)).toEqual([]);
    expect(reviewerEditFixups(thread, [agents], decisions)).toEqual([]);
  });

  it('keeps the edited fixup after its approval is undone and given again', () => {
    const thread = {
      id: 't1',
      messages: [{ author: REVIEWER_AUTHOR, createdAt: at(0) }, reviewerEdit(1)],
    };
    const edited = fixup('eeee', ['t1'], '2026-01-01T00:01:00Z');
    const decisions = mergeReviewDecisions(
      [decision('approved', 'eeee', at(1)), decision('unapproved', '', at(2))],
      [decision('approved', 'eeee', at(3))],
    );

    expect(shas(reviewerEditFixups(thread, [edited], decisions))).toEqual(['eeee']);
  });

  it('offers nothing while an agent fixup written on top of the edit also stands', () => {
    const thread = {
      id: 't1',
      messages: [{ author: REVIEWER_AUTHOR, createdAt: at(0) }, reviewerEdit(1)],
    };
    const fixups = [
      fixup('eeee', ['t1'], '2026-01-01T00:01:00Z'),
      fixup('aaaa', ['t1'], '2026-01-01T00:05:00Z'),
    ];
    const decisions = [decision('approved', 'eeee', at(6)), decision('approved', 'aaaa', at(6))];

    expect(reviewerEditFixups(thread, fixups, decisions)).toEqual([]);
    expect(
      shas(reviewerEditFixups(thread, fixups, [...decisions, decision('rejected', 'aaaa', at(7))])),
    ).toEqual(['eeee']);
  });

  it('pairs a second edit with its own fixup, not the agent fixup rejected before it', () => {
    const thread = {
      id: 't1',
      messages: [{ author: REVIEWER_AUTHOR, createdAt: at(0) }, reviewerEdit(1), reviewerEdit(9)],
    };
    const fixups = [
      fixup('eeee', ['t1'], '2026-01-01T00:01:00Z'),
      fixup('bbbb', ['t1'], '2026-01-01T00:05:00Z'),
      fixup('ffff', ['t1'], '2026-01-01T00:09:00Z'),
    ];
    const decisions = [decision('rejected', 'eeee', at(2)), decision('rejected', 'bbbb', at(8))];

    expect(shas(reviewerEditFixups(thread, fixups, decisions))).toEqual(['ffff']);
  });

  it('offers only the edit stacked on the agent fixup, which then waits for approval again', () => {
    const thread = {
      id: 't1',
      messages: [{ author: REVIEWER_AUTHOR, createdAt: at(0) }, reviewerEdit(9)],
    };
    const fixups = [
      fixup('aaaa', ['t1'], '2026-01-01T00:05:00Z'),
      fixup('eeee', ['t1'], '2026-01-01T00:09:00Z'),
    ];
    const approved = [decision('approved', 'aaaa', at(9)), decision('approved', 'eeee', at(9))];

    expect(deriveThreadReviewState('t1', fixups, approved, thread)).toBe('approved');
    expect(shas(reviewerEditFixups(thread, fixups, approved))).toEqual(['eeee']);

    const reverted = [...approved, decision('rejected', 'eeee', at(10))];
    expect(deriveThreadReviewState('t1', fixups, reverted, thread)).toBe('awaiting-approval');
    expect(shas(pendingFixupsFor('t1', fixups, reverted))).toEqual(['aaaa']);
    expect(reviewerEditFixups(thread, fixups, reverted)).toEqual([]);
  });
});

describe('pendingFixupsFor', () => {
  it('returns the fixups not yet rejected, oldest first', () => {
    const shas = (fixups: ThreadFixup[]) => fixups.map(({ sha }) => sha);
    expect(shas(pendingFixupsFor('t1', [fixup('aaaa')], []))).toEqual(['aaaa']);
    expect(
      shas(
        pendingFixupsFor(
          't1',
          [fixup('aaaa'), fixup('bbbb'), fixup('cccc')],
          [decision('rejected', 'bbbb')],
        ),
      ),
    ).toEqual(['aaaa', 'cccc']);
    expect(pendingFixupsFor('t1', [], [])).toEqual([]);
  });
});

describe('mergeReviewDecisions', () => {
  it('unions by thread, kind and fixup, keeping the later copy and sorting by time', () => {
    const merged = mergeReviewDecisions(
      [decision('approved', 'aaaa', '2026-01-03T00:00:00Z')],
      [
        decision('rejected', 'zzzz', '2026-01-01T00:00:00Z'),
        decision('approved', 'aaaa', '2026-01-02T00:00:00Z'),
      ],
    );
    expect(merged.map((d) => [d.kind, d.at])).toEqual([
      ['rejected', '2026-01-01T00:00:00Z'],
      ['approved', '2026-01-03T00:00:00Z'],
    ]);
  });
});

describe('normalizeReviewDecisions', () => {
  it('drops entries that are not decisions', () => {
    expect(
      normalizeReviewDecisions([
        decision('approved', 'aaaa'),
        { threadId: 't1', kind: 'nope', fixupSha: 'a', at: 'x' },
        'garbage',
        null,
      ]),
    ).toHaveLength(1);
    expect(normalizeReviewDecisions(undefined)).toEqual([]);
  });

  it('keeps resolutions and reopenings, which name no fixup', () => {
    const records = [decision('resolved', ''), decision('unresolved', '')];
    expect(normalizeReviewDecisions(records)).toEqual(records);
  });

  it('keeps only the fields a decision has and drops a mistyped optional field', () => {
    expect(
      normalizeReviewDecisions([{ ...decision('approved', 'aaaa'), patchId: 'p', extra: 'x' }]),
    ).toEqual([{ ...decision('approved', 'aaaa'), patchId: 'p' }]);
    expect(normalizeReviewDecisions([{ ...decision('folded', 'aaaa'), targetSha: 1 }])).toEqual([]);
  });
});

describe('selectThreadsAwaitingAgent', () => {
  const thread = (id: string, ...authors: Array<[string | undefined, string?]>) => ({
    id,
    filePath: 'a.ts',
    position: { side: 'new' as const, line: 1 },
    messages: authors.map(([author, createdAt = '2026-01-01T00:00:00Z'], index) => ({
      id: `${id}-${index}`,
      body: `${author ?? 'agent'} ${index}`,
      ...(author === undefined ? {} : { author }),
      createdAt,
      updatedAt: createdAt,
    })),
  });
  const ids = (
    threads: ReturnType<typeof thread>[],
    byThread: Map<string, ThreadFixup[]> | undefined,
    decisions: ReviewDecision[] = [],
  ) => selectThreadsAwaitingAgent(threads, byThread, decisions).map((t) => t.threadId);

  it('takes, without states, every thread where the reviewer spoke last', () => {
    const threads = [thread('asked', ['User']), thread('replied', ['User'], ['Claude'])];
    expect(selectThreadsAwaitingAgent(threads, undefined, [])).toEqual([
      {
        threadId: 'asked',
        filePath: 'a.ts',
        position: { side: 'new', line: 1 },
        message: 'User 0',
      },
    ]);
  });

  it('hands over a thread on a whole commit without a file path', () => {
    const onCommit = {
      id: 'commit',
      position: { scope: 'commit' as const },
      messages: thread('commit', ['User']).messages,
      fixupTarget: 'abc1234',
    };

    expect(selectThreadsAwaitingAgent([onCommit], undefined, [])).toStrictEqual([
      {
        threadId: 'commit',
        position: { scope: 'commit' },
        message: 'User 0',
        fixupTarget: 'abc1234',
      },
    ]);
  });

  it('leaves a thread whose last agent reply says a fixup follows to the agent, without handing it over', () => {
    const asked = thread('t1', ['User'], [undefined]);
    const promised = {
      ...asked,
      messages: [asked.messages[0]!, { ...asked.messages[1]!, fixPending: true as const }],
    };
    expect(ids([promised], new Map())).toEqual([]);
    expect(isAgentResponding(promised, new Map(), [])).toBe(false);
  });

  it('hands over the reviewer’s pick with the choice it answers', () => {
    const asked = thread('t1', ['User'], [undefined]);
    const offered = {
      ...asked,
      messages: [asked.messages[0]!, { ...asked.messages[1]!, choices: [{ id: 'B' }] }],
    };
    const pick = {
      id: 't1-2',
      body: '고름: B — 묶음',
      author: 'User',
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      answer: { messageId: 't1-1', choice: 'B' },
    };
    const picked = { ...offered, messages: [...offered.messages, pick] };

    expect(ids([offered], new Map())).toEqual([]);
    expect(selectThreadsAwaitingAgent([picked], new Map(), [])).toEqual([
      expect.objectContaining({
        threadId: 't1',
        message: '고름: B — 묶음',
        answer: { messageId: 't1-1', choice: 'B' },
        state: 'awaiting-fix',
      }),
    ]);
    expect(selectThreadsAwaitingAgent([picked], undefined, [])[0]).toHaveProperty('answer');
  });

  it('leaves out a resolved thread with or without fixups', () => {
    const threads = [thread('asked', ['User']), thread('resolved', ['User'])];
    const resolution = [decision('resolved', '', undefined, 'resolved')];
    expect(ids(threads, undefined, resolution)).toEqual(['asked']);
    expect(ids(threads, new Map(), resolution)).toEqual(['asked']);
  });

  it('takes a comment waiting for a fix only while the reviewer has the last word', () => {
    const threads = [
      thread('new', ['User']),
      thread('answered-in-words', ['User'], [undefined]),
      thread('asked-back', [undefined], ['User']),
      thread('own-note', [undefined]),
    ];
    expect(ids(threads, new Map())).toEqual(['new', 'asked-back']);
    expect(selectThreadsAwaitingAgent(threads, new Map(), [])[0]).toMatchObject({
      state: 'awaiting-fix',
      label: '답변 대기',
    });
  });

  it('leaves out a thread whose fixup waits for the reviewer or was approved', () => {
    const threads = [thread('pending', ['User']), thread('approved', ['User'])];
    const byThread = new Map([
      ['pending', [fixup('aaaa', ['pending'])]],
      ['approved', [fixup('bbbb', ['approved'])]],
    ]);
    expect(ids(threads, byThread, [decision('approved', 'bbbb', undefined, 'approved')])).toEqual(
      [],
    );
  });

  it('takes a fixup waiting for approval once the reviewer replies after it', () => {
    const pending = new Map([['t1', [fixup('aaaa', ['t1'], '2026-01-02T00:00:00+09:00')]]]);
    const askedBack = thread('t1', ['User'], ['User', '2026-01-02T00:00:00Z']);
    expect(selectThreadsAwaitingAgent([askedBack], pending, [])).toMatchObject([
      { threadId: 't1', state: 'awaiting-approval', label: '승인 대기' },
    ]);
    expect(selectThreadsAwaitingAgent([askedBack], pending, [])[0]).not.toHaveProperty(
      'rejectedFixupSha',
    );

    const askedBefore = thread('t1', ['User'], ['User', '2026-01-01T12:00:00Z']);
    const answered = thread(
      't1',
      ['User'],
      ['User', '2026-01-02T00:00:00Z'],
      [undefined, '2026-01-03T00:00:00Z'],
    );
    expect(ids([askedBefore], pending)).toEqual([]);
    expect(ids([answered], pending)).toEqual([]);

    const fixedAgain = new Map([['t1', [fixup('bbbb', ['t1'], '2026-01-03T00:00:00Z')]]]);
    expect(ids([askedBack], fixedAgain)).toEqual([]);
  });

  it('weighs a reply on a fixup waiting for approval against the fixups not rejected', () => {
    const askedBack = thread('t1', ['User'], ['User', '2026-01-02T00:00:00Z']);
    const fixups = new Map([
      [
        't1',
        [
          fixup('aaaa', ['t1'], '2026-01-01T00:00:00Z'),
          fixup('bbbb', ['t1'], '2026-01-01T12:00:00Z'),
        ],
      ],
    ]);
    expect(ids([askedBack], fixups)).toEqual(['t1']);
    const newerRejected = new Map([
      ['t1', [fixup('aaaa'), fixup('bbbb', ['t1'], '2026-01-03T00:00:00Z')]],
    ]);
    expect(ids([askedBack], newerRejected, [decision('rejected', 'bbbb')])).toEqual(['t1']);
  });

  it('takes an approved fixup once the reviewer replies after it, keeping the approval', () => {
    const approvedFixup = new Map([['t1', [fixup('aaaa', ['t1'], '2026-01-02T00:00:00Z')]]]);
    const approval = [decision('approved', 'aaaa', '2026-01-02T12:00:00Z')];
    const askedBack = thread('t1', ['User'], ['User', '2026-01-03T00:00:00Z']);
    expect(selectThreadsAwaitingAgent([askedBack], approvedFixup, approval)).toMatchObject([
      { threadId: 't1', state: 'approved', label: '승인됨' },
    ]);
    expect(deriveThreadReviewState('t1', approvedFixup.get('t1')!, approval, askedBack)).toBe(
      'approved',
    );

    const answered = thread(
      't1',
      ['User'],
      ['User', '2026-01-03T00:00:00Z'],
      [undefined, '2026-01-04T00:00:00Z'],
    );
    expect(ids([answered], approvedFixup, approval)).toEqual([]);
    expect(ids([thread('t1', ['User'])], approvedFixup, approval)).toEqual([]);
    expect(ids([thread('t1', ['User'])], new Map(), approval)).toEqual([]);
  });

  it('keeps a reply made before approving the agent’s turn while its fixup is in the range', () => {
    const approvedFixup = new Map([['t1', [fixup('aaaa', ['t1'], '2026-01-02T00:00:00Z')]]]);
    const approval = [decision('approved', 'aaaa', '2026-01-02T12:00:00Z')];
    const askedBeforeApproving = thread('t1', ['User'], ['User', '2026-01-02T06:00:00Z']);
    expect(
      selectThreadsAwaitingAgent([askedBeforeApproving], approvedFixup, approval),
    ).toMatchObject([{ threadId: 't1', state: 'approved', label: '승인됨' }]);

    const askedBeforeFixup = thread('t1', ['User'], ['User', '2026-01-01T12:00:00Z']);
    expect(ids([askedBeforeFixup], approvedFixup, approval)).toEqual([]);
    expect(ids([askedBeforeApproving], new Map(), approval)).toEqual([]);
    const rejectedLeftBehind = new Map([['t1', [fixup('bbbb', ['t1'], '2026-01-01T12:00:00Z')]]]);
    expect(
      ids([askedBeforeApproving], rejectedLeftBehind, [
        decision('rejected', 'bbbb', '2026-01-01T18:00:00Z'),
        ...approval,
      ]),
    ).toEqual([]);

    const answered = thread(
      't1',
      ['User'],
      ['User', '2026-01-02T06:00:00Z'],
      [undefined, '2026-01-02T09:00:00Z'],
    );
    expect(ids([answered], approvedFixup, approval)).toEqual([]);
  });

  it('takes a reply made after the approval even when the fixup looks newer or is gone', () => {
    const approval = [decision('approved', 'aaaa', '2026-01-02T12:00:00Z')];
    const askedBack = thread('t1', ['User'], ['User', '2026-01-03T00:00:00Z']);
    const authoredAhead = new Map([['t1', [fixup('aaaa', ['t1'], '2026-01-03T06:00:00Z')]]]);
    expect(ids([askedBack], authoredAhead, approval)).toEqual(['t1']);
    expect(ids([askedBack], new Map(), approval)).toEqual(['t1']);
    const rejectedLeftBehind = new Map([['t1', [fixup('bbbb')]]]);
    expect(
      ids([askedBack], rejectedLeftBehind, [
        decision('rejected', 'bbbb', '2026-01-01T12:00:00Z'),
        ...approval,
      ]),
    ).toEqual(['t1']);
  });

  it('takes a rejection with the fixup to drop while it is still in the range', () => {
    const rejected = [decision('rejected', 'aaaa', '2026-01-02T00:00:00Z')];
    const inRange = selectThreadsAwaitingAgent(
      [thread('t1', ['User'])],
      new Map([['t1', [fixup('aaaa')]]]),
      rejected,
    );
    expect(inRange).toMatchObject([
      { threadId: 't1', state: 'rejected', label: '다시 수정 중', rejectedFixupSha: 'aaaa' },
    ]);
    const dropped = selectThreadsAwaitingAgent([thread('t1', ['User'])], new Map(), rejected);
    expect(dropped).toMatchObject([{ threadId: 't1', state: 'rejected' }]);
    expect(dropped[0]).not.toHaveProperty('rejectedFixupSha');
  });

  it('names every rejected fixup still in the range, and every fixup of a deleted thread', () => {
    const fixups = new Map([['t1', [fixup('aaaa'), fixup('bbbb')]]]);
    const rejected = [
      decision('rejected', 'aaaa', '2026-01-02T00:00:00Z'),
      decision('rejected', 'bbbb', '2026-01-02T00:00:00Z'),
    ];
    const deleted = [decision('deleted', '', '2026-01-02T00:00:00Z')];

    expect(selectThreadsAwaitingAgent([thread('t1', ['User'])], fixups, rejected)).toMatchObject([
      { state: 'rejected', rejectedFixupSha: 'aaaa', rejectedFixupShas: ['aaaa', 'bbbb'] },
    ]);
    expect(selectThreadsAwaitingAgent([thread('t1', ['User'])], fixups, deleted)).toMatchObject([
      { state: 'deleted', rejectedFixupSha: 'aaaa', rejectedFixupShas: ['aaaa', 'bbbb'] },
    ]);
  });

  it('gives a rejection back to the reviewer once the agent has answered after it', () => {
    const rejected = [decision('rejected', 'aaaa', '2026-01-02T00:00:00Z')];
    const answered = thread('t1', ['User'], [undefined, '2026-01-03T00:00:00Z']);
    const answeredBefore = thread('t1', ['User'], [undefined, '2026-01-01T12:00:00Z']);
    const askedAgain = thread(
      't1',
      ['User'],
      [undefined, '2026-01-03T00:00:00Z'],
      ['User', '2026-01-04T00:00:00Z'],
    );
    expect(ids([answered], new Map(), rejected)).toEqual([]);
    expect(ids([answeredBefore], new Map(), rejected)).toEqual(['t1']);
    expect(ids([askedAgain], new Map(), rejected)).toEqual(['t1']);
  });

  it('tells the commit to fix into for a thread that has one, and nothing for an old one', () => {
    const bound = { ...thread('bound', ['User']), fixupTarget: 'c'.repeat(40) };
    const rejected = [decision('rejected', 'aaaa', '2026-01-02T00:00:00Z', 'bound')];

    expect(
      selectThreadsAwaitingAgent([bound, thread('old', ['User'])], new Map(), []),
    ).toMatchObject([{ threadId: 'bound', fixupTarget: 'c'.repeat(40) }, { threadId: 'old' }]);
    expect(
      selectThreadsAwaitingAgent([thread('old', ['User'])], undefined, [])[0],
    ).not.toHaveProperty('fixupTarget');
    expect(
      selectThreadsAwaitingAgent(
        [bound],
        new Map([['bound', [fixup('aaaa', ['bound'])]]]),
        rejected,
      ),
    ).toMatchObject([{ threadId: 'bound', state: 'rejected', fixupTarget: 'c'.repeat(40) }]);
  });

  it('takes a reverted reviewer edit only until its fixup is dropped', () => {
    const edited = thread('t1', [REVIEWER_EDIT_AUTHOR]);
    const reverted = [
      decision('approved', 'aaaa'),
      decision('rejected', 'aaaa', '2026-01-02T00:00:00Z'),
    ];
    expect(
      selectThreadsAwaitingAgent([edited], new Map([['t1', [fixup('aaaa')]]]), reverted),
    ).toMatchObject([
      { threadId: 't1', state: 'withdrawn', label: '되돌림', rejectedFixupSha: 'aaaa' },
    ]);
    expect(ids([edited], new Map(), reverted)).toEqual([]);
  });
});

describe('isAgentResponding', () => {
  const thread = (...messages: Array<[string, string]>) => ({
    id: 't1',
    filePath: 'a.ts',
    position: { side: 'new' as const, line: 1 },
    messages: messages.map(([author, createdAt], index) => ({
      id: `m${index}`,
      body: 'x',
      author,
      createdAt,
      updatedAt: createdAt,
    })),
  });
  const asked = thread(['User', '2026-01-01T00:00:00Z']);
  const handed = (at: string) => decision('handed', '', at);

  it('holds from the handover until the agent answers', () => {
    expect(isAgentResponding(asked, new Map(), [])).toBe(false);
    expect(isAgentResponding(asked, new Map(), [handed('2026-01-01T00:01:00Z')])).toBe(true);
    const replied = thread(['User', '2026-01-01T00:00:00Z'], ['Agent', '2026-01-01T00:02:00Z']);
    expect(isAgentResponding(replied, new Map(), [handed('2026-01-01T00:01:00Z')])).toBe(false);
    expect(
      isAgentResponding(asked, new Map([['t1', [fixup('aaaa')]]]), [
        handed('2026-01-01T00:01:00Z'),
      ]),
    ).toBe(false);
  });

  it('ignores a handover from an earlier turn', () => {
    const askedAgain = thread(
      ['User', '2026-01-01T00:00:00Z'],
      ['Agent', '2026-01-01T00:02:00Z'],
      ['User', '2026-01-01T00:03:00Z'],
    );
    expect(isAgentResponding(askedAgain, new Map(), [handed('2026-01-01T00:01:00Z')])).toBe(false);
    expect(isAgentResponding(askedAgain, new Map(), [handed('2026-01-01T00:04:00Z')])).toBe(true);
  });

  it('starts a new turn at a rejection', () => {
    const rejected = decision('rejected', 'aaaa', '2026-01-01T00:05:00Z');
    expect(isAgentResponding(asked, new Map(), [handed('2026-01-01T00:01:00Z'), rejected])).toBe(
      false,
    );
    expect(isAgentResponding(asked, new Map(), [rejected, handed('2026-01-01T00:06:00Z')])).toBe(
      true,
    );
  });

  it('holds for a reply on a fixup waiting for approval until the agent answers', () => {
    const pending = new Map([['t1', [fixup('aaaa', ['t1'], '2026-01-01T00:02:00Z')]]]);
    const askedBack = thread(['User', '2026-01-01T00:00:00Z'], ['User', '2026-01-01T00:03:00Z']);
    const handover = [handed('2026-01-01T00:04:00Z')];
    expect(isAgentResponding(askedBack, pending, handover)).toBe(true);
    const answered = thread(
      ['User', '2026-01-01T00:00:00Z'],
      ['User', '2026-01-01T00:03:00Z'],
      ['Agent', '2026-01-01T00:05:00Z'],
    );
    expect(isAgentResponding(answered, pending, handover)).toBe(false);
  });

  it('holds for a reply on an approved fixup until the agent answers', () => {
    const approvedFixup = new Map([['t1', [fixup('aaaa', ['t1'], '2026-01-01T00:02:00Z')]]]);
    const askedBack = thread(['User', '2026-01-01T00:00:00Z'], ['User', '2026-01-01T00:03:00Z']);
    const decisions = [
      decision('approved', 'aaaa', '2026-01-01T00:02:30Z'),
      handed('2026-01-01T00:04:00Z'),
    ];
    expect(isAgentResponding(askedBack, approvedFixup, decisions)).toBe(true);
    const answered = thread(
      ['User', '2026-01-01T00:00:00Z'],
      ['User', '2026-01-01T00:03:00Z'],
      ['Agent', '2026-01-01T00:05:00Z'],
    );
    expect(isAgentResponding(answered, approvedFixup, decisions)).toBe(false);
  });

  it('holds for a reply handed over before the approval until the agent answers', () => {
    const approvedFixup = new Map([['t1', [fixup('aaaa', ['t1'], '2026-01-01T00:02:00Z')]]]);
    const askedBack = thread(['User', '2026-01-01T00:00:00Z'], ['User', '2026-01-01T00:03:00Z']);
    const decisions = [
      handed('2026-01-01T00:04:00Z'),
      decision('approved', 'aaaa', '2026-01-01T00:05:00Z'),
    ];
    expect(isAgentResponding(askedBack, approvedFixup, decisions)).toBe(true);
    const answered = thread(
      ['User', '2026-01-01T00:00:00Z'],
      ['User', '2026-01-01T00:03:00Z'],
      ['Agent', '2026-01-01T00:06:00Z'],
    );
    expect(isAgentResponding(answered, approvedFixup, decisions)).toBe(false);
  });

  it('ignores another thread’s handover', () => {
    expect(
      isAgentResponding(asked, new Map(), [decision('handed', '', '2026-01-01T00:01:00Z', 't2')]),
    ).toBe(false);
  });
});

describe('deleted threads', () => {
  const thread = (...messages: Array<[string, string]>) => ({
    id: 't1',
    filePath: 'a.ts',
    position: { side: 'new' as const, line: 1 },
    messages: messages.map(([author, createdAt], index) => ({
      id: `m${index}`,
      body: 'x',
      author,
      createdAt,
      updatedAt: createdAt,
    })),
  });
  const asked = thread(['User', '2026-01-01T00:00:00Z']);
  const deleted = (at = '2026-01-01T00:05:00Z') => decision('deleted', '', at);
  const handed = (at: string) => decision('handed', '', at);
  const turns = (
    byThread: Map<string, ThreadFixup[]> | undefined,
    decisions: ReviewDecision[],
    target = asked,
  ) => selectThreadsAwaitingAgent([target], byThread, decisions);

  it('takes a deleted thread out of every state and list', () => {
    expect(isThreadDeleted('t1', [deleted()])).toBe(true);
    expect(isThreadDeleted('t1', [decision('deleted', '', undefined, 't2')])).toBe(false);
    expect(deriveThreadReviewState('t1', [fixup('aaaa')], [deleted()], asked)).toBe('deleted');
    expect(reviewStateLabel('deleted')).toBe('지움');
    expect(selectOpenThreads([asked], new Map(), [deleted()])).toEqual([]);
  });

  it('asks the agent to drop a fixup the deleted thread left in the range', () => {
    const byThread = new Map([['t1', [fixup('aaaa')]]]);
    for (const extra of [[], [decision('approved', 'aaaa')], [handed('2026-01-01T00:09:00Z')]]) {
      expect(turns(byThread, [...extra, deleted()])).toMatchObject([
        { threadId: 't1', state: 'deleted', label: '지움', rejectedFixupSha: 'aaaa' },
      ]);
    }
    expect(turns(new Map(), [deleted()])).toEqual([]);
    expect(isAgentResponding(asked, byThread, [deleted()])).toBe(false);
    expect(isAgentResponding(asked, byThread, [deleted(), handed('2026-01-01T00:06:00Z')])).toBe(
      true,
    );
  });

  it('tells an agent still working on the thread to stop, once', () => {
    const working = [handed('2026-01-01T00:01:00Z'), deleted()];
    expect(turns(new Map(), working)).toMatchObject([{ state: 'deleted' }]);
    expect(turns(undefined, working)).toMatchObject([{ state: 'deleted' }]);
    expect(isAgentResponding(asked, new Map(), working)).toBe(false);

    const told = [...working, handed('2026-01-01T00:06:00Z')];
    expect(turns(new Map(), told)).toEqual([]);
  });

  it('leaves the agent alone when it had already answered or never got the thread', () => {
    const replied = thread(['User', '2026-01-01T00:00:00Z'], ['Agent', '2026-01-01T00:02:00Z']);
    expect(turns(new Map(), [handed('2026-01-01T00:01:00Z'), deleted()], replied)).toEqual([]);
    expect(turns(new Map(), [deleted()])).toEqual([]);
  });
});
