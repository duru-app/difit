import { MessageSquare, Plus } from 'lucide-react';

import type { CommentThread, LineNumber } from '../../types/diff';
import { coversBothSides } from '../../utils/commentPosition';
import type { LinePickStore } from '../contexts/LinePickContext';
import { rangeLabel } from '../utils/linePick';

export function PickControls({
  store,
  ranges,
  canHover,
}: {
  store: Pick<LinePickStore, 'addMode' | 'setAddMode'>;
  ranges: readonly LineNumber[];
  canHover: boolean;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-github-text-secondary">
      {ranges.length > 1 && (
        <span
          data-testid="picked-ranges"
          className="min-w-0 font-mono [overflow-wrap:anywhere]"
          style={{ color: 'var(--color-yellow-path-text)' }}
        >
          {ranges.map(rangeLabel).join(', ')}
        </span>
      )}
      <button
        type="button"
        aria-pressed={store.addMode}
        onClick={() => store.setAddMode(!store.addMode)}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
          store.addMode
            ? 'border-blue-500 text-blue-500'
            : 'border-github-border hover:text-github-text-primary'
        }`}
      >
        <Plus size={12} aria-hidden="true" />줄 더하기
      </button>
      {canHover && (
        <span>
          <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+클릭: 줄 더하기·빼기 · <kbd>Shift</kbd>+클릭: 범위 늘리기
        </span>
      )}
    </div>
  );
}

export function PickNotice({ notice }: { notice: string | null }) {
  if (!notice) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-md border border-github-border bg-github-bg-tertiary px-3 py-1.5 text-center text-xs text-github-text-primary shadow-lg"
    >
      {notice}
    </div>
  );
}

// Under a range of a thread other than the one its card sits under.
export function ThreadMarker({
  thread,
  onGo,
}: {
  thread: Pick<CommentThread, 'line' | 'side' | 'extraLines'>;
  onGo: () => void;
}) {
  if (thread.line === undefined) return null;
  const cardSide = coversBothSides(thread.side, thread.extraLines)
    ? thread.side === 'old'
      ? '지운 줄 '
      : '남은 줄 '
    : '';
  return (
    <div className="mx-4 my-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-l-[3px] border-yellow-400 px-2 py-0.5 text-xs text-github-text-secondary">
      <MessageSquare size={12} aria-hidden="true" />
      <span>
        이 줄도 {cardSide}
        {rangeLabel(thread.line)} 아래 지적에 함께 걸려 있습니다
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onGo();
        }}
        className="text-blue-500 hover:underline"
      >
        지적으로 가기
      </button>
    </div>
  );
}

export function goToThreadCard(threadId: string) {
  document
    .getElementById(`comment-thread-${threadId}`)
    ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
}
