import React, { type ReactNode, useState } from 'react';

import { CommentBodyRenderer, hasSuggestionInBody } from './CommentBodyRenderer';
import type { AppearanceSettings } from './SettingsModal';
import { SkillTextarea } from './SkillTextarea';

interface CommentFormProps {
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  selectedCode?: string;
  quote?: string;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  filename?: string;
  initialValue?: string;
  embedded?: boolean;
  location: string;
  submitLabel?: string;
  placeholder?: string;
  header?: ReactNode;
  label?: string;
  value?: string;
  onValueChange?: (next: string) => void;
}

type CommentFormMode = 'edit' | 'preview';

export function CommentForm({
  onSubmit,
  onCancel,
  selectedCode,
  quote,
  syntaxTheme,
  filename,
  initialValue = '',
  embedded = false,
  location,
  submitLabel = '보내기',
  placeholder = 'Leave a comment...',
  header,
  label,
  value,
  onValueChange,
}: CommentFormProps) {
  const [ownBody, setOwnBody] = useState(initialValue);
  const body = value ?? ownBody;
  const setBody = onValueChange ?? setOwnBody;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mode, setMode] = useState<CommentFormMode>('edit');
  const hasSuggestion = hasSuggestionInBody(body);
  const effectiveMode: CommentFormMode = hasSuggestion ? mode : 'edit';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!body.trim()) return;

    setIsSubmitting(true);
    try {
      await onSubmit(body.trim());
      setBody('');
      setMode('edit');
    } catch (error) {
      console.error('Failed to submit comment:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.metaKey || e.ctrlKey || !e.shiftKey) void handleSubmit(e);
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <form
      className={`rounded-[16px] bg-composer-bg px-[16px] py-[12px] text-composer-text shadow-[var(--composer-shadow)] ${
        embedded ? '' : 'm-2 mx-3'
      }`}
      aria-label={label}
      onSubmit={handleSubmit}
      onClick={(e) => e.stopPropagation()}
      data-empty={!body.trim()}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="min-w-0 text-[12px] italic text-composer-muted [overflow-wrap:anywhere]">
          › {location}
        </span>
        {hasSuggestion && (
          <div className="flex items-center border border-github-border rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => setMode('edit')}
              className={`text-xs px-2.5 py-1.5 ${
                effectiveMode === 'edit'
                  ? 'bg-github-bg-tertiary text-github-text-primary'
                  : 'bg-github-bg-secondary text-github-text-secondary'
              } transition-colors`}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setMode('preview')}
              className={`text-xs px-2.5 py-1.5 border-l border-github-border ${
                effectiveMode === 'preview'
                  ? 'bg-github-bg-tertiary text-github-text-primary'
                  : 'bg-github-bg-secondary text-github-text-secondary'
              } transition-colors`}
            >
              Preview
            </button>
          </div>
        )}
      </div>

      {header}

      {quote !== undefined && (
        <blockquote
          aria-label="고른 부분"
          className="mb-2 max-h-40 overflow-auto border-l-4 border-github-border pl-3 font-mono text-xs leading-5 text-github-text-secondary whitespace-pre-wrap break-all"
        >
          {quote}
        </blockquote>
      )}

      {hasSuggestion && effectiveMode === 'preview' ? (
        <div className="mb-2 min-h-[60px] rounded-[8px] border border-composer-line bg-composer-field px-3 py-2">
          <CommentBodyRenderer
            body={body}
            originalCode={selectedCode}
            filename={filename}
            syntaxTheme={syntaxTheme}
          />
        </div>
      ) : (
        <SkillTextarea
          className="min-h-[60px] resize-y rounded-[8px] border border-composer-line px-3 py-2 text-sm leading-6 text-composer-text placeholder:text-composer-muted focus:min-h-[80px] focus:border-composer-focus focus:outline-none disabled:opacity-50"
          value={body}
          onValueChange={setBody}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={Math.max(3, body.split('\n').length)}
          autoFocus
          disabled={isSubmitting}
        />
      )}

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          data-comment-cancel="true"
          onClick={onCancel}
          className="rounded border border-transparent bg-transparent px-3 py-1.5 text-xs text-composer-muted transition-colors hover:text-composer-text disabled:opacity-50"
          disabled={isSubmitting}
        >
          취소
        </button>
        <button
          type="submit"
          className="rounded border border-github-accent bg-github-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={!body.trim() || isSubmitting}
        >
          {isSubmitting ? '보내는 중…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
