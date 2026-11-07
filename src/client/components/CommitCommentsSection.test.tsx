import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';

import type { CommitThreadView, ReviewCommit, ThreadFixup } from '../../types/diff';
import { EMPTY_FIXUP_OVERLAY } from '../contexts/FixupOverlayContext';

import { CommitCommentsSection } from './CommitCommentsSection';

const FIRST: ReviewCommit = {
  sha: '1'.repeat(40),
  shortSha: '1111111',
  parentSha: '0'.repeat(40),
  subject: 'first step',
};

const onCommit = (commit: string, body: string): CommitThreadView => ({
  id: `${commit.slice(0, 7)}-${body}`,
  commit,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  messages: [
    {
      id: `${commit.slice(0, 7)}-${body}`,
      body,
      author: 'User',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ],
});

const section = (props: Partial<Parameters<typeof CommitCommentsSection>[0]>) => (
  <CommitCommentsSection
    commits={[FIRST]}
    threads={[]}
    fixupOverlay={EMPTY_FIXUP_OVERLAY}
    showAuthorBadges={false}
    onResolveThread={vi.fn()}
    onReplyToThread={vi.fn()}
    onRemoveMessage={vi.fn()}
    onUpdateMessage={vi.fn()}
    {...props}
  />
);

const renderSection = (props: Partial<Parameters<typeof CommitCommentsSection>[0]>) =>
  render(section(props));

describe('CommitCommentsSection', () => {
  describe('buttons for touch devices', () => {
    const SECOND: ReviewCommit = { ...FIRST, sha: '2'.repeat(40), shortSha: '2222222' };
    const reword = {
      load: vi.fn(async () => 'first step'),
      save: vi.fn(async () => ({ saved: true as const, movedBranches: [] })),
    };
    const touchButton = (name: string) => screen.getByRole('button', { name });
    const expectTouchOnly = (button: HTMLElement) =>
      expect(button.className.split(' ')).toEqual(
        expect.arrayContaining(['hidden', '[@media(hover:none)]:flex', 'size-[40px]']),
      );

    afterEach(() => vi.useRealTimers());

    it('shows copy and message editing to touch devices only, each 40px wide', () => {
      renderSection({ onAddComment: vi.fn(async () => {}), reword });

      expectTouchOnly(touchButton('해시 복사'));
      expectTouchOnly(touchButton('메시지 고치기'));
      const add = touchButton('이 커밋 전체에 지적 달기');
      expect(add.className.split(' ')).not.toContain('hidden');
      expect(add.className.split(' ')).toContain('[@media(hover:none)]:size-[40px]');
    });

    it('copies the same ten characters as the commit row and reads as copied for two seconds', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      vi.useFakeTimers();
      renderSection({ onAddComment: vi.fn(async () => {}) });

      await act(async () => {
        fireEvent.click(touchButton('해시 복사'));
      });
      expect(writeText).toHaveBeenCalledWith('1111111111');
      expect(touchButton('복사됨')).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(2000));
      expect(touchButton('해시 복사')).toBeInTheDocument();
    });

    it('opens the message editor under the buttons and closes it on a second tap', async () => {
      renderSection({ onAddComment: vi.fn(async () => {}), reword });

      fireEvent.click(touchButton('메시지 고치기'));
      expect(await screen.findByRole('textbox', { name: '커밋 메시지' })).toHaveValue('first step');
      expect(touchButton('메시지 고치기')).toHaveAttribute('aria-expanded', 'true');

      fireEvent.click(touchButton('메시지 고치기'));
      expect(screen.queryByRole('form', { name: '커밋 메시지 고치기' })).toBeNull();
    });

    it('does not carry the open message editor over to the next commit shown', async () => {
      const onAddComment = vi.fn(async () => {});
      const { rerender } = renderSection({ onAddComment, reword });
      fireEvent.click(touchButton('메시지 고치기'));
      await screen.findByRole('textbox', { name: '커밋 메시지' });

      rerender(section({ onAddComment, reword, commits: [SECOND] }));

      expect(screen.queryByRole('form', { name: '커밋 메시지 고치기' })).toBeNull();
    });

    it('offers no message editing on a merge commit or where the review cannot change messages', () => {
      const onAddComment = vi.fn(async () => {});
      const { rerender } = renderSection({
        onAddComment,
        reword,
        commits: [{ ...FIRST, isMerge: true }],
      });
      expect(screen.queryByRole('button', { name: '메시지 고치기' })).toBeNull();
      expect(touchButton('해시 복사')).toBeInTheDocument();

      rerender(section({ onAddComment }));
      expect(screen.queryByRole('button', { name: '메시지 고치기' })).toBeNull();
    });

    it('offers none of them when several commits are shown', () => {
      renderSection({
        onAddComment: vi.fn(async () => {}),
        reword,
        commits: [FIRST, SECOND],
        threads: [onCommit(FIRST.sha, 'first')],
      });

      expect(screen.queryByRole('button', { name: '해시 복사' })).toBeNull();
      expect(screen.queryByRole('button', { name: '메시지 고치기' })).toBeNull();
    });
  });

  it('draws nothing when no commit of the view has a comment and none can be added', () => {
    renderSection({});

    expect(screen.queryByRole('region', { name: '커밋 지적' })).toBeNull();
  });

  it('shows the body of the one commit shown when it can read messages', async () => {
    const loadMessage = vi.fn(async () => 'first step\n\nWhy it is needed.');
    renderSection({ loadMessage });

    const region = screen.getByRole('region', { name: '커밋 지적' });
    expect(await within(region).findByText('Why it is needed.')).toBeInTheDocument();
    expect(loadMessage).toHaveBeenCalledExactlyOnceWith(FIRST.sha);
  });

  it('shows the message an amend! will leave on the one commit shown', () => {
    const loadMessage = vi.fn(async () => 'first step');
    renderSection({
      loadMessage,
      amendedMessages: new Map([[FIRST.sha, 'first step, renamed\n\nWhy.']]),
    });

    expect(screen.getByText('바뀔 메시지')).toBeInTheDocument();
    expect(loadMessage).not.toHaveBeenCalled();
  });

  it('shows no body while several commits are shown', () => {
    const loadMessage = vi.fn(async () => 'step');
    renderSection({
      commits: [FIRST, { ...FIRST, sha: '2'.repeat(40), shortSha: '2222222', subject: 'second' }],
      loadMessage,
    });

    expect(screen.queryByRole('region', { name: '커밋 지적' })).toBeNull();
    expect(loadMessage).not.toHaveBeenCalled();
  });

  it('does not carry an open form over to the next commit shown', () => {
    const onAddComment = vi.fn(async () => {});
    const { rerender } = renderSection({ onAddComment });
    fireEvent.click(screen.getByRole('button', { name: '이 커밋 전체에 지적 달기' }));
    expect(screen.getByPlaceholderText(/comment/i)).toBeInTheDocument();

    const next = { ...FIRST, sha: '2'.repeat(40), shortSha: '2222222' };
    rerender(section({ onAddComment, commits: [next] }));

    expect(screen.queryByPlaceholderText(/comment/i)).toBeNull();
  });

  it('draws the fixup answering a comment above its card', () => {
    const thread = onCommit(FIRST.sha, 'Split this commit');
    const fixup: ThreadFixup = {
      sha: 'f'.repeat(40),
      shortSha: 'fffffff',
      patchId: 'patch-fffffff',
      authoredAt: '2026-01-01T00:00:00Z',
      subject: 'fixup! first step',
      threadIds: [thread.id],
      files: [],
    };
    renderSection({
      threads: [thread],
      fixupOverlay: {
        ...EMPTY_FIXUP_OVERLAY,
        enabled: true,
        fixupsByThread: new Map([[thread.id, [fixup]]]),
      },
    });

    const section = screen.getByRole('region', { name: '커밋 지적' });
    expect(within(section).getByTestId('fixup-overlay-card')).toHaveTextContent('fffffff');
  });

  it('keeps a comment whose commit is not on the list, under its short sha', () => {
    const gone = 'abcdef0'.padEnd(40, '0');
    renderSection({
      threads: [onCommit(FIRST.sha, 'On the first'), onCommit(gone, 'On a rewritten commit')],
    });

    const section = screen.getByRole('region', { name: '커밋 지적' });
    expect(within(section).getByText('On the first')).toBeInTheDocument();
    expect(within(section).getByText('On a rewritten commit')).toBeInTheDocument();
    expect(within(section).getAllByText('커밋 abcdef0').length).toBeGreaterThan(0);
  });
});
