import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommentThread, ReviewDecision, ThreadFixup } from '../../types/diff';
import {
  EMPTY_FIXUP_OVERLAY,
  FixupOverlayProvider,
  type FixupOverlayState,
} from '../contexts/FixupOverlayContext';
import { PickedThreadProvider } from '../contexts/PickedThreadContext';
import { WordHighlightProvider } from '../contexts/WordHighlightContext';
import { copyTextToClipboard } from '../utils/clipboard';

import { CommentThreadCard } from './CommentThreadCard';

vi.mock('../utils/clipboard', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

const mockThread: CommentThread = {
  id: 'thread-1',
  file: 'src/client/components/CommentThreadCard.tsx',
  line: 80,
  side: 'new',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  codeContent: 'const value = 1;',
  messages: [
    {
      id: 'message-1',
      body: 'Root comment',
      author: 'User',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 'message-2',
      body: 'Reply comment',
      author: 'Reviewer',
      createdAt: '2024-01-01T00:01:00Z',
      updatedAt: '2024-01-01T00:01:00Z',
    },
  ],
};

const threadWithUserReply: CommentThread = {
  ...mockThread,
  messages: [mockThread.messages[0]!, { ...mockThread.messages[1]!, author: 'User' }],
};

describe('CommentThreadCard', () => {
  beforeEach(() => {
    vi.mocked(copyTextToClipboard).mockClear();
  });

  it('copies only the text of one message, without its location', async () => {
    const user = userEvent.setup();
    render(
      <CommentThreadCard
        thread={mockThread}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    const copyButtons = screen.getAllByRole('button', { name: 'Copy comment' });
    expect(copyButtons).toHaveLength(2);
    await user.click(copyButtons[1]!);

    const copied = vi.mocked(copyTextToClipboard).mock.calls[0]?.[0];
    expect(copied).toBe('Reply comment');
  });

  it('offers no suggestion button in the reply or edit form', async () => {
    const user = userEvent.setup();
    render(
      <CommentThreadCard
        thread={threadWithUserReply}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Write a reply...' }));
    expect(screen.getByPlaceholderText('Write a reply...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /suggestion/i })).toBeNull();

    await user.click(screen.getAllByTitle('Edit message')[0]!);
    expect(screen.getByPlaceholderText('Edit your message...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /suggestion/i })).toBeNull();
  });

  it('draws a suggestion block as removed and added lines and copies it as ORIGINAL/SUGGESTED', async () => {
    const user = userEvent.setup();
    const suggestionThread: CommentThread = {
      ...mockThread,
      messages: [
        { ...mockThread.messages[0]!, body: 'Use two:\n\n```suggestion\nconst value = 2;\n```' },
      ],
    };
    const { container } = render(
      <WordHighlightProvider>
        <CommentThreadCard
          thread={suggestionThread}
          onResolveThread={vi.fn()}
          onReplyToThread={vi.fn().mockResolvedValue(undefined)}
          onRemoveMessage={vi.fn()}
          onUpdateMessage={vi.fn()}
        />
      </WordHighlightProvider>,
    );

    expect(container.querySelector('.bg-diff-deletion-bg')).toHaveTextContent('const value = 1;');
    expect(container.querySelector('.bg-diff-addition-bg')).toHaveTextContent('const value = 2;');

    await user.click(screen.getByRole('button', { name: 'Copy comment' }));
    const copied = vi.mocked(copyTextToClipboard).mock.calls[0]?.[0];
    expect(copied?.startsWith('Use two:')).toBe(true);
    expect(copied).toContain('ORIGINAL:');
    expect(copied).toContain('const value = 1;');
    expect(copied).toContain('SUGGESTED:');
    expect(copied).toContain('const value = 2;');
  });

  it('does not show delete action for replies authored by someone else', () => {
    render(
      <CommentThreadCard
        thread={mockThread}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.getByText('Reply comment')).toBeInTheDocument();
    expect(screen.queryByTitle('Delete reply')).not.toBeInTheDocument();
  });

  it('keeps resolve available for root comments even when not authored by the user', () => {
    render(
      <CommentThreadCard
        thread={{
          ...mockThread,
          messages: [
            {
              ...mockThread.messages[0]!,
              author: 'Reviewer',
            },
          ],
        }}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.getByTitle('Resolve thread')).toBeInTheDocument();
    expect(screen.queryByTitle('Edit message')).not.toBeInTheDocument();
  });

  it('resolves a root comment without asking', async () => {
    const user = userEvent.setup();
    const onResolveThread = vi.fn();

    render(
      <CommentThreadCard
        thread={mockThread}
        onResolveThread={onResolveThread}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle('Resolve thread'));

    expect(screen.queryByText('Resolve?')).not.toBeInTheDocument();
    expect(onResolveThread).toHaveBeenCalledWith('thread-1');
  });

  it('cancels the inline delete confirmation with the cancel button', async () => {
    const user = userEvent.setup();
    const onRemoveMessage = vi.fn();

    render(
      <CommentThreadCard
        thread={threadWithUserReply}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={onRemoveMessage}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle('Delete reply'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onRemoveMessage).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete?')).not.toBeInTheDocument();
    expect(screen.getByTitle('Delete reply')).toBeInTheDocument();
  });

  it('cancels the inline delete confirmation with Escape', async () => {
    const user = userEvent.setup();
    const onRemoveMessage = vi.fn();

    render(
      <CommentThreadCard
        thread={threadWithUserReply}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={onRemoveMessage}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle('Delete reply'));
    await user.keyboard('{Escape}');

    expect(onRemoveMessage).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete?')).not.toBeInTheDocument();
  });

  it('consumes Escape so surrounding Escape handlers do not fire', async () => {
    const user = userEvent.setup();
    const outerKeyDown = vi.fn();
    document.addEventListener('keydown', outerKeyDown);

    try {
      render(
        <CommentThreadCard
          thread={threadWithUserReply}
          onResolveThread={vi.fn()}
          onReplyToThread={vi.fn().mockResolvedValue(undefined)}
          onRemoveMessage={vi.fn()}
          onUpdateMessage={vi.fn()}
        />,
      );

      await user.click(screen.getByTitle('Delete reply'));
      await user.keyboard('{Escape}');

      expect(screen.queryByText('Delete?')).not.toBeInTheDocument();
      expect(outerKeyDown).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', outerKeyDown);
    }
  });

  it('cancels the inline delete confirmation when clicking outside', async () => {
    const user = userEvent.setup();
    const onRemoveMessage = vi.fn();

    render(
      <div>
        <button type="button">outside</button>
        <CommentThreadCard
          thread={threadWithUserReply}
          onResolveThread={vi.fn()}
          onReplyToThread={vi.fn().mockResolvedValue(undefined)}
          onRemoveMessage={onRemoveMessage}
          onUpdateMessage={vi.fn()}
        />
      </div>,
    );

    await user.click(screen.getByTitle('Delete reply'));
    await user.click(screen.getByRole('button', { name: 'outside' }));

    expect(onRemoveMessage).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete?')).not.toBeInTheDocument();
  });

  describe('message action visibility', () => {
    const hideUntilHover = [
      '[@media(hover:hover)]:opacity-0',
      'group-hover:opacity-100',
      'focus-visible:opacity-100',
    ];
    const opacityClasses = (element: HTMLElement) =>
      [...element.classList].filter((token) => token.includes('opacity')).sort();

    const renderThreadWithUserReply = () =>
      render(
        <CommentThreadCard
          thread={threadWithUserReply}
          onResolveThread={vi.fn()}
          onReplyToThread={vi.fn().mockResolvedValue(undefined)}
          onRemoveMessage={vi.fn()}
          onUpdateMessage={vi.fn()}
        />,
      );

    const replyActions = () => ({
      copy: screen.getAllByRole('button', { name: 'Copy comment' })[1]!,
      edit: screen.getAllByRole('button', { name: 'Edit message' })[1]!,
      remove: screen.getByRole('button', { name: 'Delete reply' }),
    });

    it('hides copy, edit and delete the same way until the message is hovered', () => {
      renderThreadWithUserReply();
      const { copy, edit, remove } = replyActions();

      for (const button of [copy, edit, remove]) {
        expect(button).toHaveClass(...hideUntilHover);
      }
      expect(opacityClasses(edit)).toEqual(opacityClasses(copy));
      expect(opacityClasses(remove)).toEqual(opacityClasses(copy));
    });

    it('reveals only the hovered message', () => {
      renderThreadWithUserReply();
      const [rootCopy, replyCopy] = screen.getAllByRole('button', { name: 'Copy comment' });
      const replyRow = replyCopy!.closest('.group');

      expect(replyRow).not.toBeNull();
      expect(rootCopy!.closest('.group')).not.toBe(replyRow);
      for (const button of Object.values(replyActions())) {
        expect(button.closest('.group')).toBe(replyRow);
      }
    });

    it('keeps the delete confirmation visible regardless of hover', async () => {
      const user = userEvent.setup();
      renderThreadWithUserReply();

      await user.click(screen.getByRole('button', { name: 'Delete reply' }));

      expect(screen.getByText('Delete?')).toBeInTheDocument();
      for (const name of ['Delete', 'Cancel']) {
        const button = screen.getByRole('button', { name });
        expect(button.closest('[class*="opacity-0"]')).toBeNull();
      }
    });

    it('keeps the copied check shown while edit and delete stay hidden', async () => {
      const user = userEvent.setup();
      renderThreadWithUserReply();

      await user.click(replyActions().copy);

      const { copy, edit, remove } = replyActions();
      expect(copy).toHaveAttribute('title', 'Copied!');
      expect(copy).not.toHaveClass('[@media(hover:hover)]:opacity-0');
      expect(edit).toHaveClass(...hideUntilHover);
      expect(remove).toHaveClass(...hideUntilHover);
    });
  });

  describe('deleting the whole comment', () => {
    const renderCard = (thread: CommentThread, decisions: ReviewDecision[] = []) => {
      const recordDecision = vi.fn();
      render(
        <FixupOverlayProvider value={{ ...EMPTY_FIXUP_OVERLAY, decisions, recordDecision }}>
          <CommentThreadCard
            thread={thread}
            onResolveThread={vi.fn()}
            onReplyToThread={vi.fn().mockResolvedValue(undefined)}
            onRemoveMessage={vi.fn()}
            onUpdateMessage={vi.fn()}
          />
        </FixupOverlayProvider>,
      );
      return recordDecision;
    };

    it('deletes a comment the reviewer wrote, replies and all, after asking', async () => {
      const user = userEvent.setup();
      const recordDecision = renderCard(mockThread);

      await user.click(screen.getByTitle('Delete comment'));
      expect(recordDecision).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Delete' }));

      expect(recordDecision).toHaveBeenCalledWith('thread-1', 'deleted', '');
    });

    it('offers no delete on a comment the agent opened or one already folded', () => {
      renderCard({
        ...mockThread,
        messages: [{ ...mockThread.messages[0]!, author: 'Agent' }],
      });
      expect(screen.queryByTitle('Delete comment')).not.toBeInTheDocument();
      cleanup();

      renderCard(mockThread, [
        { threadId: 'thread-1', kind: 'folded', fixupSha: 'aaaa', at: '2026-01-01T00:00:00Z' },
      ]);
      expect(screen.queryByTitle('Delete comment')).not.toBeInTheDocument();
    });
  });

  describe('when resolved', () => {
    const resolution = (kind: 'resolved' | 'unresolved', at: string): ReviewDecision => ({
      threadId: 'thread-1',
      kind,
      fixupSha: '',
      at,
    });
    const overlayWith = (decisions: ReviewDecision[], recordDecision = vi.fn()) => ({
      ...EMPTY_FIXUP_OVERLAY,
      decisions,
      recordDecision,
    });
    const card = (overlay: FixupOverlayState) => (
      <FixupOverlayProvider value={overlay}>
        <CommentThreadCard
          thread={mockThread}
          onResolveThread={vi.fn()}
          onReplyToThread={vi.fn().mockResolvedValue(undefined)}
          onRemoveMessage={vi.fn()}
          onUpdateMessage={vi.fn()}
        />
      </FixupOverlayProvider>
    );

    it('starts collapsed with the check offering to reopen', () => {
      render(card(overlayWith([resolution('resolved', '2026-01-01T00:00:00Z')])));

      expect(screen.getByText('해결됨')).toBeInTheDocument();
      expect(screen.queryByText('Reply comment')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Resolve thread')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reopen thread' })).toBeInTheDocument();
    });

    it('collapses the moment the resolution lands', () => {
      const { rerender } = render(card(overlayWith([])));
      expect(screen.getByText('Reply comment')).toBeInTheDocument();

      rerender(card(overlayWith([resolution('resolved', '2026-01-01T00:00:00Z')])));

      expect(screen.queryByText('Reply comment')).not.toBeInTheDocument();
      expect(screen.getByText('해결됨')).toBeInTheDocument();
    });

    describe('while a reply is being written and the resolution arrives from elsewhere', () => {
      const replyingCard = (overlay: FixupOverlayState, onReplyToThread = vi.fn()) => (
        <FixupOverlayProvider value={overlay}>
          <CommentThreadCard
            thread={mockThread}
            onResolveThread={vi.fn()}
            onReplyToThread={onReplyToThread}
            onRemoveMessage={vi.fn()}
            onUpdateMessage={vi.fn()}
          />
        </FixupOverlayProvider>
      );

      it('keeps the reply form and its draft open under the resolved chip', async () => {
        const user = userEvent.setup();
        const { rerender } = render(replyingCard(overlayWith([])));
        await user.click(screen.getByRole('button', { name: 'Write a reply...' }));
        await user.type(screen.getByPlaceholderText('Write a reply...'), 'Half-written');

        rerender(replyingCard(overlayWith([resolution('resolved', '2026-01-01T00:00:00Z')])));

        expect(screen.getByText('해결됨')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Write a reply...')).toHaveValue('Half-written');
      });

      it('sends the draft and reopens the thread', async () => {
        const user = userEvent.setup();
        const onReplyToThread = vi.fn().mockResolvedValue(undefined);
        const recordDecision = vi.fn();
        const { rerender } = render(replyingCard(overlayWith([], recordDecision), onReplyToThread));
        await user.click(screen.getByRole('button', { name: 'Write a reply...' }));
        await user.type(screen.getByPlaceholderText('Write a reply...'), 'Half-written');

        rerender(
          replyingCard(
            overlayWith([resolution('resolved', '2026-01-01T00:00:00Z')], recordDecision),
            onReplyToThread,
          ),
        );
        await user.click(screen.getByRole('button', { name: '답글 달고 다시 열기' }));

        expect(onReplyToThread).toHaveBeenCalledWith('thread-1', 'Half-written');
        expect(recordDecision).toHaveBeenCalledWith('thread-1', 'unresolved', '');
      });

      it('collapses once the reply form is closed', async () => {
        const user = userEvent.setup();
        const { rerender } = render(replyingCard(overlayWith([])));
        await user.click(screen.getByRole('button', { name: 'Write a reply...' }));

        rerender(replyingCard(overlayWith([resolution('resolved', '2026-01-01T00:00:00Z')])));
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(screen.queryByText('Reply comment')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Expand thread' })).toBeInTheDocument();
      });
    });

    it('reopens the thread with an unresolved record when the check is pressed again', async () => {
      const user = userEvent.setup();
      const recordDecision = vi.fn();
      render(card(overlayWith([resolution('resolved', '2026-01-01T00:00:00Z')], recordDecision)));

      await user.click(screen.getByRole('button', { name: 'Reopen thread' }));

      expect(recordDecision).toHaveBeenCalledWith('thread-1', 'unresolved', '');
    });

    it('offers no verdict on a pending fixup once resolved', async () => {
      const user = userEvent.setup();
      render(
        <FixupOverlayProvider value={overlayWith([resolution('resolved', '2026-01-01T00:00:00Z')])}>
          <CommentThreadCard
            thread={mockThread}
            review={{
              state: 'awaiting-approval',
              pendingFixups: [{ fixupSha: 'abc1234' }],
              revertibleFixups: [],
              targetCommit: 'b7c2e10',
              responding: false,
              onDecide: vi.fn(),
              onUndoApproval: vi.fn(),
              onOpenReviewAt: vi.fn(),
              onShowView: vi.fn(),
            }}
            onResolveThread={vi.fn()}
            onReplyToThread={vi.fn().mockResolvedValue(undefined)}
            onRemoveMessage={vi.fn()}
            onUpdateMessage={vi.fn()}
          />
        </FixupOverlayProvider>,
      );

      await user.click(screen.getByRole('button', { name: 'Expand thread' }));

      expect(screen.getByText('Reply comment')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '승인' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '거절' })).not.toBeInTheDocument();
    });

    it('reopens the thread after sending a reply to it', async () => {
      const user = userEvent.setup();
      const onReplyToThread = vi.fn().mockResolvedValue(undefined);
      const recordDecision = vi.fn();
      render(
        <FixupOverlayProvider
          value={overlayWith([resolution('resolved', '2026-01-01T00:00:00Z')], recordDecision)}
        >
          <CommentThreadCard
            thread={mockThread}
            onResolveThread={vi.fn()}
            onReplyToThread={onReplyToThread}
            onRemoveMessage={vi.fn()}
            onUpdateMessage={vi.fn()}
          />
        </FixupOverlayProvider>,
      );

      await user.click(screen.getByRole('button', { name: 'Expand thread' }));
      await user.click(screen.getByRole('button', { name: '답글 달고 다시 열기...' }));
      await user.type(screen.getByPlaceholderText('Write a reply...'), 'One more thing');
      await user.click(screen.getByRole('button', { name: '답글 달고 다시 열기' }));

      expect(onReplyToThread).toHaveBeenCalledWith('thread-1', 'One more thing');
      expect(recordDecision).toHaveBeenCalledWith('thread-1', 'unresolved', '');
      expect(onReplyToThread.mock.invocationCallOrder[0]).toBeLessThan(
        recordDecision.mock.invocationCallOrder[0]!,
      );
    });

    it('shows a reopened thread as open again', () => {
      render(
        card(
          overlayWith([
            resolution('resolved', '2026-01-01T00:00:00Z'),
            resolution('unresolved', '2026-01-01T00:01:00Z'),
          ]),
        ),
      );

      expect(screen.queryByText('해결됨')).not.toBeInTheDocument();
      expect(screen.getByText('Reply comment')).toBeInTheDocument();
      expect(screen.getByTitle('Resolve thread')).toBeInTheDocument();
    });
  });

  describe('when approved', () => {
    const at = (minute: number) => `2026-01-01T00:0${minute}:00Z`;
    const record = (kind: ReviewDecision['kind'], minute: number): ReviewDecision => ({
      threadId: 'thread-1',
      kind,
      fixupSha: kind === 'approved' ? 'aaaa' : '',
      at: at(minute),
    });
    const overlayWith = (decisions: ReviewDecision[], recordDecision = vi.fn()) => ({
      ...EMPTY_FIXUP_OVERLAY,
      decisions,
      recordDecision,
    });
    const review = (
      state: 'awaiting-approval' | 'approved',
      onUndoApproval = vi.fn(),
      revertibleFixups: Array<{ fixupSha: string }> = [],
    ) => ({
      state,
      pendingFixups: [{ fixupSha: 'aaaa' }],
      revertibleFixups,
      targetCommit: 'b7c2e10',
      responding: false,
      onDecide: vi.fn(),
      onUndoApproval,
      onOpenReviewAt: vi.fn(),
      onShowView: vi.fn(),
    });
    const card = (
      decisions: ReviewDecision[],
      state: 'awaiting-approval' | 'approved',
      {
        recordDecision = vi.fn(),
        onUndoApproval = vi.fn(),
        onReplyToThread = vi.fn(),
        revertibleFixups = [] as Array<{ fixupSha: string }>,
      } = {},
    ) => (
      <FixupOverlayProvider value={overlayWith(decisions, recordDecision)}>
        <CommentThreadCard
          thread={mockThread}
          review={review(state, onUndoApproval, revertibleFixups)}
          onResolveThread={vi.fn()}
          onReplyToThread={onReplyToThread}
          onRemoveMessage={vi.fn()}
          onUpdateMessage={vi.fn()}
        />
      </FixupOverlayProvider>
    );

    it('collapses as resolved the moment the approval lands, with the check pressed', () => {
      const { rerender } = render(card([], 'awaiting-approval'));
      expect(screen.getByText('Reply comment')).toBeInTheDocument();

      rerender(card([record('approved', 0)], 'approved'));

      expect(screen.queryByText('Reply comment')).not.toBeInTheDocument();
      expect(screen.getByTestId('resolved-chip')).toHaveTextContent('해결됨');
      expect(screen.getByRole('button', { name: 'Reopen thread' })).toBeInTheDocument();
    });

    it('keeps undoing the approval reachable on the expanded card', async () => {
      const user = userEvent.setup();
      const onUndoApproval = vi.fn();
      render(card([record('approved', 0)], 'approved', { onUndoApproval }));

      await user.click(screen.getByRole('button', { name: 'Expand thread' }));
      await user.click(screen.getByRole('button', { name: '승인 취소' }));

      expect(onUndoApproval).toHaveBeenCalledWith('thread-1');
    });

    it('keeps reverting a reviewer edit reachable on the expanded card', async () => {
      const user = userEvent.setup();
      render(
        card([record('approved', 0)], 'approved', { revertibleFixups: [{ fixupSha: 'aaaa' }] }),
      );

      await user.click(screen.getByRole('button', { name: 'Expand thread' }));
      expect(screen.getByRole('button', { name: '되돌리기' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '승인 취소' })).not.toBeInTheDocument();
    });

    it('reopens with an unresolved record when the check is pressed, keeping the approval', async () => {
      const user = userEvent.setup();
      const recordDecision = vi.fn();
      const { rerender } = render(card([record('approved', 0)], 'approved', { recordDecision }));

      await user.click(screen.getByRole('button', { name: 'Reopen thread' }));
      expect(recordDecision).toHaveBeenCalledWith('thread-1', 'unresolved', '');

      rerender(card([record('approved', 0), record('unresolved', 1)], 'approved'));
      expect(screen.queryByTestId('resolved-chip')).not.toBeInTheDocument();
      expect(screen.getByText('Reply comment')).toBeInTheDocument();
      expect(screen.getByTestId('review-state-chip')).toHaveTextContent('승인됨');
      expect(screen.getByRole('button', { name: '승인 취소' })).toBeInTheDocument();
    });

    it('opens again when the approval is undone', () => {
      const { rerender } = render(card([record('approved', 0)], 'approved'));
      expect(screen.queryByText('Reply comment')).not.toBeInTheDocument();

      rerender(card([record('approved', 0), record('unapproved', 1)], 'awaiting-approval'));

      expect(screen.queryByTestId('resolved-chip')).not.toBeInTheDocument();
      expect(screen.getByText('Reply comment')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '승인' })).toBeInTheDocument();
    });

    it('still shows that the agent is answering a reply on an approved card', () => {
      render(
        <FixupOverlayProvider value={overlayWith([record('approved', 0)])}>
          <CommentThreadCard
            thread={mockThread}
            review={{ ...review('approved'), responding: true }}
            onResolveThread={vi.fn()}
            onReplyToThread={vi.fn()}
            onRemoveMessage={vi.fn()}
            onUpdateMessage={vi.fn()}
          />
        </FixupOverlayProvider>,
      );

      expect(screen.getByTestId('resolved-chip')).toBeInTheDocument();
      expect(screen.getByTestId('responding-chip')).toBeInTheDocument();
    });

    it('reopens the thread after sending a reply to it', async () => {
      const user = userEvent.setup();
      const recordDecision = vi.fn();
      const onReplyToThread = vi.fn().mockResolvedValue(undefined);
      render(card([record('approved', 0)], 'approved', { recordDecision, onReplyToThread }));

      await user.click(screen.getByRole('button', { name: 'Expand thread' }));
      await user.click(screen.getByRole('button', { name: '답글 달고 다시 열기...' }));
      await user.type(screen.getByPlaceholderText('Write a reply...'), 'One more thing');
      await user.click(screen.getByRole('button', { name: '답글 달고 다시 열기' }));

      expect(onReplyToThread).toHaveBeenCalledWith('thread-1', 'One more thing');
      expect(recordDecision).toHaveBeenCalledWith('thread-1', 'unresolved', '');
    });

    describe('folding while the diff is scrolled', () => {
      const FILE_HEADER_HEIGHT = 50;
      const EXPANDED_HEIGHT = 2000;
      const COLLAPSED_HEIGHT = 40;
      let cardTop = 0;

      beforeEach(() => {
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
          function (this: Element) {
            const box = (top: number, height: number) =>
              DOMRect.fromRect({ x: 0, y: top, width: 800, height });
            if (this.tagName === 'MAIN') return box(0, 600);
            if (this.hasAttribute('data-file-header')) return box(0, FILE_HEADER_HEIGHT);
            if (this.id === 'comment-thread-thread-1') {
              const expanded = this.querySelector('[aria-label="Collapse thread"]') !== null;
              return box(cardTop, expanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT);
            }
            return box(0, 0);
          },
        );
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      const inDiff = (decisions: ReviewDecision[], state: 'awaiting-approval' | 'approved') => (
        <main className="overflow-y-auto">
          <div data-file-path={mockThread.file}>
            <div data-file-header />
            {card(decisions, state)}
          </div>
        </main>
      );

      const approveScrolledTo = (top: number) => {
        cardTop = top;
        const { container, rerender } = render(inDiff([], 'awaiting-approval'));
        const diff = container.querySelector('main');
        if (!diff) throw new Error('diff container missing');
        diff.scrollTop = 3000;
        rerender(inDiff([record('approved', 0)], 'approved'));
        return diff.scrollTop;
      };

      it('brings the folded head back under the file header when the card ran off the top', () => {
        expect(approveScrolledTo(-1500)).toBe(3000 - 1500 - FILE_HEADER_HEIGHT - 8);
      });

      it('stays put when the whole card was already above the screen', () => {
        expect(approveScrolledTo(-2500)).toBe(3000);
      });

      it('stays put when the head of the card was on screen', () => {
        expect(approveScrolledTo(200)).toBe(3000);
      });
    });
  });

  describe('when the approved fixup was amended', () => {
    const fixup = (sha: string): ThreadFixup => ({
      sha,
      shortSha: sha.slice(0, 7),
      patchId: `patch-${sha}`,
      authoredAt: '2026-01-01T00:00:00Z',
      subject: 'fixup! x',
      threadIds: ['thread-1'],
      files: [],
    });
    const approvedThenResolved: ReviewDecision[] = [
      {
        threadId: 'thread-1',
        kind: 'approved',
        fixupSha: '8adfc858050f',
        patchId: 'patch-8adfc858050f',
        at: '2026-01-01T00:00:00Z',
      },
      { threadId: 'thread-1', kind: 'resolved', fixupSha: '', at: '2026-01-01T00:01:00Z' },
    ];
    const card = (fixups: ThreadFixup[], onResolveThread = vi.fn()) => (
      <FixupOverlayProvider
        value={{
          ...EMPTY_FIXUP_OVERLAY,
          decisions: approvedThenResolved,
          fixupsByThread: new Map([['thread-1', fixups]]),
        }}
      >
        <CommentThreadCard
          thread={mockThread}
          review={{
            state: 'awaiting-approval',
            pendingFixups: fixups.map(({ sha }) => ({ fixupSha: sha })),
            revertibleFixups: [],
            targetCommit: 'b7c2e10',
            responding: false,
            onDecide: vi.fn(),
            onUndoApproval: vi.fn(),
            onOpenReviewAt: vi.fn(),
            onShowView: vi.fn(),
          }}
          onResolveThread={onResolveThread}
          onReplyToThread={vi.fn()}
          onRemoveMessage={vi.fn()}
          onUpdateMessage={vi.fn()}
        />
      </FixupOverlayProvider>
    );

    it('opens up again as awaiting approval', () => {
      const { rerender } = render(card([fixup('8adfc858050f')]));
      expect(screen.getByTestId('resolved-chip')).toBeInTheDocument();
      expect(screen.queryByText('Reply comment')).not.toBeInTheDocument();

      rerender(card([fixup('b50f2257077f')]));

      expect(screen.queryByTestId('resolved-chip')).not.toBeInTheDocument();
      expect(screen.getByText('Reply comment')).toBeInTheDocument();
      expect(screen.getByTestId('review-state-chip')).toHaveTextContent('승인 대기');
    });

    it('asks for a judgment on the new fixup instead of resolving', async () => {
      const user = userEvent.setup();
      const onResolveThread = vi.fn();
      render(card([fixup('b50f2257077f')], onResolveThread));

      const check = screen.getByRole('button', { name: 'Resolve thread' });
      expect(check).toBeDisabled();
      expect(check).toHaveAttribute('title', '바뀐 fixup 을 먼저 승인하거나 거절해 주세요');
      await user.click(check);
      expect(onResolveThread).not.toHaveBeenCalled();
    });
  });

  it('collapses the thread into a single line and expands it back', async () => {
    const user = userEvent.setup();

    render(
      <CommentThreadCard
        thread={mockThread}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Collapse thread' }));

    expect(screen.queryByText('Reply comment')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy comment' })).not.toBeInTheDocument();
    expect(screen.getByTitle('Resolve thread')).toBeInTheDocument();
    expect(screen.getByText('Root comment')).toBeInTheDocument();
    expect(screen.getByLabelText('2 messages in thread')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand thread' }));

    expect(screen.getByText('Reply comment')).toBeInTheDocument();
    expect(screen.getByTitle('Resolve thread')).toBeInTheDocument();
  });

  it('expands a collapsed thread by clicking the summary line', async () => {
    const user = userEvent.setup();

    render(
      <CommentThreadCard
        thread={mockThread}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Collapse thread' }));
    await user.click(screen.getByText('Root comment'));

    expect(screen.getByText('Reply comment')).toBeInTheDocument();
  });

  describe('picked from the comments panel', () => {
    const card = (thread: CommentThread, pickedId: string | null) => (
      <PickedThreadProvider value={pickedId}>
        <CommentThreadCard
          thread={thread}
          onResolveThread={vi.fn()}
          onReplyToThread={vi.fn().mockResolvedValue(undefined)}
          onRemoveMessage={vi.fn()}
          onUpdateMessage={vi.fn()}
        />
      </PickedThreadProvider>
    );
    const resolvedOverlay: FixupOverlayState = {
      ...EMPTY_FIXUP_OVERLAY,
      decisions: [
        { threadId: mockThread.id, kind: 'resolved', fixupSha: '', at: '2026-01-01T00:00:00Z' },
      ],
    };

    it('marks only the picked card', () => {
      const { rerender } = render(card(mockThread, mockThread.id));
      expect(document.getElementById(`comment-thread-${mockThread.id}`)).toHaveAttribute(
        'data-picked',
        'true',
      );

      rerender(card(mockThread, 'another'));
      expect(document.getElementById(`comment-thread-${mockThread.id}`)).not.toHaveAttribute(
        'data-picked',
      );
    });

    it('opens a folded resolved card when it is picked', () => {
      const { rerender } = render(
        <FixupOverlayProvider value={resolvedOverlay}>
          {card(mockThread, null)}
        </FixupOverlayProvider>,
      );
      expect(screen.queryByText('Reply comment')).not.toBeInTheDocument();

      rerender(
        <FixupOverlayProvider value={resolvedOverlay}>
          {card(mockThread, mockThread.id)}
        </FixupOverlayProvider>,
      );
      expect(screen.getByText('Reply comment')).toBeInTheDocument();
    });

    it('draws a resolved card open when it first appears picked', () => {
      render(
        <FixupOverlayProvider value={resolvedOverlay}>
          {card(mockThread, mockThread.id)}
        </FixupOverlayProvider>,
      );
      expect(screen.getByText('Reply comment')).toBeInTheDocument();
    });
  });

  it('names the author of each message when badges are on', () => {
    render(
      <CommentThreadCard
        thread={mockThread}
        showAuthorBadges
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
  });

  it('names no author when badges are off', () => {
    render(
      <CommentThreadCard
        thread={mockThread}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.queryByText('User')).not.toBeInTheDocument();
    expect(screen.queryByText('Reviewer')).not.toBeInTheDocument();
  });

  it('shows the "Outdated" badge when the thread is marked outdated', () => {
    render(
      <CommentThreadCard
        thread={{ ...mockThread, isOutdated: true }}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    const badge = screen.getByLabelText('Outdated comment');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Outdated');
    expect(badge).toHaveAttribute('title', 'Code has changed since this comment was made');
  });

  it('does not render the "Outdated" badge when the thread is up to date', () => {
    render(
      <CommentThreadCard
        thread={mockThread}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
  });

  const awaitingReview = {
    state: 'awaiting-approval' as const,
    pendingFixups: [{ fixupSha: 'abc1234' }],
    revertibleFixups: [] as Array<{ fixupSha: string }>,
    targetCommit: 'b7c2e10',
    responding: false,
    onDecide: vi.fn(),
    onUndoApproval: vi.fn(),
    onOpenReviewAt: vi.fn(),
    onShowView: vi.fn(),
  };

  it('approves and rejects every fixup under judgment at once', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    const bundle = [{ fixupSha: 'aaaa', patchId: 'patch-a' }, { fixupSha: 'bbbb' }];
    render(
      <CommentThreadCard
        thread={mockThread}
        review={{ ...awaitingReview, pendingFixups: bundle, onDecide }}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '승인' }));
    await user.click(screen.getByRole('button', { name: '거절' }));

    expect(onDecide.mock.calls).toEqual([
      [mockThread.id, 'approved', bundle],
      [mockThread.id, 'rejected', bundle],
    ]);
  });

  it('reverts the fixup a reviewer edit made', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    const renderCard = (revertibleFixups: Array<{ fixupSha: string }>) =>
      render(
        <CommentThreadCard
          thread={mockThread}
          review={{
            ...awaitingReview,
            state: 'approved',
            pendingFixups: [{ fixupSha: 'eeee' }],
            revertibleFixups,
            onDecide,
          }}
          onResolveThread={vi.fn()}
          onReplyToThread={vi.fn().mockResolvedValue(undefined)}
          onRemoveMessage={vi.fn()}
          onUpdateMessage={vi.fn()}
        />,
      );

    const { unmount } = renderCard([{ fixupSha: 'eeee' }]);
    expect(screen.queryByRole('button', { name: '승인 취소' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '되돌리기' }));
    expect(onDecide).toHaveBeenCalledWith(mockThread.id, 'rejected', [{ fixupSha: 'eeee' }]);
    unmount();
    renderCard([]);
    expect(screen.queryByRole('button', { name: '되돌리기' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '승인 취소' })).toBeInTheDocument();
  });

  it('shows that the agent is responding in place of the state chip', () => {
    const renderCard = (responding: boolean) =>
      render(
        <CommentThreadCard
          thread={mockThread}
          review={{ ...awaitingReview, state: 'awaiting-fix', pendingFixups: [], responding }}
          onResolveThread={vi.fn()}
          onReplyToThread={vi.fn().mockResolvedValue(undefined)}
          onRemoveMessage={vi.fn()}
          onUpdateMessage={vi.fn()}
        />,
      );

    const { unmount } = renderCard(true);
    expect(screen.getByTestId('responding-chip')).toHaveTextContent('응답 중');
    expect(screen.queryByTestId('review-state-chip')).not.toBeInTheDocument();
    unmount();
    renderCard(false);
    expect(screen.getByTestId('review-state-chip')).toHaveTextContent('답변 대기');
    expect(screen.queryByTestId('responding-chip')).not.toBeInTheDocument();
  });

  it('bounces three dots one after another in the responding chip and holds them still under reduced motion', () => {
    render(
      <CommentThreadCard
        thread={mockThread}
        review={{ ...awaitingReview, state: 'awaiting-fix', pendingFixups: [], responding: true }}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    const dots = screen.getAllByTestId('responding-dot');
    expect(dots).toHaveLength(3);
    expect(dots.map((dot) => dot.style.animationDelay)).toEqual(['0ms', '150ms', '300ms']);
    for (const dot of dots) {
      expect(dot).toHaveClass('animate-responding-dot', 'motion-reduce:animate-none');
    }
    expect(screen.getByTestId('responding-chip')).toHaveTextContent('응답 중');
  });

  it('marks a stale review thread visibly while keeping its state chip and decision buttons', () => {
    render(
      <CommentThreadCard
        thread={{ ...mockThread, isOutdated: true, outdatedReason: 'ambiguous' }}
        review={awaitingReview}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    const badge = screen.getByLabelText('Outdated comment');
    expect(badge).toHaveTextContent('낡음');
    expect(badge.getAttribute('title')).toContain('여러 곳');
    expect(screen.getByTestId('review-state-chip')).toHaveTextContent('승인 대기');
    expect(screen.getByRole('button', { name: '승인' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '거절' })).toBeInTheDocument();
  });

  it('offers to reopen the review at the anchor commit only on a stale thread made elsewhere', async () => {
    const user = userEvent.setup();
    const onOpenReviewAt = vi.fn();
    const staleThread = { ...mockThread, isOutdated: true, outdatedReason: 'missing' as const };
    const renderCard = (thread: CommentThread) => (
      <CommentThreadCard
        thread={thread}
        review={{ ...awaitingReview, onOpenReviewAt }}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />
    );
    const reopenButton = () => screen.queryByRole('button', { name: '이 지적을 달던 시점으로' });

    const { rerender } = render(renderCard({ ...staleThread, anchorCommit: '6e4f6d5' }));
    await user.click(screen.getByRole('button', { name: '이 지적을 달던 시점으로' }));
    expect(onOpenReviewAt).toHaveBeenCalledWith('6e4f6d5');

    rerender(renderCard({ ...mockThread, anchorCommit: '6e4f6d5' }));
    expect(reopenButton()).not.toBeInTheDocument();

    rerender(renderCard({ ...staleThread, anchorCommit: 'b7c2e10' }));
    expect(reopenButton()).not.toBeInTheDocument();

    rerender(renderCard({ ...staleThread, anchorCommit: 'b7c2e10' + '0'.repeat(33) }));
    expect(reopenButton()).not.toBeInTheDocument();

    rerender(renderCard(staleThread));
    expect(reopenButton()).not.toBeInTheDocument();
  });

  it('takes a stale thread back to the view it was made on, in place of reopening the review', async () => {
    const user = userEvent.setup();
    const onShowView = vi.fn();
    const onOpenReviewAt = vi.fn();
    const madeView = { baseCommitish: 'a'.repeat(40), targetCommitish: '6e4f6d5'.padEnd(40, '0') };
    const renderCard = (thread: CommentThread) => (
      <CommentThreadCard
        thread={thread}
        review={{ ...awaitingReview, onOpenReviewAt, onShowView }}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />
    );
    const madeViewButton = () => screen.queryByRole('button', { name: '이 지적을 단 화면으로' });
    const staleThread = {
      ...mockThread,
      isOutdated: true,
      outdatedReason: 'missing' as const,
      anchorCommit: madeView.targetCommitish,
      madeView,
    };

    const { rerender } = render(renderCard(staleThread));
    expect(
      screen.queryByRole('button', { name: '이 지적을 달던 시점으로' }),
    ).not.toBeInTheDocument();
    await user.click(madeViewButton()!);
    expect(onShowView).toHaveBeenCalledWith(madeView);
    expect(onOpenReviewAt).not.toHaveBeenCalled();

    rerender(renderCard({ ...staleThread, isOutdated: false }));
    expect(madeViewButton()).not.toBeInTheDocument();
  });

  it('names the commit a fix for the thread goes into', () => {
    const renderCard = (thread: CommentThread) => (
      <CommentThreadCard
        thread={thread}
        review={awaitingReview}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />
    );

    const { rerender } = render(
      renderCard({ ...mockThread, fixupCommit: { shortSha: '1111111', subject: 'first step' } }),
    );
    expect(screen.getByText('1111111')).toHaveAttribute('title', 'first step');
    expect(screen.queryByText('고쳐 넣을 커밋')).not.toBeInTheDocument();
    expect(screen.queryByText('first step')).not.toBeInTheDocument();

    rerender(renderCard(mockThread));
    expect(screen.queryByText('1111111')).not.toBeInTheDocument();
  });

  describe('choices in the agent’s reply', () => {
    const offered: CommentThread = {
      ...mockThread,
      messages: [
        mockThread.messages[0]!,
        {
          ...mockThread.messages[1]!,
          author: 'Claude',
          body: '하나를 골라 주세요.',
          choices: [
            { id: 'A', name: '불리언', description: '단순합니다.' },
            { id: 'B', name: '묶음', description: '넓힐 수 있습니다.', recommended: true },
          ],
        },
      ],
    };
    const renderCard = (
      thread: CommentThread,
      onReplyToThread = vi.fn().mockResolvedValue(undefined),
      review?: Parameters<typeof CommentThreadCard>[0]['review'],
    ) =>
      render(
        <CommentThreadCard
          thread={thread}
          {...(review ? { review } : {})}
          onResolveThread={vi.fn()}
          onReplyToThread={onReplyToThread}
          onRemoveMessage={vi.fn()}
          onUpdateMessage={vi.fn()}
        />,
      );
    const radio = (name: RegExp) => screen.getByRole('radio', { name });

    it('shows the thread as the reviewer’s pick in yellow', () => {
      renderCard(offered);

      const chip = screen.getByTestId('review-state-chip');
      expect(chip).toHaveTextContent('선택 대기');
      expect(chip).toHaveClass('text-github-warning');
    });

    it('shows the pick state on a pinned review too', () => {
      renderCard(offered, undefined, { ...awaitingReview, state: 'choosing', pendingFixups: [] });

      expect(screen.getByTestId('review-state-chip')).toHaveTextContent('선택 대기');
    });

    it('replies with the pick and the choice it answers', async () => {
      const user = userEvent.setup();
      const onReplyToThread = vi.fn().mockResolvedValue(undefined);
      renderCard(offered, onReplyToThread);

      await user.click(radio(/묶음/));

      expect(onReplyToThread).toHaveBeenCalledWith('thread-1', '고름: B — 묶음', {
        messageId: 'message-2',
        choice: 'B',
      });
    });

    it('turns the cards aside once the reviewer answers in the reply box', async () => {
      const user = userEvent.setup();
      const onReplyToThread = vi.fn().mockResolvedValue(undefined);
      const { rerender } = renderCard(offered, onReplyToThread);

      await user.click(screen.getByRole('button', { name: 'Write a reply...' }));
      await user.type(screen.getByPlaceholderText('Write a reply...'), '둘 다 받으면 안 되나요?');
      await user.click(screen.getByRole('button', { name: 'Reply' }));
      expect(onReplyToThread).toHaveBeenCalledWith('thread-1', '둘 다 받으면 안 되나요?');
      rerender(
        <CommentThreadCard
          thread={{
            ...offered,
            messages: [
              ...offered.messages,
              { ...mockThread.messages[0]!, id: 'message-3', body: '둘 다 받으면 안 되나요?' },
            ],
          }}
          onResolveThread={vi.fn()}
          onReplyToThread={onReplyToThread}
          onRemoveMessage={vi.fn()}
          onUpdateMessage={vi.fn()}
        />,
      );

      expect(screen.getByText(/글로 답했습니다/)).toBeVisible();
      expect(screen.getByRole('button', { name: '그래도 고르기' })).toBeVisible();
      expect(screen.queryByTestId('review-state-chip')).not.toBeInTheDocument();
    });

    it('offers no edit on a pick reply, only on a reply in words', () => {
      renderCard({
        ...offered,
        messages: [
          ...offered.messages,
          {
            ...mockThread.messages[0]!,
            id: 'message-3',
            body: '고름: B — 묶음',
            answer: { messageId: 'message-2', choice: 'B' },
          },
          { ...mockThread.messages[0]!, id: 'message-4', body: '테스트도 같이 바꿔 주세요.' },
        ],
      });

      expect(screen.getAllByRole('button', { name: 'Edit message' })).toHaveLength(2);
      expect(screen.getAllByRole('button', { name: 'Delete reply' })).toHaveLength(2);
    });
  });

  it('always shows an inline reply trigger below the last message', () => {
    render(
      <CommentThreadCard
        thread={mockThread}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Write a reply...' })).toBeInTheDocument();
  });

  it('expands the reply trigger into a reply form and submits a reply', async () => {
    const user = userEvent.setup();
    const onReplyToThread = vi.fn().mockResolvedValue(undefined);

    render(
      <CommentThreadCard
        thread={mockThread}
        onResolveThread={vi.fn()}
        onReplyToThread={onReplyToThread}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Write a reply...' }));

    const textarea = screen.getByPlaceholderText('Write a reply...');
    expect(textarea).toHaveFocus();

    await user.type(textarea, 'A new reply');
    await user.click(screen.getByRole('button', { name: 'Reply' }));

    expect(onReplyToThread).toHaveBeenCalledWith('thread-1', 'A new reply');
    // Collapses back to the trigger after submitting
    expect(screen.getByRole('button', { name: 'Write a reply...' })).toBeInTheDocument();
  });

  it('collapses the reply form back to the trigger on cancel', async () => {
    const user = userEvent.setup();

    render(
      <CommentThreadCard
        thread={mockThread}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Write a reply...' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByPlaceholderText('Write a reply...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Write a reply...' })).toBeInTheDocument();
  });

  it('shows an inline confirmation before deleting a user-authored reply', async () => {
    const user = userEvent.setup();
    const onRemoveMessage = vi.fn();

    render(
      <CommentThreadCard
        thread={{
          ...mockThread,
          messages: [
            mockThread.messages[0]!,
            {
              ...mockThread.messages[1]!,
              author: 'User',
            },
          ],
        }}
        onResolveThread={vi.fn()}
        onReplyToThread={vi.fn().mockResolvedValue(undefined)}
        onRemoveMessage={onRemoveMessage}
        onUpdateMessage={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle('Delete reply'));

    expect(onRemoveMessage).not.toHaveBeenCalled();
    expect(screen.getByText('Delete?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onRemoveMessage).toHaveBeenCalledWith('thread-1', 'message-2');
  });
});
