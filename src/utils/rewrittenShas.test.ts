import { describe, expect, it } from 'vitest';

import type { DiffCommentThread, ReviewDecision } from '../types/diff.js';

import {
  afterRewrite,
  movedCommitish,
  movedDecision,
  movedPlace,
  movedSelection,
  movedThread,
} from './rewrittenShas.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const OLD_FIXUP = 'c'.repeat(40);
const NEW_FIXUP = 'd'.repeat(40);
const KEPT = 'e'.repeat(40);
const REWRITTEN = { [OLD]: NEW, [OLD_FIXUP]: NEW_FIXUP };

describe('movedCommitish', () => {
  it('moves a whole hash, an abbreviated one at its length and the base of a one-commit review', () => {
    expect(movedCommitish(OLD, REWRITTEN)).toBe(NEW);
    expect(movedCommitish(OLD.slice(0, 7), REWRITTEN)).toBe(NEW.slice(0, 7));
    expect(movedCommitish(`${OLD}^`, REWRITTEN)).toBe(`${NEW}^`);
  });

  it('leaves names and commits the rewrite kept', () => {
    expect(movedCommitish('main', REWRITTEN)).toBe('main');
    expect(movedCommitish('working', REWRITTEN)).toBe('working');
    expect(movedCommitish(KEPT, REWRITTEN)).toBe(KEPT);
  });
});

describe('movedSelection', () => {
  it('moves both ends and keeps the base mode', () => {
    expect(
      movedSelection(
        { baseCommitish: OLD, targetCommitish: OLD_FIXUP, baseMode: 'merge-base' },
        REWRITTEN,
      ),
    ).toEqual({ baseCommitish: NEW, targetCommitish: NEW_FIXUP, baseMode: 'merge-base' });
  });
});

describe('movedPlace', () => {
  it('moves what a comment import names and adds nothing it lacks', () => {
    const named = { body: 'x', fixupTarget: OLD };
    const bare = { body: 'x' };
    expect(movedPlace(named, REWRITTEN)).toEqual({ body: 'x', fixupTarget: NEW });
    expect(movedPlace(bare, REWRITTEN)).toEqual({ body: 'x' });
  });
});

describe('movedThread', () => {
  const thread: DiffCommentThread = {
    id: 't1',
    filePath: 'a.ts',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    position: { side: 'new', line: 3 },
    view: { baseCommitish: KEPT, targetCommitish: OLD },
    fixupTarget: OLD,
    codeSnapshot: { content: 'code', commit: OLD },
    messages: [
      {
        id: 'm1',
        body: 'on a fixup line',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        fixupLines: {
          fixupSha: OLD_FIXUP,
          patchId: OLD_FIXUP,
          filePath: 'a.ts',
          ranges: [],
        },
      },
      {
        id: 'm2',
        body: 'plain',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
  };

  it('moves the view, the fixup target, the snapshot and the fixup lines of replies', () => {
    expect(movedThread(thread, REWRITTEN)).toEqual({
      ...thread,
      view: { baseCommitish: KEPT, targetCommitish: NEW },
      fixupTarget: NEW,
      codeSnapshot: { content: 'code', commit: NEW },
      messages: [
        {
          ...thread.messages[0],
          fixupLines: {
            fixupSha: NEW_FIXUP,
            patchId: NEW_FIXUP,
            filePath: 'a.ts',
            ranges: [],
          },
        },
        thread.messages[1],
      ],
    });
  });

  it('keeps a patch id that comes from the changes', () => {
    const moved = movedThread(
      {
        ...thread,
        messages: [
          {
            ...thread.messages[0]!,
            fixupLines: { fixupSha: OLD_FIXUP, patchId: 'patch-1', filePath: 'a.ts', ranges: [] },
          },
        ],
      },
      REWRITTEN,
    );
    expect(moved.messages[0]?.fixupLines).toMatchObject({
      fixupSha: NEW_FIXUP,
      patchId: 'patch-1',
    });
  });
});

describe('movedDecision', () => {
  const decision: ReviewDecision = {
    threadId: 't1',
    kind: 'approved',
    fixupSha: OLD_FIXUP,
    at: '2026-01-01T00:00:00Z',
  };

  it('moves the patch id of an amend!, whose id is its own SHA', () => {
    expect(movedDecision({ ...decision, patchId: OLD_FIXUP }, REWRITTEN)).toEqual({
      ...decision,
      fixupSha: NEW_FIXUP,
      patchId: NEW_FIXUP,
    });
  });

  it('keeps a patch id that comes from the changes, and moves the target it folded into', () => {
    expect(
      movedDecision({ ...decision, kind: 'folded', patchId: 'patch-1', targetSha: OLD }, REWRITTEN),
    ).toEqual({
      ...decision,
      kind: 'folded',
      fixupSha: NEW_FIXUP,
      patchId: 'patch-1',
      targetSha: NEW,
    });
  });

  it('leaves the empty SHA of a decision that judges no fixup', () => {
    expect(movedDecision({ ...decision, kind: 'resolved', fixupSha: '' }, REWRITTEN).fixupSha).toBe(
      '',
    );
  });
});

describe('afterRewrite', () => {
  it('leads a SHA rewritten twice straight to the newest commit', () => {
    expect(afterRewrite({ [OLD]: NEW }, { [NEW]: KEPT, [OLD_FIXUP]: NEW_FIXUP })).toEqual({
      [OLD]: KEPT,
      [NEW]: KEPT,
      [OLD_FIXUP]: NEW_FIXUP,
    });
  });
});
