import { X } from 'lucide-react';
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { useHotkeysContext } from 'react-hotkeys-hook';

import type { CommentThread } from '../../types/diff';
import { locationLabel } from '../../utils/commentPosition';
import type { CommentPanelStatus } from '../../utils/reviewDecisions';
import { keyByPosition } from '../utils/keyByPosition';

export type CommentsPanelFilter = 'remaining' | 'all';

export interface CommentsPanelHandle {
  focus: () => void;
  hasFocus: () => boolean;
}

interface CommentsPanelProps {
  ref?: Ref<CommentsPanelHandle>;
  threads: CommentThread[];
  // A thread missing here is not listed.
  statusById: ReadonlyMap<string, CommentPanelStatus>;
  resolvedThreadIds: ReadonlySet<string>;
  filter: CommentsPanelFilter;
  onFilterChange: (filter: CommentsPanelFilter) => void;
  pickedThreadId: string | null;
  onPick: (thread: CommentThread) => void;
  onResolveThread: (threadId: string) => void;
  onEscape?: () => void;
  onClose: () => void;
  inDrawer?: boolean;
}

const STATUS_CHIP: Record<CommentPanelStatus, { label: string; className: string }> = {
  open: {
    label: '열림',
    className:
      'border-github-warning text-github-warning fixup-review:border-github-text-primary fixup-review:text-github-text-primary',
  },
  answered: { label: '답함', className: 'border-blue-500 text-blue-400' },
  choosing: {
    label: '고를 차례',
    className: 'border-github-warning bg-github-warning/15 text-github-warning',
  },
  resolved: { label: '해결', className: 'border-github-border text-github-text-muted' },
};

const FILTER_BUTTON_CLASS = 'h-7 rounded-md border px-2.5 text-xs transition-colors';
const FILTER_ON_CLASS = 'border-blue-500 bg-blue-500/15 text-github-text-primary';
const FILTER_OFF_CLASS =
  'border-github-border text-github-text-secondary hover:text-github-text-primary';

// A comment on the whole file comes before its lines.
const firstLine = (line: CommentThread['line']) =>
  line === undefined ? 0 : Array.isArray(line) ? line[0] : line;

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

const isRemaining = (status: CommentPanelStatus) => status !== 'resolved';

export function CommentsPanel({
  ref,
  threads,
  statusById,
  resolvedThreadIds,
  filter,
  onFilterChange,
  pickedThreadId,
  onPick,
  onResolveThread,
  onEscape,
  onClose,
  inDrawer = false,
}: CommentsPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const lastActiveIndexRef = useRef(0);
  const { activeScopes } = useHotkeysContext();
  const takesKeys = activeScopes.includes('navigation') || activeScopes.includes('*');

  const listed = useMemo(
    () =>
      threads
        .filter((thread) => statusById.has(thread.id))
        .sort(
          (a, b) =>
            a.file.localeCompare(b.file) ||
            firstLine(a.line) - firstLine(b.line) ||
            a.createdAt.localeCompare(b.createdAt),
        ),
    [threads, statusById],
  );
  const remaining = useMemo(
    () => listed.filter((thread) => isRemaining(statusById.get(thread.id) ?? 'resolved')),
    [listed, statusById],
  );
  const shown = filter === 'remaining' ? remaining : listed;
  const choosingCount = listed.filter((thread) => statusById.get(thread.id) === 'choosing').length;

  let activeIndex = shown.findIndex((thread) => thread.id === activeThreadId);
  if (activeIndex === -1 && shown.length > 0) {
    activeIndex = Math.min(lastActiveIndexRef.current, shown.length - 1);
  }
  const activeThread = shown[activeIndex];
  useEffect(() => {
    if (activeIndex !== -1) lastActiveIndexRef.current = activeIndex;
  });

  const focusRow = (thread: CommentThread | undefined) => {
    if (!thread) {
      listRef.current?.focus();
      return;
    }
    setActiveThreadId(thread.id);
    const row = rowRefs.current.get(thread.id);
    row?.focus();
    row?.scrollIntoView?.({ block: 'nearest' });
  };

  useImperativeHandle(ref, () => ({
    focus: () =>
      focusRow(shown.find((thread) => thread.id === pickedThreadId) ?? activeThread ?? shown[0]),
    hasFocus: () => rootRef.current?.contains(document.activeElement) ?? false,
  }));

  const resolveActive = () => {
    if (!activeThread || resolvedThreadIds.has(activeThread.id)) return;
    if (filter === 'remaining') {
      focusRow(shown[activeIndex + 1] ?? shown[activeIndex - 1]);
    }
    onResolveThread(activeThread.id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!takesKeys || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    switch (keyByPosition(event)) {
      case 'j':
      case 'ArrowDown':
        focusRow(shown[Math.min(activeIndex + 1, shown.length - 1)]);
        break;
      case 'k':
      case 'ArrowUp':
        focusRow(shown[Math.max(activeIndex - 1, 0)]);
        break;
      case 'd':
        resolveActive();
        break;
      case 'Escape':
        (document.activeElement as HTMLElement | null)?.blur();
        onEscape?.();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500"
      onKeyDown={handleKeyDown}
    >
      <div className="flex flex-col gap-2 border-b border-github-border px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-github-text-primary">코멘트</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-github-text-secondary transition-colors hover:bg-github-bg-tertiary hover:text-github-text-primary"
            aria-label="코멘트 패널 닫기"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            aria-pressed={filter === 'remaining'}
            onClick={() => onFilterChange('remaining')}
            className={`${FILTER_BUTTON_CLASS} ${filter === 'remaining' ? FILTER_ON_CLASS : FILTER_OFF_CLASS}`}
          >
            남은 것 {remaining.length}
          </button>
          <button
            type="button"
            aria-pressed={filter === 'all'}
            onClick={() => onFilterChange('all')}
            className={`${FILTER_BUTTON_CLASS} ${filter === 'all' ? FILTER_ON_CLASS : FILTER_OFF_CLASS}`}
          >
            전체 {listed.length}
          </button>
          {choosingCount > 0 && (
            <span
              data-testid="choosing-count"
              className="inline-flex h-7 items-center rounded-md border border-github-warning px-2.5 text-xs text-github-warning"
            >
              고를 차례 {choosingCount}
            </span>
          )}
        </div>
      </div>

      <div
        ref={listRef}
        tabIndex={-1}
        aria-label="코멘트 목록"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1.5 focus:outline-none"
      >
        {shown.length === 0 ? (
          <p className="px-2.5 py-4 text-xs text-github-text-secondary">
            {listed.length === 0 ? '코멘트가 없습니다' : '남은 코멘트가 없습니다'}
          </p>
        ) : (
          shown.map((thread) => {
            const status = statusById.get(thread.id) ?? 'resolved';
            const chip = STATUS_CHIP[status];
            const isPicked = thread.id === pickedThreadId;
            return (
              <button
                key={thread.id}
                ref={(element) => {
                  if (element) rowRefs.current.set(thread.id, element);
                  else rowRefs.current.delete(thread.id);
                }}
                type="button"
                data-thread-id={thread.id}
                tabIndex={thread === activeThread ? 0 : -1}
                aria-current={isPicked ? 'true' : undefined}
                onFocus={() => setActiveThreadId(thread.id)}
                onClick={() => onPick(thread)}
                className={`flex w-full flex-col gap-1 rounded-md border px-2.5 py-2 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  isPicked
                    ? 'border-blue-500 bg-blue-500/15'
                    : 'border-transparent hover:bg-github-bg-tertiary'
                }`}
              >
                <span className="flex w-full items-center gap-1.5">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11px] text-github-text-secondary"
                    title={thread.file}
                  >
                    {locationLabel(
                      baseName(thread.file),
                      thread.line,
                      thread.extraLines,
                      thread.side,
                    )}
                  </span>
                  <span
                    className={`inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[10px] font-medium ${chip.className}`}
                  >
                    {chip.label}
                  </span>
                </span>
                <span className="line-clamp-2 text-xs leading-[18px] text-github-text-primary">
                  {thread.messages[0]?.body}
                </span>
              </button>
            );
          })
        )}
      </div>

      {!inDrawer && (
        <div className="border-t border-github-border px-3 py-2 text-[11px] text-github-text-muted">
          <span className="font-mono">j/k</span> 이동 · <span className="font-mono">Enter</span> 그
          줄로 · <span className="font-mono">d</span> 해결 · <span className="font-mono">Esc</span>{' '}
          diff로
        </div>
      )}
    </div>
  );
}
