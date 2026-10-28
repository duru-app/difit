import React, { useEffect, useMemo, useState } from 'react';

import type { CommentThread, DiffLine } from '../../types/diff';
import { LEAVES_CODE_ALONE_LABEL, leavesCodeAlone } from '../../utils/changeKind';
import { DiffChunk } from '../components/DiffChunk';
import { DEFAULT_EXPAND_COUNT, ExpandButton } from '../components/ExpandButton';
import type { FoldedLines } from '../components/FoldedLines';
import { useFixupOverlay } from '../contexts/FixupOverlayContext';
import { cursorLineOf, LinePickProvider } from '../contexts/LinePickContext';
import type { CursorPosition } from '../hooks/keyboardNavigation';
import { rangesAroundNewLines } from '../hooks/useExpandedLines';

import type { DiffViewerBodyProps } from './types';

function holdsThread(lines: DiffLine[], threads: CommentThread[]) {
  return threads.some((thread) =>
    [...(thread.extraLines ?? []), { side: thread.side, line: thread.line }].some((range) => {
      const end = Array.isArray(range.line) ? range.line[1] : range.line;
      return lines.some(
        (line) =>
          (range.side !== 'new' && line.oldLineNumber === end) ||
          (range.side !== 'old' && line.newLineNumber === end),
      );
    }),
  );
}

const holdsAnchor = (lines: DiffLine[], anchors: ReadonlySet<number>) =>
  lines.some((line) => line.newLineNumber !== undefined && anchors.has(line.newLineNumber));

const sameCursor = (a: CursorPosition, b: CursorPosition | null | undefined) =>
  !!b &&
  a.fileIndex === b.fileIndex &&
  a.chunkIndex === b.chunkIndex &&
  a.lineIndex === b.lineIndex &&
  a.side === b.side;

const FIXUP_ANCHOR_CONTEXT = 3;

type FoldEntry = FoldedLines & { originalIndex: number };
const NO_FOLD_ENTRIES: readonly FoldEntry[] = [];

// A block of consecutive changes counts its larger side, so one edited line is one line.
function changedLineCount(lines: DiffLine[]) {
  let total = 0;
  let adds = 0;
  let deletes = 0;
  for (const line of lines) {
    if (line.type === 'add') adds += 1;
    else if (line.type === 'delete') deletes += 1;
    else {
      total += Math.max(adds, deletes);
      adds = 0;
      deletes = 0;
    }
  }
  return total + Math.max(adds, deletes);
}

export function TextDiffViewer({
  file,
  threads,
  showAuthorBadges,
  diffMode,
  syntaxTheme,
  cursor,
  fileIndex,
  mergedChunks,
  foldCommentChanges = false,
  isExpandLoading,
  openHiddenLines,
  onAddComment,
  onResolveThread,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
  onLineClick,
  onOpenInEditor,
  commentTrigger,
  onCommentTriggerHandled,
}: DiffViewerBodyProps) {
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(new Set());
  // A part folded with the cursor inside stays folded until the cursor moves.
  const [foldedUnderCursor, setFoldedUnderCursor] = useState<{
    originalIndex: number;
    cursor: CursorPosition;
  } | null>(null);
  if (!foldCommentChanges && unfolded.size > 0) {
    setUnfolded(new Set());
  }
  if (foldedUnderCursor && (!foldCommentChanges || !sameCursor(foldedUnderCursor.cursor, cursor))) {
    setFoldedUnderCursor(null);
  }

  const opener = (start: number, end: number) => () => {
    void openHiddenLines(file, [{ start, end }]);
  };

  const renderExpandButton = (
    position: 'top' | 'middle' | 'bottom',
    mergedChunk: (typeof mergedChunks)[number],
  ) => {
    if (position === 'bottom') {
      const hidden = mergedChunk.hiddenLinesAfter;
      if (hidden <= 0) return null;
      const start = mergedChunk.oldStart + mergedChunk.oldLines;
      return (
        <ExpandButton
          direction="up"
          hiddenLines={hidden}
          onExpandUp={opener(start, start + DEFAULT_EXPAND_COUNT - 1)}
          onExpandAll={opener(start, start + hidden - 1)}
          isLoading={isExpandLoading}
        />
      );
    }

    const hidden = mergedChunk.hiddenLinesBefore;
    if (hidden <= 0) return null;
    const end = mergedChunk.oldStart - 1;
    const start = end - hidden + 1;
    return (
      <ExpandButton
        direction={position === 'top' ? 'down' : 'both'}
        hiddenLines={hidden}
        onExpandUp={opener(start, start + DEFAULT_EXPAND_COUNT - 1)}
        onExpandDown={opener(end - DEFAULT_EXPAND_COUNT + 1, end)}
        onExpandAll={opener(start, end)}
        isLoading={isExpandLoading}
      />
    );
  };

  const fileLines = useMemo(() => mergedChunks.flatMap((chunk) => chunk.lines), [mergedChunks]);
  const cursorLine = useMemo(
    () =>
      cursor
        ? cursorLineOf(mergedChunks[cursor.chunkIndex]?.lines[cursor.lineIndex], cursor.side)
        : null,
    [cursor, mergedChunks],
  );

  const fileBoxes = useFixupOverlay().boxesByFile.get(file.path);
  const boxAnchors = useMemo(() => new Set(fileBoxes?.keys()), [fileBoxes]);

  useEffect(() => {
    if (isExpandLoading || boxAnchors.size === 0) return;
    const shown = new Set(mergedChunks.flatMap((chunk) => chunk.lines.map((l) => l.newLineNumber)));
    const hidden = [...boxAnchors].filter((anchor) => !shown.has(anchor));
    if (hidden.length === 0) return;
    void openHiddenLines(file, rangesAroundNewLines(file, hidden, FIXUP_ANCHOR_CONTEXT));
  }, [boxAnchors, mergedChunks, isExpandLoading, file, openHiddenLines]);

  const foldsByChunk = useMemo(
    () =>
      mergedChunks.map((mergedChunk): readonly FoldEntry[] => {
        if (!foldCommentChanges) return NO_FOLD_ENTRIES;
        const folds = mergedChunk.originalLineRanges.flatMap(
          ({ originalIndex, start, end, changeKind }) => {
            const lines = mergedChunk.lines.slice(start, end + 1);
            if (
              !leavesCodeAlone(changeKind) ||
              holdsThread(lines, threads) ||
              holdsAnchor(lines, boxAnchors)
            ) {
              return [];
            }
            const folded = !unfolded.has(originalIndex);
            return [
              {
                originalIndex,
                start,
                end,
                summary: `${LEAVES_CODE_ALONE_LABEL[changeKind]} ${changedLineCount(lines)}줄 바뀜`,
                folded,
                onToggle: () =>
                  setUnfolded((prev) => {
                    const next = new Set(prev);
                    if (folded) next.add(originalIndex);
                    else next.delete(originalIndex);
                    return next;
                  }),
              },
            ];
          },
        );
        return folds.length > 0 ? folds : NO_FOLD_ENTRIES;
      }),
    [mergedChunks, foldCommentChanges, unfolded, threads, boxAnchors],
  );

  const shownFolds = useMemo(
    () =>
      foldsByChunk.map((folds, mergedIndex): readonly FoldedLines[] => {
        if (!cursor || cursor.chunkIndex !== mergedIndex) return folds;
        const holds = (fold: FoldEntry) =>
          foldedUnderCursor?.originalIndex !== fold.originalIndex &&
          cursor.lineIndex >= fold.start &&
          cursor.lineIndex <= fold.end;
        if (!folds.some(holds)) return folds;
        return folds.map((fold) =>
          holds(fold)
            ? {
                ...fold,
                folded: false,
                onToggle: () => {
                  setUnfolded((prev) => {
                    const next = new Set(prev);
                    next.delete(fold.originalIndex);
                    return next;
                  });
                  setFoldedUnderCursor({ originalIndex: fold.originalIndex, cursor });
                },
              }
            : fold,
        );
      }),
    [foldsByChunk, cursor, foldedUnderCursor],
  );

  return (
    <LinePickProvider lines={fileLines} cursorLine={cursorLine}>
      {mergedChunks.map((mergedChunk, mergedIndex) => {
        const isFirstMerged = mergedIndex === 0;
        const isLastMerged = mergedIndex === mergedChunks.length - 1;
        const folds = shownFolds[mergedIndex] ?? NO_FOLD_ENTRIES;

        return (
          <React.Fragment key={mergedIndex}>
            {renderExpandButton(isFirstMerged ? 'top' : 'middle', mergedChunk)}

            <div id={`chunk-${file.path.replace(/[^a-zA-Z0-9]/g, '-')}-${mergedIndex}`}>
              <DiffChunk
                chunk={mergedChunk}
                chunkIndex={mergedIndex}
                threads={threads}
                showAuthorBadges={showAuthorBadges}
                onAddComment={onAddComment}
                onResolveThread={onResolveThread}
                onReplyToThread={onReplyToThread}
                onRemoveMessage={onRemoveMessage}
                onUpdateMessage={onUpdateMessage}
                onOpenInEditor={onOpenInEditor}
                mode={diffMode}
                syntaxTheme={syntaxTheme}
                cursor={cursor && cursor.chunkIndex === mergedIndex ? cursor : null}
                fileIndex={fileIndex}
                onLineClick={onLineClick}
                commentTrigger={
                  commentTrigger && commentTrigger.chunkIndex === mergedIndex
                    ? commentTrigger
                    : null
                }
                onCommentTriggerHandled={onCommentTriggerHandled}
                filename={file.path}
                oldFilename={file.oldPath}
                foldedLines={folds}
              />
            </div>

            {isLastMerged && renderExpandButton('bottom', mergedChunk)}
          </React.Fragment>
        );
      })}
    </LinePickProvider>
  );
}
