import { Check, ChevronDown, ChevronRight, Copy, Edit2, MessageSquare, Trash2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import {
  type ChoiceAnswer,
  type AnchorStaleReason,
  type CommentThread,
  type DiffCommentMessage,
  REVIEWER_AUTHOR,
} from '../../types/diff';
import { formatCommentContent } from '../../utils/commentFormatting';
import { locationLabel } from '../../utils/commentPosition';
import { isSameCommit } from '../../utils/diffSelection';
import {
  appearsResolved,
  deriveThreadReviewState,
  reviewStateLabel,
} from '../../utils/reviewDecisions';
import { type ThreadReviewControls, useFixupOverlay } from '../contexts/FixupOverlayContext';
import { usePickedThreadId } from '../contexts/PickedThreadContext';
import { useClickOutside } from '../hooks/useClickOutside';
import { copyTextToClipboard } from '../utils/clipboard';

import { CommentBodyRenderer } from './CommentBodyRenderer';
import { CommentForm } from './CommentForm';
import { ReplyChoices } from './ReplyChoices';
import type { AppearanceSettings } from './SettingsModal';

// Hidden until the message is hovered only where hovering is possible; touch screens keep it shown.
const REVEAL_ON_HOVER =
  '[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100';

interface ThreadMessageItemProps {
  message: DiffCommentMessage;
  showAuthorBadge: boolean;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  filename?: string;
  originalCode?: string;
  onUpdate: (newBody: string) => void;
  onCopy: () => string;
  onDelete?: () => void;
  deleteLabel?: string;
  onClick?: (e: React.MouseEvent) => void;
}

function ThreadMessageItem({
  message,
  showAuthorBadge,
  syntaxTheme,
  filename,
  originalCode,
  onUpdate,
  onCopy,
  onDelete,
  deleteLabel = 'Delete reply',
  onClick,
}: ThreadMessageItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const confirmContainerRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const showAuthorHeader = showAuthorBadge && Boolean(message.author);
  const isUserAuthoredMessage = message.author?.trim() === REVIEWER_AUTHOR;

  useClickOutside(confirmContainerRef, () => setIsConfirming(false), isConfirming);

  useEffect(() => {
    if (!isConfirming) return;

    confirmButtonRef.current?.focus();

    // Capture phase so Escape only cancels the confirmation and never reaches
    // surrounding Escape handlers (e.g. the comments panel handing the keys back).
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setIsConfirming(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isConfirming]);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const handleSaveEdit = (nextBody: string) => {
    if (nextBody !== message.body) {
      onUpdate(nextBody);
    }
    setIsEditing(false);
    return Promise.resolve();
  };

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await copyTextToClipboard(onCopy());
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy comment:', error);
    }
  };

  return (
    <div className={isEditing ? '' : 'group flex min-w-0 items-start gap-3'} onClick={onClick}>
      {!isEditing ? (
        <>
          <div className="min-w-0 flex-1">
            {showAuthorHeader && (
              <div className="mb-2 flex min-w-0 items-center gap-2 pr-2 text-xs text-github-text-secondary">
                <span className="inline-flex items-center rounded-full border border-github-border bg-github-bg-primary px-2 py-0.5 text-[11px] font-medium text-github-text-primary">
                  {message.author}
                </span>
              </div>
            )}

            <CommentBodyRenderer
              body={message.body}
              originalCode={originalCode}
              filename={filename}
              syntaxTheme={syntaxTheme}
            />
          </div>
          {isConfirming ? (
            <div
              ref={confirmContainerRef}
              className="flex shrink-0 items-center gap-1.5 pt-0.5"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="whitespace-nowrap text-xs text-github-text-secondary">Delete?</span>
              <button
                ref={confirmButtonRef}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsConfirming(false);
                  onDelete?.();
                }}
                className="whitespace-nowrap rounded border border-github-border bg-github-bg-tertiary px-2 py-1 text-xs font-medium text-github-danger transition-all hover:bg-github-bg-primary"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsConfirming(false);
                }}
                className="whitespace-nowrap rounded border border-github-border bg-github-bg-tertiary px-2 py-1 text-xs text-github-text-primary transition-all hover:bg-github-bg-primary"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex shrink-0 items-start gap-2 pt-0.5">
              <button
                type="button"
                onClick={handleCopy}
                className={`rounded border border-github-border bg-github-bg-tertiary p-1.5 transition-all hover:bg-github-bg-primary ${
                  isCopied ? 'text-green-700' : `text-github-text-primary ${REVEAL_ON_HOVER}`
                }`}
                title={isCopied ? 'Copied!' : 'Copy comment'}
                aria-label="Copy comment"
              >
                {isCopied ? <Check size={12} /> : <Copy size={12} />}
              </button>
              {isUserAuthoredMessage && message.answer === undefined && (
                <button
                  type="button"
                  onClick={handleStartEdit}
                  className={`rounded border border-github-border bg-github-bg-tertiary p-1.5 text-github-text-primary transition-all hover:bg-github-bg-primary ${REVEAL_ON_HOVER}`}
                  title="Edit message"
                  aria-label="Edit message"
                >
                  <Edit2 size={12} />
                </button>
              )}
              {isUserAuthoredMessage && onDelete && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsConfirming(true);
                  }}
                  className={`rounded border border-github-border bg-github-bg-tertiary p-1.5 text-github-danger transition-all hover:bg-github-bg-primary ${REVEAL_ON_HOVER}`}
                  title={deleteLabel}
                  aria-label={deleteLabel}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <CommentForm
          onSubmit={handleSaveEdit}
          onCancel={handleCancelEdit}
          selectedCode={originalCode}
          syntaxTheme={syntaxTheme}
          filename={filename}
          initialValue={message.body}
          embedded={true}
          title="Edit comment"
          submitLabel="Save"
          placeholder="Edit your message..."
        />
      )}
    </div>
  );
}

const OUTDATED_REASON_TITLE: Record<AnchorStaleReason, string> = {
  missing: '지적한 줄이 지금 파일에 없어 수정을 겹쳐 그리지 않습니다',
  ambiguous: '같은 내용의 줄이 여러 곳이라 자리를 정할 수 없어 수정을 겹쳐 그리지 않습니다',
};

const RESPONDING_DOT_DELAYS_MS = [0, 150, 300];

interface CommentThreadCardProps {
  thread: CommentThread;
  review?: ThreadReviewControls;
  showAuthorBadges?: boolean;
  onResolveThread: (threadId: string) => void;
  onReplyToThread: (threadId: string, body: string, answer?: ChoiceAnswer) => Promise<void>;
  onRemoveMessage: (threadId: string, messageId: string) => void;
  onUpdateMessage: (threadId: string, messageId: string, newBody: string) => void;
  // Absent when this comment cannot be answered by editing the code here.
  onEditDirectly?: () => void;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
}

export function CommentThreadCard({
  thread,
  review,
  showAuthorBadges = false,
  onResolveThread,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
  onEditDirectly,
  syntaxTheme,
}: CommentThreadCardProps) {
  const [isReplying, setIsReplying] = useState(false);
  const { decisions, fixupsByThread, recordDecision } = useFixupOverlay();
  const isResolved = appearsResolved(thread.id, fixupsByThread.get(thread.id) ?? [], decisions);
  const isFolded = decisions.some(
    (decision) => decision.threadId === thread.id && decision.kind === 'folded',
  );
  const isPicked = usePickedThreadId() === thread.id;
  const [isCollapsed, setIsCollapsed] = useState(isResolved && !isPicked);
  const [wasResolved, setWasResolved] = useState(isResolved);
  if (wasResolved !== isResolved && !(isResolved && isReplying)) {
    setWasResolved(isResolved);
    setIsCollapsed(isResolved);
  }
  const [wasPicked, setWasPicked] = useState(isPicked);
  if (wasPicked !== isPicked) {
    setWasPicked(isPicked);
    if (isPicked) setIsCollapsed(false);
  }

  const toggleCollapsed = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsCollapsed((prev) => !prev);
  };

  const toggleResolved = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isResolved) recordDecision(thread.id, 'unresolved', '');
    else onResolveThread(thread.id);
  };

  const reviewState = review?.state ?? deriveThreadReviewState(thread.id, [], [], thread);

  const messageText = (message: DiffCommentMessage) =>
    formatCommentContent(message.body, thread.codeContent);

  const anchorCommit =
    review &&
    thread.isOutdated &&
    thread.anchorCommit &&
    !thread.madeView &&
    !(review.targetCommit && isSameCommit(thread.anchorCommit, review.targetCommit))
      ? thread.anchorCommit
      : null;
  const madeView = thread.isOutdated ? thread.madeView : undefined;

  const rootMessage = thread.messages[0];
  if (!rootMessage) return null;

  return (
    <div
      id={`comment-thread-${thread.id}`}
      data-picked={isPicked ? 'true' : undefined}
      className={`rounded-md border border-l-4 bg-github-bg-tertiary p-3 shadow-sm transition-all ${
        isPicked ? 'ring-2 ring-blue-500' : ''
      } ${
        review
          ? thread.isOutdated
            ? 'border-github-border border-l-github-danger'
            : 'border-github-border border-l-github-text-muted'
          : 'border-yellow-600/50 border-l-yellow-400 fixup-review:border-github-border fixup-review:border-l-github-text-muted'
      }`}
    >
      <div className={`flex items-center justify-between gap-3 ${isCollapsed ? '' : 'mb-3'}`}>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-github-text-secondary">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? 'Expand thread' : 'Collapse thread'}
            title={isCollapsed ? 'Expand thread' : 'Collapse thread'}
            className="shrink-0 rounded p-0.5 text-github-text-secondary transition-colors hover:bg-github-bg-primary hover:text-github-text-primary"
          >
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <span
            className="font-mono px-1 py-0.5 rounded overflow-hidden text-ellipsis whitespace-nowrap"
            style={{
              backgroundColor: 'var(--color-yellow-path-bg)',
              color: 'var(--color-yellow-path-text)',
            }}
          >
            {locationLabel(thread.file, thread.line, thread.extraLines, thread.side)}
          </span>
          {isResolved && (
            <span
              data-testid="resolved-chip"
              className="inline-flex h-5 shrink-0 items-center rounded-full border border-github-border px-2 text-[10px] font-medium text-github-text-secondary"
            >
              해결됨
            </span>
          )}
          {!isResolved &&
            !review?.responding &&
            (review !== undefined || reviewState === 'choosing') && (
              <span
                data-testid="review-state-chip"
                className={`inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[10px] font-medium ${
                  reviewState === 'choosing'
                    ? 'border-github-warning text-github-warning'
                    : 'border-github-border text-github-text-secondary'
                }`}
              >
                {reviewStateLabel(reviewState)}
              </span>
            )}
          {review?.responding && (
            <span
              data-testid="responding-chip"
              className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-github-accent px-2 text-[10px] font-medium text-github-accent"
            >
              <span aria-hidden className="inline-flex items-center gap-0.5">
                {RESPONDING_DOT_DELAYS_MS.map((delay) => (
                  <span
                    key={delay}
                    data-testid="responding-dot"
                    className="h-1 w-1 animate-responding-dot rounded-full bg-current motion-reduce:animate-none"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </span>
              응답 중
            </span>
          )}
          {thread.isOutdated && (
            <span
              className={`inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[10px] font-medium ${
                review
                  ? 'border-github-danger text-github-danger'
                  : 'border-github-text-muted text-github-text-muted'
              }`}
              title={
                review && thread.outdatedReason
                  ? OUTDATED_REASON_TITLE[thread.outdatedReason]
                  : 'Code has changed since this comment was made'
              }
              aria-label="Outdated comment"
            >
              {review ? '낡음' : 'Outdated'}
            </span>
          )}
          {isCollapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              title="Expand thread"
            >
              <span className="min-w-0 flex-1 truncate text-github-text-secondary">
                {rootMessage.body.split('\n')[0]}
              </span>
              <span
                className="inline-flex shrink-0 items-center gap-1 text-github-text-muted"
                aria-label={`${thread.messages.length} messages in thread`}
              >
                <MessageSquare size={12} />
                {thread.messages.length}
              </span>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={toggleResolved}
          className={`shrink-0 rounded border p-1.5 transition-all ${
            isResolved
              ? 'border-green-700 bg-green-700 text-white hover:bg-green-800'
              : 'border-github-border bg-github-bg-tertiary text-green-700 hover:bg-github-bg-primary hover:text-green-800'
          }`}
          title={isResolved ? 'Reopen thread' : 'Resolve thread'}
          aria-label={isResolved ? 'Reopen thread' : 'Resolve thread'}
        >
          <Check size={12} />
        </button>
      </div>

      {!isCollapsed && (
        <div className="space-y-3">
          {thread.fixupCommit && (
            <div className="text-xs">
              <code
                className="font-mono text-github-text-secondary"
                title={thread.fixupCommit.subject}
              >
                {thread.fixupCommit.shortSha}
              </code>
            </div>
          )}

          <ThreadMessageItem
            message={rootMessage}
            showAuthorBadge={showAuthorBadges}
            syntaxTheme={syntaxTheme}
            filename={thread.file}
            originalCode={thread.codeContent}
            onUpdate={(newBody) => onUpdateMessage(thread.id, rootMessage.id, newBody)}
            onCopy={() => messageText(rootMessage)}
            {...(isFolded ? {} : { onDelete: () => recordDecision(thread.id, 'deleted', '') })}
            deleteLabel="Delete comment"
          />

          {thread.messages.slice(1).map((message, index) => (
            <div key={message.id} className="ml-4 border-l border-github-border pl-3">
              <ThreadMessageItem
                message={message}
                showAuthorBadge={showAuthorBadges}
                syntaxTheme={syntaxTheme}
                filename={thread.file}
                originalCode={thread.codeContent}
                onUpdate={(newBody) => onUpdateMessage(thread.id, message.id, newBody)}
                onCopy={() => messageText(message)}
                onDelete={() => onRemoveMessage(thread.id, message.id)}
              />
              {message.choices && message.choices.length > 0 && (
                <ReplyChoices
                  message={{ ...message, choices: message.choices }}
                  later={thread.messages.slice(index + 2)}
                  onPick={async (body, answer) => {
                    await onReplyToThread(thread.id, body, answer);
                    if (isResolved) recordDecision(thread.id, 'unresolved', '');
                  }}
                />
              )}
            </div>
          ))}

          {review &&
            ((review.state === 'awaiting-approval' && !isResolved) ||
              review.state === 'approved') && (
              <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                {review.state === 'awaiting-approval' && review.pendingFixups.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => review.onDecide(thread.id, 'approved', review.pendingFixups)}
                      className="min-h-10 flex-1 rounded border border-github-accent bg-github-accent/20 px-3 text-sm font-medium text-github-text-primary"
                    >
                      승인
                    </button>
                    <button
                      type="button"
                      onClick={() => review.onDecide(thread.id, 'rejected', review.pendingFixups)}
                      className="min-h-10 flex-1 rounded border border-github-danger bg-github-danger/20 px-3 text-sm font-medium text-github-text-primary"
                    >
                      거절
                    </button>
                  </>
                )}
                {review.state === 'approved' && review.revertibleFixups.length > 0 && (
                  <button
                    type="button"
                    onClick={() => review.onDecide(thread.id, 'rejected', review.revertibleFixups)}
                    className="min-h-10 flex-1 rounded border border-github-danger bg-github-bg-secondary px-3 text-sm text-github-text-primary"
                  >
                    되돌리기
                  </button>
                )}
                {review.state === 'approved' && review.revertibleFixups.length === 0 && (
                  <button
                    type="button"
                    onClick={() => review.onUndoApproval(thread.id)}
                    className="min-h-10 flex-1 rounded border border-github-border bg-github-bg-secondary px-3 text-sm text-github-text-secondary"
                  >
                    승인 취소
                  </button>
                )}
              </div>
            )}

          {onEditDirectly && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEditDirectly();
              }}
              className="min-h-10 w-full rounded border border-github-accent bg-github-bg-secondary px-3 text-sm text-github-text-primary"
            >
              직접 고치기
            </button>
          )}

          {review && anchorCommit && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                review.onOpenReviewAt(anchorCommit);
              }}
              className="min-h-10 w-full rounded border border-github-border bg-github-bg-secondary px-3 text-sm text-github-text-primary"
              title={`${anchorCommit} 커밋을 대상으로 리뷰를 다시 엽니다`}
            >
              이 지적을 달던 시점으로
            </button>
          )}

          {review && madeView && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                review.onShowView(madeView);
              }}
              className="min-h-10 w-full rounded border border-github-border bg-github-bg-secondary px-3 text-sm text-github-text-primary"
            >
              이 지적을 단 화면으로
            </button>
          )}

          <div
            className="ml-4 border-l border-github-border pl-3"
            onClick={(e) => e.stopPropagation()}
          >
            {isReplying ? (
              <CommentForm
                onSubmit={async (body) => {
                  await onReplyToThread(thread.id, body);
                  if (isResolved) recordDecision(thread.id, 'unresolved', '');
                  setIsReplying(false);
                }}
                onCancel={() => setIsReplying(false)}
                selectedCode={thread.codeContent}
                syntaxTheme={syntaxTheme}
                filename={thread.file}
                embedded={true}
                title="Reply to thread"
                submitLabel={isResolved ? '답글 달고 다시 열기' : 'Reply'}
                placeholder="Write a reply..."
              />
            ) : (
              <button
                type="button"
                data-reply-trigger="true"
                onFocus={() => setIsReplying(true)}
                onClick={() => setIsReplying(true)}
                className="w-full cursor-text rounded border border-github-border bg-github-bg-secondary px-3 py-1.5 text-left text-sm text-github-text-muted transition-colors hover:border-github-text-secondary"
              >
                {isResolved ? '답글 달고 다시 열기...' : 'Write a reply...'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
