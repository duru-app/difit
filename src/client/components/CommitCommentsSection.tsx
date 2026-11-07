import { MessageSquarePlus } from 'lucide-react';
import { useState } from 'react';

import type { CommitThreadView, ReviewCommit, ReviewerReplyFields } from '../../types/diff';
import { commitLocationLabel } from '../../utils/commentPosition';
import { isSameCommit } from '../../utils/diffSelection';
import {
  type FixupOverlayState,
  FixupOverlayProvider,
  threadReviewControls,
} from '../contexts/FixupOverlayContext';

import { CommentForm } from './CommentForm';
import { CommentThreadCard } from './CommentThreadCard';
import { FixupOverlayBlock } from './FixupOverlayCard';
import type { AppearanceSettings } from './SettingsModal';

interface CommitCommentsSectionProps {
  commits: readonly ReviewCommit[];
  threads: readonly CommitThreadView[];
  onAddComment?: (sha: string, body: string) => Promise<void>;
  fixupOverlay: FixupOverlayState;
  showAuthorBadges: boolean;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  onResolveThread: (threadId: string) => void;
  onReplyToThread: (threadId: string, body: string, fields?: ReviewerReplyFields) => Promise<void>;
  onRemoveMessage: (threadId: string, messageId: string) => void;
  onUpdateMessage: (threadId: string, messageId: string, newBody: string) => void;
}

export function CommitCommentsSection({
  commits,
  threads,
  onAddComment,
  fixupOverlay,
  showAuthorBadges,
  syntaxTheme,
  onResolveThread,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
}: CommitCommentsSectionProps) {
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const addTo = onAddComment && commits.length === 1 ? commits[0] : undefined;
  const listed = commits.map((commit) => ({
    commit: commit.sha,
    label: commitLocationLabel({
      commit: commit.sha,
      fixupCommit: { shortSha: commit.shortSha, subject: commit.subject },
    }),
    addable: commit === addTo,
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
    threads: own,
  }));
  const groups = [...listed, ...unlisted].filter(
    ({ addable, threads: own }) => own.length > 0 || addable,
  );
  if (groups.length === 0) return null;

  return (
    <FixupOverlayProvider value={fixupOverlay}>
      <section
        aria-label="커밋 지적"
        className="mb-6 space-y-3 rounded-md border border-github-border bg-github-bg-secondary px-4 py-2"
      >
        {groups.map(({ commit, label, addable, threads: own }) => (
          <div key={commit} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate font-mono text-sm text-github-text-primary">
                {label}
              </span>
              {addable && (
                <button
                  type="button"
                  onClick={() => setAddingTo(commit)}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-github-border px-2 py-1.5 text-sm text-github-text-secondary transition-colors hover:bg-github-bg-tertiary hover:text-github-text-primary"
                  title="이 커밋 전체에 지적 달기"
                  aria-label="이 커밋 전체에 지적 달기"
                >
                  <MessageSquarePlus size={14} />
                  <span className="max-md:hidden">커밋 지적</span>
                </button>
              )}
            </div>
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
