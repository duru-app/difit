import { useState, useEffect, useRef, useMemo, memo } from 'react';

import {
  type ChoiceAnswer,
  type DiffFile,
  type DiffViewMode,
  type DiffSide,
  type ExtraCommentLines,
  type CommentThread,
  type ExpandedRange,
  type LineNumber,
} from '../../types/diff';
import { FileLevelTokensProvider } from '../contexts/FileLevelTokensContext';
import {
  EMPTY_FIXUP_OVERLAY,
  FixupOverlayProvider,
  type FixupOverlayState,
  threadReviewControls,
} from '../contexts/FixupOverlayContext';
import { type CursorPosition } from '../hooks/keyboardNavigation';
import { gapBeforeChunk, type MergedChunk } from '../hooks/useExpandedLines';
import { useFileLevelTokens } from '../hooks/useFileLevelTokens';
import { isWholeFileHighlightExtension } from '../utils/languageDetection';
import { getViewerForFile } from '../viewers/registry';
import type { DiffViewerBodyProps } from '../viewers/types';

import { CommentForm } from './CommentForm';
import { CommentThreadCard } from './CommentThreadCard';
import { DiffViewerHeader } from './DiffViewerHeader';
import { FixupOverlayBlock } from './FixupOverlayCard';
import type { AppearanceSettings } from './SettingsModal';

interface DiffViewerProps {
  file: DiffFile;
  threads: CommentThread[];
  showAuthorBadges?: boolean;
  diffMode: DiffViewMode;
  reviewedFiles: Set<string>;
  isChangedSinceViewed?: boolean;
  onToggleReviewed?: (path: string) => void;
  headerLabels?: readonly string[];
  collapsedFiles: Set<string>;
  onToggleCollapsed: (path: string) => void;
  onToggleAllCollapsed: (shouldCollapse: boolean) => void;
  onAddComment?: (
    file: string,
    line: LineNumber,
    body: string,
    codeContent?: string,
    side?: DiffSide,
    extra?: ExtraCommentLines,
  ) => Promise<void>;
  // Left out where the file takes no comment on the whole file.
  onAddFileComment?: (file: string, body: string, side: DiffSide) => Promise<void>;
  onResolveThread: (threadId: string) => void;
  onReplyToThread: (threadId: string, body: string, answer?: ChoiceAnswer) => Promise<void>;
  onRemoveMessage: (threadId: string, messageId: string) => void;
  onUpdateMessage: (threadId: string, messageId: string, newBody: string) => void;
  onOpenInEditor?: (filePath: string, lineNumber: number) => void;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  baseCommitish?: string;
  targetCommitish?: string;
  cursor?: CursorPosition | null;
  isFocused?: boolean;
  fileIndex?: number;
  fixupOverlay?: FixupOverlayState;
  foldCommentChanges?: boolean;
  mergedChunks: MergedChunk[];
  openLines: (file: DiffFile, ranges: readonly ExpandedRange[]) => Promise<void>;
  prefetchFileContent: (file: DiffFile) => Promise<void>;
  isExpandLoading: boolean;
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
  diffVersion?: number;
}

type LineRange = { start: number; end: number };
type ChunkRange = LineRange & { index: number };
// Indices for gapBeforeChunk; a chunk with no lines on this side splits one gap into two.
type Gap = LineRange & { chunkGapIndices: number[] };

const indicesBetween = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, offset) => first + offset);

const normalizeCommentRanges = (threads: CommentThread[]): Record<DiffSide, LineRange[]> => {
  const ranges: Record<DiffSide, LineRange[]> = { old: [], new: [] };

  threads.forEach((thread) => {
    if (thread.line === undefined) return;
    for (const { side, line } of [
      ...(thread.extraLines ?? []),
      { side: thread.side ?? 'new', line: thread.line },
    ]) {
      const [start, end] = Array.isArray(line) ? [line[0], line[1]] : [line, line];

      if (start <= 0 || end <= 0) continue;

      ranges[side].push({
        start: Math.min(start, end),
        end: Math.max(start, end),
      });
    }
  });

  return ranges;
};

const buildChunkRanges = (file: DiffFile, side: DiffSide): ChunkRange[] =>
  file.chunks
    .map((chunk, index) => {
      const start = side === 'old' ? chunk.oldStart : chunk.newStart;
      const lines = side === 'old' ? chunk.oldLines : chunk.newLines;
      if (!start || lines <= 0) return null;
      return { start, end: start + lines - 1, index };
    })
    .filter((range): range is ChunkRange => !!range);

const buildGaps = (ranges: ChunkRange[], chunkCount: number): Gap[] => {
  const gaps: Gap[] = [];
  const firstRange = ranges[0];
  if (!firstRange) return gaps;

  if (firstRange.start > 1) {
    gaps.push({
      start: 1,
      end: firstRange.start - 1,
      chunkGapIndices: indicesBetween(0, firstRange.index),
    });
  }

  for (let i = 1; i < ranges.length; i += 1) {
    const prev = ranges[i - 1];
    const current = ranges[i];
    if (!prev || !current) continue;
    if (current.start > prev.end + 1) {
      gaps.push({
        start: prev.end + 1,
        end: current.start - 1,
        chunkGapIndices: indicesBetween(prev.index + 1, current.index),
      });
    }
  }

  const last = ranges[ranges.length - 1];
  if (!last) return gaps;
  gaps.push({
    start: last.end + 1,
    end: Number.POSITIVE_INFINITY,
    chunkGapIndices: indicesBetween(last.index + 1, chunkCount),
  });

  return gaps;
};

export const DiffViewer = memo(function DiffViewer({
  file,
  threads,
  showAuthorBadges = false,
  diffMode,
  reviewedFiles,
  isChangedSinceViewed = false,
  onToggleReviewed,
  headerLabels,
  collapsedFiles,
  onToggleCollapsed,
  onToggleAllCollapsed,
  onAddComment,
  onAddFileComment,
  onResolveThread,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
  onOpenInEditor,
  syntaxTheme,
  baseCommitish,
  targetCommitish,
  cursor = null,
  isFocused = false,
  fileIndex = 0,
  onLineClick,
  commentTrigger,
  onCommentTriggerHandled,
  mergedChunks,
  openLines,
  prefetchFileContent,
  isExpandLoading,
  diffVersion,
  fixupOverlay,
  foldCommentChanges = false,
}: DiffViewerProps) {
  const isCollapsed = collapsedFiles.has(file.path);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isAddingFileComment, setIsAddingFileComment] = useState(false);
  const [fileThreads, lineThreads] = useMemo(
    () => [
      threads.filter((thread) => thread.line === undefined),
      threads.filter((thread) => thread.line !== undefined),
    ],
    [threads],
  );

  const viewer = getViewerForFile(file);
  const hasBlobContent = baseCommitish !== 'stdin' && targetCommitish !== 'stdin';
  const canExpandHiddenLines = hasBlobContent && (viewer.canExpandHiddenLines?.(file) ?? false);
  // Tokenize the whole file so embedded blocks (e.g. <script>/<style>) are
  // highlighted by their own language instead of line-by-line, which can't see
  // the surrounding context.
  const wholeFileHighlight = viewer.id === 'default' && isWholeFileHighlightExtension(file.path);

  // Observe visibility for lazy prefetch
  useEffect(() => {
    if (!canExpandHiddenLines) return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setIsVisible(true);
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [canExpandHiddenLines]);

  // Pre-fetch line counts (lightweight) only for visible, non-collapsed files that can expand
  useEffect(() => {
    if (isVisible && !isCollapsed && canExpandHiddenLines) {
      void prefetchFileContent(file);
    }
  }, [isVisible, isCollapsed, canExpandHiddenLines, file, prefetchFileContent]);

  const handleAddComment = useMemo(
    () =>
      onAddComment &&
      (async (
        line: LineNumber,
        body: string,
        codeContent?: string,
        side?: DiffSide,
        extra?: ExtraCommentLines,
      ) => {
        try {
          await onAddComment(file.path, line, body, codeContent, side, extra);
        } catch (error) {
          console.error('Failed to add comment:', error);
        }
      }),
    [file.path, onAddComment],
  );

  useEffect(() => {
    if (isCollapsed || isExpandLoading || !canExpandHiddenLines || lineThreads.length === 0) {
      return;
    }

    if (file.chunks.length === 0 || mergedChunks.length === 0) {
      return;
    }

    const commentRangesBySide = normalizeCommentRanges(lineThreads);
    const gapIndices = new Set<number>();

    (['old', 'new'] as const).forEach((side) => {
      const commentRanges = commentRangesBySide[side];
      if (commentRanges.length === 0) return;

      const ranges = buildChunkRanges(file, side);
      const gaps = buildGaps(ranges, file.chunks.length);

      gaps.forEach((gap) => {
        const hasComment = commentRanges.some(
          (range) => range.start <= gap.end && range.end >= gap.start,
        );
        if (!hasComment) return;
        gap.chunkGapIndices.forEach((index) => gapIndices.add(index));
      });
    });

    const gapRanges = [...gapIndices].flatMap((index) => gapBeforeChunk(file, index) ?? []);
    if (gapRanges.length > 0) void openLines(file, gapRanges);
  }, [
    lineThreads,
    openLines,
    file,
    isCollapsed,
    isExpandLoading,
    mergedChunks,
    canExpandHiddenLines,
  ]);

  const fileLevelTokens = useFileLevelTokens({
    file,
    enabled: wholeFileHighlight,
    baseCommitish,
    targetCommitish,
    reloadKey: diffVersion,
  });

  const ViewerComponent = viewer.Component;
  const viewerProps: DiffViewerBodyProps = {
    file,
    threads: lineThreads,
    showAuthorBadges,
    diffMode,
    syntaxTheme,
    baseCommitish,
    targetCommitish,
    cursor,
    fileIndex,
    mergedChunks,
    foldCommentChanges,
    isExpandLoading,
    openHiddenLines: openLines,
    onAddComment: handleAddComment,
    onResolveThread,
    onReplyToThread,
    onRemoveMessage,
    onUpdateMessage,
    onOpenInEditor,
    onLineClick,
    commentTrigger,
    onCommentTriggerHandled,
  };

  const overlay = fixupOverlay ?? EMPTY_FIXUP_OVERLAY;
  const fixupRef = overlay.fixupTouchedFiles.get(file.path);

  return (
    <div
      ref={containerRef}
      className="bg-github-bg-primary [--line-number-width:4em] max-md:[--line-number-width:30px]"
    >
      <DiffViewerHeader
        file={file}
        isCollapsed={isCollapsed}
        isFocused={isFocused}
        isReviewed={reviewedFiles.has(file.path)}
        isChangedSinceViewed={isChangedSinceViewed}
        onToggleCollapsed={onToggleCollapsed}
        onToggleAllCollapsed={onToggleAllCollapsed}
        onToggleReviewed={onToggleReviewed}
        labels={headerLabels}
        onRevealFixup={
          fixupRef && (() => overlay.revealFixupFile(fixupRef.fixupSha, fixupRef.path))
        }
        onAddFileComment={
          onAddFileComment &&
          (() => {
            if (isCollapsed) onToggleCollapsed(file.path);
            setIsAddingFileComment(true);
          })
        }
      />

      {!isCollapsed && (
        <FileLevelTokensProvider value={fileLevelTokens}>
          <FixupOverlayProvider value={overlay}>
            {(fileThreads.length > 0 || (isAddingFileComment && onAddFileComment)) && (
              <section
                aria-label="파일 전체 지적"
                className="space-y-2 border-b border-github-border bg-github-bg-secondary px-4 py-2"
              >
                {fileThreads.map((thread) => (
                  <div key={thread.id} id={`file-comment-${thread.id}`} className="space-y-1">
                    <FixupOverlayBlock
                      thread={thread}
                      filePath={file.path}
                      syntaxTheme={syntaxTheme}
                    />
                    <CommentThreadCard
                      thread={thread}
                      review={threadReviewControls(overlay, thread)}
                      showAuthorBadges={showAuthorBadges}
                      onResolveThread={onResolveThread}
                      onReplyToThread={onReplyToThread}
                      onRemoveMessage={onRemoveMessage}
                      onUpdateMessage={onUpdateMessage}
                      syntaxTheme={syntaxTheme}
                    />
                  </div>
                ))}
                {isAddingFileComment && onAddFileComment && (
                  <CommentForm
                    onSubmit={async (body) => {
                      await onAddFileComment(
                        file.path,
                        body,
                        file.status === 'deleted' ? 'old' : 'new',
                      );
                      setIsAddingFileComment(false);
                    }}
                    onCancel={() => setIsAddingFileComment(false)}
                    syntaxTheme={syntaxTheme}
                    filename={file.path}
                  />
                )}
              </section>
            )}
            <div className="overflow-y-auto">
              <ViewerComponent {...viewerProps} />
            </div>
          </FixupOverlayProvider>
        </FileLevelTokensProvider>
      )}
    </div>
  );
});
