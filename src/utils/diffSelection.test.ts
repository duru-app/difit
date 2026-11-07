import { describe, expect, it } from 'vitest';

import {
  bindingForView,
  commitsOfView,
  fixupCommitOf,
  isCommitHash,
  isSameCommit,
  isSameView,
  isViewOfReview,
  madeViewElsewhere,
  reviewCommitViewed,
  reviewViewShown,
  selectReviewView,
  selectionAtCommit,
  shortRef,
} from './diffSelection';

describe('shortRef', () => {
  it.each([
    ['0123456789abcdef0123456789abcdef01234567', '0123456'],
    ['0123456789abcdef0123456789abcdef01234567^', '0123456^'],
    ['0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '0123456'],
    ['0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef^', '0123456^'],
    ['HEAD', 'HEAD'],
    ['abc1234', 'abc1234'],
    [
      'feature/0123456789abcdef0123456789abcdef01234567',
      'feature/0123456789abcdef0123456789abcdef01234567',
    ],
  ])('shows %s as %s', (ref, shown) => {
    expect(shortRef(ref)).toBe(shown);
  });
});

describe('isSameCommit', () => {
  const full = 'b7c2e10a9f' + '0'.repeat(30);

  it('matches a short hash against the full hash it abbreviates', () => {
    expect(isSameCommit('b7c2e10', full)).toBe(true);
    expect(isSameCommit(full, 'B7C2E10')).toBe(true);
  });

  it('rejects hashes that differ within the shorter length', () => {
    expect(isSameCommit('b7c2e11', full)).toBe(false);
  });

  it('compares non-hash refs exactly', () => {
    expect(isSameCommit('main', 'main')).toBe(true);
    expect(isSameCommit('main', 'mainline')).toBe(false);
  });
});

describe('selectionAtCommit', () => {
  it('reviews the commit against its own parent when the current review covers one commit', () => {
    expect(
      selectionAtCommit({ baseCommitish: 'b7c2e10^', targetCommitish: 'b7c2e10' }, '6e4f6d5'),
    ).toEqual({ baseCommitish: '6e4f6d5^', targetCommitish: '6e4f6d5' });
  });

  it('keeps the base of a review that spans a range', () => {
    expect(
      selectionAtCommit(
        { baseCommitish: 'main', targetCommitish: 'feature', baseMode: 'merge-base' },
        '6e4f6d5',
      ),
    ).toEqual({ baseCommitish: 'main', targetCommitish: '6e4f6d5', baseMode: 'merge-base' });
  });
});

describe('isCommitHash', () => {
  it('accepts abbreviated and full hashes and rejects refs', () => {
    expect(isCommitHash('b7c2e10')).toBe(true);
    expect(isCommitHash('b7c2e10a9f' + '0'.repeat(30))).toBe(true);
    expect(isCommitHash('HEAD')).toBe(false);
    expect(isCommitHash('main')).toBe(false);
    expect(isCommitHash('b7c2e10^')).toBe(false);
  });
});

describe('views of a review', () => {
  const sha = (digit: string) => digit.repeat(40);
  const commits = [
    { sha: sha('1'), shortSha: '1111111', parentSha: sha('0'), subject: 'first' },
    { sha: sha('2'), shortSha: '2222222', parentSha: sha('1'), subject: 'second' },
    { sha: sha('4'), shortSha: '4444444', parentSha: sha('3'), subject: 'after a fixup' },
  ];
  const review = {
    selection: { baseCommitish: '0000000', targetCommitish: '4444444' },
    commits,
  };

  it('counts the review itself and each of its commits as views of it', () => {
    expect(isViewOfReview(review.selection, review)).toBe(true);
    expect(isViewOfReview({ baseCommitish: '1111111', targetCommitish: '2222222' }, review)).toBe(
      true,
    );
    expect(isViewOfReview({ baseCommitish: '3333333', targetCommitish: '4444444' }, review)).toBe(
      true,
    );
  });

  it('counts a run of its commits as a view of it', () => {
    expect(isViewOfReview({ baseCommitish: '0000000', targetCommitish: '2222222' }, review)).toBe(
      true,
    );
    expect(isViewOfReview({ baseCommitish: '1111111', targetCommitish: '4444444' }, review)).toBe(
      true,
    );
  });

  it('does not count a pair that leaves the range or runs backwards', () => {
    expect(isViewOfReview({ baseCommitish: 'fffffff', targetCommitish: '2222222' }, review)).toBe(
      false,
    );
    expect(isViewOfReview({ baseCommitish: '2222222', targetCommitish: '5555555' }, review)).toBe(
      false,
    );
    expect(isViewOfReview({ baseCommitish: '3333333', targetCommitish: '2222222' }, review)).toBe(
      false,
    );
    expect(
      isViewOfReview(
        { baseCommitish: '1111111', targetCommitish: '2222222', baseMode: 'merge-base' },
        review,
      ),
    ).toBe(false);
  });

  it('names the commit a view shows on its own', () => {
    expect(
      reviewCommitViewed({ baseCommitish: '1111111', targetCommitish: '2222222' }, commits),
    ).toBe(commits[1]);
    expect(reviewCommitViewed(review.selection, commits)).toBeUndefined();
    expect(
      reviewCommitViewed({ baseCommitish: '0000000', targetCommitish: '2222222' }, commits),
    ).toBeUndefined();
  });

  it('takes a short view and the full hashes it abbreviates as the same view', () => {
    const stored = { baseCommitish: sha('1'), targetCommitish: sha('2') };

    expect(isSameView({ baseCommitish: '1111111', targetCommitish: '2222222' }, stored)).toBe(true);
    expect(isSameView({ baseCommitish: '1111111', targetCommitish: '4444444' }, stored)).toBe(
      false,
    );
    expect(
      isSameView(
        { baseCommitish: '1111111', targetCommitish: '2222222', baseMode: 'merge-base' },
        stored,
      ),
    ).toBe(false);
  });

  it('lists the commits each view of the review shows', () => {
    expect(commitsOfView(review.selection, review)).toEqual(commits);
    expect(commitsOfView({ baseCommitish: '1111111', targetCommitish: '2222222' }, review)).toEqual(
      [commits[1]],
    );
    expect(commitsOfView({ baseCommitish: '1111111', targetCommitish: '4444444' }, review)).toEqual(
      commits.slice(1),
    );
    expect(commitsOfView({ baseCommitish: 'fffffff', targetCommitish: '2222222' }, review)).toEqual(
      [],
    );
  });

  it('binds a comment made on one commit to that commit by its full hashes', () => {
    expect(
      bindingForView(review, { baseCommitish: '1111111', targetCommitish: '2222222' }),
    ).toEqual({
      view: { baseCommitish: sha('1'), targetCommitish: sha('2') },
      fixupTarget: sha('2'),
      snapshotCommit: sha('2'),
    });
  });

  it('binds a comment made on a run of commits to the run and the fixup target it was given', () => {
    const run = { baseCommitish: '1111111', targetCommitish: '4444444' };
    expect(bindingForView(review, run, sha('2'))).toEqual({
      view: { baseCommitish: sha('1'), targetCommitish: sha('4') },
      fixupTarget: sha('2'),
      snapshotCommit: sha('4'),
    });
    expect(bindingForView(review, run)).toMatchObject({ fixupTarget: sha('4') });
  });

  it('binds only the fixup target to a comment made on the whole review', () => {
    expect(bindingForView(review, review.selection, sha('2'))).toEqual({ fixupTarget: sha('2') });
    expect(bindingForView(review, review.selection)).toBeUndefined();
  });

  it('binds nothing to a comment made on a view outside the review', () => {
    expect(
      bindingForView(review, { baseCommitish: 'fffffff', targetCommitish: '2222222' }, sha('2')),
    ).toBeUndefined();
  });

  describe('the view a comment was made on', () => {
    const requested = { baseCommitish: sha('0'), targetCommitish: sha('4') };
    const scope = { ...review, requested };
    const onSecond = { view: { baseCommitish: sha('1'), targetCommitish: sha('2') } };

    it('is the commit it was made on, while another view is shown', () => {
      expect(madeViewElsewhere(onSecond, review.selection, scope)).toBe(onSecond.view);
      expect(
        madeViewElsewhere(
          onSecond,
          { baseCommitish: '1111111', targetCommitish: '2222222' },
          scope,
        ),
      ).toBeUndefined();
    });

    it('is the whole review as requested for a comment that names no view', () => {
      const onCommit = { baseCommitish: '1111111', targetCommitish: '2222222' };
      expect(madeViewElsewhere({}, onCommit, scope)).toBe(requested);
      expect(madeViewElsewhere({}, review.selection, scope)).toBeUndefined();
    });

    it('is nothing for a view outside the review', () => {
      const elsewhere = { view: { baseCommitish: sha('7'), targetCommitish: sha('8') } };
      expect(madeViewElsewhere(elsewhere, review.selection, scope)).toBeUndefined();
    });
  });

  it('names the commit a fix goes into by its short hash and subject', () => {
    expect(fixupCommitOf(sha('2'), commits)).toEqual({ shortSha: '2222222', subject: 'second' });
    expect(fixupCommitOf(sha('9'), commits)).toEqual({ shortSha: '9999999' });
  });

  it('names the whole review, one commit, or a run from the resolved short shas', () => {
    expect(reviewViewShown(review.selection, review)).toEqual({ kind: 'all' });
    expect(
      reviewViewShown({ baseCommitish: '1111111', targetCommitish: '2222222' }, review),
    ).toEqual({ kind: 'commit', sha: sha('2') });
    expect(
      reviewViewShown({ baseCommitish: '0000000', targetCommitish: '2222222' }, review),
    ).toEqual({ kind: 'range', startSha: sha('1'), endSha: sha('2') });
  });

  it('names nothing for a pair outside the review or a merge-base pair', () => {
    expect(
      reviewViewShown({ baseCommitish: 'fffffff', targetCommitish: '2222222' }, review),
    ).toBeUndefined();
    expect(
      reviewViewShown(
        { baseCommitish: '1111111', targetCommitish: '2222222', baseMode: 'merge-base' },
        review,
      ),
    ).toBeUndefined();
  });
});

describe('selectReviewView', () => {
  const sha = (digit: string) => digit.repeat(40);
  const commits = ['1', '2', '3', '4'].map((digit) => ({
    sha: sha(digit),
    shortSha: digit.repeat(7),
    parentSha: sha(String(Number(digit) - 1)),
    subject: `commit ${digit}`,
  }));
  const review = {
    selection: { baseCommitish: '0000000', targetCommitish: '4444444' },
    requested: { baseCommitish: sha('0'), targetCommitish: sha('4') },
    commits,
  };
  const all = { view: { kind: 'all' as const }, anchor: null };
  const commitView = (digit: string, anchor: string | null = sha(digit)) => ({
    view: { kind: 'commit' as const, sha: sha(digit) },
    anchor,
  });
  const run = (start: string, end: string) => ({
    kind: 'range' as const,
    startSha: sha(start),
    endSha: sha(end),
  });

  it('shows one commit on a click and anchors there', () => {
    expect(selectReviewView(review, all, { kind: 'click', sha: sha('2') })).toEqual({
      view: { kind: 'commit', sha: sha('2') },
      selection: { baseCommitish: sha('1'), targetCommitish: sha('2') },
      anchor: sha('2'),
    });
  });

  it('shows the whole review on a click of the commit shown alone, and another commit on a click of it', () => {
    expect(selectReviewView(review, commitView('2'), { kind: 'click', sha: sha('2') })).toEqual({
      view: { kind: 'all' },
      selection: review.requested,
      anchor: null,
    });
    expect(selectReviewView(review, commitView('2'), { kind: 'click', sha: sha('3') })).toEqual({
      view: { kind: 'commit', sha: sha('3') },
      selection: { baseCommitish: sha('2'), targetCommitish: sha('3') },
      anchor: sha('3'),
    });
  });

  it('shows one commit of a run on a click of it, its ends included', () => {
    const shown = { view: run('1', '3'), anchor: sha('1') };
    for (const digit of ['1', '2', '3']) {
      expect(selectReviewView(review, shown, { kind: 'click', sha: sha(digit) })).toEqual({
        view: { kind: 'commit', sha: sha(digit) },
        selection: { baseCommitish: sha(String(Number(digit) - 1)), targetCommitish: sha(digit) },
        anchor: sha(digit),
      });
    }
  });

  it('shows the run from the anchor to a later commit on a Shift+click', () => {
    expect(
      selectReviewView(review, commitView('1'), { kind: 'shift-click', sha: sha('3') }),
    ).toEqual({
      view: run('1', '3'),
      selection: { baseCommitish: sha('0'), targetCommitish: sha('3') },
      anchor: sha('1'),
    });
  });

  it('shows the same run when the Shift+click lands on an earlier commit', () => {
    expect(
      selectReviewView(review, commitView('3'), { kind: 'shift-click', sha: sha('1') }),
    ).toEqual({
      view: run('1', '3'),
      selection: { baseCommitish: sha('0'), targetCommitish: sha('3') },
      anchor: sha('3'),
    });
  });

  it('treats a Shift+click with nothing anchored as a click', () => {
    expect(selectReviewView(review, all, { kind: 'shift-click', sha: sha('2') })).toEqual(
      selectReviewView(review, all, { kind: 'click', sha: sha('2') }),
    );
  });

  it('keeps the anchor so a second Shift+click resizes the run from it', () => {
    const first = selectReviewView(review, commitView('2'), {
      kind: 'shift-click',
      sha: sha('4'),
    });
    expect(first?.view).toEqual(run('2', '4'));

    const second = selectReviewView(review, first!, { kind: 'shift-click', sha: sha('1') });
    expect(second?.view).toEqual(run('1', '2'));
    expect(second?.anchor).toBe(sha('2'));
  });

  it('starts a Shift+click from the shown commit or the start of a run shown without an anchor', () => {
    expect(
      selectReviewView(review, commitView('2', null), { kind: 'shift-click', sha: sha('3') })?.view,
    ).toEqual(run('2', '3'));
    expect(
      selectReviewView(
        review,
        { view: run('2', '3'), anchor: null },
        { kind: 'shift-click', sha: sha('4') },
      )?.view,
    ).toEqual(run('2', '4'));
  });

  it('shows one commit when a Shift+click or a drop lands on the anchor', () => {
    expect(
      selectReviewView(review, commitView('2'), { kind: 'shift-click', sha: sha('2') })?.view,
    ).toEqual({ kind: 'commit', sha: sha('2') });
    expect(
      selectReviewView(review, all, { kind: 'drop', fromSha: sha('3'), toSha: sha('3') })?.view,
    ).toEqual({ kind: 'commit', sha: sha('3') });
  });

  it('shows the run between the drag start and the drop in either direction', () => {
    expect(
      selectReviewView(review, all, { kind: 'drop', fromSha: sha('2'), toSha: sha('3') }),
    ).toEqual({
      view: run('2', '3'),
      selection: { baseCommitish: sha('1'), targetCommitish: sha('3') },
      anchor: sha('2'),
    });
    expect(
      selectReviewView(review, commitView('1'), {
        kind: 'drop',
        fromSha: sha('3'),
        toSha: sha('2'),
      }),
    ).toEqual({
      view: run('2', '3'),
      selection: { baseCommitish: sha('1'), targetCommitish: sha('3') },
      anchor: sha('3'),
    });
  });

  it('shows the whole review when the run covers every commit', () => {
    expect(
      selectReviewView(review, commitView('4'), { kind: 'shift-click', sha: sha('1') }),
    ).toEqual({ view: { kind: 'all' }, selection: review.requested, anchor: sha('4') });
    expect(
      selectReviewView(review, all, { kind: 'drop', fromSha: sha('1'), toSha: sha('4') })?.view,
    ).toEqual({ kind: 'all' });
  });

  it('goes from the whole review to the first commit on next and the last on previous', () => {
    expect(selectReviewView(review, all, { kind: 'next' })).toEqual({
      view: { kind: 'commit', sha: sha('1') },
      selection: { baseCommitish: sha('0'), targetCommitish: sha('1') },
      anchor: sha('1'),
    });
    expect(selectReviewView(review, all, { kind: 'previous' })?.view).toEqual({
      kind: 'commit',
      sha: sha('4'),
    });
  });

  it('moves to the neighbouring commit on previous and next', () => {
    expect(selectReviewView(review, commitView('2'), { kind: 'next' })).toEqual({
      view: { kind: 'commit', sha: sha('3') },
      selection: { baseCommitish: sha('2'), targetCommitish: sha('3') },
      anchor: sha('3'),
    });
    expect(selectReviewView(review, commitView('2'), { kind: 'previous' })?.view).toEqual({
      kind: 'commit',
      sha: sha('1'),
    });
  });

  it('stays put on previous at the first commit and next at the last', () => {
    expect(selectReviewView(review, commitView('1'), { kind: 'previous' })).toBeNull();
    expect(selectReviewView(review, commitView('4'), { kind: 'next' })).toBeNull();
  });

  it('leaves a run for the commit just past its end or just before its start', () => {
    const shown = { view: run('2', '3'), anchor: sha('2') };
    expect(selectReviewView(review, shown, { kind: 'next' })?.view).toEqual({
      kind: 'commit',
      sha: sha('4'),
    });
    expect(selectReviewView(review, shown, { kind: 'previous' })?.view).toEqual({
      kind: 'commit',
      sha: sha('1'),
    });
    expect(
      selectReviewView(review, { view: run('1', '2'), anchor: null }, { kind: 'previous' }),
    ).toBeNull();
    expect(
      selectReviewView(review, { view: run('3', '4'), anchor: null }, { kind: 'next' }),
    ).toBeNull();
  });

  it('shows the whole review and drops the anchor on all', () => {
    expect(selectReviewView(review, commitView('2'), { kind: 'all' })).toEqual({
      view: { kind: 'all' },
      selection: review.requested,
      anchor: null,
    });
  });

  describe('on a phone', () => {
    it('starts a run at the long-pressed commit and leaves the shown diff as it is', () => {
      expect(
        selectReviewView(review, commitView('2'), { kind: 'long-press', sha: sha('3') }),
      ).toEqual({
        view: { kind: 'commit', sha: sha('2') },
        selection: null,
        anchor: sha('2'),
        rangeStart: sha('3'),
      });
    });

    it('shows the run from the long-pressed commit to the next one tapped, in either direction', () => {
      const picking = { ...all, rangeStart: sha('2') };
      expect(selectReviewView(review, picking, { kind: 'click', sha: sha('3') })).toEqual({
        view: run('2', '3'),
        selection: { baseCommitish: sha('1'), targetCommitish: sha('3') },
        anchor: sha('2'),
      });
      expect(
        selectReviewView(review, { ...all, rangeStart: sha('4') }, { kind: 'click', sha: sha('2') })
          ?.view,
      ).toEqual(run('2', '4'));
    });

    it('chooses the same run by dragging from the long-pressed commit as by tapping after it', () => {
      const pressed = selectReviewView(review, commitView('1'), {
        kind: 'long-press',
        sha: sha('2'),
      })!;

      expect(
        selectReviewView(review, pressed, { kind: 'drop', fromSha: sha('2'), toSha: sha('4') }),
      ).toEqual(selectReviewView(review, pressed, { kind: 'click', sha: sha('4') }));
    });

    it('shows the long-pressed commit alone when it is tapped again', () => {
      expect(
        selectReviewView(review, { ...all, rangeStart: sha('3') }, { kind: 'click', sha: sha('3') })
          ?.view,
      ).toEqual({ kind: 'commit', sha: sha('3') });
    });

    it('starts the run again from a second long-pressed commit', () => {
      expect(
        selectReviewView(
          review,
          { ...all, rangeStart: sha('1') },
          { kind: 'long-press', sha: sha('3') },
        )?.rangeStart,
      ).toBe(sha('3'));
    });

    it('stops choosing a run on cancel and keeps what was shown and anchored before', () => {
      const pressed = selectReviewView(
        review,
        { view: run('2', '3'), anchor: sha('2') },
        {
          kind: 'long-press',
          sha: sha('4'),
        },
      )!;

      expect(selectReviewView(review, pressed, { kind: 'cancel' })).toEqual({
        view: run('2', '3'),
        selection: null,
        anchor: sha('2'),
      });
    });

    it('does nothing on cancel while no run is being chosen', () => {
      expect(selectReviewView(review, commitView('2'), { kind: 'cancel' })).toBeNull();
    });

    it('stops choosing a run once another view is chosen', () => {
      const picking = { ...commitView('2'), rangeStart: sha('3') };
      expect(selectReviewView(review, picking, { kind: 'all' })).not.toHaveProperty('rangeStart');
      expect(selectReviewView(review, picking, { kind: 'next' })).not.toHaveProperty('rangeStart');
    });
  });

  it('produces only pairs the server counts as views of the review', () => {
    const shownViews = [
      all,
      commitView('1'),
      commitView('4'),
      { view: run('2', '3'), anchor: null },
    ];
    const actions = [
      ...commits.flatMap((commit) => [
        { kind: 'click' as const, sha: commit.sha },
        { kind: 'shift-click' as const, sha: commit.sha },
        ...commits.map((to) => ({ kind: 'drop' as const, fromSha: commit.sha, toSha: to.sha })),
      ]),
      { kind: 'previous' as const },
      { kind: 'next' as const },
      { kind: 'all' as const },
    ];
    for (const shown of shownViews.flatMap((view) => [view, { ...view, rangeStart: sha('2') }])) {
      for (const action of actions) {
        const chosen = selectReviewView(review, shown, action);
        if (!chosen?.selection) continue;
        expect(isViewOfReview(chosen.selection, review)).toBe(true);
        if (chosen.view.kind === 'all') expect(chosen.selection).toBe(review.requested);
        else expect(reviewViewShown(chosen.selection, review)).toEqual(chosen.view);
      }
    }
  });
});
