import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
