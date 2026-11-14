import { Check, Copy, MessageSquarePlus, Pencil } from 'lucide-react';
import { useState } from 'react';

import type { CommitThreadView, ReviewCommit, ReviewerReplyFields } from '../../types/diff';
import { commitLocationLabel } from '../../utils/commentPosition';
import { isSameCommit } from '../../utils/diffSelection';
import {
  type FixupOverlayState,
  FixupOverlayProvider,
  threadReviewControls,
} from '../contexts/FixupOverlayContext';
import { useCopyCommitHash } from '../hooks/useCopyCommitHash';
import { useGuardedReword } from '../hooks/useGuardedReword';

import { CommentForm } from './CommentForm';
import { CommentThreadCard } from './CommentThreadCard';
import { CommitMessageBody, type LoadCommitMessage } from './CommitMessageBody';
import { CommitMessageForm, type RewordControls } from './CommitMessageForm';
import { FixupOverlayBlock } from './FixupOverlayCard';
import { MovedBranchesNotice } from './MovedBranchesNotice';
import type { AppearanceSettings } from './SettingsModal';

const TOUCH_ICON_CLASS = '[@media(hover:none)]:size-[18px]';
const TOUCH_ONLY_BUTTON_CLASS =
  'hidden size-[40px] shrink-0 items-center justify-center rounded-md border border-github-border text-github-text-secondary transition-colors [@media(hover:none)]:flex disabled:pointer-events-none disabled:opacity-50';

interface CommitCommentsSectionProps {
  commits: readonly ReviewCommit[];
  threads: readonly CommitThreadView[];
  onAddComment?: (sha: string, body: string) => Promise<void>;
  reword?: RewordControls | undefined;
  fixupOverlay: FixupOverlayState;
  showAuthorBadges: boolean;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  onResolveThread: (threadId: string) => void;
  onReplyToThread: (threadId: string, body: string, fields?: ReviewerReplyFields) => Promise<void>;
  onRemoveMessage: (threadId: string, messageId: string) => void;
  onUpdateMessage: (threadId: string, messageId: string, newBody: string) => void;
  loadMessage?: LoadCommitMessage | undefined;
  amendedMessages?: ReadonlyMap<string, string> | undefined;
}

export function CommitCommentsSection({
  commits,
  threads,
  onAddComment,
  reword,
  fixupOverlay,
  showAuthorBadges,
  syntaxTheme,
  onResolveThread,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
  loadMessage,
  amendedMessages,
}: CommitCommentsSectionProps) {
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [rewording, setRewording] = useState<string | null>(null);
  const {
    reword: guardedReword,
    isSaving: isSavingMessage,
    movedBranches,
    dismissMovedBranches,
  } = useGuardedReword(reword);
  const { copiedSha, copyHash } = useCopyCommitHash();
  const only = commits.length === 1 ? commits[0] : undefined;
  const addTo = onAddComment ? only : undefined;
  const listed = commits.map((commit) => ({
    commit: commit.sha,
    label: commitLocationLabel({
      commit: commit.sha,
      fixupCommit: { shortSha: commit.shortSha, subject: commit.subject },
    }),
    addable: commit === addTo,
    showsBody: loadMessage !== undefined && commit === only,
    threads: threads.filter((thread) => isSameCommit(thread.commit, commit.sha)),
  }));
  const offList = new Map<string, CommitThreadView[]>();
  for (const thread of threads) {
    if (commits.some((commit) => isSameCommit(thread.commit, commit.sha))) continue;
    offList.set(thread.commit, [...(offList.get(thread.commit) ?? []), thread]);
  }
  const unlisted = [...offList].map(([commit, own]) => ({
    commit,
    label: commitLocationLabel({ commit, fixupCommit: own[0]?.fixupCommit }),
    addable: false,
    showsBody: false,
    threads: own,
  }));
  const groups = [...listed, ...unlisted].filter(
    ({ addable, showsBody, threads: own }) => own.length > 0 || addable || showsBody,
  );
  if (groups.length === 0 && movedBranches.length === 0) return null;

  return (
    <FixupOverlayProvider value={fixupOverlay}>
      <section
        aria-label="커밋 지적"
        className="mb-6 space-y-3 rounded-md border border-github-border bg-github-bg-secondary px-4 py-2"
      >
        <MovedBranchesNotice branches={movedBranches} onDismiss={dismissMovedBranches} />
        {groups.map(({ commit, label, addable, showsBody, threads: own }) => (
          <div key={commit} className="space-y-2">
            <div className="flex items-center justify-between gap-3 [@media(hover:none)]:flex-col [@media(hover:none)]:items-start [@media(hover:none)]:gap-2">
              <span className="min-w-0 truncate font-mono text-sm text-github-text-primary">
                {label}
              </span>
              {addable && (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void copyHash(commit)}
                    className={TOUCH_ONLY_BUTTON_CLASS}
                    title={copiedSha === commit ? '복사됨' : '해시 복사'}
                    aria-label={copiedSha === commit ? '복사됨' : '해시 복사'}
                  >
                    {copiedSha === commit ? <Check size={18} /> : <Copy size={18} />}
                  </button>
                  {guardedReword && !addTo?.isMerge && (
                    <button
                      type="button"
                      disabled={isSavingMessage}
                      aria-expanded={rewording === commit}
                      onClick={() =>
                        setRewording((current) => (current === commit ? null : commit))
                      }
                      className={TOUCH_ONLY_BUTTON_CLASS}
                      title="메시지 고치기"
                      aria-label="메시지 고치기"
                    >
                      <Pencil size={18} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setAddingTo(commit)}
                    className="flex shrink-0 items-center gap-1.5 rounded-md border border-github-border px-2 py-1.5 text-sm text-github-text-secondary transition-colors hover:bg-github-bg-tertiary hover:text-github-text-primary [@media(hover:none)]:size-[40px] [@media(hover:none)]:justify-center [@media(hover:none)]:p-0"
                    title="이 커밋 전체에 지적 달기"
                    aria-label="이 커밋 전체에 지적 달기"
                  >
                    <MessageSquarePlus size={14} className={TOUCH_ICON_CLASS} />
                    <span className="max-md:hidden [@media(hover:none)]:hidden">커밋 지적</span>
                  </button>
                </div>
              )}
            </div>
            {addable && guardedReword && rewording === commit && (
              <CommitMessageForm
                sha={commit}
                controls={guardedReword}
                onClose={() => setRewording(null)}
              />
            )}
            {showsBody && loadMessage && (
              <CommitMessageBody
                sha={commit}
                load={loadMessage}
                amendedMessage={amendedMessages?.get(commit)}
                className="max-h-[40vh] overflow-y-auto"
              />
            )}
            {own.map((thread) => (
              <div key={thread.id} className="space-y-1">
                <FixupOverlayBlock thread={thread} filePath={undefined} syntaxTheme={syntaxTheme} />
                <CommentThreadCard
                  thread={thread}
                  review={threadReviewControls(fixupOverlay, thread)}
                  showAuthorBadges={showAuthorBadges}
                  onResolveThread={onResolveThread}
                  onReplyToThread={onReplyToThread}
                  onRemoveMessage={onRemoveMessage}
                  onUpdateMessage={onUpdateMessage}
                  syntaxTheme={syntaxTheme}
                />
              </div>
            ))}
            {addable && addingTo === commit && onAddComment && (
              <CommentForm
                onSubmit={async (body) => {
                  await onAddComment(commit, body);
                  setAddingTo(null);
                }}
                onCancel={() => setAddingTo(null)}
                location={commitLocationLabel({ commit })}
                syntaxTheme={syntaxTheme}
              />
            )}
          </div>
        ))}
      </section>
    </FixupOverlayProvider>
  );
}
