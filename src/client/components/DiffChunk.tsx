import React, { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';

import {
  type ChoiceAnswer,
  type DiffChunk as DiffChunkType,
  type DiffLine,
  type DiffSide,
  type ExtraCommentLines,
  type CommentThread,
  type LineNumber,
  type DiffViewMode,
  type LineSelection,
} from '../../types/diff';
import { DEFAULT_DIFF_VIEW_MODE } from '../../utils/diffMode';
import { threadReviewControls, useFixupOverlay } from '../contexts/FixupOverlayContext';
import { type CursorPosition } from '../hooks/keyboardNavigation';
import { useCanHover } from '../hooks/useCanHover';
import { useCodeSelection } from '../hooks/useCodeSelection';
import { cursorLineOf, useLinePick } from '../contexts/LinePickContext';
import { useDirectEditing } from '../hooks/useDirectEditing';
import { quoteSelection } from '../utils/codeSelection';
import { extraRangeEndsAt, pickHolds, rangesOfPick, threadHoldsLine } from '../utils/linePick';
import {
  computeWordLevelDiff,
  shouldComputeWordDiff,
  type DiffSegment,
} from '../utils/wordLevelDiff';

import { CommentForm } from './CommentForm';
import { CommentThreadCard } from './CommentThreadCard';
import { DiffLineRow } from './DiffLineRow';
import { goToThreadCard, PickControls, PickNotice, ThreadMarker } from './LinePickParts';
import { DirectEditForm } from './DirectEditForm';
import { EditHunkButton } from './EditLineButton';
import { FixupBoxRows, FixupOverlayRow } from './FixupOverlayCard';
import {
  type FoldedLines,
  FoldedLinesRow,
  foldAt,
  lockFoldsUnderForms,
  NO_FOLDS,
} from './FoldedLines';
import { SelectionCommentBar } from './SelectionCommentBar';
import type { AppearanceSettings } from './SettingsModal';
import { SideBySideDiffChunk } from './SideBySideDiffChunk';

interface DiffChunkProps {
  chunk: DiffChunkType;
  chunkIndex: number;
  threads: CommentThread[];
  showAuthorBadges?: boolean;
  // Left out where the diff takes no comments.
  onAddComment?: (
    line: LineNumber,
    body: string,
    codeContent?: string,
    side?: DiffSide,
    extra?: ExtraCommentLines,
  ) => Promise<void>;
  onResolveThread: (threadId: string) => void;
  onReplyToThread: (threadId: string, body: string, answer?: ChoiceAnswer) => Promise<void>;
  onRemoveMessage: (threadId: string, messageId: string) => void;
  onUpdateMessage: (threadId: string, messageId: string, newBody: string) => void;
  mode?: DiffViewMode;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  cursor?: CursorPosition | null;
  fileIndex?: number;
  onLineClick?: (
    fileIndex: number,
    chunkIndex: number,
    lineIndex: number,
    side: 'left' | 'right',
  ) => void;
  commentTrigger?: {
    fileIndex: number;
    chunkIndex: number;
    lineIndex: number;
  } | null;
  onCommentTriggerHandled?: () => void;
  filename?: string;
  oldFilename?: string;
  onOpenInEditor?: (filePath: string, lineNumber: number) => void;
  foldedLines?: readonly FoldedLines[];
}

function lineNumberOn(line: DiffLine, side: DiffSide): number | undefined {
  return side === 'old' ? line.oldLineNumber : line.newLineNumber;
}

export const DiffChunk = memo(function DiffChunk({
  chunk,
  chunkIndex,
  threads,
  showAuthorBadges = false,
  onAddComment,
  onResolveThread,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
  mode = DEFAULT_DIFF_VIEW_MODE,
  syntaxTheme,
  cursor = null,
  fileIndex = 0,
  onLineClick,
  commentTrigger,
  onCommentTriggerHandled,
  filename,
  oldFilename,
  onOpenInEditor,
  foldedLines = NO_FOLDS,
}: DiffChunkProps) {
  const [startLine, setStartLine] = useState<number | null>(null);
  const [endLine, setEndLine] = useState<number | null>(null);
  const [dragSide, setDragSide] = useState<DiffSide | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const linePick = useLinePick(
    chunk.lines,
    cursor ? cursorLineOf(chunk.lines[cursor.lineIndex], cursor.side) : null,
  );
  const pick = onAddComment ? linePick.pick : null;
  const pickedRanges = useMemo(() => (pick ? rangesOfPick(pick) : []), [pick]);
  const formRange = pickedRanges.at(-1);
  const commentingLine =
    pick && formRange !== undefined
      ? { side: pick.side, lineNumber: formRange, quote: linePick.quote }
      : null;
  const [hoveredLine, setHoveredLine] = useState<number | null>(null);
  const dragFromLineNumber = useRef(false);
  const dragStartRow = useRef<DiffLine | null>(null);
  const toggleOnClick = useRef<LineSelection | null>(null);
  const overlay = useFixupOverlay();
  const directEditing = useDirectEditing(chunk.lines, threads);
  const canHover = useCanHover();
  const containerRef = useRef<HTMLDivElement>(null);
  const codeSelection = useCodeSelection(containerRef, 'unified');

  const { open: openPick, start: startPick } = linePick;

  // Handle comment trigger from keyboard navigation
  useEffect(() => {
    if (commentTrigger?.lineIndex !== undefined) {
      const line = chunk.lines[commentTrigger.lineIndex];
      if (line) {
        const side: DiffSide = line.type === 'delete' ? 'old' : 'new';
        const lineNumber = lineNumberOn(line, side);
        if (lineNumber) {
          startPick(side, lineNumber);
          onCommentTriggerHandled?.();
        }
      }
    }
  }, [commentTrigger, chunk.lines, onCommentTriggerHandled, startPick]);

  const handleAddComment = useCallback(
    (side: DiffSide, lineNumber: LineNumber) => openPick(side, lineNumber),
    [openPick],
  );

  const openShiftClickComment = (selection: LineSelection) => linePick.extend(selection);

  const startCommentDrag = (selection: LineSelection, row: DiffLine, fromLineNumber = false) => {
    if (!onAddComment) return;
    dragFromLineNumber.current = fromLineNumber;
    dragStartRow.current = row;
    linePick.setAnchor(selection);
    setStartLine(selection.lineNumber);
    setEndLine(selection.lineNumber);
    setDragSide(selection.side);
    setIsDragging(true);
  };

  const handleCommentButtonMouseDown = ({
    isShiftClick,
    addsLine,
    selection,
    row,
  }: {
    isShiftClick: boolean;
    addsLine: boolean;
    selection: LineSelection | null;
    row: DiffLine;
  }) => {
    toggleOnClick.current = null;
    if (!selection) return;

    if (isShiftClick) {
      openShiftClickComment(selection);
      return;
    }

    if (addsLine) {
      toggleOnClick.current = selection;
      return;
    }

    startCommentDrag(selection, row);
  };

  // A drag from an unchanged line follows the side of the lines it reaches.
  const extendCommentDrag = (row: DiffLine) => {
    if (!dragSide) return;
    const lineNumber = lineNumberOn(row, dragSide);
    if (lineNumber) {
      setEndLine(lineNumber);
      return;
    }
    const otherSide: DiffSide = dragSide === 'old' ? 'new' : 'old';
    const otherStart = dragStartRow.current && lineNumberOn(dragStartRow.current, otherSide);
    const otherEnd = lineNumberOn(row, otherSide);
    if (otherStart && otherEnd) {
      setDragSide(otherSide);
      setStartLine(otherStart);
      setEndLine(otherEnd);
      linePick.setAnchor({ side: otherSide, lineNumber: otherStart });
    }
  };

  const handleRowClick = ({
    isShiftClick,
    addsLine,
    lineIndex,
    navigationSide,
    selection,
  }: {
    isShiftClick: boolean;
    addsLine: boolean;
    lineIndex: number;
    navigationSide: 'left' | 'right';
    selection: LineSelection | null;
  }) => {
    if (!selection) {
      onLineClick?.(fileIndex, chunkIndex, lineIndex, navigationSide);
      return;
    }

    if (isShiftClick) {
      openShiftClickComment(selection);
      return;
    }

    if (addsLine && onAddComment) {
      linePick.toggle(selection);
      return;
    }

    linePick.setAnchor(selection);
    onLineClick?.(fileIndex, chunkIndex, lineIndex, navigationSide);
  };

  const toggleAfterPress = () => {
    const selection = toggleOnClick.current;
    toggleOnClick.current = null;
    if (selection) linePick.toggle(selection);
  };

  // Global mouse up handler for drag selection: commit the selection wherever
  // the mouse is released, not only on the comment button itself
  useEffect(() => {
    if (!isDragging) {
      return undefined;
    }

    const handleGlobalMouseUp = () => {
      // Defer so the click event fired after mouseup doesn't immediately
      // close the newly opened (still empty) comment form
      setTimeout(() => {
        const actualEndLine = endLine ?? startLine;
        const clickedLineNumber = dragFromLineNumber.current && startLine === actualEndLine;
        if (startLine && actualEndLine && dragSide && !clickedLineNumber) {
          if (startLine === actualEndLine) {
            handleAddComment(dragSide, startLine);
          } else {
            const min = Math.min(startLine, actualEndLine);
            const max = Math.max(startLine, actualEndLine);
            handleAddComment(dragSide, [min, max]);
          }
        }
        setIsDragging(false);
        setStartLine(null);
        setEndLine(null);
        setDragSide(null);
      }, 0);
    };

    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isDragging, startLine, endLine, dragSide, handleAddComment]);

  const handleCancelComment = linePick.close;

  const getSelectedCodeContent = (): string =>
    commentingLine ? linePick.contentOf(commentingLine.side, commentingLine.lineNumber) : '';

  const handleSubmitComment = async (body: string) => {
    if (commentingLine === null || !onAddComment) return;
    const { side, lineNumber, quote } = commentingLine;
    const extraLines = pickedRanges.slice(0, -1);
    await onAddComment(
      lineNumber,
      quote === undefined ? body : quoteSelection(quote, body),
      linePick.contentOf(side, lineNumber),
      side,
      ...(extraLines.length > 0
        ? [
            {
              lines: extraLines.map((line) => ({ side, line })),
              contents: extraLines.map((line) => linePick.contentOf(side, line)),
            },
          ]
        : []),
    );
    linePick.close();
  };

  const flashedThread = threads.find(({ id }) => id === linePick.flashedThreadId);
  const holdsFlashed = (line: DiffLine) =>
    !!flashedThread &&
    (threadHoldsLine(flashedThread, 'old', line.oldLineNumber) ||
      threadHoldsLine(flashedThread, 'new', line.newLineNumber));
  const showThread = (thread: CommentThread) => {
    goToThreadCard(thread.id);
    linePick.flash(thread.id);
  };

  const getThreadsForLine = (line: DiffLine) => {
    return threads
      .filter((thread) => {
        const lineNumber = lineNumberOn(line, thread.side ?? 'new');
        const lastLine = Array.isArray(thread.line) ? thread.line[1] : thread.line;
        return lineNumber !== undefined && lineNumber === lastLine;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };

  const getCommentLayout = (line: DiffLine): 'left' | 'right' | 'full' => {
    // In unified mode, always use full width for comments
    if (mode === 'unified') {
      return 'full';
    }

    switch (line.type) {
      case 'delete':
        return 'left';
      case 'add':
        return 'right';
      default:
        return 'full';
    }
  };

  const getSelectedLineStyle = (line: DiffLine): string => {
    // Show selection during drag
    const draggedNumber = dragSide && lineNumberOn(line, dragSide);
    if (isDragging && startLine && endLine && draggedNumber) {
      const min = Math.min(startLine, endLine);
      const max = Math.max(startLine, endLine);
      if (draggedNumber >= min && draggedNumber <= max) {
        let classes = 'drag-selected';
        // Add top border for first line
        if (draggedNumber === min) {
          classes += ' drag-selected-first';
        }
        // Add bottom border for last line
        if (draggedNumber === max) {
          classes += ' drag-selected-last';
        }
        return classes;
      }
    }

    if (pick && pickHolds(pick, pick.side, lineNumberOn(line, pick.side))) {
      return 'comment-selected';
    }

    return holdsFlashed(line) ? 'comment-flash' : '';
  };

  // Compute word-level diff for unified mode
  // Maps line index to diff segments for that line
  const wordLevelDiffMap = useMemo(() => {
    const map = new Map<number, DiffSegment[]>();
    const lines = chunk.lines;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line) {
        i++;
        continue;
      }

      if (line.type === 'delete') {
        // Look ahead for corresponding add lines
        let j = i + 1;
        while (j < lines.length && lines[j]?.type === 'delete') {
          j++;
        }

        const deleteLines = lines.slice(i, j);
        const deleteStartIndex = i;
        const addLines: { line: DiffLine; index: number }[] = [];

        while (j < lines.length && lines[j]?.type === 'add') {
          const addLine = lines[j];
          if (addLine) {
            addLines.push({ line: addLine, index: j });
          }
          j++;
        }

        // Pair delete and add lines and compute word-level diff
        const maxLines = Math.max(deleteLines.length, addLines.length);
        for (let k = 0; k < maxLines; k++) {
          const deleteLine = deleteLines[k];
          const addLineInfo = addLines[k];

          if (deleteLine && addLineInfo) {
            if (shouldComputeWordDiff(deleteLine.content, addLineInfo.line.content)) {
              const wordLevelDiff = computeWordLevelDiff(
                deleteLine.content,
                addLineInfo.line.content,
              );
              map.set(deleteStartIndex + k, wordLevelDiff.oldSegments);
              map.set(addLineInfo.index, wordLevelDiff.newSegments);
            }
          }
        }

        i = j;
      } else {
        i++;
      }
    }

    return map;
  }, [chunk.lines]);

  // Use side-by-side component for split mode
  if (mode === 'split') {
    return (
      <SideBySideDiffChunk
        chunk={chunk}
        chunkIndex={chunkIndex}
        threads={threads}
        showAuthorBadges={showAuthorBadges}
        onAddComment={onAddComment}
        onResolveThread={onResolveThread}
        onReplyToThread={onReplyToThread}
        onRemoveMessage={onRemoveMessage}
        onUpdateMessage={onUpdateMessage}
        onOpenInEditor={onOpenInEditor}
        syntaxTheme={syntaxTheme}
        cursor={cursor}
        fileIndex={fileIndex}
        onLineClick={onLineClick}
        filename={filename}
        oldFilename={oldFilename}
        commentTrigger={commentTrigger}
        onCommentTriggerHandled={onCommentTriggerHandled}
        foldedLines={foldedLines}
      />
    );
  }

  const { editing, editLine, editHunk, editRange } = directEditing;
  const folds = lockFoldsUnderForms(
    foldedLines,
    chunk.lines,
    pick ? pickedRanges.map((lineNumber) => ({ side: pick.side, lineNumber })) : null,
    editing,
  );
  const selected = codeSelection.selected;

  return (
    <div
      ref={containerRef}
      className="group/hunk relative bg-github-bg-primary"
      data-adds-lines={linePick.addMode || undefined}
    >
      {editHunk && <EditHunkButton onClick={editHunk} />}
      {selected && onAddComment && (
        <SelectionCommentBar
          range={selected.range}
          container={containerRef.current}
          canHover={canHover}
          onPress={codeSelection.hold}
          onComment={() => {
            linePick.start(selected.side, selected.lineNumber, selected.text);
            codeSelection.clear();
          }}
          onEdit={
            editRange && selected.side === 'new'
              ? () => {
                  const [start, end] = Array.isArray(selected.lineNumber)
                    ? selected.lineNumber
                    : [selected.lineNumber, selected.lineNumber];
                  editRange({ start, end });
                  codeSelection.clear();
                }
              : undefined
          }
        />
      )}
      <table className="w-full table-fixed border-collapse font-mono text-sm leading-5">
        <colgroup>
          <col className="w-[var(--line-number-width)]" />
          <col className="w-[var(--line-number-width)]" />
          <col className="w-full" />
        </colgroup>
        <tbody>
          {chunk.lines.map((line, index) => {
            const fold = foldAt(folds, index);
            if (fold?.folded) {
              return index === fold.start ? (
                <React.Fragment key={index}>
                  <FoldedLinesRow fold={fold} colSpan={3} />
                </React.Fragment>
              ) : null;
            }
            const formTargetLineNumber = commentingLine
              ? Array.isArray(commentingLine.lineNumber)
                ? commentingLine.lineNumber[1]
                : commentingLine.lineNumber
              : null;
            const markedThreads = threads.filter(
              (thread) =>
                extraRangeEndsAt(thread, 'old', line.oldLineNumber) ||
                extraRangeEndsAt(thread, 'new', line.newLineNumber),
            );

            const commentLineNumber =
              line.type === 'delete' ? line.oldLineNumber : line.newLineNumber;
            const commentSide: DiffSide = line.type === 'delete' ? 'old' : 'new';
            const lineThreads = getThreadsForLine(line);
            // Generate ID for all lines to match the format used in useKeyboardNavigation
            const lineId = `file-${fileIndex}-chunk-${chunkIndex}-line-${index}`;
            const isCurrentLine =
              cursor && cursor.chunkIndex === chunkIndex && cursor.lineIndex === index;
            const selection = commentLineNumber
              ? { side: commentSide, lineNumber: commentLineNumber }
              : null;

            return (
              <React.Fragment key={index}>
                {fold && index === fold.start && <FoldedLinesRow fold={fold} colSpan={3} />}
                <DiffLineRow
                  line={line}
                  index={index}
                  lineId={lineId}
                  isCurrentLine={isCurrentLine || false}
                  hoveredLineIndex={hoveredLine}
                  selectedLineStyle={getSelectedLineStyle(line)}
                  onMouseEnter={() => {
                    setHoveredLine(index);
                  }}
                  onMouseLeave={() => setHoveredLine(null)}
                  onMouseMove={() => {
                    if (isDragging && startLine) extendCommentDrag(line);
                  }}
                  onCommentButtonMouseDown={
                    onAddComment &&
                    ((e) => {
                      e.stopPropagation();
                      const addsLine = e.ctrlKey || e.metaKey || linePick.addMode;
                      if (e.shiftKey || addsLine) {
                        e.preventDefault();
                      }
                      handleCommentButtonMouseDown({
                        isShiftClick: e.shiftKey,
                        addsLine,
                        selection,
                        row: line,
                      });
                    })
                  }
                  onCommentButtonClick={onAddComment && toggleAfterPress}
                  onComment={
                    onAddComment &&
                    (() => {
                      if (selection) handleAddComment(selection.side, selection.lineNumber);
                    })
                  }
                  onLineNumberMouseDown={(e) => {
                    if (e.button !== 0 || e.shiftKey || !selection) return;
                    e.preventDefault();
                    if (e.ctrlKey || e.metaKey || linePick.addMode) return;
                    startCommentDrag(selection, line, true);
                  }}
                  canHover={canHover}
                  onOpenInEditor={
                    onOpenInEditor &&
                    filename &&
                    line.type !== 'delete' &&
                    (line.newLineNumber || line.oldLineNumber)
                      ? () => {
                          const lineNumber = line.newLineNumber || line.oldLineNumber;
                          if (!lineNumber) return;
                          if (!filename) return;
                          onOpenInEditor(filename, lineNumber);
                        }
                      : undefined
                  }
                  onEditLine={
                    editLine && line.type !== 'delete' && line.newLineNumber
                      ? () => editLine(line.newLineNumber ?? 0)
                      : undefined
                  }
                  syntaxTheme={syntaxTheme}
                  filename={filename}
                  oldFilename={oldFilename}
                  diffSegments={wordLevelDiffMap.get(index)}
                  onClick={(e) => {
                    // Determine the side based on line type for unified mode
                    const side = line.type === 'delete' ? 'left' : 'right';
                    if (e.shiftKey) {
                      e.preventDefault();
                    }
                    handleRowClick({
                      isShiftClick: e.shiftKey,
                      addsLine:
                        (e.ctrlKey || e.metaKey || linePick.addMode) &&
                        e.target instanceof Element &&
                        e.target.closest('[data-line-number-cell]') !== null,
                      lineIndex: index,
                      navigationSide: side,
                      selection,
                    });
                  }}
                />

                <FixupBoxRows
                  filePath={filename}
                  lineNumber={line.type === 'delete' ? undefined : line.newLineNumber}
                  colSpan={3}
                  syntaxTheme={syntaxTheme}
                />

                {markedThreads.map((thread) => (
                  <tr key={`marker-${thread.id}`} data-thread-marker={thread.id}>
                    <td colSpan={3} className="p-0">
                      <ThreadMarker thread={thread} onGo={() => showThread(thread)} />
                    </td>
                  </tr>
                ))}

                {lineThreads.map((thread) => {
                  const layout = getCommentLayout(line);
                  const review = threadReviewControls(overlay, thread);
                  return (
                    <React.Fragment key={thread.id}>
                      <FixupOverlayRow
                        thread={thread}
                        filePath={filename}
                        colSpan={3}
                        syntaxTheme={syntaxTheme}
                      />
                      <tr className="bg-github-bg-secondary">
                        <td colSpan={3} className="p-0 border-t border-github-border">
                          <div
                            className={`flex ${
                              layout === 'left'
                                ? 'justify-start'
                                : layout === 'right'
                                  ? 'justify-end'
                                  : 'justify-center'
                            }`}
                          >
                            <div
                              className={`${layout === 'full' ? 'w-full' : 'w-1/2'} m-2 mx-4 min-w-0`}
                              onClick={
                                thread.extraLines ? () => linePick.flash(thread.id) : undefined
                              }
                            >
                              <CommentThreadCard
                                thread={thread}
                                review={review}
                                showAuthorBadges={showAuthorBadges}
                                onResolveThread={onResolveThread}
                                onReplyToThread={onReplyToThread}
                                onRemoveMessage={onRemoveMessage}
                                onUpdateMessage={onUpdateMessage}
                                onEditDirectly={directEditing.editThread(thread)}
                                syntaxTheme={syntaxTheme}
                              />
                            </div>
                          </div>
                        </td>
                      </tr>
                    </React.Fragment>
                  );
                })}

                {editing &&
                  directEditing.controls &&
                  directEditing.targetCommit &&
                  filename &&
                  line.type !== 'delete' &&
                  line.newLineNumber === editing.end && (
                    <tr className="bg-github-bg-secondary">
                      <td colSpan={3} className="p-0">
                        <DirectEditForm
                          key={`${editing.start}-${editing.end}-${editing.threadId ?? ''}`}
                          filePath={filename}
                          range={editing}
                          targetCommit={directEditing.targetCommit}
                          threadId={editing.threadId}
                          controls={directEditing.controls}
                          onClose={directEditing.close}
                        />
                      </td>
                    </tr>
                  )}

                {commentingLine &&
                  lineNumberOn(line, commentingLine.side) === formTargetLineNumber && (
                    <tr className="bg-[var(--bg-secondary)]">
                      <td colSpan={3} className="p-0">
                        <div
                          className={`flex ${
                            getCommentLayout(line) === 'left'
                              ? 'justify-start'
                              : getCommentLayout(line) === 'right'
                                ? 'justify-end'
                                : 'justify-center'
                          }`}
                        >
                          <div
                            className={`${getCommentLayout(line) === 'full' ? 'w-full' : 'w-1/2'}`}
                          >
                            <PickNotice notice={linePick.notice} />
                            <CommentForm
                              onSubmit={handleSubmitComment}
                              onCancel={handleCancelComment}
                              header={
                                <PickControls
                                  store={linePick}
                                  ranges={pickedRanges}
                                  canHover={canHover}
                                />
                              }
                              quote={commentingLine.quote}
                              selectedCode={getSelectedCodeContent()}
                              syntaxTheme={syntaxTheme}
                              filename={filename}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
