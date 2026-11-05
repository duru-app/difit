import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  CommentThread,
  DiffChunk,
  DiffFile,
  ExpandedRange,
  ThreadFixup,
} from '../../types/diff';
import { EMPTY_FIXUP_OVERLAY, type FixupOverlayState } from '../contexts/FixupOverlayContext';
import { WordHighlightProvider } from '../contexts/WordHighlightContext';
import type { MergedChunk } from '../hooks/useExpandedLines';

import { DiffViewer } from './DiffViewer';

type DiffViewerProps = Parameters<typeof DiffViewer>[0];

const changed = (oldStart: number, newStart: number): DiffChunk => ({
  header: `@@ -${oldStart},1 +${newStart},1 @@`,
  oldStart,
  oldLines: 1,
  newStart,
  newLines: 1,
  lines: [
    { type: 'delete', content: `old ${oldStart}`, oldLineNumber: oldStart },
    { type: 'add', content: `new ${newStart}`, newLineNumber: newStart },
  ],
});
const added = (after: number, newStart: number): DiffChunk => ({
  header: `@@ -${after},0 +${newStart},1 @@`,
  oldStart: after,
  oldLines: 0,
  newStart,
  newLines: 1,
  lines: [{ type: 'add', content: `added ${newStart}`, newLineNumber: newStart }],
});
const deleted = (oldStart: number, after: number): DiffChunk => ({
  header: `@@ -${oldStart},1 +${after},0 @@`,
  oldStart,
  oldLines: 1,
  newStart: after,
  newLines: 0,
  lines: [{ type: 'delete', content: `deleted ${oldStart}`, oldLineNumber: oldStart }],
});

const merged = (chunks: DiffChunk[]): MergedChunk[] =>
  chunks.map((chunk, index) => ({
    ...chunk,
    originalIndices: [index],
    originalLineRanges: [{ originalIndex: index, start: 0, end: chunk.lines.length }],
    hiddenLinesBefore: 1,
    hiddenLinesAfter: 1,
  }));

const threadAt = (line: number, side: 'old' | 'new'): CommentThread => ({
  id: 't1',
  file: 'a.ts',
  line,
  side,
  createdAt: '',
  updatedAt: '',
  messages: [],
});

function renderViewer(
  chunks: DiffChunk[],
  threads: CommentThread[],
  fixupOverlay?: FixupOverlayState,
  props: Partial<DiffViewerProps> = {},
) {
  const file: DiffFile = {
    path: 'a.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    chunks,
  };
  const openLines = vi.fn<(file: DiffFile, ranges: readonly ExpandedRange[]) => Promise<void>>(
    async () => {},
  );
  render(
    <WordHighlightProvider>
      <DiffViewer
        file={file}
        threads={threads}
        diffMode="split"
        reviewedFiles={new Set()}
        collapsedFiles={new Set()}
        onToggleCollapsed={() => {}}
        onToggleAllCollapsed={() => {}}
        onResolveThread={() => {}}
        onReplyToThread={async () => {}}
        onRemoveMessage={() => {}}
        onUpdateMessage={() => {}}
        baseCommitish="base"
        targetCommitish="target"
        mergedChunks={merged(chunks)}
        openLines={openLines}
        prefetchFileContent={async () => {}}
        isExpandLoading={false}
        fixupOverlay={fixupOverlay}
        {...props}
      />
    </WordHighlightProvider>,
  );
  return openLines;
}

function openedFor(chunks: DiffChunk[], thread: CommentThread) {
  return renderViewer(chunks, [thread]).mock.calls.flatMap(([, ranges]) => ranges);
}

describe('DiffViewer opening the hidden lines a comment sits on', () => {
  it('opens the tail for a new-side comment when the last chunk only deletes', () => {
    const ranges = openedFor([changed(10, 10), deleted(30, 29)], threadAt(50, 'new'));

    expect(ranges).toContainEqual({ start: 31, end: Number.POSITIVE_INFINITY });
  });

  it('opens the tail for an old-side comment when the last chunk only adds', () => {
    const ranges = openedFor([changed(10, 10), added(30, 31)], threadAt(50, 'old'));

    expect(ranges).toContainEqual({ start: 30, end: Number.POSITIVE_INFINITY });
  });

  it('opens the lines on both sides of a chunk the comment side has no lines in', () => {
    const ranges = openedFor(
      [changed(10, 10), deleted(30, 29), changed(60, 59)],
      threadAt(20, 'new'),
    );

    expect(ranges).toContainEqual({ start: 11, end: 29 });
    expect(ranges).toContainEqual({ start: 31, end: 59 });
  });

  it('leaves hidden the lines a comment range only passes over', () => {
    const ranges = openedFor([changed(10, 10), changed(60, 60)], {
      ...threadAt(10, 'new'),
      line: [10, 60],
    });

    expect(ranges).toEqual([]);
  });

  it('opens the hidden lines that hold an end of a comment range', () => {
    const ranges = openedFor([changed(10, 10), changed(60, 60)], {
      ...threadAt(10, 'new'),
      line: [20, 60],
    });

    expect(ranges).toContainEqual({ start: 11, end: 59 });
  });
});

describe('DiffViewer header of a file a fixup changed', () => {
  it('marks the file and goes to its fixup box when the mark is clicked', async () => {
    const revealFixupFile = vi.fn();
    renderViewer([changed(10, 10)], [], {
      ...EMPTY_FIXUP_OVERLAY,
      fixupTouchedFiles: new Map([['a.ts', { fixupSha: 'f1', path: 'a.ts' }]]),
      revealFixupFile,
    });

    await userEvent.setup().click(screen.getByRole('button', { name: 'fixup 수정' }));

    expect(revealFixupFile).toHaveBeenCalledWith('f1', 'a.ts');
  });

  it('leaves the file unmarked when no shown fixup changed it', () => {
    renderViewer([changed(10, 10)], [], {
      ...EMPTY_FIXUP_OVERLAY,
      fixupTouchedFiles: new Map([['b.ts', { fixupSha: 'f1', path: 'b.ts' }]]),
    });

    expect(screen.queryByRole('button', { name: 'fixup 수정' })).toBeNull();
  });
});

describe('DiffViewer file a fixup brought back to the review base', () => {
  const lineThread: CommentThread = {
    id: 'line',
    file: 'a.ts',
    line: 10,
    side: 'new',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    messages: [
      { id: 'm1', body: 'Drop this change', author: 'User', createdAt: '', updatedAt: '' },
    ],
  };
  const revertingFixup: ThreadFixup = {
    sha: 'f2f2f2f2',
    shortSha: 'f2f2f2f',
    patchId: 'p2',
    authoredAt: '2026-01-02T00:00:00Z',
    subject: 'fixup! revert',
    threadIds: ['line'],
    files: [{ path: 'a.ts', status: 'modified', chunks: [changed(20, 20)] }],
  };
  const overlay = (revealFixupFile = vi.fn()): FixupOverlayState => ({
    ...EMPTY_FIXUP_OVERLAY,
    enabled: true,
    fixupsByThread: new Map([['line', [revertingFixup]]]),
    fixupPlaces: new Map([['f2f2f2f2:a.ts', { kind: 'card', threadId: 'line' }]]),
    fixupTouchedFiles: new Map([['a.ts', { fixupSha: 'f1', path: 'a.ts' }]]),
    fixupRevertedFiles: new Map([['a.ts', { fixupSha: 'f2f2f2f2', path: 'a.ts' }]]),
    revealFixupFile,
  });

  it('dims the name and marks the file with the fixup that reverted it', async () => {
    const revealFixupFile = vi.fn();
    renderViewer([changed(10, 10)], [lineThread], overlay(revealFixupFile));

    expect(screen.queryByRole('button', { name: 'fixup 수정' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'fixup 되돌림' }));
    expect(revealFixupFile).toHaveBeenCalledWith('f2f2f2f2', 'a.ts');
    const name = screen.getByRole('heading', { name: 'a.ts' });
    expect(name).toHaveClass('text-github-text-muted');
    expect(name).not.toHaveClass('line-through');
  });

  it('draws the boxes of a reverting fixup that answers a comment on another file', () => {
    const elsewhere: ThreadFixup = { ...revertingFixup, threadIds: ['other'] };
    const fixupFile = elsewhere.files[0]!;
    renderViewer([changed(10, 10)], [], {
      ...overlay(),
      fixupsByThread: new Map([['other', [elsewhere]]]),
      fixupPlaces: new Map([['f2f2f2f2:a.ts', { kind: 'box', reviewPath: 'a.ts' }]]),
      boxesByFile: new Map([
        [
          'a.ts',
          new Map([
            [
              20,
              [
                {
                  fixup: elsewhere,
                  threads: [{ id: 'other', file: 'b.ts', line: 3 }],
                  file: fixupFile,
                  chunk: fixupFile.chunks[0]!,
                  chunkIndex: 0,
                  anchor: 20,
                },
              ],
            ],
          ]),
        ],
      ]),
    });

    const section = screen.getByRole('region', { name: '이 파일의 지적' });
    expect(within(section).getByTestId('fixup-file-box')).toHaveTextContent('new 20');
    expect(screen.queryByText('new 10')).toBeNull();
  });

  it('draws the comments with their fixup cards instead of the code lines', () => {
    renderViewer([changed(10, 10)], [lineThread], overlay());

    const section = screen.getByRole('region', { name: '이 파일의 지적' });
    expect(within(section).getByText('Drop this change')).toBeInTheDocument();
    const card = within(section).getByTestId('fixup-overlay-card');
    expect(card).toHaveTextContent('new 20');
    expect(screen.queryByText('new 10')).toBeNull();
    expect(screen.getAllByRole('table').every((table) => card.contains(table))).toBe(true);
  });
});

describe('DiffViewer comments on the whole file', () => {
  const thread = (id: string, body: string, line?: number): CommentThread => ({
    id,
    file: 'a.ts',
    ...(line === undefined ? {} : { line }),
    side: 'new',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    messages: [{ id, body, author: 'User', createdAt: '2026-01-01T00:00:00Z', updatedAt: '' }],
  });

  it('shows a thread on the whole file above the code and leaves line threads at their lines', () => {
    renderViewer(
      [changed(10, 10)],
      [thread('file', 'Split this file'), thread('line', 'Rename this', 10)],
    );

    const section = screen.getByRole('region', { name: '파일 전체 지적' });
    expect(within(section).getByText('Split this file')).toBeInTheDocument();
    expect(within(section).queryByText('Rename this')).toBeNull();
    expect(within(section).getByText('a.ts')).toBeInTheDocument();
    expect(within(section).queryByText(/a\.ts:/)).toBeNull();
    expect(section.compareDocumentPosition(screen.getByText('Rename this'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('adds a comment on the whole file from the file header', async () => {
    const onAddFileComment = vi.fn(async () => {});
    renderViewer([changed(10, 10)], [], undefined, { onAddFileComment });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '파일 전체에 지적 달기' }));
    await user.type(screen.getByPlaceholderText(/comment/i), 'Split this file');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onAddFileComment).toHaveBeenCalledWith('a.ts', 'Split this file', 'new');
    expect(screen.queryByPlaceholderText(/comment/i)).toBeNull();
  });

  it('keeps the form and its text when the comment cannot be added', async () => {
    const onAddFileComment = vi.fn(async () => {
      throw new Error('offline');
    });
    renderViewer([changed(10, 10)], [], undefined, { onAddFileComment });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '파일 전체에 지적 달기' }));
    await user.type(screen.getByPlaceholderText(/comment/i), 'Split this file');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(screen.getByPlaceholderText(/comment/i)).toHaveValue('Split this file');
  });

  it('puts a comment on a deleted file on the old side', async () => {
    const onAddFileComment = vi.fn(async () => {});
    renderViewer([deleted(1, 0)], [], undefined, {
      onAddFileComment,
      file: {
        path: 'a.ts',
        status: 'deleted',
        additions: 0,
        deletions: 1,
        chunks: [deleted(1, 0)],
      },
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '파일 전체에 지적 달기' }));
    await user.type(screen.getByPlaceholderText(/comment/i), 'Keep this file');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(onAddFileComment).toHaveBeenCalledWith('a.ts', 'Keep this file', 'old');
  });

  it('opens a folded file to take the comment', async () => {
    const onToggleCollapsed = vi.fn();
    renderViewer([changed(10, 10)], [], undefined, {
      onAddFileComment: async () => {},
      collapsedFiles: new Set(['a.ts']),
      onToggleCollapsed,
    });

    await userEvent.setup().click(screen.getByRole('button', { name: '파일 전체에 지적 달기' }));

    expect(onToggleCollapsed).toHaveBeenCalledWith('a.ts');
  });

  it('keeps the fixup of a thread on the whole file in the block the comments panel scrolls to', () => {
    const fixup: ThreadFixup = {
      sha: 'f'.repeat(40),
      shortSha: 'abc1234',
      patchId: 'patch-abc1234',
      authoredAt: '2026-01-01T00:00:00Z',
      subject: 'fixup! split file',
      threadIds: ['file'],
      files: [],
    };
    renderViewer([changed(10, 10)], [thread('file', 'Split this file')], {
      ...EMPTY_FIXUP_OVERLAY,
      enabled: true,
      fixupsByThread: new Map([['file', [fixup]]]),
    });

    const block = document.getElementById('file-comment-file')!;
    expect(within(block).getByText('Split this file')).toBeInTheDocument();
    expect(within(block).getByText(/abc1234/)).toBeInTheDocument();
  });

  it('offers no header button where the diff takes no comments', () => {
    renderViewer([changed(10, 10)], []);

    expect(screen.queryByRole('button', { name: '파일 전체에 지적 달기' })).toBeNull();
  });
});
