import { MessageSquare, Plus } from 'lucide-react';

import type { CommentThread, DiffSide, SidedLine } from '../../types/diff';
import { coversBothSides, startOfLine } from '../../utils/commentPosition';
import type { LinePickStore } from '../contexts/LinePickContext';
import { rangeLabel } from '../utils/linePick';

const SIDE_NAMES: Record<DiffSide, string> = { old: '지운 줄', new: '남은 줄' };

function pickedRangesLabel(ranges: readonly SidedLine[]): string {
  const sides = (['old', 'new'] as const).filter((side) =>
    ranges.some((range) => range.side === side),
  );
  if (sides.length < 2) return ranges.map(({ line }) => rangeLabel(line)).join(', ');
  return sides
    .map((side) => {
      const labels = ranges
        .filter((range) => range.side === side)
        .sort((a, b) => startOfLine(a.line) - startOfLine(b.line))
        .map(({ line }) => rangeLabel(line));
      return `${SIDE_NAMES[side]} ${labels.join(', ')}`;
    })
    .join(' · ');
}

export function PickControls({
  store,
  ranges,
  canHover,
}: {
  store: Pick<LinePickStore, 'addMode' | 'setAddMode'>;
  ranges: readonly SidedLine[];
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
          {pickedRangesLabel(ranges)}
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

// Under a range of a thread other than the one its card sits under.
export function ThreadMarker({
  thread,
  card,
  onGo,
}: {
  thread: Pick<CommentThread, 'side' | 'extraLines'>;
  card: SidedLine | undefined;
  onGo: () => void;
}) {
  if (!card) return null;
  const cardSide = coversBothSides(thread.side, thread.extraLines)
    ? `${SIDE_NAMES[card.side]} `
    : '';
  return (
    <div className="mx-4 my-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-l-[3px] border-yellow-400 px-2 py-0.5 text-xs text-github-text-secondary">
      <MessageSquare size={12} aria-hidden="true" />
      <span>
        이 줄도 {cardSide}
        {rangeLabel(card.line)} 아래 지적에 함께 걸려 있습니다
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
