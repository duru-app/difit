import { describe, expect, it } from 'vitest';

import type { DiffCommentThread, DiffFile, DiffLine } from '../../types/diff';

import { buildFileLineIndex, locateThread, placeThread } from './outdatedComments';

const buildThread = (overrides: Partial<DiffCommentThread> = {}): DiffCommentThread => ({
  id: 'thread-1',
  filePath: 'src/app.ts',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  position: { side: 'new', line: 10 },
  codeSnapshot: { content: 'const value = 1;' },
  messages: [
    {
      id: 'message-1',
      body: 'comment',
      author: 'User',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
  ...overrides,
});

const buildFile = (lines: DiffLine[]): DiffFile => ({
  path: 'src/app.ts',
  status: 'modified',
  additions: 0,
  deletions: 0,
  chunks: [
    {
      header: '@@ -1,1 +1,1 @@',
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: lines.length,
      lines,
    },
  ],
});

const newLine = (lineNumber: number, content: string): DiffLine => ({
  type: 'add',
  content,
  newLineNumber: lineNumber,
});

const oldLine = (lineNumber: number, content: string): DiffLine => ({
  type: 'delete',
  content,
  oldLineNumber: lineNumber,
});

const TARGET = '1234567';

describe('locateThread', () => {
  it('keeps the stored line when the snapshot still sits there and nowhere else', () => {
    const thread = buildThread({ position: { side: 'new', line: 10 } });
    const index = buildFileLineIndex(buildFile([newLine(10, 'const value = 1;')]));

    expect(locateThread(thread, index, TARGET)).toEqual({ line: 10, isOutdated: false });
  });

  it('moves the thread to where its snapshot now sits when lines were inserted above', () => {
    const thread = buildThread({
      codeSnapshot: { content: 'const a = 1;\nconst b = 2;' },
      position: { side: 'new', line: { start: 10, end: 11 } },
    });
    const index = buildFileLineIndex(
      buildFile([
        newLine(10, 'import x;'),
        newLine(11, 'import y;'),
        newLine(12, 'const a = 1;'),
        newLine(13, 'const b = 2;'),
      ]),
    );

    expect(locateThread(thread, index, TARGET)).toEqual({ line: [12, 13], isOutdated: false });
  });

  it('is outdated at the stored line when the snapshot is gone', () => {
    const thread = buildThread({ position: { side: 'new', line: 10 } });
    const index = buildFileLineIndex(buildFile([newLine(10, 'const value = 2;')]));

    expect(locateThread(thread, index, TARGET)).toEqual({
      line: 10,
      isOutdated: true,
      outdatedReason: 'missing',
    });
  });

  it('is outdated when the snapshot occurs more than once', () => {
    const thread = buildThread({
      position: { side: 'new', line: 10 },
      codeSnapshot: { content: 'const value = 1;', commit: '7654321' },
    });
    const index = buildFileLineIndex(
      buildFile([newLine(10, 'const value = 1;'), newLine(20, 'const value = 1;')]),
    );

    expect(locateThread(thread, index, TARGET)).toEqual({
      line: 10,
      isOutdated: true,
      outdatedReason: 'ambiguous',
    });
  });

  it('trusts the stored line of a repeated snapshot while viewing the commit it was made on', () => {
    const fullHash = 'b7c2e10' + '0'.repeat(33);
    const thread = buildThread({
      position: { side: 'new', line: 20 },
      codeSnapshot: { content: '}', commit: fullHash },
    });
    const index = buildFileLineIndex(buildFile([newLine(10, '}'), newLine(20, '}')]));

    expect(locateThread(thread, index, 'b7c2e10')).toEqual({ line: 20, isOutdated: false });
    expect(locateThread(thread, index, '6e4f6d5')).toEqual({
      line: 20,
      isOutdated: true,
      outdatedReason: 'ambiguous',
    });
  });

  it('trusts a stored line in collapsed context while viewing the commit it was made on', () => {
    const thread = buildThread({
      position: { side: 'new', line: 10 },
      codeSnapshot: { content: 'const value = 1;', commit: TARGET },
    });
    const index = buildFileLineIndex(buildFile([newLine(5, 'const other = 99;')]));

    expect(locateThread(thread, index, TARGET)).toEqual({ line: 10, isOutdated: false });
  });

  it('trusts the stored line of a thread saved without the commit it was made on', () => {
    const thread = buildThread({
      position: { side: 'new', line: 20 },
      codeSnapshot: { content: '}' },
    });

    const repeated = buildFileLineIndex(buildFile([newLine(10, '}'), newLine(20, '}')]));
    expect(locateThread(thread, repeated, TARGET)).toEqual({ line: 20, isOutdated: false });

    const collapsed = buildFileLineIndex(buildFile([newLine(5, 'const other = 99;')]));
    expect(locateThread(thread, collapsed, TARGET)).toEqual({ line: 20, isOutdated: false });
  });

  describe('without a target commit', () => {
    it('keeps a repeated line in place instead of calling it ambiguous', () => {
      const thread = buildThread({ position: { side: 'new', line: 20 } });
      const index = buildFileLineIndex(
        buildFile([newLine(10, 'const value = 1;'), newLine(20, 'const value = 1;')]),
      );

      expect(locateThread(thread, index, null)).toEqual({ line: 20, isOutdated: false });
    });

    it('does not move the thread when lines were inserted above', () => {
      const thread = buildThread({ position: { side: 'new', line: 10 } });
      const index = buildFileLineIndex(
        buildFile([newLine(10, 'import x;'), newLine(11, 'const value = 1;')]),
      );

      expect(locateThread(thread, index, null)).toEqual({
        line: 10,
        isOutdated: true,
        outdatedReason: 'missing',
      });
    });

    it('does not judge a stored line hidden in collapsed context', () => {
      const thread = buildThread({ position: { side: 'new', line: 10 } });
      const index = buildFileLineIndex(buildFile([newLine(5, 'const other = 99;')]));

      expect(locateThread(thread, index, null)).toEqual({ line: 10, isOutdated: false });
    });
  });

  it('is outdated when the file is missing from the index map (file no longer in the diff)', () => {
    expect(locateThread(buildThread(), undefined, TARGET)).toEqual({
      line: 10,
      isOutdated: true,
      outdatedReason: 'missing',
    });
  });

  it('keeps a thread without a code snapshot (legacy comment) where it was', () => {
    const thread = buildThread({ codeSnapshot: undefined });
    const index = buildFileLineIndex(buildFile([newLine(10, 'anything')]));

    expect(locateThread(thread, index, TARGET)).toEqual({ line: 10, isOutdated: false });
  });

  it('ignores trailing whitespace and line endings when matching', () => {
    const thread = buildThread({
      codeSnapshot: { content: 'const value = 1;  \r\nconst next = 2;' },
      position: { side: 'new', line: { start: 10, end: 11 } },
    });
    const index = buildFileLineIndex(
      buildFile([newLine(10, 'const value = 1;'), newLine(11, 'const next = 2;')]),
    );

    expect(locateThread(thread, index, TARGET)).toEqual({ line: [10, 11], isOutdated: false });
  });

  it('compares against the "old" side when the thread is anchored to a deletion', () => {
    const thread = buildThread({
      codeSnapshot: { content: 'const removed = true;' },
      position: { side: 'old', line: 42 },
    });
    const changed = buildFileLineIndex(buildFile([oldLine(42, 'const removed = false;')]));
    const same = buildFileLineIndex(buildFile([oldLine(42, 'const removed = true;')]));

    expect(locateThread(thread, changed, TARGET).isOutdated).toBe(true);
    expect(locateThread(thread, same, TARGET)).toEqual({ line: 42, isOutdated: false });
  });

  it('does not confuse "old" and "new" line numbers when both sides exist', () => {
    const thread = buildThread({
      codeSnapshot: { content: 'old-side text' },
      position: { side: 'old', line: 5 },
    });
    const index = buildFileLineIndex(
      buildFile([{ type: 'normal', content: 'new-side text', oldLineNumber: 5, newLineNumber: 5 }]),
    );

    expect(locateThread(thread, index, TARGET).isOutdated).toBe(true);
  });
});

describe('locateThread on a thread with several ranges', () => {
  const multi = buildThread({
    position: { side: 'new', line: { start: 30, end: 31 }, extraRanges: [10, 20] },
    codeSnapshot: {
      content: 'log(a + b);\nreturn;',
      extraContents: ['log(x + y);', 'log(p + q);'],
      commit: '7654321',
    },
  });
  const shifted = (by: number, overrides: Partial<Record<number, string>> = {}) =>
    buildFileLineIndex(
      buildFile(
        [
          [10, 'log(x + y);'],
          [20, 'log(p + q);'],
          [30, 'log(a + b);'],
          [31, 'return;'],
        ].map(([line, content]) =>
          newLine(Number(line) + by, overrides[Number(line)] ?? String(content)),
        ),
      ),
    );

  it('keeps every range where it was stored', () => {
    expect(locateThread(multi, shifted(0), TARGET)).toEqual({
      line: [30, 31],
      extraLines: [
        { side: 'new', line: 10 },
        { side: 'new', line: 20 },
      ],
      isOutdated: false,
    });
  });

  it('moves every range to where its code now sits', () => {
    expect(locateThread(multi, shifted(5), TARGET)).toEqual({
      line: [35, 36],
      extraLines: [
        { side: 'new', line: 15 },
        { side: 'new', line: 25 },
      ],
      isOutdated: false,
    });
  });

  it('is outdated as a whole when the code of one range is gone', () => {
    expect(locateThread(multi, shifted(5, { 20: 'log(`${p}${q}`);' }), TARGET)).toEqual({
      line: [30, 31],
      extraLines: [
        { side: 'new', line: 10 },
        { side: 'new', line: 20 },
      ],
      isOutdated: true,
      outdatedReason: 'missing',
    });
  });

  it('leaves a range saved without its code where it was stored', () => {
    const withoutCode = buildThread({
      ...multi,
      codeSnapshot: { content: 'log(a + b);\nreturn;', commit: '7654321' },
    });

    expect(locateThread(withoutCode, shifted(5), TARGET)).toEqual({
      line: [35, 36],
      extraLines: [
        { side: 'new', line: 10 },
        { side: 'new', line: 20 },
      ],
      isOutdated: false,
    });
  });

  it('checks every range in place without a target commit', () => {
    expect(locateThread(multi, shifted(0, { 10: 'changed();' }), null)).toMatchObject({
      isOutdated: true,
    });
    expect(locateThread(multi, shifted(0), null)).toMatchObject({ isOutdated: false });
  });
});

describe('locateThread on a thread over deleted and kept lines', () => {
  const mixed = buildThread({
    position: {
      side: 'new',
      line: { start: 12, end: 13 },
      extraRanges: [{ side: 'old', start: 12, end: 14 }],
    },
    codeSnapshot: {
      content: 'next(a);\nnext(b);',
      extraContents: ['prev(a);\nprev(b);\nprev(c);'],
      commit: '7654321',
    },
  });
  const file = (newBy: number, oldContent = 'prev(a);') =>
    buildFileLineIndex(
      buildFile([
        oldLine(12, oldContent),
        oldLine(13, 'prev(b);'),
        oldLine(14, 'prev(c);'),
        newLine(12 + newBy, 'next(a);'),
        newLine(13 + newBy, 'next(b);'),
      ]),
    );

  it('finds each range among the lines of its own side', () => {
    expect(locateThread(mixed, file(4), TARGET)).toEqual({
      line: [16, 17],
      extraLines: [{ side: 'old', line: [12, 14] }],
      isOutdated: false,
    });
  });

  it('is outdated as a whole when the deleted lines are not found', () => {
    expect(locateThread(mixed, file(4, 'prev(z);'), TARGET)).toEqual({
      line: [12, 13],
      extraLines: [{ side: 'old', line: [12, 14] }],
      isOutdated: true,
      outdatedReason: 'missing',
    });
  });
});

describe('placeThread', () => {
  const sha = (digit: string) => digit.repeat(40);
  const PIN = { sha: sha('1'), shortSha: '1111111', parentSha: sha('0'), subject: 'test: pin' };
  const FIX = { sha: sha('2'), shortSha: '2222222', parentSha: sha('1'), subject: 'fix: round' };
  const review = {
    selection: { baseCommitish: '0000000', targetCommitish: '2222222' },
    commits: [PIN, FIX],
  };
  const WHOLE = { baseCommitish: '0000000', targetCommitish: '2222222' };
  const PIN_VIEW = { baseCommitish: '0000000', targetCommitish: '1111111' };
  const FIX_VIEW = { baseCommitish: '1111111', targetCommitish: '2222222' };
  const shownOn = (view: typeof WHOLE) => ({ view, review, targetCommit: '2222222' });

  const madeOnPin = (overrides: Partial<DiffCommentThread> = {}) =>
    buildThread({
      view: { baseCommitish: PIN.parentSha, targetCommitish: PIN.sha },
      fixupTarget: PIN.sha,
      codeSnapshot: { content: 'const value = 1;', commit: PIN.sha },
      ...overrides,
    });
  const oldThread = () =>
    buildThread({ codeSnapshot: { content: 'const value = 1;', commit: '2222222' } });
  const repeated = buildFileLineIndex(
    buildFile([newLine(10, 'const value = 1;'), newLine(20, 'const value = 1;')]),
  );
  const movedDown = buildFileLineIndex(
    buildFile([newLine(10, 'import x;'), newLine(12, 'const value = 1;')]),
  );
  const gone = buildFileLineIndex(buildFile([newLine(10, 'const value = 2;')]));

  it('draws a thread at its stored line on the view it was made on, even when the line repeats', () => {
    expect(placeThread(madeOnPin(), shownOn(PIN_VIEW), repeated)).toEqual({
      kind: 'stored',
      line: 10,
    });
  });

  it('moves a thread on another view to the one line that holds its content', () => {
    expect(placeThread(madeOnPin(), shownOn(WHOLE), movedDown)).toEqual({
      kind: 'moved',
      line: 12,
    });
  });

  it('marks a thread on another view outdated when its content is gone or repeats', () => {
    expect(placeThread(madeOnPin(), shownOn(WHOLE), gone)).toEqual({
      kind: 'stale',
      reason: 'missing',
      line: 10,
    });
    expect(placeThread(madeOnPin(), shownOn(WHOLE), repeated)).toEqual({
      kind: 'stale',
      reason: 'ambiguous',
      line: 10,
    });
  });

  it('hides a thread on a commit view that does not hold its fixup target', () => {
    expect(placeThread(madeOnPin(), shownOn(FIX_VIEW), movedDown)).toEqual({
      kind: 'hidden',
      line: 10,
    });
  });

  it('never hides a thread on the whole review', () => {
    const elsewhere = madeOnPin({ fixupTarget: 'abcdef0' });

    expect(placeThread(elsewhere, shownOn(WHOLE), movedDown).kind).toBe('moved');
  });

  it('places a thread from before views as made on the whole review and aimed at its target', () => {
    expect(placeThread(oldThread(), shownOn(WHOLE), repeated)).toEqual({
      kind: 'stored',
      line: 10,
    });
    expect(placeThread(oldThread(), shownOn(FIX_VIEW), movedDown)).toEqual({
      kind: 'moved',
      line: 12,
    });
    expect(placeThread(oldThread(), shownOn(FIX_VIEW), repeated)).toEqual({
      kind: 'stale',
      reason: 'ambiguous',
      line: 10,
    });
    expect(placeThread(oldThread(), shownOn(PIN_VIEW), repeated).kind).toBe('hidden');
  });

  it('does not trust the stored line of a deleted line commented on the last commit', () => {
    const thread = buildThread({
      position: { side: 'old', line: 10 },
      codeSnapshot: { content: 'const removed = true;', commit: FIX.sha },
      view: { baseCommitish: FIX.parentSha, targetCommitish: FIX.sha },
      fixupTarget: FIX.sha,
    });
    const index = buildFileLineIndex(
      buildFile([oldLine(10, 'const removed = true;'), oldLine(30, 'const removed = true;')]),
    );

    expect(placeThread(thread, shownOn(FIX_VIEW), index).kind).toBe('stored');
    expect(placeThread(thread, shownOn(WHOLE), index)).toEqual({
      kind: 'stale',
      reason: 'ambiguous',
      line: 10,
    });
  });

  it("keeps a thread made on a fixup's own file at its stored line in that fixup's tree", () => {
    const fixupSha = sha('3');
    const thread = buildThread({
      filePath: 'src/new.test.ts',
      codeSnapshot: { content: 'const value = 1;', commit: fixupSha },
      fixupTarget: PIN.sha,
    });

    expect(placeThread(thread, shownOn(WHOLE), repeated, fixupSha)).toEqual({
      kind: 'stored',
      line: 10,
    });
    expect(placeThread(thread, shownOn(WHOLE), repeated)).toEqual({
      kind: 'stale',
      reason: 'ambiguous',
      line: 10,
    });
  });

  it('relocates an imported thread whose snapshot comes from an older commit', () => {
    const thread = buildThread({
      codeSnapshot: { content: 'const value = 1;', commit: 'abcdef0' },
    });

    expect(placeThread(thread, shownOn(WHOLE), repeated)).toEqual({
      kind: 'stale',
      reason: 'ambiguous',
      line: 10,
    });
  });

  it('places a thread as before when the diff is no view of a review', () => {
    expect(placeThread(madeOnPin(), { view: null, targetCommit: TARGET }, movedDown)).toEqual({
      kind: 'moved',
      line: 12,
    });
    expect(placeThread(oldThread(), { view: WHOLE, targetCommit: null }, movedDown)).toEqual({
      kind: 'stale',
      reason: 'missing',
      line: 10,
    });
  });

  describe('a thread on the whole file', () => {
    const onFile = (overrides: Partial<DiffCommentThread> = {}) =>
      madeOnPin({
        position: { side: 'new', scope: 'file' },
        codeSnapshot: { content: '', commit: PIN.sha },
        ...overrides,
      });

    it('is drawn without a line wherever its file is in the diff, whatever the lines hold', () => {
      expect(placeThread(onFile(), shownOn(PIN_VIEW), gone)).toEqual({ kind: 'stored' });
      expect(placeThread(onFile(), shownOn(WHOLE), repeated)).toEqual({ kind: 'stored' });
      expect(placeThread(onFile(), { view: WHOLE, targetCommit: null }, gone)).toEqual({
        kind: 'stored',
      });
    });

    it('is outdated where the diff does not hold its file', () => {
      expect(placeThread(onFile(), shownOn(WHOLE), undefined)).toEqual({
        kind: 'stale',
        reason: 'missing',
      });
    });

    it('is hidden on a commit view that does not hold its fixup target, like a line thread', () => {
      expect(placeThread(onFile(), shownOn(FIX_VIEW), gone)).toEqual({ kind: 'hidden' });
    });
  });
});
