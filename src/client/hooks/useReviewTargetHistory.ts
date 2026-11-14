import { useCallback, useEffect, useRef } from 'react';

import { type DiffSelection, type DiffSide } from '../../types/diff';
import { createDiffSelection } from '../../utils/diffSelection';

const HISTORY_STATE_KEY = 'difitReviewTarget';
const PLACE_STATE_KEY = 'difitPlace';

// A line place with cursor puts the keyboard cursor back; without it, it only scrolls there.
// A thread place with top puts its card back that far below the diff's top edge; without it, the
// card is shown as picking the comment shows it.
export type ReviewPlace =
  | { kind: 'file'; file: string }
  | { kind: 'line'; file: string; line: number; side: DiffSide; cursor: boolean }
  | { kind: 'thread'; threadId: string; top?: number }
  | { kind: 'fixup'; fixupSha: string; path: string };

export interface ReviewHistoryEntry {
  selection: DiffSelection;
  place: ReviewPlace | null;
}

function selectionFromHistoryState(state: unknown): DiffSelection | null {
  if (typeof state !== 'object' || state === null) return null;
  const entry = (state as Record<string, unknown>)[HISTORY_STATE_KEY];
  if (typeof entry !== 'object' || entry === null) return null;
  const { baseCommitish, targetCommitish, baseMode } = entry as Record<string, unknown>;
  if (typeof baseCommitish !== 'string' || typeof targetCommitish !== 'string') return null;
  return createDiffSelection(
    baseCommitish,
    targetCommitish,
    baseMode === 'merge-base' ? 'merge-base' : undefined,
  );
}

function placeFromHistoryState(state: unknown): ReviewPlace | null {
  if (typeof state !== 'object' || state === null) return null;
  const place = (state as Record<string, unknown>)[PLACE_STATE_KEY];
  if (typeof place !== 'object' || place === null) return null;
  const { kind, file, line, side, cursor, threadId, top, fixupSha, path } = place as Record<
    string,
    unknown
  >;
  if (kind === 'file' && typeof file === 'string') return { kind, file };
  if (
    kind === 'line' &&
    typeof file === 'string' &&
    typeof line === 'number' &&
    (side === 'old' || side === 'new')
  ) {
    return { kind, file, line, side, cursor: cursor === true };
  }
  if (kind === 'thread' && typeof threadId === 'string') {
    return { kind, threadId, ...(typeof top === 'number' && { top }) };
  }
  if (kind === 'fixup' && typeof fixupSha === 'string' && typeof path === 'string') {
    return { kind, fixupSha, path };
  }
  return null;
}

function entryFromHistoryState(state: unknown): ReviewHistoryEntry | null {
  const selection = selectionFromHistoryState(state);
  return selection ? { selection, place: placeFromHistoryState(state) } : null;
}

function historyState({ selection, place }: ReviewHistoryEntry) {
  return { [HISTORY_STATE_KEY]: selection, ...(place && { [PLACE_STATE_KEY]: place }) };
}

// A page loaded afresh by Back/Forward must show the entry's review, not the one the server last
// switched to. A reload keeps the server's review.
export function reviewEntryRestoredByHistory(): ReviewHistoryEntry | null {
  const [navigation] = performance.getEntriesByType('navigation');
  if ((navigation as PerformanceNavigationTiming | undefined)?.type !== 'back_forward') return null;
  return entryFromHistoryState(window.history.state);
}

interface UseReviewTargetHistoryOptions {
  current: () => ReviewHistoryEntry;
  restore: (entry: ReviewHistoryEntry) => void;
}

// The URL stays the same within a review, so each jump to another review or another place in it
// is recorded in history state, and Back/Forward go back to it without recording anything.
export function useReviewTargetHistory(
  options: UseReviewTargetHistoryOptions,
): (to: ReviewHistoryEntry, from?: ReviewHistoryEntry) => void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const entry = entryFromHistoryState(event.state);
      if (entry) optionsRef.current.restore(entry);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  return useCallback((to: ReviewHistoryEntry, given?: ReviewHistoryEntry) => {
    const from = given ?? optionsRef.current.current();
    if (JSON.stringify(historyState(from)) === JSON.stringify(historyState(to))) return;
    const currentState: unknown = window.history.state;
    const kept: Record<string, unknown> =
      typeof currentState === 'object' && currentState !== null ? { ...currentState } : {};
    delete kept[PLACE_STATE_KEY];
    window.history.replaceState({ ...kept, ...historyState(from) }, '');
    window.history.pushState(historyState(to), '');
  }, []);
}
