import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';

import type { DiffCommentThread, DiffResponse, ReviewDecision, ThreadFixup } from '../types/diff';

import App from './App';

// Real hooks throughout: only the network (fetch, WebSocket) is faked.

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  static watchConnections() {
    return MockWebSocket.instances.filter((socket) => new URL(socket.url).pathname === '/api/live');
  }
}

const TARGET = 'abc1234';
const THREAD_ID = 'thread-1';

const diffResponse: DiffResponse = {
  commit: TARGET,
  baseCommitish: `${TARGET}^`,
  targetCommitish: TARGET,
  requestedBaseCommitish: `${TARGET}^`,
  requestedTargetCommitish: TARGET,
  files: [
    {
      path: 'test.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      chunks: [
        {
          header: '@@ -1,2 +1,3 @@',
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [
            { type: 'normal', content: 'const a = 1;', oldLineNumber: 1, newLineNumber: 1 },
            { type: 'add', content: 'const b = 2;', newLineNumber: 2 },
            { type: 'normal', content: 'const c = 3;', oldLineNumber: 2, newLineNumber: 3 },
          ],
        },
      ],
    },
  ],
  ignoreWhitespace: false,
  isEmpty: false,
};

const thread: DiffCommentThread = {
  id: THREAD_ID,
  filePath: 'test.ts',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  position: { side: 'new', line: 2 },
  codeSnapshot: { content: 'const b = 2;', language: 'typescript', commit: TARGET },
  messages: [
    {
      id: THREAD_ID,
      body: 'Rename b',
      author: 'User',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};

const fixup: ThreadFixup = {
  sha: 'f'.repeat(40),
  shortSha: 'fffffff',
  patchId: 'patch-1',
  authoredAt: '2026-01-01T00:00:00Z',
  subject: 'fixup! rename b',
  threadIds: [THREAD_ID],
  files: [
    {
      path: 'test.ts',
      status: 'modified',
      chunks: [
        {
          header: '@@ -2,1 +2,1 @@',
          oldStart: 2,
          oldLines: 1,
          newStart: 2,
          newLines: 1,
          lines: [
            { type: 'delete', content: 'const b = 2;', oldLineNumber: 2 },
            { type: 'add', content: 'const renamed = 2;', newLineNumber: 2 },
          ],
        },
      ],
    },
  ],
};

let server: { version: number; threads: DiffCommentThread[]; decisions: ReviewDecision[] };
let serverFixups: ThreadFixup[];

const callsTo = (prefix: string, method?: string) =>
  vi
    .mocked(global.fetch)
    .mock.calls.filter(
      ([url, init]) => String(url).startsWith(prefix) && (!method || init?.method === method),
    );

function stubServer() {
  vi.mocked(global.fetch).mockImplementation((input, init) => {
    const url = String(input);
    const reply = (body: unknown) =>
      Promise.resolve({ ok: true, json: async () => body } as Response);

    if (url.startsWith('/api/comments-json')) {
      return reply(server);
    }
    if (url.startsWith('/api/comments') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        threads: DiffCommentThread[];
        decisions?: ReviewDecision[];
      };
      server = {
        version: server.version + 1,
        threads: body.threads,
        decisions: body.decisions ?? server.decisions,
      };
      return reply({ version: server.version, merged: false });
    }
    if (url.startsWith('/api/fixups')) {
      return reply({ fixups: serverFixups });
    }
    if (url.startsWith('/api/revisions')) {
      return reply(null);
    }
    return reply(diffResponse);
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

async function renderReview() {
  render(
    <HotkeysProvider initiallyActiveScopes={['navigation']}>
      <App />
    </HotkeysProvider>,
  );
  await screen.findByRole('button', { name: '승인' }, { timeout: 5000 });
  await settle();
}

const openWatch = () => MockWebSocket.watchConnections().at(-1);

async function sendCommentsChanged() {
  const readsBefore = callsTo('/api/comments-json').length;
  act(() => {
    openWatch()?.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'commentsChanged', version: server.version }),
      }),
    );
  });
  await waitFor(() => expect(callsTo('/api/comments-json')).toHaveLength(readsBefore + 1));
  await settle();
}

describe('App - live comment sync', { timeout: 15_000 }, () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.stubGlobal('WebSocket', MockWebSocket);
    MockWebSocket.instances = [];
    server = { version: 1, threads: [thread], decisions: [] };
    serverFixups = [fixup];
    stubServer();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps one connection to the server for a loaded review', async () => {
    await renderReview();

    expect(MockWebSocket.watchConnections()).toHaveLength(1);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it.each(['승인', '거절'])('keeps the watch connection when %s is pressed', async (label) => {
    await renderReview();
    const watch = openWatch();

    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(server.decisions).toHaveLength(1));
    await sendCommentsChanged();

    expect(openWatch()).toBe(watch);
    expect(watch?.close).not.toHaveBeenCalled();
  });

  it('keeps the watch connection when the server changes comments and decisions', async () => {
    await renderReview();
    const watch = openWatch();

    server = {
      version: server.version + 1,
      threads: [{ ...thread, updatedAt: '2026-01-02T00:00:00.000Z' }],
      decisions: [
        { threadId: THREAD_ID, kind: 'approved', fixupSha: fixup.sha, at: '2026-01-02T00:00:00Z' },
      ],
    };
    await sendCommentsChanged();
    await screen.findByTestId('resolved-chip');

    expect(openWatch()).toBe(watch);
    expect(watch?.close).not.toHaveBeenCalled();
  });

  it('shows a fixup committed while the review is open once the server says HEAD moved', async () => {
    serverFixups = [];
    render(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <App />
      </HotkeysProvider>,
    );
    await waitFor(() => expect(callsTo('/api/fixups')).toHaveLength(1), { timeout: 5000 });
    await settle();
    expect(screen.queryByRole('button', { name: '승인' })).not.toBeInTheDocument();

    serverFixups = [fixup];
    act(() => {
      openWatch()?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'headMoved', timestamp: '2026-01-02T00:00:00Z' }),
        }),
      );
    });

    expect(await screen.findByRole('button', { name: '승인' })).toBeInTheDocument();
  });

  it('posts nothing when the server sends back the comments and decisions it already has', async () => {
    server.decisions = [
      {
        threadId: THREAD_ID,
        kind: 'rejected',
        fixupSha: 'e'.repeat(40),
        at: '2026-01-02T00:00:00Z',
      },
    ];
    await renderReview();
    const postsBefore = callsTo('/api/comments', 'POST').length;

    server = { ...server, version: server.version + 1 };
    await sendCommentsChanged();

    expect(callsTo('/api/comments', 'POST')).toHaveLength(postsBefore);
  });
});
