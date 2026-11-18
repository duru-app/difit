import { ChevronLeft, ChevronRight, X } from 'lucide-react';

import type { WalkthroughCase } from '../../types/diff';

interface WalkthroughBarProps {
  walkthroughCase: WalkthroughCase;
  index: number;
  shown: boolean;
  onMove: (index: number) => void;
  onClose: () => void;
}

const BUTTON_CLASS =
  'inline-flex items-center gap-0.5 rounded-md border border-github-border px-2 py-0.5 text-xs text-github-text-primary hover:bg-github-bg-tertiary disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent';

export function WalkthroughBar({
  walkthroughCase,
  index,
  shown,
  onMove,
  onClose,
}: WalkthroughBarProps) {
  const { steps } = walkthroughCase;
  const step = steps[index];
  if (!step) return null;
  const location = `${step.file}:${step.line}${step.endLine === undefined ? '' : `-${step.endLine}`}`;

  return (
    <div
      role="region"
      aria-label="따라가기"
      data-walkthrough-bar
      className="shrink-0 flex items-start gap-3 px-4 py-2 text-sm bg-github-bg-secondary border-b border-github-border border-l-4 border-l-[var(--color-walkthrough-step-border)]"
    >
      <div className="shrink-0 flex flex-col items-start gap-0.5 pt-0.5">
        <span className="text-xs font-semibold text-github-text-primary">따라가기</span>
        <span className="text-xs tabular-nums text-github-text-secondary">
          {index + 1} / {steps.length}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-github-text-muted">
          <span className="font-mono">{location}</span>
          {!shown && <span className="text-github-warning">diff 에 안 보이는 줄</span>}
        </p>
        <p className="text-github-text-primary break-words">{step.description}</p>
      </div>
      <div className="shrink-0 flex items-center gap-1">
        <button
          type="button"
          aria-label="이전 단계"
          className={BUTTON_CLASS}
          disabled={index === 0}
          onClick={() => onMove(index - 1)}
        >
          <ChevronLeft size={14} />
          이전
        </button>
        <button
          type="button"
          aria-label="다음 단계"
          className={BUTTON_CLASS}
          disabled={index === steps.length - 1}
          onClick={() => onMove(index + 1)}
        >
          다음
          <ChevronRight size={14} />
        </button>
        <button
          type="button"
          aria-label="따라가기 닫기"
          title="따라가기 닫기"
          className="ml-1 p-1 text-github-text-muted hover:text-github-text-primary"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
