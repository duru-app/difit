import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type LoadCommitMessage = (sha: string) => Promise<string | null>;

const HOVER_DELAY_MS = 350;
const LEAVE_GRACE_MS = 200;
const CARD_GAP_PX = 8;
const CARD_WIDTH_PX = 520;
const CARD_MAX_HEIGHT_PX = 400;

const bodyOf = (message: string) => {
  const subjectEnd = /\n[ \t]*\n/.exec(message);
  return subjectEnd ? message.slice(subjectEnd.index + subjectEnd[0].length).trim() : '';
};

export function useCachedMessageLoader(load: LoadCommitMessage | undefined) {
  return useMemo(() => {
    if (!load) return undefined;
    const cache = new Map<string, Promise<string | null>>();
    return (sha: string) => {
      const cached = cache.get(sha);
      if (cached) return cached;
      const pending = load(sha).then((message) => {
        if (message === null) cache.delete(sha);
        return message;
      });
      cache.set(sha, pending);
      return pending;
    };
  }, [load]);
}

export function CommitMessageBody({
  sha,
  load,
  amendedMessage,
  className = '',
}: {
  sha: string;
  load: LoadCommitMessage;
  amendedMessage?: string | undefined;
  className?: string;
}) {
  const [message, setMessage] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (amendedMessage !== undefined) return;
    let live = true;
    setMessage(undefined);
    void load(sha).then((loaded) => {
      if (live) setMessage(loaded);
    });
    return () => {
      live = false;
    };
  }, [sha, load, amendedMessage]);

  const textClass = `whitespace-pre-wrap break-words text-sm text-github-text-primary select-text [-webkit-touch-callout:default] ${className}`;
  if (amendedMessage !== undefined) {
    return (
      <div className={textClass}>
        <div className="mb-1 text-xs font-medium text-github-accent">바뀔 메시지</div>
        {amendedMessage}
      </div>
    );
  }
  const body = message == null ? message : bodyOf(message);
  return (
    <div className={textClass}>
      {body === undefined ? (
        <span className="text-github-text-muted">불러오는 중…</span>
      ) : body === null ? (
        <span className="text-github-text-muted">메시지를 읽지 못했습니다.</span>
      ) : body === '' ? (
        <span className="text-github-text-muted">본문 없음</span>
      ) : (
        body
      )}
    </div>
  );
}

interface HoveredCommit {
  sha: string;
  shortSha: string;
  subject: string;
}

interface CardPlace extends HoveredCommit {
  top: number;
  left: number;
}

export function useCommitHoverCard() {
  const [place, setPlace] = useState<CardPlace | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    showTimer.current = null;
    hideTimer.current = null;
  };
  useEffect(() => clearTimers, []);

  const enter = (commit: HoveredCommit, row: HTMLElement) => {
    clearTimers();
    showTimer.current = setTimeout(
      () => {
        const rowRect = row.getBoundingClientRect();
        const listRect = row.closest('section')?.getBoundingClientRect() ?? rowRect;
        setPlace({ ...commit, top: rowRect.top, left: listRect.right + CARD_GAP_PX });
      },
      place ? 0 : HOVER_DELAY_MS,
    );
  };
  const leave = () => {
    clearTimers();
    hideTimer.current = setTimeout(() => setPlace(null), LEAVE_GRACE_MS);
  };
  const hide = () => {
    clearTimers();
    setPlace(null);
  };
  return { place, enter, leave, keep: clearTimers, hide };
}

export function CommitHoverCard({
  id,
  place,
  load,
  amendedMessage,
  onKeep,
  onLeave,
}: {
  id: string;
  place: CardPlace;
  load: LoadCommitMessage;
  amendedMessage: string | undefined;
  onKeep: () => void;
  onLeave: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const measure = () => setHeight(card.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);
  const top = Math.max(
    CARD_GAP_PX,
    Math.min(place.top - 12, window.innerHeight - height - CARD_GAP_PX),
  );
  const width = Math.min(CARD_WIDTH_PX, window.innerWidth - place.left - 2 * CARD_GAP_PX);
  return createPortal(
    <div
      ref={cardRef}
      id={id}
      role="tooltip"
      onMouseEnter={onKeep}
      onMouseLeave={onLeave}
      style={{ top, left: place.left, width, maxHeight: CARD_MAX_HEIGHT_PX }}
      className="fixed z-50 overflow-y-auto rounded-md border border-github-border bg-github-bg-secondary shadow-2xl"
    >
      <div className="sticky top-0 flex items-baseline gap-2 border-b border-github-border bg-github-bg-secondary px-4 py-2">
        <code className="shrink-0 font-mono text-xs text-github-accent">{place.shortSha}</code>
        <span className="text-sm font-medium text-github-text-primary select-text">
          {place.subject}
        </span>
      </div>
      <CommitMessageBody
        sha={place.sha}
        load={load}
        amendedMessage={amendedMessage}
        className="px-4 py-3 leading-relaxed"
      />
    </div>,
    document.body,
  );
}
