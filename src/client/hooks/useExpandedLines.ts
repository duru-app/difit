import { useState, useCallback, useRef, useEffect } from 'react';

import {
  type ChunkChangeKind,
  type DiffFile,
  type DiffChunk,
  type DiffLine,
  type ExpandedLine,
  type ExpandedLinesState,
  type ExpandedRange,
  type FileExpandedState,
} from '../../types/diff';
import { combineChangeKinds } from '../../utils/changeKind';

interface UseExpandedLinesOptions {
  baseCommitish?: string;
  targetCommitish?: string;
  diffIdentity?: string | number;
}

interface OriginalLineRange {
  originalIndex: number;
  start: number;
  end: number;
  changeKind?: ChunkChangeKind;
}

export interface MergedChunk extends DiffChunk {
  // Empty for lines opened in the middle of a gap, away from every chunk.
  originalIndices: number[];
  // Where each original chunk's own lines sit in `lines`.
  originalLineRanges: OriginalLineRange[];
  // Old lines hidden right above `oldStart`.
  hiddenLinesBefore: number;
  // Old lines hidden from `oldStart + oldLines`; set on the last chunk only, -1 while the file length is unknown.
  hiddenLinesAfter: number;
}

interface UseExpandedLinesResult {
  expandedState: ExpandedLinesState;
  isLoading: boolean;
  lastUpdatedFilePath: string | null;
  lastUpdatedAt: number;
  openLines: (file: DiffFile, ranges: readonly ExpandedRange[]) => Promise<void>;
  prefetchFileContent: (file: DiffFile) => Promise<void>;
  getMergedChunks: (file: DiffFile) => MergedChunk[];
}

async function fetchFileContent(
  filePath: string,
  commitish: string,
): Promise<{ lines: string[]; totalLines: number }> {
  const encodedPath = encodeURIComponent(filePath);
  const response = await fetch(`/api/blob/${encodedPath}?ref=${encodeURIComponent(commitish)}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch file content: ${response.statusText}`);
  }

  const text = await response.text();
  const lines = text.split('\n');
  // Remove last empty line if file doesn't end with newline
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return { lines, totalLines: lines.length };
}

async function fetchLineCount(
  filePath: string,
  oldRef?: string,
  newRef?: string,
  oldPath?: string,
): Promise<{ oldLineCount?: number; newLineCount?: number }> {
  const encodedPath = encodeURIComponent(filePath);
  const params = new URLSearchParams();
  if (oldRef) params.set('oldRef', oldRef);
  if (newRef) params.set('newRef', newRef);
  if (oldPath && oldPath !== filePath) params.set('oldPath', oldPath);

  const response = await fetch(`/api/line-count/${encodedPath}?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch line count: ${response.statusText}`);
  }
  return response.json() as Promise<{ oldLineCount?: number; newLineCount?: number }>;
}

const showsWholeFile = (file: DiffFile) => file.status === 'added' || file.status === 'deleted';

// The unchanged old lines between chunks[index - 1] and chunks[index]; index === chunks.length is the tail.
export function gapBeforeChunk(file: DiffFile, index: number): ExpandedRange | null {
  if (showsWholeFile(file)) return null;
  const prev = file.chunks[index - 1];
  const next = file.chunks[index];
  if (!prev && !next) return null;
  return {
    start: prev ? prev.oldStart + prev.oldLines : 1,
    end: next ? next.oldStart - 1 : Number.POSITIVE_INFINITY,
  };
}

// New line number minus old line number, the same for every line of that gap.
function gapShift(file: DiffFile, index: number): number {
  const next = file.chunks[index];
  if (next) return next.newStart - next.oldStart;
  const last = file.chunks[index - 1];
  return last ? last.newStart + last.newLines - (last.oldStart + last.oldLines) : 0;
}

// `context` old lines on each side of every hidden new-side line, kept inside its gap.
export function rangesAroundNewLines(
  file: DiffFile,
  newLines: readonly number[],
  context: number,
): ExpandedRange[] {
  return Array.from({ length: file.chunks.length + 1 }, (_, index) => index).flatMap((index) => {
    const gap = gapBeforeChunk(file, index);
    if (!gap) return [];
    const shift = gapShift(file, index);
    return newLines.flatMap((newLine) => {
      const oldLine = newLine - shift;
      if (oldLine < gap.start || oldLine > gap.end) return [];
      return [
        {
          start: Math.max(gap.start, oldLine - context),
          end: Math.min(gap.end, oldLine + context),
        },
      ];
    });
  });
}

function withRanges(
  ranges: readonly ExpandedRange[],
  added: readonly ExpandedRange[],
): ExpandedRange[] {
  const merged: ExpandedRange[] = [];
  for (const range of [...ranges, ...added].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

const covers = (ranges: readonly ExpandedRange[], range: ExpandedRange) =>
  ranges.some((opened) => opened.start <= range.start && opened.end >= range.end);

function buildMergedChunks(
  file: DiffFile,
  fileState: FileExpandedState | undefined,
): MergedChunk[] {
  const opened = fileState?.expandedRanges ?? [];
  const oldContent = fileState?.oldContent ?? [];
  const newContent = fileState?.newContent ?? [];
  const totalLines = fileState?.oldTotalLines || fileState?.newTotalLines;
  const mergedChunks: MergedChunk[] = [];
  let current: MergedChunk | null = null;
  let hiddenRun = 0;
  let tailHidden = 0;

  const place = (
    lines: DiffLine[],
    oldStart: number,
    oldStop: number,
    newStart: number,
    newStop: number,
  ) => {
    const target: MergedChunk = current ?? {
      header: '',
      oldStart,
      oldLines: 0,
      newStart,
      newLines: 0,
      lines: [],
      originalIndices: [],
      originalLineRanges: [],
      hiddenLinesBefore: hiddenRun,
      hiddenLinesAfter: 0,
    };
    if (!current) {
      mergedChunks.push(target);
      current = target;
      hiddenRun = 0;
    }
    const offset = target.lines.length;
    target.lines = target.lines.concat(lines);
    target.oldLines = oldStop - target.oldStart;
    target.newLines = newStop - target.newStart;
    return { target, offset };
  };

  const chunkCount = file.chunks.length;
  for (let index = 0; index <= chunkCount; index++) {
    const gap = gapBeforeChunk(file, index);
    if (gap) {
      const isTail = index === chunkCount;
      const end = isTail ? (totalLines ?? gap.start - 1) : gap.end;
      const shift = gapShift(file, index);
      let next = gap.start;
      for (const range of opened) {
        const from = Math.max(range.start, next);
        const to = Math.min(range.end, end);
        if (from > to) continue;
        if (from > next) {
          current = null;
          hiddenRun = from - next;
        }
        const lines: DiffLine[] = [];
        for (let oldLine = from; oldLine <= to; oldLine++) {
          const newLine = oldLine + shift;
          const content = oldContent[oldLine - 1] ?? newContent[newLine - 1];
          const line: ExpandedLine = {
            type: 'normal',
            content: content ?? '',
            oldLineNumber: oldLine,
            newLineNumber: newLine,
            isExpanded: true,
            ...(content === undefined ? { contentUnread: true } : {}),
          };
          lines.push(line);
        }
        place(lines, from, to + 1, from + shift, to + 1 + shift);
        next = to + 1;
      }
      const hidden = Math.max(0, end - next + 1);
      if (isTail) {
        tailHidden = totalLines === undefined ? -1 : hidden;
      } else if (hidden > 0) {
        current = null;
        hiddenRun = hidden;
      }
    }

    const chunk = file.chunks[index];
    if (!chunk) continue;
    const { target, offset } = place(
      chunk.lines,
      chunk.oldStart,
      chunk.oldStart + chunk.oldLines,
      chunk.newStart,
      chunk.newStart + chunk.newLines,
    );
    if (target.originalIndices.length === 0) target.header = chunk.header;
    target.originalIndices.push(index);
    target.originalLineRanges.push({
      originalIndex: index,
      start: offset,
      end: offset + chunk.lines.length - 1,
      changeKind: chunk.changeKind,
    });
    target.changeKind = combineChangeKinds(
      target.originalLineRanges.map((range) => range.changeKind),
    );
  }

  const last = mergedChunks[mergedChunks.length - 1];
  if (last) last.hiddenLinesAfter = tailHidden;
  return mergedChunks;
}

export function useExpandedLines({
  baseCommitish,
  targetCommitish,
  diffIdentity,
}: UseExpandedLinesOptions): UseExpandedLinesResult {
  const isStdinDiff = baseCommitish === 'stdin' || targetCommitish === 'stdin';
  const [expandedState, setExpandedState] = useState<ExpandedLinesState>({});
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdatedFilePath, setLastUpdatedFilePath] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(0);
  // Track pending fetch promises to allow waiting for in-flight requests (#2)
  const pendingFetchesRef = useRef<Map<string, Promise<FileExpandedState | null>>>(new Map());
  // Use ref to access current state without causing dependency loop (#2)
  const expandedStateRef = useRef<ExpandedLinesState>({});
  expandedStateRef.current = expandedState;
  const revisionGenerationRef = useRef(0);

  useEffect(() => {
    revisionGenerationRef.current += 1;
    pendingFetchesRef.current.clear();
    expandedStateRef.current = {};
    setExpandedState({});
    setIsLoading(false);
    setLastUpdatedFilePath(null);
    setLastUpdatedAt(0);
  }, [baseCommitish, targetCommitish, diffIdentity]);

  const ensureFileContent = useCallback(
    async (file: DiffFile): Promise<FileExpandedState | null> => {
      if (isStdinDiff) {
        return null;
      }

      const revisionGeneration = revisionGenerationRef.current;
      const pendingFetchKey = `${revisionGeneration}:${file.path}`;

      // Check if fetch is already in progress - wait for it instead of returning stale data
      const pendingFetch = pendingFetchesRef.current.get(pendingFetchKey);
      if (pendingFetch) {
        return pendingFetch;
      }

      // Create the fetch promise
      const fetchPromise = (async (): Promise<FileExpandedState | null> => {
        // Read current state via ref to avoid dependency on expandedState
        const existingState = expandedStateRef.current[file.path];

        if (existingState?.oldContent && existingState?.newContent) {
          return existingState;
        }

        const state: FileExpandedState = {
          ...existingState,
          expandedRanges: existingState?.expandedRanges || [],
        };

        // Fetch old content for modified/deleted/renamed files
        if (file.status !== 'added' && baseCommitish) {
          const oldPath = file.oldPath || file.path;
          try {
            const { lines, totalLines } = await fetchFileContent(oldPath, baseCommitish);
            if (revisionGenerationRef.current !== revisionGeneration) {
              return null;
            }
            state.oldContent = lines;
            state.oldTotalLines = totalLines;
          } catch (error) {
            console.error('Failed to fetch old file content:', error);
            state.oldContent = [];
            state.oldTotalLines = 0;
          }
        }

        // Fetch new content for modified/added/renamed files
        if (file.status !== 'deleted' && targetCommitish) {
          try {
            const { lines, totalLines } = await fetchFileContent(file.path, targetCommitish);
            if (revisionGenerationRef.current !== revisionGeneration) {
              return null;
            }
            state.newContent = lines;
            state.newTotalLines = totalLines;
          } catch (error) {
            console.error('Failed to fetch new file content:', error);
            state.newContent = [];
            state.newTotalLines = 0;
          }
        }

        return state;
      })();

      pendingFetchesRef.current.set(pendingFetchKey, fetchPromise);

      try {
        return await fetchPromise;
      } finally {
        pendingFetchesRef.current.delete(pendingFetchKey);
      }
    },
    [baseCommitish, targetCommitish, isStdinDiff],
  );

  const markFileUpdated = useCallback((filePath: string) => {
    setLastUpdatedFilePath(filePath);
    setLastUpdatedAt((prev) => prev + 1);
  }, []);

  const openLines = useCallback(
    async (file: DiffFile, ranges: readonly ExpandedRange[]) => {
      const wanted = ranges.filter((range) => range.start <= range.end);
      const opened = expandedStateRef.current[file.path]?.expandedRanges ?? [];
      if (isStdinDiff || wanted.every((range) => covers(opened, range))) return;

      const revisionGeneration = revisionGenerationRef.current;
      setIsLoading(true);
      try {
        const fileState = await ensureFileContent(file);
        if (!fileState || revisionGenerationRef.current !== revisionGeneration) {
          return;
        }

        setExpandedState((prev) => {
          const currentFileState = prev[file.path];
          return {
            ...prev,
            [file.path]: {
              oldContent: currentFileState?.oldContent ?? fileState.oldContent,
              newContent: currentFileState?.newContent ?? fileState.newContent,
              oldTotalLines: currentFileState?.oldTotalLines ?? fileState.oldTotalLines,
              newTotalLines: currentFileState?.newTotalLines ?? fileState.newTotalLines,
              expandedRanges: withRanges(
                currentFileState?.expandedRanges ?? fileState.expandedRanges,
                wanted,
              ),
            },
          };
        });
        markFileUpdated(file.path);
      } finally {
        setIsLoading(false);
      }
    },
    [ensureFileContent, markFileUpdated, isStdinDiff],
  );

  // Pre-fetch only line counts (lightweight) to show bottom expand button
  const prefetchFileContent = useCallback(
    async (file: DiffFile) => {
      if (isStdinDiff) {
        return;
      }

      const revisionGeneration = revisionGenerationRef.current;
      // Skip if we already have total lines info
      const existing = expandedStateRef.current[file.path];
      if (existing?.oldTotalLines !== undefined || existing?.newTotalLines !== undefined) {
        return;
      }

      const oldRef = file.status !== 'added' ? baseCommitish : undefined;
      const newRef = file.status !== 'deleted' ? targetCommitish : undefined;

      if (!oldRef && !newRef) return;

      try {
        const { oldLineCount, newLineCount } = await fetchLineCount(
          file.path,
          oldRef,
          newRef,
          file.oldPath,
        );
        if (revisionGenerationRef.current !== revisionGeneration) {
          return;
        }

        setExpandedState((prev) => {
          const current = prev[file.path];
          if (current?.oldTotalLines !== undefined || current?.newTotalLines !== undefined) {
            return prev;
          }
          return {
            ...prev,
            [file.path]: {
              ...current,
              expandedRanges: current?.expandedRanges || [],
              oldTotalLines: oldLineCount,
              newTotalLines: newLineCount,
            },
          };
        });
        markFileUpdated(file.path);
      } catch (error) {
        console.error('Failed to prefetch line count:', error);
      }
    },
    [baseCommitish, targetCommitish, isStdinDiff, markFileUpdated],
  );

  const getMergedChunks = useCallback(
    (file: DiffFile): MergedChunk[] => buildMergedChunks(file, expandedState[file.path]),
    [expandedState],
  );

  return {
    expandedState,
    isLoading,
    lastUpdatedFilePath,
    lastUpdatedAt,
    openLines,
    prefetchFileContent,
    getMergedChunks,
  };
}
