import React, { useEffect, useState } from 'react';

import type { RewordRequest, RewriteConflict, RewriteWarning } from '../../types/diff';
import { withoutThreadTrailers } from '../../utils/commitMessage';
import type { DirectEditFailure } from '../contexts/FixupOverlayContext';
import { rewordFailureMessage, rewordHandoffBody } from '../utils/directEdit';

export interface RewordFailure extends DirectEditFailure {
  // Saving again with these acknowledged goes ahead.
  warnings?: RewriteWarning[];
  conflict?: RewriteConflict;
}

export const CONFLICT_ACTION_CLASS =
  'rounded border border-github-danger bg-github-danger/20 px-3 py-1 text-xs font-medium text-github-text-primary transition-all hover:opacity-80';

export function ConflictDetails({ conflict }: { conflict: RewriteConflict }) {
  return (
    <>
      {conflict.commit && (
        <p className="mt-1">
          충돌한 커밋: <span className="font-mono">{conflict.commit.sha.slice(0, 7)}</span>{' '}
          {conflict.commit.subject}
        </p>
      )}
      {!conflict.agentAttached && <p className="mt-1">연결된 에이전트가 없어 맡길 수 없습니다.</p>}
    </>
  );
}

export interface RewordControls {
  // The message the review shows for the commit; null when it could not be read.
  load: (sha: string) => Promise<string | null>;
  save: (request: RewordRequest) => Promise<RewordFailure | null>;
}

interface CommitMessageFormProps {
  sha: string;
  controls: RewordControls;
  onClose: () => void;
  onHandOff?: ((sha: string, body: string) => Promise<void>) | undefined;
}

export function CommitMessageForm({ sha, controls, onClose, onHandOff }: CommitMessageFormProps) {
  const [original, setOriginal] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [text, setText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [failure, setFailure] = useState<RewordFailure | null>(null);
  const cleaned = withoutThreadTrailers(text);
  const unchanged = original === null || cleaned === withoutThreadTrailers(original);
  const blank = cleaned === '';
  const blankHint = !unchanged && blank ? rewordFailureMessage('empty-message', '') : '';
  const conflict = failure?.conflict;

  const { load } = controls;
  useEffect(() => {
    let cancelled = false;
    setOriginal(null);
    setLoadFailed(false);
    void load(sha).then((message) => {
      if (cancelled) return;
      if (message === null) {
        setLoadFailed(true);
        return;
      }
      setOriginal(message);
      setText(message);
    });
    return () => {
      cancelled = true;
    };
  }, [load, sha]);

  const save = async (acknowledged?: RewriteWarning[]) => {
    if (original === null || unchanged || blank || isSaving) return;
    setIsSaving(true);
    setFailure(null);
    const result = await controls.save({
      commit: sha,
      original,
      message: text,
      ...(acknowledged ? { acknowledged } : {}),
    });
    setIsSaving(false);
    if (result) {
      setFailure(result);
      return;
    }
    onClose();
  };

  const handOff = async (stopped: RewriteConflict) => {
    await onHandOff?.(sha, rewordHandoffBody(cleaned, stopped));
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void save();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <form
      className="mx-3 my-1 rounded-md border border-github-border border-l-4 border-l-github-accent bg-github-bg-tertiary p-2 select-text"
      onSubmit={handleSubmit}
      aria-label="커밋 메시지 고치기"
    >
      {original !== null ? (
        <textarea
          aria-label="커밋 메시지"
          className="mb-2 w-full resize-y rounded border border-github-border bg-github-bg-secondary px-2 py-1.5 font-mono text-xs leading-5 text-github-text-primary focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/30 disabled:opacity-50"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setFailure(null);
          }}
          onKeyDown={handleKeyDown}
          rows={Math.min(12, Math.max(3, text.split('\n').length))}
          spellCheck={false}
          autoFocus
          disabled={isSaving}
        />
      ) : loadFailed ? (
        <p
          role="alert"
          className="mb-2 rounded border border-github-danger bg-github-danger/10 px-2 py-1.5 text-xs text-github-text-primary"
        >
          이 커밋의 메시지를 읽지 못했습니다.
        </p>
      ) : (
        <p className="mb-2 text-xs text-github-text-secondary">메시지를 읽는 중…</p>
      )}

      {failure && (
        <div
          role="alert"
          className="mb-2 rounded border border-github-danger bg-github-danger/10 px-2 py-1.5 text-xs text-github-text-primary"
        >
          <p>{failure.message}</p>
          {failure.output && (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-github-text-secondary">
              {failure.output}
            </pre>
          )}
          {conflict && <ConflictDetails conflict={conflict} />}
          {failure.warnings && (
            <button
              type="button"
              onClick={() => void save(failure.warnings)}
              className={`mt-1 ${CONFLICT_ACTION_CLASS}`}
            >
              그래도 저장
            </button>
          )}
          {conflict?.agentAttached && onHandOff && (
            <button
              type="button"
              onClick={() => void handOff(conflict)}
              className={`mt-1 ${CONFLICT_ACTION_CLASS}`}
            >
              에이전트에게 맡기기
            </button>
          )}
        </div>
      )}

      <p role="status" className={`text-xs text-github-danger ${blankHint ? 'mb-2' : ''}`}>
        {blankHint}
      </p>

      <p className="mb-2 text-xs text-github-text-secondary">
        저장하면 이 커밋의 메시지가 바로 바뀌고, 이 커밋과 뒤 커밋의 SHA가 달라집니다.
      </p>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-github-border bg-github-bg-tertiary px-3 py-1 text-xs text-github-text-primary transition-all hover:opacity-80 disabled:opacity-50"
          disabled={isSaving}
        >
          취소
        </button>
        <button
          type="submit"
          className="rounded border border-github-accent bg-github-accent/20 px-3 py-1 text-xs font-medium text-github-text-primary transition-all disabled:opacity-50"
          disabled={unchanged || blank || isSaving}
        >
          {isSaving ? '저장하는 중…' : '저장'}
        </button>
      </div>
    </form>
  );
}
