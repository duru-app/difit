import { X } from 'lucide-react';

interface NoticeBarProps {
  text: string;
  onDismiss: () => void;
}

export function NoticeBar({ text, onDismiss }: NoticeBarProps) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-4 py-1 text-xs bg-github-bg-tertiary border-t border-github-border">
      <p role="status" className="min-w-0 flex-1 text-github-text-secondary">
        {text}
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
