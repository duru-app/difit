import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';

import type {
  DiffCommentThread,
  DiffResponse,
  DiffSelection,
  RewriteBlockingThread,
} from '../types/diff';

import App from './App';

const full = (short: string) => short.padEnd(40, '0');
const FIRST = {
  sha: full('1111111'),
  shortSha: '1111111',
  parentSha: full('def4567'),
  subject: 'first step',
};
const SECOND = {
  sha: full('abc1234'),
  shortSha: 'abc1234',
  parentSha: FIRST.sha,
  subject: 'second step',
};
const SHOWN: DiffSelection = { baseCommitish: FIRST.parentSha, targetCommitish: SECOND.sha };
const EARLIER: DiffSelection = { baseCommitish: FIRST.parentSha, targetCommitish: FIRST.sha };

const reviewAt = (requested: DiffSelection, commits: (typeof FIRST)[]): DiffResponse => ({
  commit: requested.targetCommitish.slice(0, 7),
  baseCommitish: requested.baseCommitish.slice(0, 7),
  targetCommitish: requested.targetCommitish.slice(0, 7),
  requestedBaseCommitish: requested.baseCommitish,
  requestedTargetCommitish: requested.targetCommitish,
  files: [
    {
      path: 'test.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      chunks: [
        {
          header: '@@ -1,1 +1,1 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [{ type: 'add', content: 'const a = 1;', newLineNumber: 1 }],
        },
      ],
    },
  ],
  ignoreWhitespace: false,
  isEmpty: false,
  directEditAvailable: true,
  review: {
    selection: {
      baseCommitish: requested.baseCommitish.slice(0, 7),
      targetCommitish: requested.targetCommitish.slice(0, 7),
    },
    requested,
    commits,
  },
});

const earlierThread: DiffCommentThread = {
  id: 'on-the-earlier-review',
  filePath: 'test.ts',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  position: { side: 'new', line: 1 },
  codeSnapshot: { content: 'const a = 1;', commit: FIRST.sha },
  messages: [
    {
      id: 'on-the-earlier-review',
      body: 'Kept on the earlier review',
      author: 'User',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};

const blocking: RewriteBlockingThread = {
  threadId: earlierThread.id,
  review: EARLIER,
  commit: { shortSha: FIRST.shortSha, subject: FIRST.subject },
  file: 'test.ts',
  line: 1,
};

const COMMENTS_DELAY_MS = 300;

function stubServer() {
  vi.mocked(global.fetch).mockImplementation(async (input) => {
    const url = String(input);
    const params = new URLSearchParams(url.split('?')[1]);
    const reply = (body: unknown, status = 200) =>
      ({ ok: status < 300, status, json: async () => body }) as Response;

    if (url.startsWith('/api/comments-json')) {
      if (params.get('target') !== SHOWN.targetCommitish.slice(0, 7)) {
        await new Promise((resolve) => setTimeout(resolve, COMMENTS_DELAY_MS));
        return reply({ version: 1, threads: [earlierThread], decisions: [] });
      }
      return reply({ version: 1, threads: [], decisions: [] });
    }
    if (url.startsWith('/api/comments')) return reply({ version: 2, merged: false });
    if (url.startsWith('/api/commit-message')) return reply({ message: FIRST.subject });
    if (url.startsWith('/api/reword')) {
      return reply(
        {
          error: 'Reword refused: agent-working',
          reason: 'agent-working',
          blockingThreads: [blocking],
        },
        409,
      );
    }
    if (url.startsWith('/api/fixups')) return reply({ fixups: [] });
    if (url.startsWith('/api/revisions')) return reply(null);
    if (url.startsWith('/api/diff')) {
      return reply(
        params.get('target') === EARLIER.targetCommitish
          ? reviewAt(EARLIER, [FIRST])
          : reviewAt(SHOWN, [FIRST, SECOND]),
      );
    }
    return reply({});
  });
}

describe('App - going to a comment that blocks saving a message', { timeout: 15_000 }, () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    stubServer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '');
  });

  it('lands on the card of another review this browser never showed, after its comments arrive late', async () => {
    const realRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        return this.id === `comment-thread-${earlierThread.id}`
          ? ({ top: 1500, bottom: 1600, left: 0, right: 0, height: 100, width: 0 } as DOMRect)
          : realRect.call(this);
      },
    );
    const scrolls = vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => {});
    render(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <App />
      </HotkeysProvider>,
    );
    const commits = await screen.findByRole(
      'region',
      { name: '리뷰 범위의 커밋' },
      { timeout: 5000 },
    );
    const row = within(commits)
      .getByRole('button', { name: /1111111/ })
      .closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: '메시지 고치기' }));
    fireEvent.change(await within(row).findByRole('textbox', { name: '커밋 메시지' }), {
      target: { value: 'first step, renamed' },
    });
    fireEvent.click(within(row).getByRole('button', { name: '저장' }));
    const link = within(await within(row).findByRole('alert')).getByRole('button', {
      name: /1111111 first step ← test\.ts:1/,
    });

    await act(async () => {
      fireEvent.click(link);
    });

    const card = await waitFor(
      () => {
        const found = document.getElementById(`comment-thread-${earlierThread.id}`);
        expect(found).toHaveAttribute('data-picked', 'true');
        return found!;
      },
      { timeout: 3000 },
    );
    expect(card).toHaveTextContent('Kept on the earlier review');
    await waitFor(() =>
      expect(scrolls.mock.calls.some(([options]) => (options as ScrollToOptions).top! > 0)).toBe(
        true,
      ),
    );
  });
});
