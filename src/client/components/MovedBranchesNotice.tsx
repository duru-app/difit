import { X } from 'lucide-react';

import { movedBranchesNotice } from '../utils/directEdit';

interface MovedBranchesNoticeProps {
  branches: readonly string[];
  onDismiss: () => void;
}

export function MovedBranchesNotice({ branches, onDismiss }: MovedBranchesNoticeProps) {
  if (branches.length === 0) return null;
  return (
    <div className="shrink-0 flex items-center gap-2 px-4 py-1 text-xs bg-github-bg-tertiary border-t border-github-border">
      <p role="status" className="min-w-0 flex-1 text-github-text-secondary">
        {movedBranchesNotice(branches)}
      </p>
      <button
        type="button"
        aria-label="알림 닫기"
        onClick={onDismiss}
        className="shrink-0 p-0.5 text-github-text-muted hover:text-github-text-primary"
      >
        <X size={12} />
      </button>
    </div>
  );
}
