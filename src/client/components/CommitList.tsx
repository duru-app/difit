import { Check, ChevronDown, ChevronRight, Copy, MessageSquarePlus, Pencil, X } from 'lucide-react';
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent,
} from 'react';

import type { ReviewCommit, ReviewScope, ReviewView, ReviewViewAction } from '../../types/diff';
import type { FollowedTerminalRewrite } from '../../types/watch';
import { layoutCommitGraph } from '../../utils/commitGraph';
import { isSameCommit, selectReviewView } from '../../utils/diffSelection';
import { useCopyCommitHash } from '../hooks/useCopyCommitHash';
import { useGuardedReword } from '../hooks/useGuardedReword';
import { terminalRewriteNotice } from '../utils/directEdit';

import { CommentCount } from './CommentCount';
import { CommentForm } from './CommentForm';
import { CommitGraph } from './CommitGraph';
import {
  CommitHoverCard,
  type LoadCommitMessage,
  useCachedMessageLoader,
  useCommitHoverCard,
} from './CommitMessageBody';
import { CommitMessageForm, type RewordControls } from './CommitMessageForm';
import {
  ReorderDropLine,
  ReorderHandle,
  ReorderNotice,
  reorderHandoff,
  type SaveOrder,
  useCommitReorder,
} from './CommitReorder';
import { MovedBranchesNotice } from './MovedBranchesNotice';
import { NoticeBar } from './NoticeBar';

interface CommitListProps {
  review: Pick<ReviewScope, 'requested' | 'commits'>;
  shown: ReviewView;
  onSelect: (action: ReviewViewAction) => void;
  rangeStart?: string | undefined;
  inDrawer?: boolean;
  onClose?: (() => void) | undefined;
  openCounts?: ReadonlyMap<string, number> | undefined;
  // Keyed by commit sha: the whole message an amend! will leave on that commit.
  amendedMessages?: ReadonlyMap<string, string> | undefined;
  reword?: RewordControls | undefined;
  onReorder?: SaveOrder | undefined;
  onAddCommitComment?: ((sha: string, body: string) => Promise<void>) | undefined;
  height?: number | null | undefined;
  onResize?: ((height: number) => void) | undefined;
  loadMessage?: LoadCommitMessage | undefined;
  terminalRewrite?: FollowedTerminalRewrite | null | undefined;
  onDismissTerminalRewrite?: (() => void) | undefined;
}

interface Drag {
  fromSha: string;
  overSha: string | null;
}

interface Press {
  sha: string;
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const LONG_PRESS_MS = 500;
const TAP_SLOP_PX = 10;
const DEFAULT_MAX_HEIGHT = '40%';
const MIN_HEIGHT_PX = 80;
// Room kept for the file list and the sidebar footer below it.
const FILES_ROOM_PX = 160;

const ITEM_CLASS =
  'w-full flex items-center gap-2 px-4 text-left text-sm hover:bg-github-bg-tertiary transition-colors';
const CURRENT_CLASS = 'bg-github-bg-tertiary text-github-text-primary font-medium';
const CURRENT_COMMIT_CLASS = `${CURRENT_CLASS} shadow-[inset_2px_0_0_var(--color-github-accent)]`;
const PREVIEW_CLASS = 'outline-1 outline-dashed -outline-offset-1 outline-github-text-secondary';
const ROW_ACTIONS_HIDDEN_CLASS =
  'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-has-[:focus-visible]:opacity-100 group-has-[:focus-visible]:pointer-events-auto';
const ROW_ACTIONS_OFF_ON_TOUCH_CLASS = '[@media(hover:none)]:hidden';
const HANDLE_ON_TOUCH_CLASS =
  '[@media(hover:none)]:static [@media(hover:none)]:w-8 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto';
const MERGED_CLASS = 'flex items-center gap-2 px-4 text-sm text-github-text-muted';
const CURRENT_MERGED_CLASS =
  'bg-github-bg-tertiary text-github-text-secondary shadow-[inset_2px_0_0_var(--color-github-accent)]';

const commitUnder = (x: number, y: number) =>
  document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-commit-sha]')?.dataset.commitSha ??
  null;

const AMEND_BADGE_CLASS =
  'inline-flex h-4 shrink-0 items-center rounded-full border border-github-accent px-1.5 text-[10px] font-medium text-github-accent';

const AMENDED_SUBJECT_CLIPPED_ON_TOUCH_CLASS = '[@media(hover:none)]:overflow-hidden';

// Like git's %s: the first paragraph with its lines joined by spaces.
const subjectOf = (message: string) =>
  (message.split(/\n[ \t]*\n/, 1)[0] ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join(' ');

function AmendedSubject({ subject, message }: { subject: string; message: string }) {
  const amendedSubject = subjectOf(message);
  if (amendedSubject === subject) {
    return (
      <span
        className={`min-w-0 flex items-center gap-1.5 ${AMENDED_SUBJECT_CLIPPED_ON_TOUCH_CLASS}`}
      >
        <span className="min-w-0 truncate">{subject}</span>
        <span className={AMEND_BADGE_CLASS}>본문 변경됨</span>
      </span>
    );
  }
  return (
    <span className={`min-w-0 flex flex-col ${AMENDED_SUBJECT_CLIPPED_ON_TOUCH_CLASS}`}>
      <del className="min-w-0 truncate text-github-text-muted">{subject}</del>
      <span className="min-w-0 flex items-center gap-1.5">
        <span className={AMEND_BADGE_CLASS}>바뀔 메시지</span>
        <span className="min-w-0 truncate text-github-text-primary">{amendedSubject}</span>
      </span>
    </span>
  );
}

export function ShownCommits({
  commits,
  shown,
}: {
  commits: readonly ReviewCommit[];
  shown: ReviewView;
}) {
  const find = (sha: string) => commits.find((commit) => isSameCommit(commit.sha, sha));
  if (shown.kind === 'commit') {
    const single = find(shown.sha);
    if (single) {
      return (
        <>
          <code className="font-mono">{single.shortSha}</code> {single.subject}
        </>
      );
    }
  }
  if (shown.kind === 'range') {
    const first = find(shown.startSha);
    const last = find(shown.endSha);
    if (first && last) {
      return (
        <>
          <code className="font-mono" title={`${first.subject} ~ ${last.subject}`}>
            {first.shortSha}~{last.shortSha}
          </code>{' '}
          ({commits.indexOf(last) - commits.indexOf(first) + 1}개)
        </>
      );
    }
  }
  return '전체';
}

export function CommitList({
  review,
  shown,
  onSelect,
  rangeStart,
  inDrawer = false,
  onClose,
  openCounts,
  amendedMessages,
  reword,
  onReorder,
  onAddCommitComment,
  height,
  onResize,
  loadMessage,
  terminalRewrite,
  onDismissTerminalRewrite,
}: CommitListProps) {
  const { commits } = review;
  const isOnlyCommit = commits.length === 1;
  const cardId = useId();
  const loadCardMessage = useCachedMessageLoader(inDrawer ? undefined : loadMessage);
  const hoverCard = useCommitHoverCard();
  const [isOpen, setIsOpen] = useState(true);
  const [rewording, setRewording] = useState<string | null>(null);
  const [commenting, setCommenting] = useState<string | null>(null);
  const {
    reword: guardedReword,
    isSaving: isSavingMessage,
    movedBranches,
    dismissMovedBranches,
  } = useGuardedReword(reword);
  const [drag, setDrag] = useState<Drag | null>(null);
  const isDragging = drag !== null;
  const listRef = useRef<HTMLUListElement>(null);
  const shas = useMemo(() => commits.map(({ sha }) => sha), [commits]);
  const reorder = useCommitReorder(shas, listRef, onReorder);
  const canMove =
    onReorder !== undefined && !isSavingMessage && !reorder.isSaving && rangeStart === undefined;
  const hasOpenForm = rewording !== null || commenting !== null;
  const sectionRef = useRef<HTMLElement>(null);
  const pressRef = useRef<Press | null>(null);
  const { copiedSha, copyHash } = useCopyCommitHash();
  const copyButtonOf = (sha: string, placement = '') => {
    const isCopied = copiedSha === sha;
    const label = isCopied ? '복사됨' : '해시 복사';
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => void copyHash(sha)}
        className={`shrink-0 self-stretch px-2 ${placement} text-github-text-muted hover:text-github-text-primary hover:bg-github-bg-primary`}
      >
        {isCopied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    );
  };

  useEffect(() => {
    if (!isDragging) return;
    const cancel = () => setDrag(null);
    window.addEventListener('mouseup', cancel);
    return () => window.removeEventListener('mouseup', cancel);
  }, [isDragging]);

  const isListShown = inDrawer || isOpen;
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onTouchMove = (event: globalThis.TouchEvent) => {
      const press = pressRef.current;
      const touch = event.touches[0];
      if (!press || !touch) return;
      if (press.timer !== null) {
        if (Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > TAP_SLOP_PX) {
          clearTimeout(press.timer);
          pressRef.current = null;
        }
        return;
      }
      event.preventDefault();
      const overSha = commitUnder(touch.clientX, touch.clientY);
      setDrag((current) => current && { ...current, overSha });
    };
    list.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => list.removeEventListener('touchmove', onTouchMove);
  }, [isListShown]);

  useEffect(
    () => () => {
      const timer = pressRef.current?.timer;
      if (timer != null) clearTimeout(timer);
    },
    [],
  );

  const startPress = (sha: string, event: TouchEvent) => {
    if (isOnlyCommit) return;
    const touch = event.touches[0];
    const previous = pressRef.current?.timer;
    if (previous != null) clearTimeout(previous);
    if (!touch || event.touches.length > 1) {
      pressRef.current = null;
      return;
    }
    const press: Press = {
      sha,
      x: touch.clientX,
      y: touch.clientY,
      timer: null,
    };
    press.timer = setTimeout(() => {
      press.timer = null;
      setDrag({ fromSha: sha, overSha: null });
      onSelect({ kind: 'long-press', sha });
    }, LONG_PRESS_MS);
    pressRef.current = press;
  };
  const endPress = (event: TouchEvent) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press) return;
    if (press.timer !== null) {
      clearTimeout(press.timer);
      return;
    }
    event.preventDefault();
    setDrag(null);
    const touch = event.changedTouches[0];
    const toSha = touch ? commitUnder(touch.clientX, touch.clientY) : null;
    if (toSha && toSha !== press.sha) onSelect({ kind: 'drop', fromSha: press.sha, toSha });
  };
  const startResize = (event: ReactMouseEvent) => {
    const section = sectionRef.current;
    if (!onResize || !section) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = section.getBoundingClientRect().height;
    const list = listRef.current;
    const content = list ? startHeight - list.clientHeight + list.scrollHeight : startHeight;
    const room = Math.min(content, (section.parentElement?.clientHeight ?? 0) - FILES_ROOM_PX);
    let shownHeight = startHeight;
    const onMove = (move: MouseEvent) => {
      const next = Math.max(MIN_HEIGHT_PX, Math.min(room, startHeight + startY - move.clientY));
      if (next === shownHeight) return;
      shownHeight = next;
      onResize(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  const cancelPress = () => {
    const timer = pressRef.current?.timer;
    if (timer != null) clearTimeout(timer);
    pressRef.current = null;
    setDrag(null);
  };

  const indexOf = (sha: string) => commits.findIndex((commit) => isSameCommit(commit.sha, sha));
  const spanOf = (view: ReviewView): [number, number] =>
    view.kind === 'all'
      ? [0, commits.length - 1]
      : view.kind === 'commit'
        ? [indexOf(view.sha), indexOf(view.sha)]
        : [indexOf(view.startSha), indexOf(view.endSha)];
  const [shownStart, shownEnd] = shown.kind === 'all' ? [-1, -2] : spanOf(shown);
  const preview =
    drag?.overSha != null
      ? selectReviewView(
          review,
          { view: shown, anchor: null },
          { kind: 'drop', fromSha: drag.fromSha, toSha: drag.overSha },
        )
      : null;
  const [previewStart, previewEnd] = preview
    ? spanOf(preview.view)
    : rangeStart !== undefined
      ? spanOf({ kind: 'commit', sha: rangeStart })
      : [-1, -2];
  const rowPadding = inDrawer ? 'py-3' : 'py-1.5';
  const graphBleed = inDrawer ? '-my-3' : '-my-1.5';
  const itemClass = `${ITEM_CLASS} ${rowPadding}`;
  const graph = layoutCommitGraph(commits);
  const openCountOf = (sha: string) => {
    const count = openCounts?.get(sha) ?? 0;
    return count > 0 && <CommentCount count={count} title={`열린 지적 ${count}개`} />;
  };
  const title = (
    <>
      <span className="shrink-0 font-semibold text-github-text-primary">
        커밋 {commits.length}개
      </span>
      {!isOnlyCommit && (
        <span className="min-w-0 truncate text-github-text-secondary">
          <ShownCommits commits={commits} shown={shown} />
        </span>
      )}
    </>
  );

  const isResizable = !inDrawer && isListShown && onResize !== undefined;
  const closeButton = inDrawer && onClose && (
    <button
      type="button"
      onClick={onClose}
      className="ml-auto shrink-0 rounded p-2 text-github-text-secondary transition-colors hover:bg-github-bg-primary hover:text-github-text-primary"
      aria-label="커밋 서랍 닫기"
      title="닫기"
    >
      <X size={16} />
    </button>
  );

  return (
    <section
      ref={sectionRef}
      className={`min-h-0 flex flex-col ${
        inDrawer ? 'flex-1' : `shrink-0 ${isResizable ? '' : 'border-t border-github-border'}`
      }`}
      style={
        inDrawer
          ? undefined
          : {
              maxHeight:
                height != null
                  ? `min(${height}px, calc(100% - ${FILES_ROOM_PX}px))`
                  : DEFAULT_MAX_HEIGHT,
            }
      }
      aria-label="리뷰 범위의 커밋"
    >
      {isResizable && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="커밋 목록 높이 조절"
          onMouseDown={startResize}
          className="shrink-0 h-1 bg-github-border hover:bg-github-text-muted cursor-row-resize"
          title="Drag to resize commit list"
        />
      )}
      {rangeStart !== undefined ? (
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 text-sm bg-github-bg-tertiary">
          <span role="status" className="min-w-0 flex-1 truncate text-github-text-primary">
            범위 고르는 중
          </span>
          <button
            type="button"
            onClick={() => onSelect({ kind: 'cancel' })}
            className="shrink-0 px-2 py-0.5 text-sm text-github-text-secondary border border-github-border rounded hover:text-github-text-primary hover:bg-github-bg-primary transition-colors"
          >
            취소
          </button>
          {closeButton}
        </div>
      ) : inDrawer ? (
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 text-sm bg-github-bg-tertiary">
          {title}
          {closeButton}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          aria-expanded={isOpen}
          className="w-full flex items-center gap-2 px-4 py-2 text-sm bg-github-bg-tertiary hover:bg-github-bg-primary transition-colors"
        >
          {isOpen ? (
            <ChevronDown size={16} className="shrink-0 text-github-text-secondary" />
          ) : (
            <ChevronRight size={16} className="shrink-0 text-github-text-secondary" />
          )}
          {title}
        </button>
      )}
      {loadCardMessage && hoverCard.place && (
        <CommitHoverCard
          id={cardId}
          place={hoverCard.place}
          load={loadCardMessage}
          amendedMessage={amendedMessages?.get(hoverCard.place.sha)}
          onKeep={hoverCard.keep}
          onLeave={hoverCard.leave}
        />
      )}
      {terminalRewrite && onDismissTerminalRewrite && (
        <NoticeBar
          text={terminalRewriteNotice(terminalRewrite)}
          onDismiss={onDismissTerminalRewrite}
        />
      )}
      <MovedBranchesNotice branches={movedBranches} onDismiss={dismissMovedBranches} />
      <MovedBranchesNotice
        branches={reorder.saved?.movedBranches ?? []}
        left={reorder.saved?.leftBranches ?? []}
        onDismiss={reorder.dismissSaved}
      />
      {isListShown && (
        <ReorderNotice
          isSaving={reorder.isSaving}
          refused={reorder.refused}
          shownReview={review.requested}
          onShowThread={reword?.showBlockingThread}
          onRetry={reorder.retry}
          onDismiss={reorder.dismiss}
          onHandOff={
            onAddCommitComment &&
            (({ order }, conflict) => {
              const handoff = reorderHandoff(commits, order, conflict);
              if (!handoff) return;
              void onAddCommitComment(handoff.sha, handoff.body).then(reorder.dismiss);
            })
          }
        />
      )}
      {isListShown && (
        <ul
          ref={listRef}
          onContextMenu={(event) => event.preventDefault()}
          className={`flex-1 min-h-0 overflow-y-auto py-1 m-0 list-none p-0 select-none [-webkit-touch-callout:none]`}
        >
          {!isOnlyCommit && (
            <li>
              <button
                type="button"
                onClick={() => onSelect({ kind: 'all' })}
                aria-current={shown.kind === 'all' ? true : undefined}
                className={`${itemClass} ${shown.kind === 'all' ? CURRENT_CLASS : 'text-github-text-secondary'}`}
              >
                <span className="w-[32px] shrink-0" />
                전체
              </button>
            </li>
          )}
          {graph.map(({ commit, cell, merged }, index) => {
            const isCurrent = isOnlyCommit || (index >= shownStart && index <= shownEnd);
            const isPreviewed = index >= previewStart && index <= previewEnd;
            const amendedMessage = amendedMessages?.get(commit.sha);
            const isActionPinned =
              rewording === commit.sha || commenting === commit.sha || copiedSha === commit.sha;
            const openCount = openCounts?.get(commit.sha) ?? 0;
            const hoverButtons = (
              <>
                {copyButtonOf(commit.sha)}
                {guardedReword && !commit.isMerge && (
                  <button
                    type="button"
                    aria-label="메시지 고치기"
                    title="메시지 고치기"
                    aria-expanded={rewording === commit.sha}
                    disabled={isSavingMessage || reorder.isSaving}
                    onClick={() =>
                      setRewording((current) => (current === commit.sha ? null : commit.sha))
                    }
                    className="shrink-0 px-2 text-github-text-muted hover:text-github-text-primary hover:bg-github-bg-primary disabled:pointer-events-none disabled:opacity-50"
                  >
                    <Pencil size={12} />
                  </button>
                )}
              </>
            );
            const commentButton = onAddCommitComment && (
              <button
                type="button"
                aria-label="커밋에 지적 달기"
                title={
                  openCount > 0
                    ? `열린 지적 ${openCount}개 · 이 커밋 전체에 지적 달기`
                    : '이 커밋 전체에 지적 달기'
                }
                aria-expanded={commenting === commit.sha}
                onClick={() =>
                  setCommenting((current) => (current === commit.sha ? null : commit.sha))
                }
                className={`shrink-0 flex items-center gap-1 px-2 hover:bg-github-bg-primary ${openCount > 0 ? 'text-sm font-medium text-github-warning fixup-review:text-github-text-secondary' : 'text-github-text-muted hover:text-github-text-primary'}`}
              >
                <MessageSquarePlus size={openCount > 0 ? 14 : 12} />
                {openCount > 0 && openCount}
              </button>
            );
            const hoverClass = `bg-github-bg-tertiary ${isActionPinned ? '' : ROW_ACTIONS_HIDDEN_CLASS}`;
            // With an open count the comment button stays in line, so the subject stops before
            // it and the other buttons open over the subject to its left.
            const rowActions = inDrawer ? (
              <div className={`contents ${ROW_ACTIONS_OFF_ON_TOUCH_CLASS}`}>
                {hoverButtons}
                {commentButton}
              </div>
            ) : openCount > 0 && commentButton ? (
              <div
                className={`relative flex shrink-0 items-stretch ${ROW_ACTIONS_OFF_ON_TOUCH_CLASS}`}
              >
                <div className={`absolute inset-y-0 right-full flex items-stretch ${hoverClass}`}>
                  {hoverButtons}
                </div>
                {commentButton}
              </div>
            ) : (
              <div
                className={`absolute inset-y-0 right-0 flex items-stretch ${hoverClass} ${ROW_ACTIONS_OFF_ON_TOUCH_CLASS}`}
              >
                {hoverButtons}
                {commentButton}
              </div>
            );
            return (
              <Fragment key={commit.sha}>
                {reorder.shownAt === index && <ReorderDropLine />}
                {merged.map((entry) => (
                  <li
                    key={entry.kind === 'commit' ? entry.commit.sha : `${commit.sha}:omitted`}
                    data-reorder-at={index}
                    data-reorder-side=""
                    aria-current={isCurrent ? true : undefined}
                    title={entry.kind === 'commit' ? entry.commit.subject : undefined}
                    className={`group ${MERGED_CLASS} ${rowPadding} ${isCurrent ? CURRENT_MERGED_CLASS : ''}`}
                  >
                    <CommitGraph cell={entry.cell} bleed={graphBleed} />
                    {entry.kind === 'commit' ? (
                      <>
                        <code className="shrink-0 font-mono text-xs">{entry.commit.shortSha}</code>
                        <span className="min-w-0 truncate">{entry.commit.subject}</span>
                        {openCountOf(entry.commit.sha)}
                        {copyButtonOf(
                          entry.commit.sha,
                          `ml-auto -mr-4 ${graphBleed} focus:opacity-100 ${inDrawer || copiedSha === entry.commit.sha ? '' : 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100'}`,
                        )}
                      </>
                    ) : (
                      <span>커밋 {entry.count}개 더</span>
                    )}
                  </li>
                ))}
                <li
                  data-reorder-at={index}
                  className={`group ${reorder.movingSha === commit.sha ? 'opacity-50' : ''}`}
                >
                  <div
                    className="relative flex items-stretch"
                    onMouseEnter={(event) => {
                      if (loadCardMessage && reorder.movingSha === null) {
                        hoverCard.enter(commit, event.currentTarget);
                      }
                    }}
                    onMouseLeave={loadCardMessage && hoverCard.leave}
                  >
                    {onReorder && commits.length > 1 && (
                      <ReorderHandle
                        disabled={!canMove || hasOpenForm}
                        placement={
                          inDrawer
                            ? 'w-8'
                            : `absolute inset-y-0 left-0 w-4 ${reorder.movingSha === commit.sha ? '' : ROW_ACTIONS_HIDDEN_CLASS} ${HANDLE_ON_TOUCH_CLASS}`
                        }
                        onStart={() => {
                          hoverCard.hide();
                          reorder.startMoving(commit.sha);
                        }}
                      />
                    )}
                    <button
                      type="button"
                      data-commit-sha={commit.sha}
                      onMouseDown={(event) => {
                        if (event.button === 0 && !event.shiftKey) {
                          setDrag({ fromSha: commit.sha, overSha: null });
                        }
                      }}
                      onMouseEnter={() => {
                        setDrag((current) => current && { ...current, overSha: commit.sha });
                      }}
                      onFocus={(event) => {
                        if (loadCardMessage) hoverCard.enter(commit, event.currentTarget);
                      }}
                      onBlur={loadCardMessage && hoverCard.leave}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape' && hoverCard.place) hoverCard.hide();
                      }}
                      onMouseUp={() => {
                        if (drag && drag.fromSha !== commit.sha) {
                          onSelect({
                            kind: 'drop',
                            fromSha: drag.fromSha,
                            toSha: commit.sha,
                          });
                        }
                        setDrag(null);
                      }}
                      onTouchStart={(event) => startPress(commit.sha, event)}
                      onTouchEnd={endPress}
                      onTouchCancel={cancelPress}
                      onClick={(event) => {
                        if (isOnlyCommit) return;
                        onSelect({
                          kind: event.shiftKey ? 'shift-click' : 'click',
                          sha: commit.sha,
                        });
                      }}
                      aria-current={isCurrent ? true : undefined}
                      data-drag-preview={isPreviewed ? '' : undefined}
                      title={
                        loadCardMessage
                          ? undefined
                          : amendedMessage === undefined
                            ? commit.subject
                            : `${commit.subject}\n\n바뀔 메시지:\n${amendedMessage}`
                      }
                      aria-describedby={
                        hoverCard.place && isSameCommit(hoverCard.place.sha, commit.sha)
                          ? cardId
                          : undefined
                      }
                      className={`${itemClass} min-w-0 flex-1 group-hover:bg-github-bg-tertiary ${isCurrent ? CURRENT_COMMIT_CLASS : 'text-github-text-secondary'} ${isPreviewed ? PREVIEW_CLASS : ''} ${isActionPinned && !inDrawer ? 'bg-github-bg-tertiary' : ''}`}
                    >
                      <CommitGraph cell={cell} bleed={graphBleed} />
                      <code className="shrink-0 font-mono text-xs">{commit.shortSha}</code>
                      {amendedMessage === undefined ? (
                        <span className="min-w-0 truncate">{commit.subject}</span>
                      ) : (
                        <AmendedSubject subject={commit.subject} message={amendedMessage} />
                      )}
                      <span
                        className={
                          onAddCommitComment ? 'hidden [@media(hover:none)]:contents' : 'contents'
                        }
                      >
                        {openCountOf(commit.sha)}
                      </span>
                    </button>
                    {rowActions}
                  </div>
                  {onAddCommitComment && commenting === commit.sha && (
                    <div
                      onContextMenu={(event) => event.stopPropagation()}
                      className="px-4 py-2 select-text [-webkit-touch-callout:default]"
                    >
                      <CommentForm
                        onSubmit={async (body) => {
                          await onAddCommitComment(commit.sha, body);
                          setCommenting(null);
                        }}
                        onCancel={() => setCommenting(null)}
                      />
                    </div>
                  )}
                  {guardedReword && rewording === commit.sha && (
                    <CommitMessageForm
                      sha={commit.sha}
                      controls={guardedReword}
                      shownReview={review.requested}
                      onClose={() => setRewording(null)}
                      onHandOff={onAddCommitComment}
                    />
                  )}
                </li>
              </Fragment>
            );
          })}
          {reorder.shownAt === commits.length && <ReorderDropLine />}
        </ul>
      )}
    </section>
  );
}
