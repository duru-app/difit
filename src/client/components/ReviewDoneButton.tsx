import { Check } from 'lucide-react';

interface ReviewDoneButtonProps {
  reviewDone: boolean;
  // At least one listed comment and none of them remaining.
  nothingRemains: boolean;
  onReviewDone: () => void;
  compact?: boolean;
}

const hintFor = (reviewDone: boolean, prominent: boolean) => {
  if (reviewDone) return '에이전트에게 리뷰가 끝났다고 알렸습니다. 코멘트를 새로 달면 풀립니다.';
  if (prominent) {
    return '남은 코멘트가 없고 fixup을 모두 승인했습니다. 리뷰를 끝내려면 「리뷰 끝」을 누르세요.';
  }
  return '에이전트에게 리뷰가 끝났다고 알립니다.';
};

export function ReviewDoneButton({
  reviewDone,
  nothingRemains,
  onReviewDone,
  compact = false,
}: ReviewDoneButtonProps) {
  const prominent = !reviewDone && nothingRemains;
  const hint = hintFor(reviewDone, prominent);
  return (
    <button
      type="button"
      disabled={reviewDone}
      aria-pressed={reviewDone}
      data-prominent={prominent ? 'true' : undefined}
      onClick={onReviewDone}
      title={hint}
      aria-label={`리뷰 끝: ${hint}`}
      className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border text-xs transition-colors ${
        compact ? 'h-7 px-2' : 'h-8 px-2.5'
      } ${
        reviewDone
          ? 'cursor-default border-github-accent text-github-accent'
          : prominent
            ? 'border-github-accent bg-github-accent font-semibold text-white hover:bg-github-accent/90'
            : 'border-github-border bg-github-bg-tertiary text-github-text-primary hover:bg-github-bg-primary'
      }`}
    >
      {reviewDone && <Check size={12} aria-hidden="true" />}
      리뷰 끝
    </button>
  );
}
