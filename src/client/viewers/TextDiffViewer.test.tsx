import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ChunkChangeKind, CommentThread, DiffFile, ThreadFixup } from '../../types/diff';
import { EMPTY_FIXUP_OVERLAY, FixupOverlayProvider } from '../contexts/FixupOverlayContext';
import { WordHighlightProvider } from '../contexts/WordHighlightContext';
import type { MergedChunk } from '../hooks/useExpandedLines';
import { boxesByAnchor, type FixupBox } from '../utils/fixupSpread';

import { TextDiffViewer } from './TextDiffViewer';
import type { DiffViewerBodyProps } from './types';

const chunk = (changeKind: ChunkChangeKind | undefined, start: number): MergedChunk => ({
  header: `@@ -${start},2 +${start},2 @@`,
  oldStart: start,
  oldLines: 2,
  newStart: start,
  newLines: 2,
  changeKind,
  originalIndices: [start],
  originalLineRanges: [{ originalIndex: start, start: 0, end: 2, changeKind }],
  hiddenLinesBefore: 0,
  hiddenLinesAfter: 0,
  lines: [
    { type: 'delete', content: `// old ${start}`, oldLineNumber: start },
    { type: 'add', content: `// new ${start}`, newLineNumber: start },
    { type: 'normal', content: `f${start}();`, oldLineNumber: start + 1, newLineNumber: start + 1 },
  ],
});

const file: DiffFile = {
  path: 'src/a.ts',
  status: 'modified',
  additions: 2,
  deletions: 2,
  chunks: [],
};

const shown = (code: string) => document.body.textContent?.includes(code) ?? false;
const noop = () => {};
const asyncNoop = async () => {};

function viewer(props: Partial<DiffViewerBodyProps>) {
  return (
    <WordHighlightProvider>
      <TextDiffViewer
        file={file}
        threads={[]}
        diffMode="unified"
        mergedChunks={[chunk('comment', 10), chunk('code', 40)]}
        foldCommentChanges
        isExpandLoading={false}
        openHiddenLines={asyncNoop}
        onAddComment={asyncNoop}
        onResolveThread={noop}
        onReplyToThread={asyncNoop}
        onRemoveMessage={noop}
        onUpdateMessage={noop}
        {...props}
      />
    </WordHighlightProvider>
  );
}

function renderViewer(props: Partial<DiffViewerBodyProps>) {
  return render(viewer(props));
}

// A code change and a comment-only change joined by the opened line between them.
const codeThenComment = (): MergedChunk => ({
  header: '@@ -1,5 +1,5 @@',
  oldStart: 1,
  oldLines: 5,
  newStart: 1,
  newLines: 5,
  changeKind: 'code',
  originalIndices: [0, 1],
  originalLineRanges: [
    { originalIndex: 0, start: 0, end: 2, changeKind: 'code' },
    { originalIndex: 1, start: 4, end: 6, changeKind: 'comment' },
  ],
  hiddenLinesBefore: 0,
  hiddenLinesAfter: 0,
  lines: [
    { type: 'delete', content: 'a = 1;', oldLineNumber: 1 },
    { type: 'add', content: 'a = 2;', newLineNumber: 1 },
    { type: 'normal', content: 'b();', oldLineNumber: 2, newLineNumber: 2 },
    { type: 'normal', content: 'opened();', oldLineNumber: 3, newLineNumber: 3 },
    { type: 'delete', content: '// old note', oldLineNumber: 4 },
    { type: 'add', content: '// new note', newLineNumber: 4 },
    { type: 'normal', content: 'c();', oldLineNumber: 5, newLineNumber: 5 },
  ],
});

const codeThenTwoComments = (): MergedChunk => {
  const base = codeThenComment();
  return {
    ...base,
    header: '@@ -1,7 +1,7 @@',
    oldLines: 7,
    newLines: 7,
    originalIndices: [0, 1, 2],
    originalLineRanges: [
      ...base.originalLineRanges,
      { originalIndex: 2, start: 8, end: 9, changeKind: 'comment' },
    ],
    lines: [
      ...base.lines,
      { type: 'normal', content: 'd();', oldLineNumber: 6, newLineNumber: 6 },
      { type: 'delete', content: '// old tail', oldLineNumber: 7 },
      { type: 'add', content: '// new tail', newLineNumber: 7 },
    ],
  };
};

describe('TextDiffViewer folding', () => {
  it('folds a comment-only chunk into one line and opens it on click', () => {
    renderViewer({});

    const fold = screen.getByRole('button', { name: '주석 1줄 바뀜 · 펼치기' });
    expect(shown('// new 10')).toBe(false);
    expect(shown('// new 40')).toBe(true);

    fireEvent.click(fold);
    expect(shown('// new 10')).toBe(true);
    expect(screen.queryByRole('button', { name: /펼치기/ })).toBeNull();
  });

  it('folds an opened chunk again when folding is turned off and back on', () => {
    const { rerender } = renderViewer({});
    fireEvent.click(screen.getByRole('button', { name: '주석 1줄 바뀜 · 펼치기' }));

    rerender(viewer({ foldCommentChanges: false }));
    rerender(viewer({ foldCommentChanges: true }));

    expect(shown('// new 10')).toBe(false);
    expect(screen.getByRole('button', { name: '주석 1줄 바뀜 · 펼치기' })).toBeInTheDocument();
  });

  it.each(['unified', 'split'] as const)(
    'folds the comment-only part of a chunk that also changes code in %s mode',
    (diffMode) => {
      renderViewer({ mergedChunks: [codeThenComment()], diffMode });

      const fold = screen.getByRole('button', { name: '주석 1줄 바뀜 · 펼치기' });
      expect(shown('a = 2;')).toBe(true);
      expect(shown('opened();')).toBe(true);
      expect(shown('// new note')).toBe(false);
      expect(shown('c();')).toBe(false);

      fireEvent.click(fold);
      expect(shown('// new note')).toBe(true);
    },
  );

  it.each(['unified', 'split'] as const)(
    'folds an opened part again from its header in %s mode',
    (diffMode) => {
      renderViewer({ mergedChunks: [codeThenComment()], diffMode });

      fireEvent.click(screen.getByRole('button', { name: '주석 1줄 바뀜 · 펼치기' }));
      const header = screen.getByRole('button', { name: '주석 1줄 바뀜 · 접기' });
      expect(shown('// new note')).toBe(true);

      fireEvent.click(header);
      expect(shown('// new note')).toBe(false);
      expect(shown('a = 2;')).toBe(true);
      expect(screen.getByRole('button', { name: '주석 1줄 바뀜 · 펼치기' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /접기/ })).toBeNull();
    },
  );

  it('folds an opened part from its header while the cursor is inside it', () => {
    const { rerender } = renderViewer({ mergedChunks: [codeThenComment()] });
    fireEvent.click(screen.getByRole('button', { name: '주석 1줄 바뀜 · 펼치기' }));
    rerender(
      viewer({
        mergedChunks: [codeThenComment()],
        cursor: { fileIndex: 0, chunkIndex: 0, lineIndex: 5, side: 'right' },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: '주석 1줄 바뀜 · 접기' }));

    expect(shown('// new note')).toBe(false);
    expect(screen.getByRole('button', { name: '주석 1줄 바뀜 · 펼치기' })).toBeInTheDocument();
  });

  it('folds a part the cursor opened until the cursor moves', () => {
    const { rerender } = renderViewer({
      mergedChunks: [codeThenComment()],
      cursor: { fileIndex: 0, chunkIndex: 0, lineIndex: 5, side: 'right' },
    });

    fireEvent.click(screen.getByRole('button', { name: '주석 1줄 바뀜 · 접기' }));
    expect(shown('// new note')).toBe(false);

    rerender(
      viewer({
        mergedChunks: [codeThenComment()],
        cursor: { fileIndex: 0, chunkIndex: 0, lineIndex: 6, side: 'right' },
      }),
    );
    expect(shown('// new note')).toBe(true);
  });

  it.each(['unified', 'split'] as const)(
    'keeps a part folded over the cursor while another part is toggled in %s mode',
    (diffMode) => {
      const twoNotes = codeThenTwoComments();
      renderViewer({
        mergedChunks: [twoNotes],
        diffMode,
        cursor: { fileIndex: 0, chunkIndex: 0, lineIndex: 5, side: 'right' },
      });

      fireEvent.click(screen.getByRole('button', { name: '주석 1줄 바뀜 · 접기' }));
      const folds = screen.getAllByRole('button', { name: '주석 1줄 바뀜 · 펼치기' });
      fireEvent.click(folds[1]!);

      expect(shown('// new tail')).toBe(true);
      expect(shown('// new note')).toBe(false);
    },
  );

  it('forgets a part folded over the cursor when folding is turned off', () => {
    const cursor = { fileIndex: 0, chunkIndex: 0, lineIndex: 5, side: 'right' } as const;
    const { rerender } = renderViewer({ mergedChunks: [codeThenComment()], cursor });
    fireEvent.click(screen.getByRole('button', { name: '주석 1줄 바뀜 · 접기' }));

    rerender(viewer({ mergedChunks: [codeThenComment()], cursor, foldCommentChanges: false }));
    rerender(viewer({ mergedChunks: [codeThenComment()], cursor }));

    expect(shown('// new note')).toBe(true);
  });

  it.each(['unified', 'split'] as const)(
    'cannot fold a part while a comment form is open in it in %s mode',
    (diffMode) => {
      renderViewer({
        mergedChunks: [codeThenComment()],
        diffMode,
        cursor: { fileIndex: 0, chunkIndex: 0, lineIndex: 5, side: 'right' },
        commentTrigger: { fileIndex: 0, chunkIndex: 0, lineIndex: 5 },
      });

      expect(screen.getByRole('textbox')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '주석 1줄 바뀜 · 접기' })).toBeDisabled();
    },
  );

  it.each(['unified', 'split'] as const)(
    'keeps focus on the header across folding in %s mode',
    (diffMode) => {
      renderViewer({ mergedChunks: [codeThenComment()], diffMode });
      const header = screen.getByRole('button', { name: '주석 1줄 바뀜 · 펼치기' });
      header.focus();

      fireEvent.click(header);

      expect(document.activeElement).toBe(header);
      expect(header).toHaveAccessibleName('주석 1줄 바뀜 · 접기');
    },
  );

  it('keeps the comment-only part folded while the cursor is outside it', () => {
    renderViewer({
      mergedChunks: [codeThenComment()],
      cursor: { fileIndex: 0, chunkIndex: 0, lineIndex: 3, side: 'right' },
    });

    expect(screen.getByRole('button', { name: '주석 1줄 바뀜 · 펼치기' })).toBeInTheDocument();
  });

  it('opens the comment-only part when the cursor moves into it', () => {
    renderViewer({
      mergedChunks: [codeThenComment()],
      cursor: { fileIndex: 0, chunkIndex: 0, lineIndex: 5, side: 'right' },
    });

    expect(shown('// new note')).toBe(true);
  });

  it.each(['unified', 'split'] as const)(
    'keeps a comment form open after the cursor leaves the folded part in %s mode',
    (diffMode) => {
      const { rerender } = renderViewer({
        mergedChunks: [codeThenComment()],
        diffMode,
        cursor: { fileIndex: 0, chunkIndex: 0, lineIndex: 5, side: 'right' },
        commentTrigger: { fileIndex: 0, chunkIndex: 0, lineIndex: 5 },
      });
      expect(screen.getByRole('textbox')).toBeInTheDocument();

      rerender(
        viewer({
          mergedChunks: [codeThenComment()],
          diffMode,
          cursor: { fileIndex: 0, chunkIndex: 0, lineIndex: 0, side: 'right' },
          commentTrigger: null,
        }),
      );

      expect(screen.getByRole('textbox')).toBeInTheDocument();
      expect(shown('// new note')).toBe(true);
    },
  );

  it('keeps a comment form open on a wholly folded chunk after the cursor leaves it', () => {
    const { rerender } = renderViewer({
      cursor: { fileIndex: 0, chunkIndex: 0, lineIndex: 1, side: 'right' },
      commentTrigger: { fileIndex: 0, chunkIndex: 0, lineIndex: 1 },
    });
    expect(screen.getByRole('textbox')).toBeInTheDocument();

    rerender(
      viewer({
        cursor: { fileIndex: 0, chunkIndex: 1, lineIndex: 0, side: 'right' },
        commentTrigger: null,
      }),
    );

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(shown('// new 10')).toBe(true);
  });

  it('folds and opens each comment-only part of one chunk on its own', () => {
    const twoNotes = codeThenTwoComments();
    const thread: CommentThread = {
      id: 't1',
      file: 'src/a.ts',
      line: 7,
      side: 'new',
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
      messages: [],
    };

    const { rerender } = renderViewer({ mergedChunks: [twoNotes] });
    const folds = screen.getAllByRole('button', { name: '주석 1줄 바뀜 · 펼치기' });
    expect(folds).toHaveLength(2);

    fireEvent.click(folds[1]!);
    expect(shown('// new tail')).toBe(true);
    expect(shown('// new note')).toBe(false);

    rerender(viewer({ mergedChunks: [twoNotes], foldCommentChanges: false }));
    rerender(viewer({ mergedChunks: [twoNotes], threads: [thread] }));
    expect(shown('// new tail')).toBe(true);
    expect(shown('// new note')).toBe(false);
  });

  it('labels a whitespace-only chunk as such', () => {
    renderViewer({ mergedChunks: [chunk('whitespace', 10)] });

    expect(screen.getByRole('button', { name: '공백 1줄 바뀜 · 펼치기' })).toBeInTheDocument();
  });

  it('counts the larger side when lines are split or joined', () => {
    const split = chunk('whitespace', 10);
    split.lines = [
      { type: 'delete', content: 'f(a, b);', oldLineNumber: 10 },
      { type: 'add', content: 'f(', newLineNumber: 10 },
      { type: 'add', content: '  a,', newLineNumber: 11 },
      { type: 'add', content: '  b);', newLineNumber: 12 },
    ];
    split.originalLineRanges = [{ originalIndex: 10, start: 0, end: 3, changeKind: 'whitespace' }];
    renderViewer({ mergedChunks: [split] });

    expect(screen.getByRole('button', { name: '공백 3줄 바뀜 · 펼치기' })).toBeInTheDocument();
  });

  it('adds up separate changes inside one chunk', () => {
    const twoPlaces = chunk('comment', 10);
    twoPlaces.lines = [
      { type: 'add', content: '// note', newLineNumber: 10 },
      { type: 'normal', content: 'f();', oldLineNumber: 10, newLineNumber: 11 },
      { type: 'delete', content: '// stale', oldLineNumber: 11 },
    ];
    renderViewer({ mergedChunks: [twoPlaces] });

    expect(screen.getByRole('button', { name: '주석 2줄 바뀜 · 펼치기' })).toBeInTheDocument();
  });

  it('shows every chunk when folding is off', () => {
    renderViewer({ foldCommentChanges: false });

    expect(shown('// new 10')).toBe(true);
    expect(screen.queryByRole('button', { name: /펼치기/ })).toBeNull();
  });

  it('keeps unclassified and unknown chunks open', () => {
    renderViewer({ mergedChunks: [chunk(undefined, 10), chunk('unknown', 40)] });

    expect(shown('// new 10')).toBe(true);
    expect(shown('// new 40')).toBe(true);
  });

  it('keeps a chunk open when a thread sits on it', () => {
    const thread: CommentThread = {
      id: 't1',
      file: 'src/a.ts',
      line: 11,
      side: 'new',
      createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:00.000Z',
      messages: [],
    };
    renderViewer({ threads: [thread] });

    expect(shown('// new 10')).toBe(true);
  });

  it('keeps a part open, and its fixup box shown, when a fixup changed a line in it', () => {
    const fixupChunk = chunk(undefined, 11);
    const fixupFile: ThreadFixup['files'][number] = {
      path: 'src/a.ts',
      status: 'modified',
      chunks: [fixupChunk],
    };
    const box: FixupBox = {
      fixup: {
        sha: 'abc1234abc1234',
        shortSha: 'abc1234',
        patchId: 'patch-abc1234',
        authoredAt: '2026-01-01T00:00:00Z',
        subject: 'fixup! x',
        threadIds: ['t1'],
        files: [fixupFile],
      },
      threads: [{ id: 't1', file: 'src/b.ts', line: 3 }],
      file: fixupFile,
      chunk: fixupChunk,
      chunkIndex: 0,
      anchor: 11,
    };
    render(
      <FixupOverlayProvider
        value={{
          ...EMPTY_FIXUP_OVERLAY,
          enabled: true,
          boxesByFile: new Map([['src/a.ts', boxesByAnchor([box])]]),
        }}
      >
        {viewer({})}
      </FixupOverlayProvider>,
    );

    expect(shown('// new 10')).toBe(true);
    expect(screen.queryByRole('button', { name: /펼치기/ })).toBeNull();
    expect(screen.getByTestId('fixup-file-box')).toHaveTextContent('// new 11');
  });

  it('keeps a chunk open while the cursor is in it', () => {
    renderViewer({ cursor: { fileIndex: 0, chunkIndex: 0, lineIndex: 1, side: 'right' } });

    expect(shown('// new 10')).toBe(true);
  });
});

describe('TextDiffViewer lines hidden around a fixup box', () => {
  const line = (oldLine: number) => ({
    type: 'normal' as const,
    content: `line ${oldLine}`,
    oldLineNumber: oldLine,
    newLineNumber: oldLine,
    isExpanded: true,
  });
  const change = (at: number) => ({
    header: `@@ -${at},2 +${at},2 @@`,
    oldStart: at,
    oldLines: 2,
    newStart: at,
    newLines: 2,
    lines: [
      { type: 'delete' as const, content: `old ${at}`, oldLineNumber: at },
      { type: 'add' as const, content: `new ${at}`, newLineNumber: at },
      {
        type: 'normal' as const,
        content: `kept ${at}`,
        oldLineNumber: at + 1,
        newLineNumber: at + 1,
      },
    ],
  });
  const gapFile: DiffFile = {
    path: 'src/a.ts',
    status: 'modified',
    additions: 2,
    deletions: 2,
    chunks: [change(10), change(60)],
  };
  const merged = (
    originalIndex: number,
    hiddenLinesBefore: number,
    hiddenLinesAfter = 0,
  ): MergedChunk => {
    const own = gapFile.chunks[originalIndex] ?? change(1);
    return {
      ...own,
      originalIndices: [originalIndex],
      originalLineRanges: [{ originalIndex, start: 0, end: own.lines.length - 1 }],
      hiddenLinesBefore,
      hiddenLinesAfter,
    };
  };
  const opened = (start: number, end: number, hiddenLinesBefore: number): MergedChunk => ({
    header: '',
    oldStart: start,
    oldLines: end - start + 1,
    newStart: start,
    newLines: end - start + 1,
    lines: Array.from({ length: end - start + 1 }, (_, index) => line(start + index)),
    originalIndices: [],
    originalLineRanges: [],
    hiddenLinesBefore,
    hiddenLinesAfter: 0,
  });
  const boxAt = (anchor: number): FixupBox => {
    const fixupFile: ThreadFixup['files'][number] = {
      path: 'src/a.ts',
      status: 'modified',
      chunks: [change(anchor)],
    };
    return {
      fixup: {
        sha: 'abc1234abc1234',
        shortSha: 'abc1234',
        patchId: 'patch-abc1234',
        authoredAt: '2026-01-01T00:00:00Z',
        subject: 'fixup! x',
        threadIds: ['t1'],
        files: [fixupFile],
      },
      threads: [{ id: 't1', file: 'src/b.ts', line: 3 }],
      file: fixupFile,
      chunk: fixupFile.chunks[0] ?? change(anchor),
      chunkIndex: 0,
      anchor,
    };
  };
  const renderWithBox = (
    mergedChunks: MergedChunk[],
    openHiddenLines: DiffViewerBodyProps['openHiddenLines'],
  ) =>
    render(
      <FixupOverlayProvider
        value={{
          ...EMPTY_FIXUP_OVERLAY,
          enabled: true,
          boxesByFile: new Map([['src/a.ts', boxesByAnchor([boxAt(30)])]]),
        }}
      >
        {viewer({ file: gapFile, mergedChunks, foldCommentChanges: false, openHiddenLines })}
      </FixupOverlayProvider>,
    );

  it('opens three lines on each side of a box anchored on a hidden line', () => {
    const openHiddenLines = vi.fn<DiffViewerBodyProps['openHiddenLines']>(async () => {});
    renderWithBox([merged(0, 9), merged(1, 48, 5)], openHiddenLines);

    expect(openHiddenLines).toHaveBeenCalledWith(gapFile, [{ start: 27, end: 33 }]);
    expect(screen.queryByTestId('fixup-file-box')).toBeNull();
  });

  it('draws the box in the opened lines and opens nothing more', () => {
    const openHiddenLines = vi.fn<DiffViewerBodyProps['openHiddenLines']>(async () => {});
    renderWithBox([merged(0, 9), opened(27, 33, 15), merged(1, 26, 5)], openHiddenLines);

    expect(openHiddenLines).not.toHaveBeenCalled();
    const box = screen.getByTestId('fixup-file-box');
    expect(box.closest('tr')?.previousElementSibling).toHaveTextContent('line 30');
  });

  it('opens the hidden part a button sits on, above or below the opened lines', () => {
    const openHiddenLines = vi.fn<DiffViewerBodyProps['openHiddenLines']>(async () => {});
    renderWithBox([merged(0, 9), opened(27, 33, 15), merged(1, 26, 5)], openHiddenLines);

    fireEvent.click(screen.getByRole('button', { name: 'Expand all 9 hidden lines' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all 15 hidden lines' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand 20 hidden lines above' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand 20 hidden lines below' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all 5 hidden lines' }));

    expect(openHiddenLines.mock.calls.map(([, ranges]) => ranges)).toEqual([
      [{ start: 1, end: 9 }],
      [{ start: 12, end: 26 }],
      [{ start: 34, end: 53 }],
      [{ start: 40, end: 59 }],
      [{ start: 62, end: 66 }],
    ]);
  });
});

describe.each(['unified', 'split'] as const)(
  'one comment on lines of several parts (%s)',
  (mode) => {
    const rowOf = (code: string) =>
      Array.from(document.querySelectorAll('[data-diff-line-row="true"]')).find((row) =>
        row.textContent?.includes(code),
      )!;
    // Both layouts put the old number before the new one.
    const numberCell = (code: string, side: 'old' | 'new' = 'new') =>
      rowOf(code).querySelectorAll('[data-line-number-cell]')[side === 'old' ? 0 : 1]!;
    const ctrlClick = (code: string, side?: 'old' | 'new') =>
      fireEvent.click(numberCell(code, side), { ctrlKey: true });
    const rowsWith = (selector: string, className: string) =>
      Array.from(document.querySelectorAll('[data-diff-line-row="true"]'))
        .filter((row) => row.classList.contains(className) || row.querySelector(selector))
        .map((row) => {
          const text = row.textContent ?? '';
          return [/f\d+\(\);/, /\/\/ new \d+/, /\/\/ old \d+/]
            .map((code) => text.match(code)?.[0])
            .find(Boolean);
        });
    const picked = () => rowsWith('[class*="after:bg-diff-selected-bg"]', 'comment-selected');
    const flashed = () => rowsWith('[class*="after:bg-blue-400/20"]', 'comment-flash');
    const open = { diffMode: mode, foldCommentChanges: false };

    it('adds lines with Ctrl+click, grows the last with Shift and hands over every range', async () => {
      const onAddComment = vi.fn<NonNullable<DiffViewerBodyProps['onAddComment']>>(async () => {});
      renderViewer({ ...open, onAddComment });

      ctrlClick('f10();');
      ctrlClick('// new 40');
      fireEvent.click(numberCell('f40();'), { shiftKey: true });

      expect(picked()).toEqual(['f10();', '// new 40', 'f40();']);
      expect(screen.getByTestId('picked-ranges')).toHaveTextContent('L11, L40-L41');
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Same mistake' } });
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      await vi.waitFor(() =>
        expect(onAddComment).toHaveBeenCalledWith(
          [40, 41],
          'Same mistake',
          '// new 40\nf40();',
          'new',
          {
            lines: [{ side: 'new', line: 11 }],
            contents: ['f10();'],
          },
        ),
      );
    });

    it('takes a line out again with Ctrl+click', () => {
      renderViewer(open);

      ctrlClick('f10();');
      ctrlClick('// new 40');
      ctrlClick('f10();');

      expect(picked()).toEqual(['// new 40']);
    });

    it('picks the line clicked before along with the first Ctrl+click', () => {
      const { rerender } = renderViewer(open);

      fireEvent.click(numberCell('f10();'));
      rerender(
        viewer({ ...open, cursor: { fileIndex: 0, chunkIndex: 0, lineIndex: 2, side: 'right' } }),
      );
      ctrlClick('// new 40');

      expect(picked()).toEqual(['f10();', '// new 40']);
    });

    it('refuses a deleted line next to kept lines and says why', () => {
      renderViewer(open);

      ctrlClick('f10();');
      ctrlClick('// old 40', 'old');

      expect(screen.getByRole('status')).toHaveTextContent(
        '지운 줄과 남은 줄은 지적 하나에 함께 고를 수 없습니다',
      );
      expect(picked()).toEqual(['f10();']);
    });

    it('adds lines with plain clicks while 줄 더하기 is on', () => {
      renderViewer(open);

      ctrlClick('f10();');
      fireEvent.click(screen.getByRole('button', { name: '줄 더하기' }));
      fireEvent.click(numberCell('f40();'));

      expect(screen.getByRole('button', { name: '줄 더하기' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(picked()).toEqual(['f10();', 'f40();']);
    });

    describe('a saved comment on several ranges', () => {
      const thread: CommentThread = {
        id: 'multi',
        file: 'src/a.ts',
        line: [40, 41],
        extraLines: [{ side: 'new', line: 11 }],
        side: 'new',
        createdAt: '2026-10-27T00:00:00.000Z',
        updatedAt: '2026-10-27T00:00:00.000Z',
        messages: [
          {
            id: 'multi',
            body: 'Same mistake',
            createdAt: '2026-10-27T00:00:00.000Z',
            updatedAt: '2026-10-27T00:00:00.000Z',
          },
        ],
      };

      it('shows its card once, under the last range, and points to it from the others', () => {
        renderViewer({ ...open, threads: [thread] });

        expect(screen.getAllByText('Same mistake')).toHaveLength(1);
        const marker = screen.getByText('이 줄도 L40-L41 아래 지적에 함께 걸려 있습니다');
        expect(
          rowOf('f10();').compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
          rowOf('// new 40').compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_PRECEDING,
        ).toBeTruthy();
      });

      it('lights up all of its lines from the marker', () => {
        renderViewer({ ...open, threads: [thread] });

        expect(flashed()).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: '지적으로 가기' }));

        expect(flashed()).toEqual(['f10();', '// new 40', 'f40();']);
      });

      it('lights up all of its lines from the card', () => {
        renderViewer({ ...open, threads: [thread] });

        fireEvent.click(screen.getByText('Same mistake'));

        expect(flashed()).toEqual(['f10();', '// new 40', 'f40();']);
      });
    });

    describe('a saved comment on deleted and kept lines', () => {
      const thread: CommentThread = {
        id: 'mixed',
        file: 'src/a.ts',
        line: [40, 41],
        extraLines: [{ side: 'old', line: 10 }],
        side: 'new',
        createdAt: '2026-10-27T00:00:00.000Z',
        updatedAt: '2026-10-27T00:00:00.000Z',
        messages: [
          {
            id: 'mixed',
            body: 'Same mistake',
            createdAt: '2026-10-27T00:00:00.000Z',
            updatedAt: '2026-10-27T00:00:00.000Z',
          },
        ],
      };

      it('points to the card from the deleted line, naming the side of the card', () => {
        renderViewer({ ...open, threads: [thread] });

        expect(screen.getAllByText('Same mistake')).toHaveLength(1);
        const marker = screen.getByText('이 줄도 남은 줄 L40-L41 아래 지적에 함께 걸려 있습니다');
        expect(
          rowOf('// old 10').compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
          rowOf('f10();').compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_PRECEDING,
        ).toBeTruthy();
        expect(screen.getByText('src/a.ts:old:10,new:40-41')).toBeInTheDocument();
      });

      it('lights up the deleted line along with the kept ones', () => {
        renderViewer({ ...open, threads: [thread] });

        fireEvent.click(screen.getByText('Same mistake'));

        // The split view shows the deleted line on the row of the line that replaced it.
        expect(flashed()).toEqual([
          mode === 'unified' ? '// old 10' : '// new 10',
          '// new 40',
          'f40();',
        ]);
      });
    });
  },
);
