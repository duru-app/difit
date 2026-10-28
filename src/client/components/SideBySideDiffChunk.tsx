import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';

import {
  type ChoiceAnswer,
  type DiffChunk as DiffChunkType,
  type DiffLine,
  type DiffSide,
  type ExtraCommentLines,
  type CommentThread,
  type LineNumber,
  type LineSelection,
} from '../../types/diff';
import { threadReviewControls, useFixupOverlay } from '../contexts/FixupOverlayContext';
import { type CursorPosition } from '../hooks/keyboardNavigation';
import { useCanHover } from '../hooks/useCanHover';
import { useCodeSelection } from '../hooks/useCodeSelection';
import { cursorLineOf, useLinePick } from '../contexts/LinePickContext';
import { useDirectEditing } from '../hooks/useDirectEditing';
import { codeCellAttributes, quoteSelection } from '../utils/codeSelection';
import { endOfLine } from '../../utils/commentPosition';
import { endsOnRow, pickHolds, threadHoldsLine } from '../utils/linePick';
import {
  computeWordLevelDiff,
  shouldComputeWordDiff,
  type WordLevelDiffResult,
} from '../utils/wordLevelDiff';
import { useFileLevelTokensLookup } from '../contexts/FileLevelTokensContext';

import { CommentForm } from './CommentForm';
import { CommentThreadCard } from './CommentThreadCard';
import { DirectEditForm } from './DirectEditForm';
import { EditHunkButton } from './EditLineButton';
import { EnhancedPrismSyntaxHighlighter } from './EnhancedPrismSyntaxHighlighter';
import { FixupBoxRows, FixupOverlayRow } from './FixupOverlayCard';
import { goToThreadCard, PickControls, ThreadMarker } from './LinePickParts';
import {
  type FoldedLines,
  FoldedLinesRow,
  foldAt,
  lockFoldsUnderForms,
  NO_FOLDS,
} from './FoldedLines';
import { LineEndActions, LineNumberActions } from './LineActions';
import { SelectionCommentBar } from './SelectionCommentBar';
import type { AppearanceSettings } from './SettingsModal';
import { WordLevelDiffHighlighter } from './WordLevelDiffHighlighter';

interface SideBySideDiffChunkProps {
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

interface SideBySideLine {
  oldLine?: DiffLine;
  newLine?: DiffLine;
  oldLineNumber?: number;
  newLineNumber?: number;
  oldLineOriginalIndex?: number;
  newLineOriginalIndex?: number;
  wordLevelDiff?: WordLevelDiffResult;
}

interface ClickedLineTarget {
  selection: LineSelection;
  lineIndex: number;
  navigationSide: 'left' | 'right';
}

// Type guard to check if a line is an expanded line (#6)
const isExpandedLine = (line: DiffLine | undefined): boolean => {
  return line !== undefined && 'isExpanded' in line && line.isExpanded === true;
};

// Utility function to get split line class (#10)
const getSideBySideLineClass = (line: DiffLine | undefined, isExpanded: boolean): string => {
  if (isExpanded) {
    return 'bg-github-bg-tertiary/80';
  }
  if (line?.type === 'delete') {
    return 'bg-diff-deletion-bg';
  }
  if (line?.type === 'add') {
    return 'bg-diff-addition-bg';
  }
  if (line?.type === 'normal') {
    return 'bg-transparent';
  }
  return 'bg-github-bg-secondary';
};

const getClickedLineTarget = (
  target: HTMLElement,
  sideLine: SideBySideLine,
): ClickedLineTarget | null => {
  const isInOldSide = target.closest('td:nth-child(1)') || target.closest('td:nth-child(2)');
  if (isInOldSide) {
    if (
      !sideLine.oldLineNumber ||
      sideLine.oldLineOriginalIndex === undefined ||
      sideLine.oldLineOriginalIndex < 0
    ) {
      return null;
    }
    return {
      selection: {
        side: 'old',
        lineNumber: sideLine.oldLineNumber,
      },
      lineIndex: sideLine.oldLineOriginalIndex,
      navigationSide: 'left',
    };
  }

  const isInNewSide = target.closest('td:nth-child(3)') || target.closest('td:nth-child(4)');
  if (!isInNewSide) return null;

  if (
    !sideLine.newLineNumber ||
    sideLine.newLineOriginalIndex === undefined ||
    sideLine.newLineOriginalIndex < 0
  ) {
    return null;
  }
  return {
    selection: {
      side: 'new',
      lineNumber: sideLine.newLineNumber,
    },
    lineIndex: sideLine.newLineOriginalIndex,
    navigationSide: 'right',
  };
};

export function SideBySideDiffChunk({
  chunk,
  chunkIndex,
  threads,
  showAuthorBadges = false,
  onAddComment,
  onResolveThread,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
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
}: SideBySideDiffChunkProps) {
  const { getOldTokens, getNewTokens } = useFileLevelTokensLookup();
  const [startLine, setStartLine] = useState<LineSelection | null>(null);
  const [endLine, setEndLine] = useState<LineSelection | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const linePick = useLinePick(
    chunk.lines,
    cursor ? cursorLineOf(chunk.lines[cursor.lineIndex], cursor.side) : null,
  );
  const pick = onAddComment ? linePick.pick : null;
  const { ranges: rangesFor } = linePick;
  const pickedRanges = useMemo(() => (pick ? rangesFor('split') : []), [pick, rangesFor]);
  const formRange = pickedRanges.at(-1);
  const commentingLine = formRange
    ? { side: formRange.side, lineNumber: formRange.line, quote: linePick.quote }
    : null;
  const [hoveredLine, setHoveredLine] = useState<LineSelection | null>(null);
  const overlay = useFixupOverlay();
  const directEditing = useDirectEditing(chunk.lines, threads);
  const { editing, editLine, editHunk, editRange } = directEditing;
  const folds = lockFoldsUnderForms(
    foldedLines,
    chunk.lines,
    pickedRanges.map(({ side, line }) => ({ side, lineNumber: line })),
    editing,
  );
  const foldOf = (sideLine: SideBySideLine | undefined) =>
    sideLine &&
    (foldAt(folds, sideLine.oldLineOriginalIndex ?? -1) ??
      foldAt(folds, sideLine.newLineOriginalIndex ?? -1));
  const dragFromLineNumber = useRef(false);
  const toggleOnClick = useRef<LineSelection | null>(null);
  const canHover = useCanHover();
  const containerRef = useRef<HTMLDivElement>(null);
  const codeSelection = useCodeSelection(containerRef, 'split');

  const { open: openPick, openBetween: openPickBetween, start: startPick } = linePick;

  // Handle comment trigger from keyboard navigation
  useEffect(() => {
    if (commentTrigger?.lineIndex !== undefined) {
      const line = chunk.lines[commentTrigger.lineIndex];
      if (line && line.type !== 'delete') {
        const lineNumber = line.newLineNumber;
        if (lineNumber) {
          startPick('new', lineNumber);
          onCommentTriggerHandled?.();
        }
      }
    }
  }, [commentTrigger, chunk.lines, onCommentTriggerHandled, startPick]);

  const handleAddComment = useCallback(
    (side: DiffSide, lineNumber: LineNumber) => openPick(side, lineNumber),
    [openPick],
  );

  const openShiftClickComment = (selection: LineSelection) => linePick.extend(selection, 'split');

  const startCommentDrag = (selection: LineSelection, fromLineNumber = false) => {
    if (!onAddComment) return;
    dragFromLineNumber.current = fromLineNumber;
    linePick.setAnchor(selection);
    setStartLine(selection);
    setEndLine(selection);
    setIsDragging(true);
  };

  const handleCommentButtonMouseDown = ({
    isShiftClick,
    addsLine,
    selection,
  }: {
    isShiftClick: boolean;
    addsLine: boolean;
    selection: LineSelection | null;
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

    startCommentDrag(selection);
  };

  const handleRowClick = ({
    isShiftClick,
    addsLine,
    target,
    sideLine,
  }: {
    isShiftClick: boolean;
    addsLine: boolean;
    target: HTMLElement;
    sideLine: SideBySideLine;
  }) => {
    if (isDragging) return;

    const clickedLine = getClickedLineTarget(target, sideLine);
    if (!clickedLine) return;

    if (isShiftClick) {
      openShiftClickComment(clickedLine.selection);
      return;
    }

    if (addsLine && onAddComment && target.closest('[data-line-number-cell]')) {
      linePick.toggle(clickedLine.selection);
      return;
    }

    linePick.setAnchor(clickedLine.selection);
    onLineClick?.(fileIndex, chunkIndex, clickedLine.lineIndex, clickedLine.navigationSide);
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
        const end = endLine ?? startLine;
        const clickedLineNumber =
          dragFromLineNumber.current &&
          startLine?.side === end?.side &&
          startLine?.lineNumber === end?.lineNumber;
        if (startLine && end && !clickedLineNumber) {
          openPickBetween(startLine, end, 'split');
        }
        setIsDragging(false);
        setStartLine(null);
        setEndLine(null);
      }, 0);
    };

    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isDragging, startLine, endLine, openPickBetween]);

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
              lines: extraLines,
              contents: extraLines.map((range) => linePick.contentOf(range.side, range.line)),
            },
          ]
        : []),
    );
    linePick.close();
  };

  const flashedThread = threads.find(({ id }) => id === linePick.flashedThreadId);
  const showThread = (thread: CommentThread) => {
    goToThreadCard(thread.id);
    linePick.flash(thread.id);
  };

  const getProcomputedTokens = useCallback(
    (getTokens: typeof getOldTokens, lineNumber: number | null | undefined) => {
      if (lineNumber == null) return null;
      const lineTokens = getTokens?.(lineNumber) ?? null;
      return lineTokens ? [lineTokens] : null;
    },
    [],
  );

  const { placeCard } = linePick;
  const cards = useMemo(
    () => new Map(threads.map((thread) => [thread.id, placeCard(thread, 'split')])),
    [threads, placeCard],
  );

  const getThreadsForLine = (lineNumber: number, side: DiffSide) => {
    return threads
      .filter((thread) => {
        const card = cards.get(thread.id)?.card;
        return card?.side === side && endOfLine(card.line) === lineNumber;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };

  const getCommentLayout = (sideLine: SideBySideLine): 'left' | 'right' | 'full' => {
    // サイドバイサイドでは、削除行側（左）にコメントがある場合は左半分、
    // 追加行側（右）にコメントがある場合は右半分、
    // 変更なし行の場合は全幅で表示
    if (sideLine.oldLine?.type === 'delete' && sideLine.newLine?.type === 'add') {
      // 変更行の場合、newLineNumberを使って判定
      return sideLine.newLineNumber ? 'right' : 'left';
    }
    if (sideLine.oldLine?.type === 'delete') {
      return 'left';
    }
    if (sideLine.newLine?.type === 'add') {
      return 'right';
    }
    return 'full';
  };

  const { between: linesBetween } = linePick;
  const draggedOn = useMemo(() => {
    const dragged =
      isDragging && startLine && endLine ? linesBetween(startLine, endLine, 'split') : [];
    const numbersOn = (side: DiffSide) =>
      dragged.filter((line) => line.side === side).map(({ lineNumber }) => lineNumber);
    return { old: numbersOn('old'), new: numbersOn('new') };
  }, [isDragging, startLine, endLine, linesBetween]);

  const getSelectedLineStyle = (side: DiffSide, sideLine: SideBySideLine): string => {
    const lineNumber = side === 'old' ? sideLine.oldLineNumber : sideLine.newLineNumber;
    if (!lineNumber) {
      return '';
    }

    // Show selection during drag
    const dragged = draggedOn[side];
    if (dragged.includes(lineNumber)) {
      let classes =
        'after:bg-blue-100 after:absolute after:inset-0 after:opacity-30 after:border-l-4 after:border-blue-500 after:pointer-events-none';
      if (lineNumber === dragged[0]) {
        classes += ' after:border-t-2';
      }
      if (lineNumber === dragged.at(-1)) {
        classes += ' after:border-b-2';
      }
      return classes;
    }

    if (pickHolds(pick, side, lineNumber)) {
      return 'after:bg-diff-selected-bg after:absolute after:inset-0 after:border-l-5 after:border-l-diff-selected-border after:pointer-events-none';
    }

    return flashedThread && threadHoldsLine(flashedThread, side, lineNumber)
      ? 'after:bg-blue-400/20 after:absolute after:inset-0 after:pointer-events-none'
      : '';
  };

  // Convert unified diff to split format
  const convertToSideBySide = useCallback(
    (lines: DiffLine[]): SideBySideLine[] => {
      const result: SideBySideLine[] = [];
      let oldLineNum = chunk.oldStart;
      let newLineNum = chunk.newStart;

      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (!line) {
          i++;
          continue;
        }

        if (line.type === 'normal') {
          result.push({
            oldLine: line,
            newLine: { ...line },
            oldLineNumber: line.oldLineNumber ?? oldLineNum,
            newLineNumber: line.newLineNumber ?? newLineNum,
            oldLineOriginalIndex: i,
            newLineOriginalIndex: i,
          });
          oldLineNum++;
          newLineNum++;
          i++;
        } else if (line.type === 'delete') {
          // Look ahead for corresponding add
          let j = i + 1;
          while (j < lines.length && lines[j]?.type === 'delete') {
            j++;
          }

          const deleteLines = lines.slice(i, j);
          const deleteStartIndex = i;
          const addLines: DiffLine[] = [];
          const addStartIndex = j;

          // Collect corresponding add lines
          while (j < lines.length && lines[j]?.type === 'add') {
            const addLine = lines[j];
            if (addLine) {
              addLines.push(addLine);
            }
            j++;
          }

          // Pair delete and add lines
          const maxLines = Math.max(deleteLines.length, addLines.length);
          for (let k = 0; k < maxLines; k++) {
            const deleteLine = deleteLines[k];
            const addLine = addLines[k];

            // Compute word-level diff if both lines exist
            let wordLevelDiff: WordLevelDiffResult | undefined;
            if (deleteLine && addLine) {
              if (shouldComputeWordDiff(deleteLine.content, addLine.content)) {
                wordLevelDiff = computeWordLevelDiff(deleteLine.content, addLine.content);
              }
            }

            result.push({
              oldLine: deleteLine,
              newLine: addLine,
              oldLineNumber: deleteLine ? (deleteLine.oldLineNumber ?? oldLineNum + k) : undefined,
              newLineNumber: addLine ? (addLine.newLineNumber ?? newLineNum + k) : undefined,
              oldLineOriginalIndex: deleteLine ? deleteStartIndex + k : undefined,
              newLineOriginalIndex: addLine ? addStartIndex + k : undefined,
              wordLevelDiff,
            });
          }

          oldLineNum += deleteLines.length;
          newLineNum += addLines.length;
          i = j;
        } else if (line.type === 'add') {
          result.push({
            newLine: line,
            newLineNumber: line.newLineNumber ?? newLineNum,
            newLineOriginalIndex: i,
          });
          newLineNum++;
          i++;
        }
      }

      return result;
    },
    [chunk.oldStart, chunk.newStart],
  );

  const sideBySideLines = useMemo(
    () => convertToSideBySide(chunk.lines),
    [chunk.lines, convertToSideBySide],
  );

  const selected = codeSelection.selected;
  const commentActions = (selection: LineSelection | null) =>
    onAddComment
      ? {
          onCommentMouseDown: (e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            const addsLine = e.ctrlKey || e.metaKey || linePick.addMode;
            if (e.shiftKey || addsLine) {
              e.preventDefault();
            }
            handleCommentButtonMouseDown({ isShiftClick: e.shiftKey, addsLine, selection });
          },
          onCommentClick: toggleAfterPress,
          onComment: () => {
            if (selection) handleAddComment(selection.side, selection.lineNumber);
          },
        }
      : {};
  const startLineNumberDrag = (selection: LineSelection | null) => (e: React.MouseEvent) => {
    if (e.button !== 0 || e.shiftKey || !selection) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || linePick.addMode) return;
    startCommentDrag(selection, true);
  };

  return (
    <div
      ref={containerRef}
      className="group/hunk relative bg-github-bg-primary overflow-hidden"
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
          <col className="w-1/2" />
          <col className="w-[var(--line-number-width)]" />
          <col className="w-1/2" />
        </colgroup>
        <tbody>
          {sideBySideLines.map((sideLine, index) => {
            const fold = foldOf(sideLine);
            const foldStartsHere = fold && foldOf(sideBySideLines[index - 1]) !== fold;
            if (fold?.folded) {
              return foldStartsHere ? (
                <React.Fragment key={index}>
                  <FoldedLinesRow fold={fold} colSpan={4} />
                </React.Fragment>
              ) : null;
            }
            const oldThreads = sideLine.oldLineNumber
              ? getThreadsForLine(sideLine.oldLineNumber, 'old')
              : [];
            const newThreads = sideLine.newLineNumber
              ? getThreadsForLine(sideLine.newLineNumber, 'new')
              : [];
            const allThreads = [...oldThreads, ...newThreads];

            // Use the stored original indices
            const oldLineOriginalIndex = sideLine.oldLineOriginalIndex ?? -1;
            const newLineOriginalIndex = sideLine.newLineOriginalIndex ?? -1;

            // Check if the current side's line matches the cursor position
            const isHighlighted = (() => {
              if (!cursor) return false;

              // Only highlight the line on the current side
              if (cursor.side === 'left' && oldLineOriginalIndex >= 0) {
                return (
                  cursor.chunkIndex === chunkIndex && cursor.lineIndex === oldLineOriginalIndex
                );
              } else if (cursor.side === 'right' && newLineOriginalIndex >= 0) {
                return (
                  cursor.chunkIndex === chunkIndex && cursor.lineIndex === newLineOriginalIndex
                );
              }

              return false;
            })();

            // Generate IDs for navigation with side suffix
            const oldLineNavId =
              oldLineOriginalIndex >= 0
                ? `file-${fileIndex}-chunk-${chunkIndex}-line-${oldLineOriginalIndex}-left`
                : undefined;
            const newLineNavId =
              newLineOriginalIndex >= 0
                ? `file-${fileIndex}-chunk-${chunkIndex}-line-${newLineOriginalIndex}-right`
                : undefined;

            // Determine which cell to highlight
            const highlightOldCell = isHighlighted && cursor?.side === 'left';
            const highlightNewCell = isHighlighted && cursor?.side === 'right';

            const cellHighlightClass = 'keyboard-cursor';
            const oldSelection = sideLine.oldLineNumber
              ? {
                  side: 'old' as const,
                  lineNumber: sideLine.oldLineNumber,
                }
              : null;
            const newSelection = sideLine.newLineNumber
              ? {
                  side: 'new' as const,
                  lineNumber: sideLine.newLineNumber,
                }
              : null;

            const isOldHovered =
              hoveredLine?.side === 'old' && hoveredLine.lineNumber === sideLine.oldLineNumber;
            const isNewHovered =
              hoveredLine?.side === 'new' && hoveredLine.lineNumber === sideLine.newLineNumber;
            const openInEditorAt = (lineNumber: number | undefined) =>
              onOpenInEditor && filename && lineNumber !== undefined
                ? () => onOpenInEditor(filename, lineNumber)
                : undefined;
            const openOldSideInEditor =
              sideLine.oldLine?.type === 'delete'
                ? undefined
                : openInEditorAt(sideLine.newLineNumber);
            const openNewSideInEditor = openInEditorAt(sideLine.newLineNumber);
            const editNewLine =
              editLine && sideLine.newLineNumber !== undefined
                ? () => editLine(sideLine.newLineNumber ?? 0)
                : undefined;

            return (
              <React.Fragment key={index}>
                {fold && foldStartsHere && <FoldedLinesRow fold={fold} colSpan={4} />}
                <tr
                  data-diff-line-row="true"
                  className="group cursor-pointer"
                  onClick={(e) => {
                    const target = e.target;
                    if (!(target instanceof HTMLElement)) return;
                    if (e.shiftKey) {
                      e.preventDefault();
                    }
                    handleRowClick({
                      isShiftClick: e.shiftKey,
                      addsLine: e.ctrlKey || e.metaKey || linePick.addMode,
                      target,
                      sideLine,
                    });
                  }}
                  onMouseEnter={(e) => {
                    const target = e.target;
                    if (!(target instanceof HTMLElement)) return;
                    const isInOldSide =
                      target.closest('td:nth-child(1)') || target.closest('td:nth-child(2)');
                    const isInNewSide =
                      target.closest('td:nth-child(3)') || target.closest('td:nth-child(4)');

                    if (isInOldSide && sideLine.oldLineNumber) {
                      setHoveredLine({
                        side: 'old',
                        lineNumber: sideLine.oldLineNumber,
                      });
                    } else if (isInNewSide && sideLine.newLineNumber) {
                      setHoveredLine({
                        side: 'new',
                        lineNumber: sideLine.newLineNumber,
                      });
                    }
                  }}
                  onMouseMove={(e) => {
                    const target = e.target;
                    if (!(target instanceof HTMLElement)) return;
                    const isInOldSide =
                      target.closest('td:nth-child(1)') || target.closest('td:nth-child(2)');
                    const isInNewSide =
                      target.closest('td:nth-child(3)') || target.closest('td:nth-child(4)');

                    // Update hover state based on mouse position
                    if (isInOldSide && sideLine.oldLineNumber) {
                      if (
                        hoveredLine?.side !== 'old' ||
                        hoveredLine?.lineNumber !== sideLine.oldLineNumber
                      ) {
                        setHoveredLine({
                          side: 'old',
                          lineNumber: sideLine.oldLineNumber,
                        });
                      }
                    } else if (isInNewSide && sideLine.newLineNumber) {
                      if (
                        hoveredLine?.side !== 'new' ||
                        hoveredLine?.lineNumber !== sideLine.newLineNumber
                      ) {
                        setHoveredLine({
                          side: 'new',
                          lineNumber: sideLine.newLineNumber,
                        });
                      }
                    }

                    // Handle dragging
                    if (isDragging && startLine) {
                      if (isInOldSide && sideLine.oldLineNumber) {
                        setEndLine({ side: 'old', lineNumber: sideLine.oldLineNumber });
                      } else if (isInNewSide && sideLine.newLineNumber) {
                        setEndLine({ side: 'new', lineNumber: sideLine.newLineNumber });
                      }
                    }
                  }}
                  onMouseLeave={() => setHoveredLine(null)}
                >
                  {/* Old side */}
                  <td
                    id={oldLineNavId}
                    className={`w-[var(--line-number-width)] min-w-[var(--line-number-width)] max-w-[var(--line-number-width)] px-2 text-right text-github-text-muted bg-github-bg-secondary border-r border-github-border select-none align-top relative overflow-visible ${highlightOldCell ? cellHighlightClass : ''}`}
                    onMouseDown={startLineNumberDrag(oldSelection)}
                    data-line-number-cell
                  >
                    <span>{sideLine.oldLineNumber || ''}</span>
                    {isOldHovered && (
                      <LineNumberActions
                        canHover={canHover}
                        {...commentActions(oldSelection)}
                        onOpenInEditor={openOldSideInEditor}
                      />
                    )}
                  </td>
                  <td
                    className={`w-1/2 p-0 align-top border-r border-github-border relative ${getSideBySideLineClass(sideLine.oldLine, isExpandedLine(sideLine.oldLine))} ${getSelectedLineStyle('old', sideLine)} ${highlightOldCell ? cellHighlightClass : ''}`}
                    {...codeCellAttributes(
                      'old',
                      sideLine.oldLine ? sideLine.oldLineNumber : undefined,
                    )}
                  >
                    {sideLine.oldLine && (
                      <div
                        className="flex items-center relative min-h-[20px] px-3"
                        data-symbol-side="old"
                        data-symbol-path={oldFilename ?? filename}
                        data-symbol-line={sideLine.oldLineNumber}
                      >
                        {sideLine.wordLevelDiff ? (
                          <WordLevelDiffHighlighter
                            segments={sideLine.wordLevelDiff.oldSegments}
                            className="flex-1 text-github-text-primary whitespace-pre-wrap break-all overflow-wrap-break-word select-text"
                            syntaxTheme={syntaxTheme}
                            filename={filename}
                            lineTokens={
                              sideLine.oldLine.oldLineNumber != null
                                ? (getOldTokens?.(sideLine.oldLine.oldLineNumber) ?? null)
                                : null
                            }
                          />
                        ) : (
                          <EnhancedPrismSyntaxHighlighter
                            code={sideLine.oldLine.content}
                            className="flex-1 text-github-text-primary whitespace-pre-wrap break-all overflow-wrap-break-word select-text [&_pre]:m-0 [&_pre]:p-0 [&_pre]:!bg-transparent [&_pre]:font-inherit [&_pre]:text-inherit [&_pre]:leading-inherit [&_code]:!bg-transparent [&_code]:font-inherit [&_code]:text-inherit [&_code]:leading-inherit"
                            syntaxTheme={syntaxTheme}
                            filename={filename}
                            precomputedTokens={getProcomputedTokens(
                              getOldTokens,
                              sideLine.oldLine.oldLineNumber,
                            )}
                          />
                        )}
                      </div>
                    )}
                    {isOldHovered && canHover && (
                      <LineEndActions onOpenInEditor={openOldSideInEditor} />
                    )}
                  </td>

                  {/* New side */}
                  <td
                    id={newLineNavId}
                    className={`w-[var(--line-number-width)] min-w-[var(--line-number-width)] max-w-[var(--line-number-width)] px-2 text-right text-github-text-muted bg-github-bg-secondary border-r border-github-border select-none align-top relative overflow-visible ${highlightNewCell ? cellHighlightClass : ''}`}
                    onMouseDown={startLineNumberDrag(newSelection)}
                    data-line-number-cell
                  >
                    <span>{sideLine.newLineNumber || ''}</span>
                    {isNewHovered && (
                      <LineNumberActions
                        canHover={canHover}
                        {...commentActions(newSelection)}
                        onEditLine={editNewLine}
                        onOpenInEditor={openNewSideInEditor}
                      />
                    )}
                  </td>
                  <td
                    className={`w-1/2 p-0 align-top relative ${getSideBySideLineClass(sideLine.newLine, isExpandedLine(sideLine.newLine))} ${getSelectedLineStyle('new', sideLine)} ${highlightNewCell ? cellHighlightClass : ''}`}
                    {...codeCellAttributes(
                      'new',
                      sideLine.newLine ? sideLine.newLineNumber : undefined,
                    )}
                  >
                    {sideLine.newLine && (
                      <div
                        className="flex items-center relative min-h-[20px] px-3"
                        data-symbol-side="new"
                        data-symbol-path={filename}
                        data-symbol-line={sideLine.newLineNumber}
                      >
                        {sideLine.wordLevelDiff ? (
                          <WordLevelDiffHighlighter
                            segments={sideLine.wordLevelDiff.newSegments}
                            className="flex-1 text-github-text-primary whitespace-pre-wrap break-all overflow-wrap-break-word select-text"
                            syntaxTheme={syntaxTheme}
                            filename={filename}
                            lineTokens={
                              sideLine.newLine.newLineNumber != null
                                ? (getNewTokens?.(sideLine.newLine.newLineNumber) ?? null)
                                : null
                            }
                          />
                        ) : (
                          <EnhancedPrismSyntaxHighlighter
                            code={sideLine.newLine.content}
                            className="flex-1 text-github-text-primary whitespace-pre-wrap break-all overflow-wrap-break-word select-text [&_pre]:m-0 [&_pre]:p-0 [&_pre]:!bg-transparent [&_pre]:font-inherit [&_pre]:text-inherit [&_pre]:leading-inherit [&_code]:!bg-transparent [&_code]:font-inherit [&_code]:text-inherit [&_code]:leading-inherit"
                            syntaxTheme={syntaxTheme}
                            filename={filename}
                            precomputedTokens={getProcomputedTokens(
                              getNewTokens,
                              sideLine.newLine.newLineNumber,
                            )}
                          />
                        )}
                      </div>
                    )}
                    {isNewHovered && canHover && (
                      <LineEndActions
                        onEditLine={editNewLine}
                        onOpenInEditor={openNewSideInEditor}
                      />
                    )}
                  </td>
                </tr>

                <FixupBoxRows
                  filePath={filename}
                  lineNumber={sideLine.newLine ? sideLine.newLineNumber : undefined}
                  colSpan={4}
                  syntaxTheme={syntaxTheme}
                />

                {threads
                  .filter((thread) => endsOnRow(cards.get(thread.id)?.others ?? [], sideLine))
                  .map((thread) => (
                    <tr key={`marker-${thread.id}`} data-thread-marker={thread.id}>
                      <td colSpan={4} className="p-0">
                        <ThreadMarker
                          thread={thread}
                          card={cards.get(thread.id)?.card}
                          onGo={() => showThread(thread)}
                        />
                      </td>
                    </tr>
                  ))}

                {allThreads.map((thread) => (
                  <FixupOverlayRow
                    key={`fixup-${thread.id}`}
                    thread={thread}
                    filePath={filename}
                    colSpan={4}
                    syntaxTheme={syntaxTheme}
                  />
                ))}

                {/* Comment threads row */}
                {allThreads.length > 0 && (
                  <tr className="bg-github-bg-secondary">
                    <td colSpan={4} className="p-0 border-t border-github-border">
                      {allThreads.map((thread) => {
                        const threadSide = cards.get(thread.id)?.card.side ?? thread.side ?? 'new';
                        const review = threadReviewControls(overlay, thread);
                        let layout: 'left' | 'right' | 'full';

                        if (threadSide === 'old' && sideLine.oldLineNumber) {
                          layout = 'left';
                        } else if (threadSide === 'new' && sideLine.newLineNumber) {
                          layout = 'right';
                        } else {
                          layout = getCommentLayout(sideLine);
                        }

                        return (
                          <div
                            key={thread.id}
                            className={`flex ${
                              layout === 'left'
                                ? 'justify-start'
                                : layout === 'right'
                                  ? 'justify-end'
                                  : 'justify-center'
                            }`}
                          >
                            <div className={`${layout === 'full' ? 'w-full' : 'w-1/2'} min-w-0`}>
                              <div
                                className="m-2 mx-3"
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
                          </div>
                        );
                      })}
                    </td>
                  </tr>
                )}

                {editing &&
                  directEditing.controls &&
                  directEditing.targetCommit &&
                  filename &&
                  sideLine.newLineNumber === editing.end && (
                    <tr className="bg-github-bg-secondary">
                      <td colSpan={4} className="p-0">
                        <div className="flex justify-end">
                          <div className="w-1/2">
                            <DirectEditForm
                              key={`${editing.start}-${editing.end}-${editing.threadId ?? ''}`}
                              filePath={filename}
                              range={editing}
                              targetCommit={directEditing.targetCommit}
                              threadId={editing.threadId}
                              controls={directEditing.controls}
                              onClose={directEditing.close}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}

                {/* Comment form row */}
                {commentingLine &&
                  ((commentingLine.side === 'old' &&
                    commentingLine.lineNumber === sideLine.oldLineNumber) ||
                    (commentingLine.side === 'new' &&
                      commentingLine.lineNumber === sideLine.newLineNumber) ||
                    (Array.isArray(commentingLine.lineNumber) &&
                      ((commentingLine.side === 'new' &&
                        commentingLine.lineNumber[1] === sideLine.newLineNumber) ||
                        (commentingLine.side === 'old' &&
                          commentingLine.lineNumber[1] === sideLine.oldLineNumber)))) && (
                    <tr className="bg-github-bg-secondary">
                      <td colSpan={4} className="p-0">
                        <div
                          className={`flex ${
                            commentingLine.side === 'old'
                              ? 'justify-start'
                              : commentingLine.side === 'new'
                                ? 'justify-end'
                                : 'justify-center'
                          }`}
                        >
                          <div className={`w-1/2`}>
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
}
