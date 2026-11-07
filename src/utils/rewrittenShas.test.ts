import { describe, expect, it } from 'vitest';

import type { DiffCommentThread, ReviewDecision } from '../types/diff.js';

import {
  afterRewrite,
  movedCommitish,
  movedDecision,
  movedPlace,
  movedSelection,
  movedThread,
  selectionAfterMoves,
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
    const bare: { body: string; fixupTarget?: string } = { body: 'x' };
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

describe('selectionAfterMoves', () => {
  const sha = (digit: string) => digit.repeat(40);
  const placed = (commit: string, parent: string) => ({ sha: sha(commit), parentSha: sha(parent) });
  // 1 2 3 become 7 8 9 in the order 3 1 2: commit 9 is the old 3, 7 the old 1, 8 the old 2.
  const REORDER = {
    rewritten: { [sha('1')]: sha('7'), [sha('2')]: sha('8'), [sha('3')]: sha('9') },
    reorder: {
      before: [placed('1', '0'), placed('2', '1'), placed('3', '2')],
      after: [placed('9', '0'), placed('7', '9'), placed('8', '7')],
    },
  };
  const view = (base: string, target: string) => ({
    baseCommitish: sha(base),
    targetCommitish: sha(target),
  });

  it('keeps a one-commit view on that commit, on its new parent', () => {
    expect(selectionAfterMoves(view('2', '3'), [REORDER])).toEqual(view('0', '9'));
    expect(selectionAfterMoves(view('0', '1'), [REORDER])).toEqual(view('9', '7'));
  });

  it('turns the whole review into the whole review', () => {
    expect(selectionAfterMoves(view('0', '3'), [REORDER])).toEqual(view('0', '8'));
  });

  it('spans a run that came apart, so it still shows every commit it showed', () => {
    expect(selectionAfterMoves(view('1', '3'), [REORDER])).toEqual(view('0', '8'));
  });

  it('keeps the length of an abbreviated hash', () => {
    expect(
      selectionAfterMoves(
        { baseCommitish: sha('2').slice(0, 7), targetCommitish: sha('3').slice(0, 7) },
        [REORDER],
      ),
    ).toEqual({ baseCommitish: sha('0').slice(0, 7), targetCommitish: sha('9').slice(0, 7) });
  });

  it('moves the base of a one-commit review and leaves names alone', () => {
    expect(
      selectionAfterMoves({ baseCommitish: `${sha('2')}^`, targetCommitish: sha('2') }, [REORDER]),
    ).toEqual({ baseCommitish: `${sha('8')}^`, targetCommitish: sha('8') });
    const named = { baseCommitish: 'main', targetCommitish: 'HEAD' };
    expect(selectionAfterMoves(named, [REORDER])).toEqual(named);
  });

  it('moves a review ending on the old last commit to the new last, whatever its base', () => {
    expect(
      selectionAfterMoves(
        { baseCommitish: 'main', targetCommitish: sha('3'), baseMode: 'merge-base' },
        [REORDER],
      ),
    ).toEqual({ baseCommitish: 'main', targetCommitish: sha('8'), baseMode: 'merge-base' });
  });

  it('applies the moves in turn and leaves a selection already past them', () => {
    const reword = { rewritten: { [sha('9')]: sha('a') } };
    const later = {
      rewritten: { [sha('7')]: sha('b'), [sha('a')]: sha('c') },
      reorder: {
        before: [placed('a', '0'), placed('7', 'a'), placed('8', '7')],
        after: [placed('b', '0'), placed('c', 'b'), placed('8', 'c')],
      },
    };
    const moves = [REORDER, reword, later];
    expect(selectionAfterMoves(view('2', '3'), moves)).toEqual(view('b', 'c'));
    expect(selectionAfterMoves(view('b', 'c'), moves)).toEqual(view('b', 'c'));
  });
});

describe('movedThread with history moves', () => {
  it('moves the view through the moves and the SHAs through the map', () => {
    const at = '2026-11-07T00:00:00Z';
    const thread: DiffCommentThread = {
      id: 't1',
      filePath: 'a.ts',
      createdAt: at,
      updatedAt: at,
      position: { side: 'new', line: 2 },
      view: { baseCommitish: OLD, targetCommitish: OLD_FIXUP },
      fixupTarget: OLD_FIXUP,
      messages: [{ id: 't1', body: 'x', createdAt: at, updatedAt: at }],
    };
    const moves = [
      {
        rewritten: REWRITTEN,
        reorder: {
          before: [
            { sha: OLD, parentSha: KEPT },
            { sha: OLD_FIXUP, parentSha: OLD },
          ],
          after: [
            { sha: NEW_FIXUP, parentSha: KEPT },
            { sha: NEW, parentSha: NEW_FIXUP },
          ],
        },
      },
    ];

    expect(movedThread(thread, REWRITTEN, moves)).toMatchObject({
      view: { baseCommitish: KEPT, targetCommitish: NEW_FIXUP },
      fixupTarget: NEW_FIXUP,
    });
  });
});
