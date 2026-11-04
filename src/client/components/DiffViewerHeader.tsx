import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  FilePen,
  FilePlus,
  FileX,
  MessageSquarePlus,
  Square,
} from 'lucide-react';
import { useState } from 'react';

import type { DiffFile } from '../../types/diff';
import { copyTextToClipboard } from '../utils/clipboard';

import { FilePathText } from './FilePathText';

interface DiffViewerHeaderProps {
  file: DiffFile;
  isCollapsed: boolean;
  isFocused?: boolean;
  isReviewed: boolean;
  isChangedSinceViewed?: boolean;
  onToggleCollapsed: (path: string) => void;
  onToggleAllCollapsed: (shouldCollapse: boolean) => void;
  // Without it the file has no viewed state and no Viewed button.
  onToggleReviewed?: (path: string) => void;
  labels?: readonly string[];
  onRevealFixup?: () => void;
  // A fixup brought the file back to the review base; onRevealFixup goes to that fixup.
  isRevertedByFixup?: boolean;
  // Without it the file takes no comment on the whole file.
  onAddFileComment?: () => void;
}

const NO_LABELS: readonly string[] = [];

const getFileIcon = (status: DiffFile['status']) => {
  switch (status) {
    case 'added':
      return <FilePlus size={16} className="text-github-accent" />;
    case 'deleted':
      return <FileX size={16} className="text-github-danger" />;
    case 'renamed':
      return (
        <FilePen
          size={16}
          className="text-github-warning fixup-review:text-github-text-secondary"
        />
      );
    default:
      return <FileDiff size={16} className="text-github-text-secondary" />;
  }
};

export const DiffViewerHeader = ({
  file,
  isCollapsed,
  isFocused = false,
  isReviewed,
  isChangedSinceViewed = false,
  onToggleCollapsed,
  onToggleAllCollapsed,
  onToggleReviewed,
  labels = NO_LABELS,
  onRevealFixup,
  isRevertedByFixup = false,
  onAddFileComment,
}: DiffViewerHeaderProps) => {
  const [isCopied, setIsCopied] = useState(false);

  return (
    <div
      data-file-header
      className={`bg-github-bg-secondary border-t-2 border-t-github-accent border-b border-github-border px-5 py-4 flex items-center justify-between flex-wrap gap-3 sticky top-0 z-10 ${
        isFocused ? 'keyboard-focused-file-header' : ''
      }`}
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <button
          onClick={(e) => {
            if (e.altKey) {
              // When Alt+clicking, collapse all if this file is expanded, expand all if collapsed
              onToggleAllCollapsed(!isCollapsed);
            } else {
              onToggleCollapsed(file.path);
            }
          }}
          className="text-github-text-muted hover:text-github-text-primary transition-colors cursor-pointer"
          title={
            isCollapsed
              ? 'Expand file (Alt+Click to expand all)'
              : 'Collapse file (Alt+Click to collapse all)'
          }
        >
          {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        {getFileIcon(file.status)}
        <h2
          className={`min-w-0 overflow-hidden text-sm font-mono m-0 ${
            isRevertedByFixup ? 'text-github-text-muted' : 'text-github-text-primary'
          }`}
        >
          <FilePathText path={file.path} />
        </h2>
        <button
          className={`bg-transparent border-none cursor-pointer px-1.5 py-1 rounded text-sm transition-all hover:bg-github-bg-tertiary ${
            isCopied
              ? 'text-github-accent'
              : 'text-github-text-secondary hover:text-github-text-primary'
          }`}
          onClick={() => {
            void copyTextToClipboard(file.path)
              .then(() => {
                console.log('File path copied to clipboard:', file.path);
                setIsCopied(true);
                setTimeout(() => setIsCopied(false), 2000);
              })
              .catch((err) => {
                console.error('Failed to copy file path:', err);
              });
          }}
          title="Copy file path"
        >
          {isCopied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        {file.oldPath && file.oldPath !== file.path && (
          <span className="text-xs text-github-text-muted italic">
            (renamed from {file.oldPath})
          </span>
        )}
        {labels.map((label) => (
          <span key={label} className="shrink-0 text-xs text-github-warning">
            {label}
          </span>
        ))}
        {onRevealFixup && (
          <button
            type="button"
            onClick={onRevealFixup}
            className="shrink-0 text-xs text-github-warning hover:underline"
          >
            {isRevertedByFixup ? 'fixup 되돌림' : 'fixup 수정'}
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        {isChangedSinceViewed && !isReviewed && (
          <span
            className="inline-flex h-6 items-center rounded-full border border-github-warning px-2.5 text-xs font-medium text-github-warning fixup-review:border-github-text-secondary fixup-review:text-github-text-secondary"
            title="Updated since you last viewed this file"
            aria-label="Updated since you last viewed this file"
          >
            Updated
          </span>
        )}
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium px-1 py-0.5 rounded text-github-accent bg-green-100/10">
            +{file.additions}
          </span>
          <span className="font-medium px-1 py-0.5 rounded text-github-danger bg-red-100/10">
            -{file.deletions}
          </span>
        </div>
        {onAddFileComment && (
          <button
            type="button"
            onClick={onAddFileComment}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm text-github-text-secondary border border-github-border hover:bg-github-bg-tertiary hover:text-github-text-primary transition-colors"
            title="파일 전체에 지적 달기"
            aria-label="파일 전체에 지적 달기"
          >
            <MessageSquarePlus size={14} />
            <span className="max-md:hidden">파일 지적</span>
          </button>
        )}
        {onToggleReviewed && (
          <button
            onClick={() => onToggleReviewed(file.path)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
              isReviewed
                ? 'bg-github-accent text-white'
                : 'dark:bg-slate-600 dark:text-white dark:border-slate-500 dark:hover:bg-slate-500 dark:hover:border-slate-400 bg-github-bg-secondary text-github-text-primary border border-github-border hover:bg-github-bg-tertiary hover:border-github-text-muted'
            }`}
            title={isReviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}
          >
            {isReviewed ? <Check size={14} /> : <Square size={14} />}
            Viewed
          </button>
        )}
      </div>
    </div>
  );
};
