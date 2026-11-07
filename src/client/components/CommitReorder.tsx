import { GripVertical } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

import type {
  ReorderRequest,
  ReviewCommit,
  RewriteConflict,
  RewriteWarning,
} from '../../types/diff';

import { reorderHandoffBody } from '../utils/directEdit';

import { CONFLICT_ACTION_CLASS, ConflictDetails, type RewordFailure } from './CommitMessageForm';

export type SaveOrder = (request: ReorderRequest) => Promise<RewordFailure | null>;

interface Moving {
  sha: string;
  // Where the commit lands: before the row of this index, or past the last row at the list's length.
  at: number | null;
}

interface Refused {
  order: string[];
  failure: RewordFailure;
}

// The comment goes on the commit that conflicted, or when the review does not list that one, on the
// first commit whose place changed.
export function reorderHandoff(
  commits: readonly ReviewCommit[],
  order: readonly string[],
  conflict: RewriteConflict,
): { sha: string; body: string } | null {
  const stopped = conflict.commit?.sha;
  const sha = commits.some((commit) => commit.sha === stopped)
    ? stopped
    : order.find((each, at) => each !== commits[at]?.sha);
  return sha === undefined ? null : { sha, body: reorderHandoffBody(commits, order, conflict) };
}

const SCROLL_EDGE_PX = 28;
const SCROLL_STEP_PX = 12;
const SCROLL_EVERY_MS = 30;

// Rows carry `data-reorder-at`; a branch's rows, drawn above their merge, also `data-reorder-side`.
function dropPlace(
  list: HTMLElement | null,
  x: number,
  y: number,
  previous: number | null,
): number | null {
  const under = document.elementFromPoint(x, y);
  if (!list || !under || !list.contains(under)) return null;
  const row = under.closest<HTMLElement>('[data-reorder-at]');
  if (!row) return previous;
  const at = Number(row.dataset.reorderAt);
  if (row.hasAttribute('data-reorder-side')) return at;
  const { top, height } = row.getBoundingClientRect();
  return y > top + height / 2 ? at + 1 : at;
}

function orderAfterDrop(shas: readonly string[], sha: string, at: number | null): string[] | null {
  const from = shas.indexOf(sha);
  if (from === -1 || at === null || at === from || at === from + 1) return null;
  const rest = shas.filter((each) => each !== sha);
  rest.splice(at > from ? at - 1 : at, 0, sha);
  return rest;
}

export function useCommitReorder(
  shas: readonly string[],
  listRef: RefObject<HTMLElement | null>,
  save: SaveOrder | undefined,
) {
  const [moving, setMoving] = useState<Moving | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [refused, setRefused] = useState<Refused | null>(null);

  const submit = useCallback(
    async (order: string[], acknowledged?: RewriteWarning[]) => {
      if (!save) return;
      setIsSaving(true);
      setRefused(null);
      const failure = await save({ order, ...(acknowledged ? { acknowledged } : {}) });
      setIsSaving(false);
      if (failure) setRefused({ order, failure });
    },
    [save],
  );

  const latest = useRef({ shas, submit });
  latest.current = { shas, submit };
  const movingSha = moving?.sha ?? null;
  useEffect(() => {
    if (movingSha === null) return;
    let at: number | null = null;
    let pointer: { x: number; y: number } | null = null;
    const place = () => {
      if (!pointer) return;
      at = dropPlace(listRef.current, pointer.x, pointer.y, at);
      setMoving({ sha: movingSha, at });
    };
    const onMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      place();
    };
    const onUp = (event: PointerEvent) => {
      onMove(event);
      setMoving(null);
      const order = orderAfterDrop(latest.current.shas, movingSha, at);
      if (order) void latest.current.submit(order);
    };
    const onCancel = () => setMoving(null);
    const scroller = setInterval(() => {
      const list = listRef.current;
      if (!list || !pointer || list.scrollHeight <= list.clientHeight) return;
      const { top, bottom } = list.getBoundingClientRect();
      if (pointer.y < top + SCROLL_EDGE_PX) list.scrollTop -= SCROLL_STEP_PX;
      else if (pointer.y > bottom - SCROLL_EDGE_PX) list.scrollTop += SCROLL_STEP_PX;
      else return;
      place();
    }, SCROLL_EVERY_MS);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      clearInterval(scroller);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [movingSha, listRef]);

  const shownAt = moving && orderAfterDrop(shas, moving.sha, moving.at) !== null ? moving.at : null;

  return {
    movingSha,
    shownAt,
    isSaving,
    refused,
    startMoving: (sha: string) => {
      setRefused(null);
      setMoving({ sha, at: null });
    },
    retry: (acknowledged: RewriteWarning[]) => {
      if (refused) void submit(refused.order, acknowledged);
    },
    dismiss: () => setRefused(null),
  };
}

export function ReorderHandle({
  disabled,
  placement,
  onStart,
}: {
  disabled: boolean;
  placement: string;
  onStart: () => void;
}) {
  const start = (event: ReactPointerEvent) => {
    if (event.button !== 0 || disabled) return;
    event.preventDefault();
    onStart();
  };
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label="순서 바꾸기"
      title="끌어서 순서 바꾸기"
      disabled={disabled}
      onPointerDown={start}
      className={`z-10 flex shrink-0 cursor-grab touch-none items-center justify-center text-github-text-muted hover:text-github-text-primary disabled:cursor-default disabled:opacity-30 ${placement}`}
    >
      <GripVertical size={12} />
    </button>
  );
}

export function ReorderDropLine() {
  return (
    <li aria-hidden className="relative h-0">
      <div
        data-drop-line
        className="pointer-events-none absolute inset-x-0 -top-px z-10 h-0.5 bg-github-accent"
      />
    </li>
  );
}

const NOTICE_BUTTON_CLASS =
  'rounded border border-github-border bg-github-bg-tertiary px-3 py-1 text-xs text-github-text-primary transition-all hover:opacity-80';

export function ReorderNotice({
  isSaving,
  refused,
  onRetry,
  onDismiss,
  onHandOff,
}: {
  isSaving: boolean;
  refused: Refused | null;
  onRetry: (acknowledged: RewriteWarning[]) => void;
  onDismiss: () => void;
  onHandOff?: ((refused: Refused, conflict: RewriteConflict) => void) | undefined;
}) {
  if (isSaving) {
    return (
      <p role="status" className="shrink-0 px-4 py-1 text-xs text-github-text-secondary">
        옮기는 중…
      </p>
    );
  }
  if (!refused) return null;
  const { message, output, warnings, conflict } = refused.failure;
  return (
    <div
      role="alert"
      className="mx-3 my-1 min-h-0 overflow-y-auto rounded border border-github-danger bg-github-danger/10 px-2 pt-1.5 text-xs text-github-text-primary select-text"
    >
      <p>{message}</p>
      {output && (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-github-text-secondary">
          {output}
        </pre>
      )}
      {conflict && <ConflictDetails conflict={conflict} />}
      <div className="sticky bottom-0 mt-1 flex justify-end gap-2 bg-github-bg-secondary py-1.5">
        <button type="button" onClick={onDismiss} className={NOTICE_BUTTON_CLASS}>
          {warnings ? '취소' : '닫기'}
        </button>
        {warnings && (
          <button type="button" onClick={() => onRetry(warnings)} className={CONFLICT_ACTION_CLASS}>
            그래도 옮기기
          </button>
        )}
        {conflict?.agentAttached && onHandOff && (
          <button
            type="button"
            onClick={() => onHandOff(refused, conflict)}
            className={CONFLICT_ACTION_CLASS}
          >
            에이전트에게 맡기기
          </button>
        )}
      </div>
    </div>
  );
}
