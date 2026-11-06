import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import '@testing-library/jest-dom';

import { mockFetch } from '../../vitest.setup';
import type {
  DiffCommentThread,
  DiffResponse,
  FileCommentThread,
  ReviewDecision,
} from '../types/diff';
import type { ClientWatchState } from '../types/watch';
import { DiffMode } from '../types/watch';
import { mergeCommentImports, parseCommentImportValue } from '../utils/commentImports';

import App from './App';
import { useDiffComments } from './hooks/useDiffComments';
import { useViewedFiles } from './hooks/useViewedFiles';
import { useViewport } from './hooks/useViewport';
import { resetClientSettingsForTests } from './services/userSettings';
import { fixupFileElementId, getFileElementId } from './utils/domUtils';
import { spreadFixups } from './utils/fixupSpread';
import { placeThread } from './utils/outdatedComments';

vi.mock('./utils/outdatedComments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/outdatedComments')>();
  return { ...actual, placeThread: vi.fn(actual.placeThread) };
});

vi.mock('./utils/fixupSpread', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/fixupSpread')>();
  return { ...actual, spreadFixups: vi.fn(actual.spreadFixups) };
});

let forcedFileScrolledPast: boolean | undefined;
const mockScrollFileIntoDiffContainer = vi.fn();
vi.mock('./hooks/useLazyDiffRendering', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hooks/useLazyDiffRendering')>();
  return {
    ...actual,
    useLazyDiffRendering: (...args: Parameters<typeof actual.useLazyDiffRendering>) => {
      const real = actual.useLazyDiffRendering(...args);
      return {
        ...real,
        isFileScrolledPastContainerTop: (filePath: string) =>
          forcedFileScrolledPast ?? real.isFileScrolledPastContainerTop(filePath),
        scrollFileIntoDiffContainer: (
          ...scrollArgs: Parameters<typeof real.scrollFileIntoDiffContainer>
        ) => {
          mockScrollFileIntoDiffContainer(...scrollArgs);
          real.scrollFileIntoDiffContainer(...scrollArgs);
        },
      };
    },
  };
});

// Mock the useViewport hook
vi.mock('./hooks/useViewport', () => ({
  useViewport: vi.fn(() => ({ isMobile: false, isDesktop: true })),
}));

// Mock the useDiffComments hook
vi.mock('./hooks/useDiffComments', () => ({
  useDiffComments: vi.fn(() => ({
    hasLoadedComments: true,
    comments: [],
    threads: mockComments,
    decisions: mockDecisions,
    replaceThreads: mockReplaceThreads,
    mergeDecisions: mockMergeDecisions,
    addComment: vi.fn(),
    addThread: vi.fn(),
    removeComment: vi.fn(),
    removeThread: vi.fn(),
    removeMessage: vi.fn(),
    replyToThread: vi.fn(),
    updateComment: vi.fn(),
    updateMessage: vi.fn(),
    clearAllComments: mockClearAllComments,
    applyCommentImports: mockApplyCommentImports,
    generatePrompt: vi.fn(),
    generateAllCommentsPrompt: mockGenerateAllCommentsPrompt,
  })),
}));

// Mock the useViewedFiles hook
const mockClearViewedFiles = vi.fn();
const mockToggleFileViewed = vi.fn();
let mockViewedFiles = new Set<string>();
let mockHasLoadedInitialViewedFiles = true;
vi.mock('./hooks/useViewedFiles', () => ({
  useViewedFiles: vi.fn(() => ({
    viewedFiles: mockViewedFiles,
    changedSinceViewedFiles: new Set<string>(),
    hasLoadedInitialViewedFiles: mockHasLoadedInitialViewedFiles,
    toggleFileViewed: mockToggleFileViewed,
    isFileContentChanged: vi.fn(),
    getViewedFileRecord: vi.fn(),
    clearViewedFiles: mockClearViewedFiles,
  })),
}));

const mockWatchState: ClientWatchState = {
  isWatchEnabled: true,
  diffMode: DiffMode.DEFAULT,
  shouldReload: false,
  isReloading: false,
  lastChangeTime: null,
  lastChangeType: null,
  connectionStatus: 'connected',
};

vi.mock('./hooks/useFileWatch', () => ({
  useFileWatch: vi.fn((onReload?: () => Promise<void>) => ({
    shouldReload: mockWatchState.shouldReload,
    isConnected: true,
    error: null,
    reload: vi.fn(async () => {
      if (onReload) {
        await onReload();
      }
      mockWatchState.shouldReload = false;
      mockWatchState.lastChangeType = null;
    }),
    watchState: mockWatchState,
  })),
}));

// Mock navigator.sendBeacon
Object.defineProperty(navigator, 'sendBeacon', {
  writable: true,
  value: vi.fn(),
});

// Mock window.confirm
const mockConfirm = vi.fn();
Object.defineProperty(window, 'confirm', {
  writable: true,
  value: mockConfirm,
});

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  url: string;

  static clearInstances() {
    MockWebSocket.instances = [];
  }
}
Object.defineProperty(window, 'WebSocket', {
  writable: true,
  value: MockWebSocket,
});

let mockComments: DiffCommentThread[] = [];
let mockDecisions: ReviewDecision[] = [];
const mockReplaceThreads = vi.fn();
const mockMergeDecisions = vi.fn();
const mockClearAllComments = vi.fn();
const mockApplyCommentImports = vi.fn(() => []);
const mockGenerateAllCommentsPrompt = vi.fn(() => 'formatted prompt');

function createMockThread({
  id,
  filePath,
  line,
  body,
  author = 'User',
}: {
  id: string;
  filePath: string;
  line: number;
  body: string;
  author?: string;
}): FileCommentThread {
  const timestamp = '2024-01-01T00:00:00.000Z';
  return {
    id,
    filePath,
    createdAt: timestamp,
    updatedAt: timestamp,
    position: { side: 'new', line },
    messages: [
      {
        id,
        body,
        author,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

// Helper to render App with HotkeysProvider
const renderApp = () => {
  return render(
    <HotkeysProvider initiallyActiveScopes={['navigation']}>
      <App />
    </HotkeysProvider>,
  );
};

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllEnvs();
  MockWebSocket.clearInstances();
  mockViewedFiles = new Set<string>();
  mockHasLoadedInitialViewedFiles = true;
  mockReplaceThreads.mockReset();
  mockGenerateAllCommentsPrompt.mockClear();
});

const mockDiffResponse: DiffResponse = {
  commit: 'abc123',
  baseCommitish: 'HEAD^',
  targetCommitish: 'HEAD',
  requestedBaseCommitish: 'HEAD^',
  requestedTargetCommitish: 'HEAD',
  files: [
    {
      path: 'test.ts',
      status: 'modified',
      additions: 5,
      deletions: 2,
      chunks: [],
    },
  ],
  ignoreWhitespace: false,
  isEmpty: false,
};

const linedFile = (path: string, count: number): DiffResponse['files'][number] => ({
  path,
  status: 'modified',
  additions: 0,
  deletions: 0,
  chunks: [
    {
      header: `@@ -1,${count} +1,${count} @@`,
      oldStart: 1,
      oldLines: count,
      newStart: 1,
      newLines: count,
      lines: Array.from({ length: count }, (_, index) => ({
        type: 'normal' as const,
        content: `line ${index + 1}`,
        oldLineNumber: index + 1,
        newLineNumber: index + 1,
      })),
    },
  ],
});

const commentsPanel = () => document.getElementById('comments-panel');
const commentsPanelBox = () => document.querySelector<HTMLElement>('[data-comments-panel-box]')!;
const fileListBox = () => document.getElementById('file-tree-panel')!.parentElement!;
const diffColumn = () => document.querySelector('main')!;
// happy-dom does no layout, so a test states the widths the browser would give.
const layOut = (widths: { row: number; diff: number; fileList?: number; comments?: number }) => {
  const set = (element: Element, width: number) =>
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, width, 0));
  set(diffColumn().parentElement!, widths.row);
  set(diffColumn(), widths.diff);
  if (widths.fileList !== undefined) set(fileListBox(), widths.fileList);
  if (widths.comments !== undefined) set(commentsPanelBox(), widths.comments);
};
const commentsPanelHasFocus = () => commentsPanel()?.contains(document.activeElement) ?? false;
const fileListHasFocus = () =>
  document.getElementById('file-tree-panel')?.contains(document.activeElement) ?? false;
const pressShiftB = () => userEvent.keyboard('{Shift>}B{/Shift}');
const diffMain = async () => within(await screen.findByRole('main'));

const pinnedDiffResponse: DiffResponse = {
  ...mockDiffResponse,
  baseCommitish: 'abc1234^',
  targetCommitish: 'abc1234',
  requestedBaseCommitish: 'abc1234^',
  requestedTargetCommitish: 'abc1234',
};

describe('App Component - Clear Comments Functionality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockDecisions = [];
    mockApplyCommentImports.mockReset();
    mockApplyCommentImports.mockReturnValue([]);
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
  });

  describe('Copy All Prompt Button', () => {
    it('should generate Copy All Prompt with requested and resolved diff context', async () => {
      mockComments = [
        createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'Test comment' }),
      ];
      mockFetch({
        ...mockDiffResponse,
        baseCommitish: 'abcdef1',
        targetCommitish: '1234567',
        requestedBaseCommitish: 'main',
        requestedTargetCommitish: 'feature/docs-update',
        requestedBaseMode: 'merge-base',
      });

      renderApp();

      fireEvent.click(await screen.findByText(/Copy All Prompt/));

      await waitFor(() => {
        expect(mockGenerateAllCommentsPrompt).toHaveBeenCalledWith(
          {
            requestedBaseCommitish: 'main',
            requestedTargetCommitish: 'feature/docs-update',
            baseMode: 'merge-base',
            resolvedBaseCommitish: 'abcdef1',
            resolvedTargetCommitish: '1234567',
          },
          mockComments,
        );
      });
    });

    it('should leave settled threads out and copy only the open ones', async () => {
      mockComments = [
        createMockThread({ id: 'open', filePath: 'test.ts', line: 10, body: 'Still open' }),
        createMockThread({ id: 'approved', filePath: 'test.ts', line: 20, body: 'Approved' }),
      ];
      mockDecisions = [
        { threadId: 'approved', kind: 'approved', fixupSha: 'aaaa', at: '2026-01-01T00:00:00Z' },
      ];

      renderApp();

      fireEvent.click(await screen.findByText('Copy All Prompt (1)'));

      await waitFor(() => {
        expect(mockGenerateAllCommentsPrompt).toHaveBeenCalledWith(expect.anything(), [
          mockComments[0],
        ]);
      });
    });

    it('should say there is nothing open and write nothing when every thread is settled', async () => {
      mockComments = [
        createMockThread({ id: 'approved', filePath: 'test.ts', line: 20, body: 'Approved' }),
      ];
      mockDecisions = [
        { threadId: 'approved', kind: 'approved', fixupSha: 'aaaa', at: '2026-01-01T00:00:00Z' },
      ];
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });

      renderApp();

      fireEvent.click(await screen.findByText(/Copy All Prompt/));

      expect(await screen.findByText('No open comments')).toBeInTheDocument();
      expect(mockGenerateAllCommentsPrompt).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
    });

    it('should show resolved threads again once none are left to hide', async () => {
      mockComments = [
        createMockThread({ id: 'settled', filePath: 'test.ts', line: 10, body: 'Settled' }),
      ];
      const at = (minute: number) => `2026-01-01T00:0${minute}:00Z`;
      const resolved = (minute: number): ReviewDecision => ({
        threadId: 'settled',
        kind: 'resolved',
        fixupSha: '',
        at: at(minute),
      });
      const reopened = (minute: number): ReviewDecision => ({
        threadId: 'settled',
        kind: 'unresolved',
        fixupSha: '',
        at: at(minute),
      });
      const showResolved = () => screen.queryByRole('checkbox', { name: '해결된 지적 보기' });
      mockDecisions = [resolved(0)];

      const { rerender } = renderApp();
      fireEvent.click(await screen.findByRole('checkbox', { name: '해결된 지적 보기' }));
      expect(showResolved()).toHaveAttribute('aria-checked', 'false');

      const app = () => (
        <HotkeysProvider initiallyActiveScopes={['navigation']}>
          <App />
        </HotkeysProvider>
      );
      mockDecisions = [resolved(0), reopened(1)];
      rerender(app());
      expect(showResolved()).not.toBeInTheDocument();

      mockDecisions = [reopened(1), resolved(2)];
      rerender(app());
      expect(showResolved()).toHaveAttribute('aria-checked', 'true');
    });

    it('treats an approved comment as resolved until it is reopened or the approval is undone', async () => {
      mockComments = [
        createMockThread({ id: 'approved', filePath: 'test.ts', line: 10, body: 'Fixed' }),
      ];
      const record = (kind: ReviewDecision['kind'], minute: number): ReviewDecision => ({
        threadId: 'approved',
        kind,
        fixupSha: kind === 'approved' ? 'aaaa' : '',
        at: `2026-01-01T00:0${minute}:00Z`,
      });
      const showResolved = () => screen.queryByRole('checkbox', { name: '해결된 지적 보기' });
      const app = () => (
        <HotkeysProvider initiallyActiveScopes={['navigation']}>
          <App />
        </HotkeysProvider>
      );
      mockDecisions = [record('approved', 0)];

      const { rerender } = renderApp();
      expect(await screen.findByRole('checkbox', { name: '해결된 지적 보기' })).toBeInTheDocument();

      mockDecisions = [record('approved', 0), record('unresolved', 1)];
      rerender(app());
      expect(showResolved()).not.toBeInTheDocument();

      mockDecisions = [record('approved', 0), record('unapproved', 1)];
      rerender(app());
      expect(showResolved()).not.toBeInTheDocument();
    });

    it('should not read fixups for a review that follows HEAD', async () => {
      mockComments = [
        createMockThread({ id: 'plain', filePath: 'test.ts', line: 10, body: 'Plain review' }),
      ];

      renderApp();

      await screen.findByText('Copy All Prompt (1)');
      expect(
        vi.mocked(global.fetch).mock.calls.some(([url]) => String(url).startsWith('/api/fixups')),
      ).toBe(false);
    });

    it('should not copy before the fixup list says which threads are answered', async () => {
      mockComments = [
        createMockThread({ id: 'answered', filePath: 'test.ts', line: 10, body: 'Answered' }),
      ];
      vi.mocked(global.fetch).mockImplementation((input) => {
        if (String(input).startsWith('/api/fixups')) return new Promise(() => {});
        if (String(input) === '/api/revisions') {
          return Promise.resolve({ ok: true, json: async () => null } as Response);
        }
        return Promise.resolve({
          ok: true,
          json: async () => pinnedDiffResponse,
          blob: async () => ({ size: 1024 }),
        } as Response);
      });

      renderApp();

      const button = await screen.findByText('Checking fixups…');
      fireEvent.click(button);

      expect(mockGenerateAllCommentsPrompt).not.toHaveBeenCalled();
    });
  });

  describe('Cleanup All Prompt Button', () => {
    it('should not show delete button when no comments exist', async () => {
      mockComments = [];

      renderApp();

      await waitFor(() => {
        // Cleanup All Prompt should not be visible without comments (dropdown doesn't exist)
        expect(screen.queryByText('Copy All Prompt')).not.toBeInTheDocument();
        expect(screen.queryByText('Cleanup All Prompt')).not.toBeInTheDocument();
      });
    });

    it('should show delete button when comments exist', async () => {
      mockComments = [
        createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'Test comment' }),
      ];

      renderApp();

      await waitFor(() => {
        // Find and click the dropdown toggle button (chevron)
        const dropdownToggle = screen.getByTitle('More options');
        fireEvent.click(dropdownToggle);
      });

      await waitFor(() => {
        expect(screen.getByText('Cleanup All Prompt')).toBeInTheDocument();
      });
    });

    it('should call clearAllComments immediately when delete button is clicked', async () => {
      mockComments = [
        createMockThread({ id: '1', filePath: 'test.ts', line: 10, body: 'Comment 1' }),
        createMockThread({ id: '2', filePath: 'test.ts', line: 20, body: 'Comment 2' }),
      ];

      renderApp();

      await waitFor(() => {
        // First, open the dropdown
        const dropdownToggle = screen.getByTitle('More options');
        fireEvent.click(dropdownToggle);
      });

      await waitFor(() => {
        const deleteButton = screen.getByText('Cleanup All Prompt');
        fireEvent.click(deleteButton);
      });

      expect(mockClearAllComments).toHaveBeenCalled();
    });
  });

  describe('Clean flag on Startup', () => {
    it('should clear existing comments for a clean run the browser has not seen', async () => {
      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        cleanRunId: 'run-1',
      };

      mockFetch(responseWithClearFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).toHaveBeenCalledWith({
          resetAppliedCommentImportIds: true,
        });
      });
    });

    it('should clear viewed files for a clean run the browser has not seen', async () => {
      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        cleanRunId: 'run-1',
      };

      mockFetch(responseWithClearFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearViewedFiles).toHaveBeenCalled();
      });
    });

    it('should not clear comments for a clean run the browser already applied', async () => {
      const reloaded: DiffResponse = { ...mockDiffResponse, cleanRunId: 'run-1' };
      mockFetch(reloaded);

      const first = renderApp();
      await waitFor(() => expect(mockClearViewedFiles).toHaveBeenCalledTimes(1));
      first.unmount();
      vi.mocked(mockClearAllComments).mockClear();
      vi.mocked(mockClearViewedFiles).mockClear();

      renderApp();

      await screen.findAllByText('test.ts');
      expect(mockClearAllComments).not.toHaveBeenCalled();
      expect(mockClearViewedFiles).not.toHaveBeenCalled();
    });

    it('should not clear comments without a clean run', async () => {
      const responseWithoutFlag: DiffResponse = {
        ...mockDiffResponse,
      };

      mockFetch(responseWithoutFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).not.toHaveBeenCalled();
      });
    });

    it('should log message when clearing comments via CLI flag', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        cleanRunId: 'run-1',
      };

      mockFetch(responseWithClearFlag);

      renderApp();

      await waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith(
          '✅ All existing comments and viewed files cleared as requested via --clean flag',
        );
      });

      consoleLogSpy.mockRestore();
    });

    it('hydrates comments from the server comment session on startup', async () => {
      const serverThreads = [
        createMockThread({
          id: 'imported-thread',
          filePath: 'test.ts',
          line: 10,
          body: 'Imported comment',
        }),
      ];

      vi.mocked(global.fetch).mockImplementation((input) => {
        const url = String(input);

        if (url.startsWith('/api/comments-json')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ threads: serverThreads }),
          } as Response);
        }

        if (url.startsWith('/api/comments')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          } as Response);
        }

        if (url === '/api/revisions') {
          return Promise.resolve({
            ok: true,
            json: async () => null,
          } as Response);
        }

        return Promise.resolve({
          ok: true,
          json: async () => mockDiffResponse,
          blob: async () => ({ size: 1024 }),
        } as Response);
      });

      renderApp();

      await waitFor(() => {
        expect(mockReplaceThreads).toHaveBeenCalledWith(serverThreads);
      });

      expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
        '/api/comments-json?base=HEAD%5E&target=HEAD',
      );
    });

    it('pushes locally recorded decisions to a server session that has none', async () => {
      const thread = createMockThread({
        id: 'thread-1',
        filePath: 'test.ts',
        line: 10,
        body: 'Local comment',
      });
      mockComments = [thread];
      mockDecisions = [
        { threadId: 'thread-1', kind: 'rejected', fixupSha: 'aaaa', at: '2026-01-01T00:00:00Z' },
      ];

      vi.mocked(global.fetch).mockImplementation((input) => {
        const url = String(input);

        if (url.startsWith('/api/comments-json')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ threads: [thread], decisions: [] }),
          } as Response);
        }

        if (url.startsWith('/api/comments')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          } as Response);
        }

        if (url === '/api/revisions') {
          return Promise.resolve({
            ok: true,
            json: async () => null,
          } as Response);
        }

        return Promise.resolve({
          ok: true,
          json: async () => mockDiffResponse,
          blob: async () => ({ size: 1024 }),
        } as Response);
      });

      renderApp();

      await waitFor(() => {
        const posts = vi
          .mocked(global.fetch)
          .mock.calls.filter(([url]) => String(url).startsWith('/api/comments?'));
        const [, request] = posts[0] as [string, RequestInit];
        expect(JSON.parse(String(request.body)).decisions).toEqual(mockDecisions);
      });
    });

    it('still sends a deleted thread to the server', async () => {
      const kept = createMockThread({ id: 'kept', filePath: 'test.ts', line: 10, body: 'Kept' });
      const gone = createMockThread({ id: 'gone', filePath: 'test.ts', line: 20, body: 'Gone' });
      mockComments = [kept, gone];
      mockDecisions = [
        { threadId: 'gone', kind: 'deleted', fixupSha: '', at: '2026-01-01T00:00:00Z' },
      ];

      vi.mocked(global.fetch).mockImplementation((input) => {
        const url = String(input);
        if (url.startsWith('/api/comments-json')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ threads: [], decisions: [] }),
          } as Response);
        }
        if (url.startsWith('/api/comments')) {
          return Promise.resolve({ ok: true, json: async () => ({ success: true }) } as Response);
        }
        if (url === '/api/revisions') {
          return Promise.resolve({ ok: true, json: async () => null } as Response);
        }
        return Promise.resolve({
          ok: true,
          json: async () => mockDiffResponse,
          blob: async () => ({ size: 1024 }),
        } as Response);
      });

      renderApp();

      expect(await screen.findByText('Copy All Prompt (1)')).toBeInTheDocument();
      await waitFor(() => {
        const posts = vi
          .mocked(global.fetch)
          .mock.calls.filter(([url]) => String(url).startsWith('/api/comments?'));
        const [, request] = posts[0] as [string, RequestInit];
        expect(JSON.parse(String(request.body)).threads.map((t: { id: string }) => t.id)).toEqual([
          'kept',
          'gone',
        ]);
      });
    });

    it('preserves server-provided comments after clearing local comments on startup', async () => {
      mockComments = [
        createMockThread({
          id: 'stale-local-thread',
          filePath: 'test.ts',
          line: 5,
          body: 'Stale local comment',
        }),
      ];
      const serverThreads = [
        createMockThread({
          id: 'imported-thread',
          filePath: 'test.ts',
          line: 10,
          body: 'Imported comment',
        }),
      ];
      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        cleanRunId: 'run-1',
      };

      vi.mocked(global.fetch).mockImplementation((input) => {
        const url = String(input);

        if (url.startsWith('/api/comments-json')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ threads: serverThreads }),
          } as Response);
        }

        if (url.startsWith('/api/comments')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          } as Response);
        }

        if (url === '/api/revisions') {
          return Promise.resolve({
            ok: true,
            json: async () => null,
          } as Response);
        }

        return Promise.resolve({
          ok: true,
          json: async () => responseWithClearFlag,
          blob: async () => ({ size: 1024 }),
        } as Response);
      });

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).toHaveBeenCalledWith({
          resetAppliedCommentImportIds: true,
        });
      });

      await waitFor(() => {
        expect(mockReplaceThreads).toHaveBeenCalledWith(serverThreads);
      });

      expect(mockReplaceThreads).not.toHaveBeenCalledWith([...serverThreads, ...mockComments]);
    });
  });
});

describe('App Component - Initial file collapsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
    mockViewedFiles = new Set<string>();
    mockHasLoadedInitialViewedFiles = false;
  });

  it('collapses initially viewed files after viewed state finishes loading', async () => {
    const view = renderApp();

    await waitFor(() => {
      expect(screen.getByTitle('Collapse file (Alt+Click to collapse all)')).toBeInTheDocument();
    });

    expect(screen.getByTitle('Collapse file (Alt+Click to collapse all)')).toBeInTheDocument();

    act(() => {
      mockViewedFiles = new Set(['test.ts']);
      mockHasLoadedInitialViewedFiles = true;
      view.rerender(
        <HotkeysProvider initiallyActiveScopes={['navigation']}>
          <App />
        </HotkeysProvider>,
      );
    });

    await waitFor(() => {
      expect(screen.getByTitle('Expand file (Alt+Click to expand all)')).toBeInTheDocument();
    });
  });
});

describe('App Component - Collapsing a file keeps the reader in place', () => {
  afterEach(() => {
    forcedFileScrolledPast = undefined;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockFetch(mockDiffResponse);
    forcedFileScrolledPast = false;
  });

  it('puts the collapsed header back in view when its top had scrolled away', async () => {
    forcedFileScrolledPast = true;
    renderApp();

    await userEvent.click(await screen.findByTitle('Collapse file (Alt+Click to collapse all)'));

    await waitFor(() => {
      expect(mockScrollFileIntoDiffContainer).toHaveBeenCalledWith('test.ts');
    });
  });

  it('leaves the scroll alone when the file header is still on screen', async () => {
    renderApp();

    await userEvent.click(await screen.findByTitle('Collapse file (Alt+Click to collapse all)'));
    await screen.findByTitle('Expand file (Alt+Click to expand all)');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(mockScrollFileIntoDiffContainer).not.toHaveBeenCalled();
  });

  it('does not scroll when expanding a collapsed file', async () => {
    forcedFileScrolledPast = true;
    mockViewedFiles = new Set(['test.ts']);
    renderApp();

    await userEvent.click(await screen.findByTitle('Expand file (Alt+Click to expand all)'));
    await screen.findByTitle('Collapse file (Alt+Click to collapse all)');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(mockScrollFileIntoDiffContainer).not.toHaveBeenCalled();
  });
});

describe('App Component - Comment sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
  });

  it('syncs an empty comment list after the last comment is resolved', async () => {
    mockComments = [
      createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'Test comment' }),
    ];

    const mockGlobalFetch = vi.mocked(global.fetch);
    const { rerender } = renderApp();

    await waitFor(() => {
      const commentCalls = mockGlobalFetch.mock.calls.filter(([url]) =>
        String(url).startsWith('/api/comments?'),
      );
      expect(commentCalls).toHaveLength(1);

      const [url, request] = commentCalls[0] as [string, RequestInit];
      expect(url).toBe('/api/comments?base=HEAD%5E&target=HEAD');
      expect(request.method).toBe('POST');
      expect(JSON.parse(String(request.body))).toEqual({
        threads: [
          expect.objectContaining({
            id: 'test-1',
            filePath: 'test.ts',
            position: { side: 'new', line: 10 },
            messages: [
              expect.objectContaining({
                id: 'test-1',
                body: 'Test comment',
                author: 'User',
              }),
            ],
          }),
        ],
        decisions: [],
      });
    });

    mockComments = [];
    rerender(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <App />
      </HotkeysProvider>,
    );

    await waitFor(() => {
      const commentCalls = mockGlobalFetch.mock.calls.filter(([url]) =>
        String(url).startsWith('/api/comments?'),
      );
      expect(commentCalls).toHaveLength(2);

      const [url, request] = commentCalls[1] as [string, RequestInit];
      expect(url).toBe('/api/comments?base=HEAD%5E&target=HEAD');
      expect(request.method).toBe('POST');
      expect(JSON.parse(String(request.body))).toEqual({ threads: [], decisions: [] });
    });
  });

  it('sends an empty comment list on unload when no comments remain', async () => {
    mockComments = [];
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    renderApp();

    await waitFor(() => {
      expect(addEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    });

    const beforeUnloadHandler = addEventListenerSpy.mock.calls.find(
      ([eventName]) => eventName === 'beforeunload',
    )?.[1] as (() => void) | undefined;
    expect(beforeUnloadHandler).toBeDefined();
    beforeUnloadHandler?.();

    expect(navigator.sendBeacon).toHaveBeenCalledWith(
      '/api/comments?base=HEAD%5E&target=HEAD',
      JSON.stringify({ threads: [], decisions: [] }),
    );
    addEventListenerSpy.mockRestore();
  });

  it('shows author badges on the comment cards when the diff has multiple authors', async () => {
    mockComments = [
      createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'User comment' }),
      createMockThread({
        id: 'test-2',
        filePath: 'other.ts',
        line: 20,
        body: 'Reviewer comment',
        author: 'Reviewer',
      }),
    ];
    mockFetch({
      ...mockDiffResponse,
      files: [linedFile('test.ts', 25), linedFile('other.ts', 25)],
    });

    renderApp();

    await screen.findByText('Reviewer comment');
    expect(
      within(document.getElementById('comment-thread-test-1')!).getByText('User'),
    ).toBeInTheDocument();
    expect(
      within(document.getElementById('comment-thread-test-2')!).getByText('Reviewer'),
    ).toBeInTheDocument();
  });

  it('shows author badges when the reviewer and an agent without a named author both comment', async () => {
    const agentThreads = mergeCommentImports(
      [],
      parseCommentImportValue(
        JSON.stringify({
          type: 'thread',
          filePath: 'test.ts',
          position: { side: 'new', line: 20 },
          body: 'Agent comment',
        }),
      ),
    ).threads;
    mockComments = [
      createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'User comment' }),
      ...agentThreads,
    ];
    mockFetch({ ...mockDiffResponse, files: [linedFile('test.ts', 25)] });

    renderApp();

    const agentCard = (await screen.findByText('Agent comment')).closest<HTMLElement>(
      '[id^="comment-thread-"]',
    )!;
    expect(within(agentCard).getByText('Agent')).toBeInTheDocument();
    expect(
      within(document.getElementById('comment-thread-test-1')!).getByText('User'),
    ).toBeInTheDocument();
  });
});

describe('App Component - Diff Mode Persistence', () => {
  it('initializes the selected view mode from localStorage', async () => {
    mockFetch(mockDiffResponse);
    window.localStorage.setItem('difit.diffViewMode', 'unified');

    renderApp();

    const unifiedButton = await screen.findByRole('button', { name: 'Unified' });

    await waitFor(() => {
      expect(unifiedButton).toHaveClass('bg-github-bg-primary');
    });
  });

  it('persists the selected view mode to localStorage', async () => {
    mockFetch(mockDiffResponse);

    renderApp();

    const unifiedButton = await screen.findByRole('button', { name: 'Unified' });
    fireEvent.click(unifiedButton);

    expect(window.localStorage.getItem('difit.diffViewMode')).toBe('unified');
  });

  it('keeps the selected view mode after triggering refresh', async () => {
    const mockGlobalFetch = vi.mocked(global.fetch);
    mockGlobalFetch.mockClear();
    mockComments = [];
    mockClearAllComments.mockReset();
    mockConfirm.mockReturnValue(false);
    mockWatchState.shouldReload = true;
    mockWatchState.lastChangeType = 'file';
    mockFetch(mockDiffResponse);

    renderApp();

    const unifiedButton = await screen.findByRole('button', { name: 'Unified' });
    fireEvent.click(unifiedButton);

    await waitFor(() => {
      expect(unifiedButton).toHaveClass('bg-github-bg-primary');
    });

    const refreshButton = await screen.findByRole('button', { name: 'Refresh' });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      const diffCalls = mockGlobalFetch.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.startsWith('/api/diff'),
      );
      expect(diffCalls).toHaveLength(2);
    });

    await waitFor(() => {
      expect(unifiedButton).toHaveClass('bg-github-bg-primary');
    });
    mockWatchState.shouldReload = false;
    mockWatchState.lastChangeType = null;
  });
});

describe('App Component - Merge-base selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
  });

  it('clears the resolved base revision after switching to a merge-base quick diff', async () => {
    const initialDiffResponse: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '88aabb0',
      targetCommitish: '.',
      requestedBaseCommitish: 'HEAD',
      requestedTargetCommitish: '.',
    };
    const mergeBaseDiffResponse: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '1122334',
      targetCommitish: '.',
      requestedBaseCommitish: 'origin/main',
      requestedTargetCommitish: '.',
      requestedBaseMode: 'merge-base',
    };
    const revisionsResponse = {
      specialOptions: [{ value: '.', label: 'All Uncommitted Changes' }],
      branches: [],
      commits: [
        {
          hash: '88aabb0fffff1111222233334444555566667777',
          shortHash: '88aabb0',
          message: 'stale direct base',
        },
        {
          hash: '1122334fffff1111222233334444555566667777',
          shortHash: '1122334',
          message: 'merge base',
        },
      ],
      originDefaultBranch: 'origin/main',
    };

    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);

      if (url.includes('/api/revisions')) {
        return Promise.resolve({
          ok: true,
          json: async () => revisionsResponse,
        } as Response);
      }

      if (url.includes('/api/diff')) {
        const response =
          url.includes('base=origin%2Fmain') && url.includes('baseMode=merge-base')
            ? mergeBaseDiffResponse
            : initialDiffResponse;

        return Promise.resolve({
          ok: true,
          json: async () => response,
          blob: async () => ({ size: 1024 }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      } as Response);
    });

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: /Revision menu:/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'origin/main...Uncommitted (merge-base)' }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Revision menu: origin/main...Uncommitted Changes (merge-base)',
        }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByRole('button', {
        name: 'Revision menu: 88aabb0...Uncommitted Changes (merge-base)',
      }),
    ).not.toBeInTheDocument();
  });

  it('uses resolved revisions for persisted diff state identity', async () => {
    const response: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '1234567',
      targetCommitish: '98664e1',
      requestedBaseCommitish: '98664e1^',
      requestedTargetCommitish: '98664e1',
    };

    mockFetch(response);

    renderApp();

    await waitFor(() => {
      expect(vi.mocked(useDiffComments)).toHaveBeenCalledWith(
        '1234567',
        '98664e1',
        'abc123',
        undefined,
        undefined,
        undefined,
      );
    });

    expect(vi.mocked(useViewedFiles)).toHaveBeenCalledWith(
      '1234567',
      '98664e1',
      'abc123',
      undefined,
      response.files,
      undefined,
      [],
      undefined,
      undefined,
    );
  });

  it('ignores stale resolvedBase from /api/revisions on initial merge-base load', async () => {
    const mergeBaseDiffResponse: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '1122334',
      targetCommitish: '.',
      requestedBaseCommitish: 'origin/main',
      requestedTargetCommitish: '.',
      requestedBaseMode: 'merge-base',
    };
    const revisionsResponse = {
      specialOptions: [{ value: '.', label: 'All Uncommitted Changes' }],
      branches: [],
      commits: [
        {
          hash: '88aabb0fffff1111222233334444555566667777',
          shortHash: '88aabb0',
          message: 'stale direct base',
        },
      ],
      originDefaultBranch: 'origin/main',
      resolvedBase: '88aabb0',
      resolvedTarget: '1122334',
    };

    let resolveRevisions: (() => void) | null = null;

    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);

      if (url.includes('/api/revisions')) {
        return new Promise<Response>((resolve) => {
          resolveRevisions = () =>
            resolve({
              ok: true,
              json: async () => revisionsResponse,
            } as Response);
        });
      }

      if (url.includes('/api/diff')) {
        return Promise.resolve({
          ok: true,
          json: async () => mergeBaseDiffResponse,
          blob: async () => ({ size: 1024 }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      } as Response);
    });

    renderApp();

    await waitFor(() => {
      expect(screen.getByText('Reviewing:')).toBeInTheDocument();
    });

    await act(async () => {
      resolveRevisions?.();
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Revision menu: origin/main...Uncommitted Changes (merge-base)',
        }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByRole('button', {
        name: 'Revision menu: 88aabb0...Uncommitted Changes (merge-base)',
      }),
    ).not.toBeInTheDocument();
  });
});

describe('App Component - Revision-aware refetching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
  });

  it('keeps the selected revisions when refetching without explicit revision params', async () => {
    const diffResponse: DiffResponse = {
      ...mockDiffResponse,
      requestedBaseCommitish: 'HEAD^',
      requestedTargetCommitish: 'HEAD',
    };

    vi.mocked(global.fetch).mockImplementation((input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/api/revisions')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            specialOptions: [],
            branches: [],
            commits: [
              {
                hash: 'abc1234',
                shortHash: 'abc1234',
                message: 'Test commit',
              },
            ],
          }),
        } as Response);
      }

      if (url.startsWith('/api/comments?')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => diffResponse,
        blob: async () => ({ size: 1024 }),
      } as Response);
    });

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: /Revision menu:/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Previous commit' }));

    await waitFor(() => {
      const diffCalls = vi
        .mocked(global.fetch)
        .mock.calls.filter(([url]) => typeof url === 'string' && url.startsWith('/api/diff'));
      expect(diffCalls).toHaveLength(2);
      expect(String(diffCalls[1]?.[0])).toContain('base=HEAD%5E%5E');
      expect(String(diffCalls[1]?.[0])).toContain('target=HEAD%5E');
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Ignore Whitespace' }));

    await waitFor(() => {
      const diffCalls = vi
        .mocked(global.fetch)
        .mock.calls.filter(([url]) => typeof url === 'string' && url.startsWith('/api/diff'));
      expect(diffCalls).toHaveLength(3);
      expect(String(diffCalls[2]?.[0])).toContain('base=HEAD%5E%5E');
      expect(String(diffCalls[2]?.[0])).toContain('target=HEAD%5E');
    });
  });
});

describe('App Component - Returning from the review a comment was made on', () => {
  const reviewAt = (commit: string): DiffResponse => ({
    ...mockDiffResponse,
    baseCommitish: `${commit}^`,
    targetCommitish: commit,
    requestedBaseCommitish: `${commit}^`,
    requestedTargetCommitish: commit,
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
            lines: [
              { type: 'normal', content: 'const a = 1;', oldLineNumber: 1, newLineNumber: 1 },
            ],
          },
        ],
      },
    ],
  });

  const diffTargets = () =>
    vi
      .mocked(global.fetch)
      .mock.calls.map(([url]) => String(url))
      .filter((url) => url.startsWith('/api/diff'))
      .map((url) => new URLSearchParams(url.split('?')[1]).get('target'));

  const originalReviewEntry = {
    difitReviewTarget: { baseCommitish: 'abc1234^', targetCommitish: 'abc1234' },
  };
  let serverTarget = 'abc1234';

  const loadedBy = (type: string) =>
    vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue([{ type } as unknown as PerformanceEntry]);

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    serverTarget = 'abc1234';
    mockDecisions = [];
    mockComments = [
      {
        ...createMockThread({ id: 'old', filePath: 'test.ts', line: 1, body: 'Old remark' }),
        codeSnapshot: { content: 'const a = 0;', commit: 'def5678' },
      },
    ];
    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/revisions') {
        return Promise.resolve({ ok: true, json: async () => null } as Response);
      }
      if (url.startsWith('/api/fixups')) {
        return Promise.resolve({ ok: true, json: async () => ({ fixups: [] }) } as Response);
      }
      const target = url.startsWith('/api/diff')
        ? new URLSearchParams(url.split('?')[1]).get('target')
        : null;
      return Promise.resolve({
        ok: true,
        json: async () => reviewAt(target ?? serverTarget),
        blob: async () => ({ size: 1024 }),
      } as Response);
    });
  });

  it('adds a browser history entry when jumping to the older review', async () => {
    renderApp();
    const lengthBefore = window.history.length;

    fireEvent.click(await screen.findByRole('button', { name: '이 지적을 달던 시점으로' }));

    await waitFor(() => expect(diffTargets()).toContain('def5678'));
    expect(window.history.length).toBe(lengthBefore + 1);
  });

  it('switches back to the original review on Back and forward again on Forward', async () => {
    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: '이 지적을 달던 시점으로' }));
    await waitFor(() => expect(diffTargets().at(-1)).toBe('def5678'));

    act(() => window.history.back());
    await waitFor(() => expect(diffTargets().at(-1)).toBe('abc1234'));
    expect(diffTargets()).toEqual([null, 'def5678', 'abc1234']);
    await waitFor(() =>
      expect(vi.mocked(useDiffComments).mock.lastCall?.slice(0, 2)).toEqual([
        'abc1234^',
        'abc1234',
      ]),
    );

    act(() => window.history.forward());
    await waitFor(() => expect(diffTargets().at(-1)).toBe('def5678'));
  });

  it("shows the original review's chips again after Back without recording decisions", async () => {
    const oldThread = mockComments[0]!;
    const fixedThread: DiffCommentThread = {
      ...createMockThread({ id: 'fixed', filePath: 'test.ts', line: 1, body: 'Fixed remark' }),
      codeSnapshot: { content: 'const a = 1;', commit: 'abc1234' },
    };
    const storedByTarget: Record<
      string,
      Pick<ReturnType<typeof useDiffComments>, 'threads' | 'decisions'>
    > = {
      abc1234: {
        threads: [oldThread, fixedThread],
        decisions: [
          { threadId: 'fixed', kind: 'approved', fixupSha: 'aaaa', at: '2026-01-01T00:00:00Z' },
        ],
      },
      def5678: {
        threads: [oldThread],
        decisions: [
          { threadId: 'old', kind: 'rejected', fixupSha: 'bbbb', at: '2026-01-01T00:00:00Z' },
        ],
      },
    };
    const recordDecision = vi.fn();
    const recordFixupDecisions = vi.fn();
    const undoApproval = vi.fn();
    const defaultComments = vi.mocked(useDiffComments).getMockImplementation()!;
    vi.mocked(useDiffComments).mockImplementation((...args) => ({
      ...defaultComments(...args),
      ...(storedByTarget[args[1] ?? ''] ?? { threads: [], decisions: [] }),
      recordDecision,
      recordFixupDecisions,
      undoApproval,
    }));
    const chips = () =>
      [...screen.queryAllByTestId('review-state-chip'), ...screen.queryAllByTestId('resolved-chip')]
        .map((chip) => chip.textContent)
        .sort();

    try {
      renderApp();
      await waitFor(() => expect(chips()).toEqual(['답변 대기', '해결됨']));

      fireEvent.click(await screen.findByRole('button', { name: '이 지적을 달던 시점으로' }));
      await waitFor(() => expect(chips()).toEqual(['다시 수정 중']));

      act(() => window.history.back());
      await waitFor(() => expect(chips()).toEqual(['답변 대기', '해결됨']));
      expect(recordDecision).not.toHaveBeenCalled();
      expect(recordFixupDecisions).not.toHaveBeenCalled();
      expect(undoApproval).not.toHaveBeenCalled();
    } finally {
      vi.mocked(useDiffComments).mockImplementation(defaultComments);
    }
  });

  it('reopens the review the history entry recorded when Back loads the page afresh', async () => {
    serverTarget = 'def5678';
    window.history.replaceState(originalReviewEntry, '');
    loadedBy('back_forward');

    renderApp();

    await waitFor(() => expect(diffTargets()).toEqual(['abc1234']));
    await waitFor(() =>
      expect(vi.mocked(useDiffComments).mock.lastCall?.slice(0, 2)).toEqual([
        'abc1234^',
        'abc1234',
      ]),
    );
  });

  it('leaves the review to the server on a plain reload', async () => {
    serverTarget = 'def5678';
    window.history.replaceState(originalReviewEntry, '');
    loadedBy('reload');

    renderApp();

    await waitFor(() =>
      expect(vi.mocked(useDiffComments).mock.lastCall?.slice(0, 2)).toEqual([
        'def5678^',
        'def5678',
      ]),
    );
    expect(diffTargets()).toEqual([null]);
  });
});

describe(
  'App Component - Back and Forward between places in one review',
  { timeout: 15_000 },
  () => {
    const FILE_TOPS: Record<string, number> = { 'a.ts': 0, 'b.ts': 3000, 'c.ts': 6000 };
    const HEADER_HEIGHT = 40;
    const LINE_HEIGHT = 20;
    let scrolled = 0;
    const box = (top: number, height: number) =>
      ({ top, bottom: top + height, left: 0, right: 0, width: 0, height }) as DOMRect;

    const diffAt = (target: string): DiffResponse => ({
      ...mockDiffResponse,
      baseCommitish: `${target}^`,
      targetCommitish: target,
      requestedBaseCommitish: `${target}^`,
      requestedTargetCommitish: target,
      files: Object.keys(FILE_TOPS).map((path) => filesByPath[path] ?? linedFile(path, 30)),
    });
    let filesByPath: Record<string, DiffResponse['files'][number]> = {};
    const diffTargets = () =>
      vi
        .mocked(global.fetch)
        .mock.calls.map(([url]) => String(url))
        .filter((url) => url.startsWith('/api/diff'))
        .map((url) => new URLSearchParams(url.split('?')[1]).get('target'));

    const cursorRow = () => document.querySelector('.keyboard-cursor')?.closest('tr') ?? null;
    const cursorFile = () =>
      cursorRow()?.closest<HTMLElement>('[data-file-path]')?.dataset.filePath ?? null;
    const fileListRow = (path: string) =>
      within(document.getElementById('file-tree-panel')!).getByTitle(path);
    const fileShown = () =>
      Object.keys(FILE_TOPS)
        .filter((path) => FILE_TOPS[path]! <= scrolled)
        .at(-1) ?? null;
    const scrollTo = async (top: number) => {
      scrolled = top;
      fireEvent.scroll(document.querySelector('main')!);
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    };
    const back = () => act(() => window.history.back());
    const forward = () => act(() => window.history.forward());
    const waitForScroll = (top: number) =>
      waitFor(() => expect(scrolled).toBe(top), { timeout: 3000 });

    beforeEach(() => {
      vi.clearAllMocks();
      mockComments = [];
      mockDecisions = [];
      scrolled = 0;
      filesByPath = {};
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: HTMLElement) {
          if (this.tagName === 'MAIN') return box(0, 800);
          const section = this.closest<HTMLElement>('[data-file-path]');
          const fileTop = FILE_TOPS[section?.dataset.filePath ?? ''];
          if (!section || fileTop === undefined) return box(0, 0);
          const top = fileTop - scrolled;
          if (this === section) return box(top, 2000);
          if (this.closest('[data-file-header]')) return box(Math.max(0, top), HEADER_HEIGHT);
          const row = this.closest('[data-diff-line-row="true"]');
          if (!row || !/^file-\d+-chunk-/.test(this.id)) return box(top + 1000, LINE_HEIGHT);
          const rowIndex = [...section.querySelectorAll('[data-diff-line-row="true"]')].indexOf(
            row,
          );
          return box(top + HEADER_HEIGHT + rowIndex * LINE_HEIGHT, LINE_HEIGHT);
        },
      );
      Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
        configurable: true,
        get(this: HTMLElement) {
          return this.tagName === 'MAIN' ? scrolled : 0;
        },
        set(this: HTMLElement, top: number) {
          if (this.tagName === 'MAIN') scrolled = top;
        },
      });
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        configurable: true,
        value(this: HTMLElement, options: ScrollToOptions) {
          if (this.tagName === 'MAIN') scrolled = options.top ?? scrolled;
        },
      });
      vi.mocked(global.fetch).mockImplementation((input) => {
        const url = String(input);
        if (url === '/api/revisions') {
          return Promise.resolve({ ok: true, json: async () => null } as Response);
        }
        if (url.startsWith('/api/fixups')) {
          return Promise.resolve({ ok: true, json: async () => ({ fixups: [] }) } as Response);
        }
        const target = url.startsWith('/api/diff')
          ? new URLSearchParams(url.split('?')[1]).get('target')
          : null;
        return Promise.resolve({
          ok: true,
          json: async () => diffAt(target ?? 'abc1234'),
          blob: async () => ({ size: 1024 }),
        } as Response);
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
      window.history.replaceState(null, '');
    });

    it.each(['split', 'unified'])(
      'in %s view, goes back from a file picked in the file list to the line that was at the top',
      async (mode) => {
        window.localStorage.setItem('difit.diffViewMode', mode);
        renderApp();
        await screen.findAllByTitle('c.ts');
        await scrollTo(3100);
        const lengthBefore = window.history.length;

        fireEvent.click(fileListRow('c.ts'));
        await waitForScroll(6000);
        expect(window.history.length).toBe(lengthBefore + 1);

        back();
        await waitForScroll(3000 + 5 * LINE_HEIGHT - 8);
        forward();
        await waitForScroll(6000);
        expect(window.history.length).toBe(lengthBefore + 1);
      },
    );

    it('goes back to a deleted line whose row also shows a later added line', async () => {
      const lines: DiffResponse['files'][number]['chunks'][number]['lines'] = [
        ...[1, 2, 3, 4, 5].map((n) => ({
          type: 'delete' as const,
          content: `old ${n}`,
          oldLineNumber: n,
        })),
        { type: 'add', content: 'new 1', newLineNumber: 1 },
        ...[6, 7, 8, 9].map((n) => ({
          type: 'normal' as const,
          content: `same ${n}`,
          oldLineNumber: n,
          newLineNumber: n - 4,
        })),
      ];
      filesByPath = {
        'b.ts': {
          path: 'b.ts',
          status: 'modified',
          additions: 1,
          deletions: 5,
          chunks: [
            {
              header: '@@ -1,9 +1,5 @@',
              oldStart: 1,
              oldLines: 9,
              newStart: 1,
              newLines: 5,
              lines,
            },
          ],
        },
      };
      renderApp();
      await screen.findAllByTitle('c.ts');
      await scrollTo(3000 + 3 * LINE_HEIGHT);

      fireEvent.click(fileListRow('c.ts'));
      await waitForScroll(6000);
      back();

      await waitForScroll(3000 + 3 * LINE_HEIGHT - 8);
    });

    it('counts ] and Shift+N as jumps but not j and k, and Back puts the cursor back', async () => {
      mockComments = [createMockThread({ id: 'n1', filePath: 'c.ts', line: 5, body: 'Note' })];
      const user = userEvent.setup();
      renderApp();
      await screen.findAllByTitle('c.ts');
      const lengthBefore = window.history.length;

      await user.keyboard('jjjk');
      expect(cursorFile()).toBe('a.ts');
      const startRow = cursorRow()!.textContent;
      expect(window.history.length).toBe(lengthBefore);

      await user.keyboard(']');
      await waitFor(() => expect(cursorFile()).toBe('b.ts'));
      await scrollTo(3000);
      await user.keyboard('{Shift>}N{/Shift}');
      await waitFor(() => expect(cursorRow()).toHaveTextContent('line 5'));
      expect(cursorFile()).toBe('c.ts');
      await scrollTo(6000);
      expect(window.history.length).toBe(lengthBefore + 2);

      back();
      await waitFor(() => expect(cursorFile()).toBe('b.ts'));
      back();
      await waitFor(() => expect(cursorFile()).toBe('a.ts'));
      expect(cursorRow()!.textContent).toBe(startRow);
      forward();
      await waitFor(() => expect(cursorFile()).toBe('b.ts'));
      expect(window.history.length).toBe(lengthBefore + 2);
    });

    it('goes back from a comment picked in the panel, and forward to it again', async () => {
      mockComments = [createMockThread({ id: 'n1', filePath: 'c.ts', line: 20, body: 'Far note' })];
      renderApp();
      await screen.findAllByTitle('c.ts');
      fireEvent.click(await screen.findByRole('button', { name: 'Toggle comments panel' }));
      const lengthBefore = window.history.length;

      await userEvent.click(within(commentsPanel()!).getByRole('button', { name: /Far note/ }));
      await waitFor(() => expect(fileShown()).toBe('c.ts'));
      expect(window.history.length).toBe(lengthBefore + 1);

      back();
      await waitFor(() => expect(fileShown()).toBe('a.ts'));
      forward();
      await waitFor(() => expect(fileShown()).toBe('c.ts'));
      expect(cursorRow()).toHaveTextContent('line 20');
    });

    it('stops at the header of a file marked viewed since, and leaves it folded', async () => {
      mockComments = [createMockThread({ id: 'n1', filePath: 'b.ts', line: 20, body: 'Middle' })];
      renderApp();
      await screen.findAllByTitle('c.ts');
      fireEvent.click(await screen.findByRole('button', { name: 'Toggle comments panel' }));
      await userEvent.click(within(commentsPanel()!).getByRole('button', { name: /Middle/ }));
      await waitFor(() => expect(fileShown()).toBe('b.ts'));
      back();
      await waitFor(() => expect(fileShown()).toBe('a.ts'));

      const bHeader = document
        .getElementById(getFileElementId('b.ts'))!
        .querySelector<HTMLElement>('[data-file-header]')!;
      fireEvent.click(within(bHeader).getByTitle('Mark as reviewed'));
      await waitFor(() => expect(within(bHeader).getByTitle(/^Expand file/)).toBeInTheDocument());
      forward();

      await waitForScroll(3000);
      expect(within(bHeader).getByTitle(/^Expand file/)).toBeInTheDocument();
    });

    it('switches back to the earlier review and then to the spot it showed', async () => {
      mockComments = [
        {
          ...createMockThread({ id: 'old', filePath: 'a.ts', line: 1, body: 'Old remark' }),
          codeSnapshot: { content: 'line 0', commit: 'def5678' },
        },
      ];
      renderApp();
      await screen.findAllByTitle('c.ts');
      await scrollTo(6100);

      fireEvent.click(await screen.findByRole('button', { name: '이 지적을 달던 시점으로' }));
      await waitFor(() => expect(diffTargets().at(-1)).toBe('def5678'));
      await screen.findAllByTitle('c.ts');
      await scrollTo(0);

      back();
      await waitFor(() => expect(diffTargets().at(-1)).toBe('abc1234'));
      await waitForScroll(6000 + 5 * LINE_HEIGHT - 8);
    });

    describe('path:line written in a comment', () => {
      const lineLink = (name: string) =>
        within(document.querySelector('main')!).getByRole('button', { name });
      const serveFileContent = (path: string, count: number) => {
        const serveDiff = vi.mocked(global.fetch).getMockImplementation()!;
        vi.mocked(global.fetch).mockImplementation((input, init) =>
          String(input).startsWith(`/api/blob/${path}?`)
            ? Promise.resolve({
                ok: true,
                text: async () =>
                  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n'),
              } as Response)
            : serveDiff(input, init),
        );
      };

      it('goes to that line, flashes it, and Back returns to where the reader was', async () => {
        mockComments = [
          createMockThread({ id: 'n1', filePath: 'a.ts', line: 1, body: 'Same at `c.ts:20`.' }),
        ];
        renderApp();
        await screen.findAllByTitle('c.ts');
        const lengthBefore = window.history.length;

        fireEvent.click(await waitFor(() => lineLink('c.ts:20')));

        await waitFor(() => expect(cursorRow()).toHaveTextContent('line 20'));
        expect(cursorFile()).toBe('c.ts');
        await waitFor(() => expect(fileShown()).toBe('c.ts'));
        await waitFor(() => expect(cursorRow()).toHaveAttribute('data-line-link-flash'));
        expect(window.history.length).toBe(lengthBefore + 1);

        back();
        await waitFor(() => expect(fileShown()).toBe('a.ts'));
      });

      it('unfolds a folded file and opens the hidden lines around the line', async () => {
        mockViewedFiles = new Set(['b.ts']);
        filesByPath = { 'b.ts': linedFile('b.ts', 3) };
        serveFileContent('b.ts', 100);
        mockComments = [
          createMockThread({ id: 'n1', filePath: 'a.ts', line: 1, body: 'Look at b.ts:50 too' }),
        ];
        renderApp();
        await screen.findAllByTitle('c.ts');
        const bHeader = () =>
          within(
            document
              .getElementById(getFileElementId('b.ts'))!
              .querySelector<HTMLElement>('[data-file-header]')!,
          );
        await waitFor(() => expect(bHeader().getByTitle(/^Expand file/)).toBeInTheDocument());

        fireEvent.click(await waitFor(() => lineLink('b.ts:50')));

        await waitFor(() => expect(cursorRow()).toHaveTextContent('line 50'));
        expect(cursorFile()).toBe('b.ts');
        expect(bHeader().queryByTitle(/^Expand file/)).toBeNull();
        await waitFor(() => expect(fileShown()).toBe('b.ts'));
      });

      it('leaves a path that names no file of the diff as text', async () => {
        mockComments = [
          createMockThread({ id: 'n1', filePath: 'a.ts', line: 1, body: 'Unlike d.ts:3 here' }),
        ];
        renderApp();
        await screen.findAllByTitle('c.ts');

        const main = within(document.querySelector('main')!);
        expect(await main.findByText(/Unlike d\.ts:3 here/)).toBeInTheDocument();
        expect(main.queryByRole('button', { name: 'd.ts:3' })).toBeNull();
      });
    });

    it('shows the spot of the entry when Back loads the page afresh', async () => {
      window.history.replaceState(
        {
          difitReviewTarget: { baseCommitish: 'abc1234^', targetCommitish: 'abc1234' },
          difitPlace: { kind: 'file', file: 'c.ts' },
        },
        '',
      );
      vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
        { type: 'back_forward' } as unknown as PerformanceEntry,
      ]);

      renderApp();

      await waitForScroll(6000);
    });
  },
);

describe('App Component - Sidebar persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
    mockFetch(mockDiffResponse);
  });

  it('restores file tree open state from localStorage', async () => {
    window.localStorage.setItem('difit.sidebarOpen', 'false');

    renderApp();

    const toggleButton = await screen.findByRole('button', { name: /toggle file tree panel/i });
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('persists file tree open state when toggled', async () => {
    renderApp();

    const toggleButton = await screen.findByRole('button', { name: /toggle file tree panel/i });

    fireEvent.click(toggleButton);
    await waitFor(() => {
      expect(window.localStorage.getItem('difit.sidebarOpen')).toBe('false');
    });

    fireEvent.click(toggleButton);
    await waitFor(() => {
      expect(window.localStorage.getItem('difit.sidebarOpen')).toBe('true');
    });
  });

  it('widens the file list by the distance dragged, within its limits', async () => {
    renderApp();

    const handle = await screen.findByTitle('Drag to resize file list');
    expect(fileListBox().style.flexBasis).toBe('280px');

    layOut({ row: 1920, diff: 1636, fileList: 280 });
    fireEvent.mouseDown(handle, { clientX: 300 });
    fireEvent.mouseMove(document, { clientX: 350 });
    fireEvent.mouseUp(document);
    expect(fileListBox().style.flexBasis).toBe('330px');
    expect(window.localStorage.getItem('difit.sidebarWidth')).toBe('330');

    layOut({ row: 1920, diff: 1586, fileList: 330 });
    fireEvent.mouseDown(handle, { clientX: 300 });
    fireEvent.mouseMove(document, { clientX: 900 });
    fireEvent.mouseUp(document);
    expect(fileListBox().style.flexBasis).toBe('600px');
  });
});

describe('App Component - Comments panel', () => {
  const toggle = () => screen.findByRole('button', { name: 'Toggle comments panel' });
  const row = (text: string) =>
    within(commentsPanel()!).getByRole('button', { name: new RegExp(text) });
  const pressShiftL = () => userEvent.keyboard('{Shift>}L{/Shift}');
  const cursorRow = () => document.querySelector('.keyboard-cursor')?.closest('tr') ?? null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDecisions = [];
    mockComments = [
      createMockThread({ id: 'p1', filePath: 'test.ts', line: 10, body: 'First note' }),
      createMockThread({ id: 'p2', filePath: 'test.ts', line: 20, body: 'Second note' }),
    ];
    mockConfirm.mockReturnValue(false);
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
    mockFetch({ ...mockDiffResponse, files: [linedFile('test.ts', 30)] });
  });

  it('starts closed, with its header button shown even when there are no comments', async () => {
    mockComments = [];
    renderApp();

    expect(await toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(commentsPanel()).toBeNull();
  });

  it('opens on Shift+L with j/k moving the list, and Shift+L there closes it', async () => {
    renderApp();
    await toggle();

    await pressShiftL();
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(row('First note')).toHaveFocus());

    await userEvent.keyboard('j');
    expect(row('Second note')).toHaveFocus();
    expect(cursorRow()).toBeNull();

    await pressShiftL();
    expect(await toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(commentsPanel()).toBeNull();
    await userEvent.keyboard('j');
    expect(cursorRow()).not.toBeNull();
  });

  it('opened from the header button, leaves j/k on the diff until Shift+L moves them in', async () => {
    renderApp();

    fireEvent.click(await toggle());
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(commentsPanelHasFocus()).toBe(false);
    await userEvent.keyboard('j');
    expect(cursorRow()).not.toBeNull();

    await pressShiftL();
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(row('First note')).toHaveFocus());
  });

  it('hands j/k back to the diff on Escape and stays open', async () => {
    renderApp();
    await toggle();
    await pressShiftL();
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));

    await userEvent.keyboard('{Escape}');

    expect(commentsPanelHasFocus()).toBe(false);
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(window.localStorage.getItem('difit.commentsPanelOpen')).toBe('true');
    await userEvent.keyboard('j');
    expect(cursorRow()).not.toBeNull();
  });

  it('hands j/k back to the diff when the diff is clicked', async () => {
    renderApp();
    await toggle();
    await pressShiftL();
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));

    fireEvent.click(document.querySelector('[data-diff-line-row="true"]')!);

    expect(commentsPanelHasFocus()).toBe(false);
    expect(commentsPanel()).not.toBeNull();
  });

  it('goes to the line of a picked comment and stays open', async () => {
    renderApp();
    fireEvent.click(await toggle());

    await userEvent.click(row('Second note'));

    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(cursorRow()).toHaveTextContent('line 20'));
    expect(row('Second note')).toHaveAttribute('aria-current', 'true');
  });

  it('goes to the line of a picked comment in a chunk drawn joined to the one above', async () => {
    const [chunk] = linedFile('test.ts', 30).chunks;
    const split = (from: number, to: number) => ({
      ...chunk!,
      header: `@@ -${from},${to - from + 1} +${from},${to - from + 1} @@`,
      oldStart: from,
      oldLines: to - from + 1,
      newStart: from,
      newLines: to - from + 1,
      lines: chunk!.lines.slice(from - 1, to),
    });
    mockFetch({
      ...mockDiffResponse,
      files: [{ ...linedFile('test.ts', 30), chunks: [split(1, 15), split(16, 30)] }],
    });
    renderApp();
    fireEvent.click(await toggle());

    await userEvent.click(row('Second note'));

    await waitFor(() => expect(cursorRow()).toHaveTextContent('line 20'));
  });

  it('opens with the keys in the list from 「View All Comments」', async () => {
    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));

    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(row('First note')).toHaveFocus());
  });

  it('keeps the chosen list when closed and opened again', async () => {
    mockDecisions = [
      { threadId: 'p2', kind: 'resolved', fixupSha: '', at: '2026-01-01T00:00:00Z' },
    ];
    renderApp();
    fireEvent.click(await toggle());
    expect(within(commentsPanel()!).queryByText('Second note')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '전체 2' }));
    fireEvent.click(await toggle());
    fireEvent.click(await toggle());

    expect(screen.getByRole('button', { name: '전체 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(row('Second note')).toHaveTextContent('해결');
  });

  it('marks the picked comment on its card and its file', async () => {
    renderApp();
    fireEvent.click(await toggle());

    await userEvent.click(row('Second note'));

    expect(document.getElementById('comment-thread-p2')).toHaveAttribute('data-picked', 'true');
    expect(document.getElementById('comment-thread-p1')).not.toHaveAttribute('data-picked');
    const fileTree = document.getElementById('file-tree-panel')!;
    expect(within(fileTree).getByTitle('test.ts').closest('[data-file-row]')).toHaveAttribute(
      'data-picked-comment',
      'true',
    );
  });

  it('unfolds a file folded as viewed to show the picked comment', async () => {
    mockViewedFiles = new Set(['test.ts']);
    renderApp();
    fireEvent.click(await toggle());
    expect(document.getElementById('comment-thread-p2')).toBeNull();

    await userEvent.click(row('Second note'));

    await waitFor(() =>
      expect(document.getElementById('comment-thread-p2')).toHaveAttribute('data-picked', 'true'),
    );
    await waitFor(() => expect(cursorRow()).toHaveTextContent('line 20'));
  });

  it('draws a picked resolved comment while resolved comments are hidden', async () => {
    mockDecisions = [
      { threadId: 'p2', kind: 'resolved', fixupSha: '', at: '2026-01-01T00:00:00Z' },
    ];
    renderApp();
    fireEvent.click(await screen.findByRole('checkbox', { name: '해결된 지적 보기' }));
    expect(document.getElementById('comment-thread-p2')).toBeNull();
    fireEvent.click(await toggle());
    fireEvent.click(screen.getByRole('button', { name: '전체 2' }));

    await userEvent.click(row('Second note'));

    const card = document.getElementById('comment-thread-p2')!;
    expect(card).toHaveAttribute('data-picked', 'true');
    expect(within(card).getByText('Second note')).toBeInTheDocument();
    expect(document.getElementById('comment-thread-p1')).not.toBeNull();
  });

  it('leaves the diff view mode as it was', async () => {
    window.localStorage.setItem('difit.diffViewMode', 'split');
    renderApp();

    fireEvent.click(await toggle());

    expect(screen.getByRole('button', { name: 'Split' })).toHaveClass('bg-github-bg-primary');
  });
});

describe('App Component - Comments panel persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockDecisions = [];
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
    mockFetch(mockDiffResponse);
  });

  afterEach(() => {
    resetClientSettingsForTests();
  });

  const toggle = () => screen.findByRole('button', { name: 'Toggle comments panel' });

  it('opens on load when it was left open, without taking the keys', async () => {
    window.localStorage.setItem('difit.commentsPanelOpen', 'true');

    renderApp();

    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(commentsPanel()).not.toBeNull();
    expect(commentsPanelHasFocus()).toBe(false);
  });

  it('remembers each open and close', async () => {
    renderApp();

    fireEvent.click(await toggle());
    await waitFor(() =>
      expect(window.localStorage.getItem('difit.commentsPanelOpen')).toBe('true'),
    );
    fireEvent.click(await toggle());
    await waitFor(() =>
      expect(window.localStorage.getItem('difit.commentsPanelOpen')).toBe('false'),
    );
  });

  it('takes the open state and width saved on the server over the ones in this browser', async () => {
    resetClientSettingsForTests();
    window.localStorage.setItem('difit.commentsPanelOpen', 'false');
    window.localStorage.setItem('difit.commentsPanelWidth', '300');
    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/user-settings') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ client: { commentsPanelOpen: true, commentsPanelWidth: 450 } }),
        } as Response);
      }
      if (url === '/api/revisions') {
        return Promise.resolve({ ok: false, json: async () => null } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => mockDiffResponse } as Response);
    });

    renderApp();

    await waitFor(async () => expect(await toggle()).toHaveAttribute('aria-expanded', 'true'));
    expect(window.localStorage.getItem('difit.commentsPanelOpen')).toBe('true');
    expect(commentsPanelBox().style.flexBasis).toBe('450px');
    expect(window.localStorage.getItem('difit.commentsPanelWidth')).toBe('450');
  });

  it('opens at the width it was left at, within its limits', async () => {
    window.localStorage.setItem('difit.commentsPanelOpen', 'true');
    window.localStorage.setItem('difit.commentsPanelWidth', '400');
    const { unmount } = renderApp();
    await toggle();
    expect(commentsPanelBox().style.flexBasis).toBe('400px');
    unmount();

    window.localStorage.setItem('difit.commentsPanelWidth', '900');
    const second = renderApp();
    await toggle();
    expect(commentsPanelBox().style.flexBasis).toBe('600px');
    second.unmount();

    window.localStorage.setItem('difit.commentsPanelWidth', '100');
    renderApp();
    await toggle();
    expect(commentsPanelBox().style.flexBasis).toBe('240px');
  });

  it('widens by the distance dragged to the left and remembers the width', async () => {
    renderApp();
    fireEvent.click(await toggle());
    expect(commentsPanelBox().style.flexBasis).toBe('320px');

    layOut({ row: 1920, diff: 1312, fileList: 280, comments: 320 });
    const handle = screen.getByTitle('Drag to resize comments panel');
    fireEvent.mouseDown(handle, { clientX: 1000 });
    fireEvent.mouseMove(document, { clientX: 900 });
    fireEvent.mouseUp(document);

    expect(commentsPanelBox().style.flexBasis).toBe('420px');
    expect(window.localStorage.getItem('difit.commentsPanelWidth')).toBe('420');
  });
});

describe('App Component - Side panels in a narrow window', () => {
  const handleOf = (title: string) => screen.getByTitle(title);
  const drag = (title: string, from: number, to: number) => {
    fireEvent.mouseDown(handleOf(title), { clientX: from });
    fireEvent.mouseMove(document, { clientX: to });
    fireEvent.mouseUp(document);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockDecisions = [];
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
    window.localStorage.setItem('difit.commentsPanelOpen', 'true');
    mockFetch(mockDiffResponse);
  });

  afterEach(() => {
    resetClientSettingsForTests();
  });

  it('keeps 640px for the diff, or what the open panels leave at their minimums', async () => {
    renderApp();
    const toggle = await screen.findByRole('button', { name: 'Toggle comments panel' });

    expect(diffColumn().style.minWidth).toBe('min(640px, calc(100% - 448px))');
    expect(fileListBox().style.minWidth).toBe('200px');
    expect(commentsPanelBox().style.minWidth).toBe('240px');

    fireEvent.click(toggle);
    expect(diffColumn().style.minWidth).toBe('min(640px, calc(100% - 204px))');
  });

  it('lets both panels give way until one is resized, then the other gives way first', async () => {
    renderApp();
    await screen.findByTitle('Drag to resize file list');
    expect(fileListBox().style.flexShrink).toBe('1');
    expect(commentsPanelBox().style.flexShrink).toBe('1');

    layOut({ row: 1920, diff: 1312, fileList: 280, comments: 320 });
    drag('Drag to resize file list', 300, 310);
    expect(fileListBox().style.flexShrink).toBe('1');
    expect(commentsPanelBox().style.flexShrink).toBe('1000');

    fireEvent.mouseDown(handleOf('Drag to resize comments panel'), { clientX: 1000 });
    expect(fileListBox().style.flexShrink).toBe('1');
    expect(commentsPanelBox().style.flexShrink).toBe('1000');
    expect(commentsPanelBox().style.flexBasis).toBe('320px');

    fireEvent.mouseMove(document, { clientX: 990 });
    fireEvent.mouseUp(document);
    expect(commentsPanelBox().style.flexShrink).toBe('1');
    expect(fileListBox().style.flexShrink).toBe('1000');
  });

  it('widens a panel by what the other panel can still give up when the diff is at 640px', async () => {
    window.localStorage.setItem('difit.sidebarWidth', '400');
    renderApp();
    await screen.findByTitle('Drag to resize file list');
    layOut({ row: 1250, diff: 640, fileList: 362, comments: 240 });

    drag('Drag to resize comments panel', 1000, 700);

    expect(commentsPanelBox().style.flexBasis).toBe('402px');
    expect(window.localStorage.getItem('difit.sidebarWidth')).toBe('400');
  });

  it('gives a panel the room a closing panel leaves, though the close is still on screen', async () => {
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Toggle file tree panel' }));
    layOut({ row: 1250, diff: 640, fileList: 350, comments: 240 });

    drag('Drag to resize comments panel', 1000, 700);

    expect(commentsPanelBox().style.flexBasis).toBe('540px');
  });

  it('keeps the room an opening panel will take, though the open is still on screen', async () => {
    window.localStorage.setItem('difit.commentsPanelOpen', 'false');
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Toggle comments panel' }));
    layOut({ row: 1250, diff: 900, fileList: 280, comments: 40 });

    drag('Drag to resize file list', 300, 600);

    expect(fileListBox().style.flexBasis).toBe('362px');
  });

  it('finishes the panels opening or closing before reading where a drag starts', async () => {
    renderApp();
    await screen.findByTitle('Drag to resize file list');
    layOut({ row: 1920, diff: 1312, fileList: 280, comments: 320 });
    const finish = vi.fn(() => {
      vi.spyOn(commentsPanelBox(), 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 0, 330, 0),
      );
    });
    const finishOther = vi.fn();
    Object.assign(commentsPanelBox(), { getAnimations: () => [{ finish }] });
    Object.assign(fileListBox(), { getAnimations: () => [{ finish: finishOther }] });

    drag('Drag to resize comments panel', 1000, 990);

    expect(finish).toHaveBeenCalled();
    expect(finishOther).toHaveBeenCalled();
    expect(commentsPanelBox().style.flexBasis).toBe('340px');
  });

  it('does not resize a panel that is closing', async () => {
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Toggle comments panel' }));
    layOut({ row: 1250, diff: 960, fileList: 280, comments: 100 });
    const savedWidth = window.localStorage.getItem('difit.commentsPanelWidth');

    expect(fireEvent.mouseDown(handleOf('Drag to resize comments panel'), { clientX: 1000 })).toBe(
      false,
    );
    fireEvent.mouseMove(document, { clientX: 900 });
    fireEvent.mouseUp(document);

    expect(window.localStorage.getItem('difit.commentsPanelWidth')).toBe(savedWidth);
    expect(fileListBox().style.flexShrink).toBe('1');
  });

  it('starts a drag from the width on screen and stops where the diff reaches 640px', async () => {
    window.localStorage.setItem('difit.sidebarWidth', '280');
    window.localStorage.setItem('difit.commentsPanelWidth', '320');
    renderApp();
    await screen.findByTitle('Drag to resize file list');
    layOut({ row: 1107, diff: 649, fileList: 210, comments: 240 });

    drag('Drag to resize file list', 300, 500);

    expect(fileListBox().style.flexBasis).toBe('219px');
    expect(window.localStorage.getItem('difit.sidebarWidth')).toBe('219');
    expect(window.localStorage.getItem('difit.commentsPanelWidth')).toBe('320');

    drag('Drag to resize file list', 300, 270);
    expect(fileListBox().style.flexBasis).toBe('200px');
  });
});

describe('App Component - Comments drawer on a phone', () => {
  const toggle = () => screen.findByRole('button', { name: 'Toggle comments panel' });
  const row = (text: string) =>
    within(commentsPanel()!).getByRole('button', { name: new RegExp(text) });

  beforeEach(() => {
    vi.clearAllMocks();
    mockDecisions = [];
    mockComments = [
      createMockThread({ id: 'p1', filePath: 'test.ts', line: 10, body: 'First note' }),
      createMockThread({ id: 'p2', filePath: 'test.ts', line: 20, body: 'Second note' }),
    ];
    mockConfirm.mockReturnValue(false);
    vi.mocked(useViewport).mockReturnValue({ isMobile: true, isDesktop: false });
    mockFetch({ ...mockDiffResponse, files: [linedFile('test.ts', 30)] });
  });

  afterEach(() => {
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
  });

  it('slides in from the header button and leaves the PC preference alone', async () => {
    window.localStorage.setItem('difit.commentsPanelOpen', 'false');
    renderApp();

    const button = await toggle();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(commentsPanel()).toHaveAttribute('inert');

    fireEvent.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(commentsPanel()).not.toHaveAttribute('inert');
    expect(window.localStorage.getItem('difit.commentsPanelOpen')).toBe('false');
  });

  it('closes when a comment is picked and goes to its line', async () => {
    renderApp();
    fireEvent.click(await toggle());

    await userEvent.click(row('Second note'));

    expect(await toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(commentsPanel()).toHaveAttribute('inert');
    await waitFor(() =>
      expect(document.querySelector('tr.keyboard-cursor')).toHaveTextContent('line 20'),
    );
    expect(document.getElementById('comment-thread-p2')).toHaveAttribute('data-picked', 'true');
  });

  it('opens from 「View All Comments」 in the bottom bar', async () => {
    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));

    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(row('First note')).toHaveFocus());
  });

  it('closes on Escape after opening from the header button', async () => {
    renderApp();
    fireEvent.click(await toggle());
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(commentsPanelHasFocus()).toBe(false);

    await userEvent.keyboard('{Escape}');

    expect(await toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on Escape and on the backdrop', async () => {
    renderApp();
    await toggle();

    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    await userEvent.keyboard('{Escape}');
    expect(await toggle()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(await toggle());
    fireEvent.click(screen.getByRole('button', { name: '코멘트 서랍 닫기' }));
    expect(await toggle()).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('App Component - File list keys', () => {
  const toggle = () => screen.findByRole('button', { name: /toggle file tree panel/i });
  const fileRow = (path: string) =>
    within(document.getElementById('file-tree-panel')!)
      .getByTitle(path)
      .closest<HTMLElement>('[data-file-row]')!;
  const cursorRow = () => document.querySelector('.keyboard-cursor')?.closest('tr') ?? null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
    mockFetch({ ...mockDiffResponse, files: [linedFile('a.ts', 10), linedFile('b.ts', 10)] });
  });

  it('opens on Shift+B with j/k moving the list, and Shift+B there closes it', async () => {
    window.localStorage.setItem('difit.sidebarOpen', 'false');
    renderApp();
    expect(await toggle()).toHaveAttribute('aria-expanded', 'false');

    await pressShiftB();
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(fileListHasFocus()).toBe(true));

    await userEvent.keyboard('k');
    expect(fileRow('a.ts')).toHaveFocus();
    await userEvent.keyboard('j');
    expect(fileRow('b.ts')).toHaveFocus();
    expect(cursorRow()).toBeNull();

    await pressShiftB();
    expect(await toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(fileListHasFocus()).toBe(false);
    await userEvent.keyboard('j');
    expect(cursorRow()).not.toBeNull();
  });

  it('opened from the header button, leaves j/k on the diff until Shift+B moves them in', async () => {
    window.localStorage.setItem('difit.sidebarOpen', 'false');
    renderApp();

    fireEvent.click(await toggle());
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(fileListHasFocus()).toBe(false);
    await userEvent.keyboard('j');
    expect(cursorRow()).not.toBeNull();

    await pressShiftB();
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(fileListHasFocus()).toBe(true));
  });

  it('goes to a file on Enter and keeps the keys in the list', async () => {
    renderApp();
    await toggle();
    await pressShiftB();
    await waitFor(() => expect(fileListHasFocus()).toBe(true));

    await userEvent.keyboard('j{Enter}');

    expect(fileRow('b.ts')).toHaveFocus();
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
  });

  it('hands j/k back to the diff on Escape and stays open', async () => {
    renderApp();
    await toggle();
    await pressShiftB();
    await waitFor(() => expect(fileListHasFocus()).toBe(true));

    await userEvent.keyboard('{Escape}');

    expect(fileListHasFocus()).toBe(false);
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(window.localStorage.getItem('difit.sidebarOpen')).toBe('true');
    await userEvent.keyboard('j');
    expect(cursorRow()).not.toBeNull();
  });

  it('hands j/k back to the diff when the diff is clicked', async () => {
    renderApp();
    await toggle();
    await pressShiftB();
    await waitFor(() => expect(fileListHasFocus()).toBe(true));

    fireEvent.click(document.querySelector('[data-diff-line-row="true"]')!);

    expect(fileListHasFocus()).toBe(false);
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
  });

  it('moves the keys between the file list and the comments panel', async () => {
    renderApp();
    await toggle();
    await pressShiftB();
    await waitFor(() => expect(fileListHasFocus()).toBe(true));

    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    await pressShiftB();

    await waitFor(() => expect(fileListHasFocus()).toBe(true));
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('App Component - File drawer keys on a phone', () => {
  const toggle = () => screen.findByRole('button', { name: /toggle file tree panel/i });

  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    vi.mocked(useViewport).mockReturnValue({ isMobile: true, isDesktop: false });
    mockFetch({ ...mockDiffResponse, files: [linedFile('a.ts', 10), linedFile('b.ts', 10)] });
  });

  afterEach(() => {
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
  });

  it('opens the drawer on Shift+B with the keys in it, and closes it on Escape', async () => {
    renderApp();
    expect(await toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('file-tree-panel')).toHaveAttribute('inert');

    await pressShiftB();
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('file-tree-panel')).not.toHaveAttribute('inert');
    await waitFor(() => expect(fileListHasFocus()).toBe(true));

    await userEvent.keyboard('{Escape}');
    expect(await toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on Escape after opening from the header button', async () => {
    renderApp();
    fireEvent.click(await toggle());
    expect(await toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(fileListHasFocus()).toBe(false);

    await userEvent.keyboard('{Escape}');

    expect(await toggle()).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('App Component - Mobile layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    vi.mocked(useViewport).mockReturnValue({ isMobile: true, isDesktop: false });
    mockFetch(mockDiffResponse);
  });

  afterEach(() => {
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
  });

  it('lists changed files as chips and keeps the file tree drawer closed on load', async () => {
    window.localStorage.setItem('difit.sidebarOpen', 'true');

    renderApp();

    const chips = await screen.findByRole('navigation', { name: 'Changed files' });
    expect(within(chips).getByRole('button', { name: 'test.ts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /toggle file tree panel/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('closes the drawer when a file is selected on mobile', async () => {
    renderApp();

    const toggleButton = await screen.findByRole('button', { name: /toggle file tree panel/i });
    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');

    const fileTree = document.getElementById('file-tree-panel')!;
    fireEvent.click(within(fileTree).getByTitle('test.ts').closest('[data-file-row]')!);

    await waitFor(() => {
      expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    });
  });

  it('leaves the PC sidebar preference alone when the drawer is toggled on a phone', async () => {
    window.localStorage.setItem('difit.sidebarOpen', 'true');

    renderApp();

    const toggleButton = await screen.findByRole('button', { name: /toggle file tree panel/i });
    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggleButton);

    await waitFor(() => {
      expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    });
    expect(window.localStorage.getItem('difit.sidebarOpen')).toBe('true');
  });

  it('shows no file chips on a PC', async () => {
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });

    renderApp();

    await screen.findByRole('button', { name: /toggle file tree panel/i });
    expect(screen.queryByRole('navigation', { name: 'Changed files' })).not.toBeInTheDocument();
  });
});

describe('App Component - Fixup review colors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
  });

  it('scopes the fixup review palette to a review pinned to a hash', async () => {
    mockFetch(pinnedDiffResponse);

    const { container } = renderApp();

    await screen.findByRole('button', { name: /toggle file tree panel/i });
    expect(container.querySelector('[data-fixup-review]')).not.toBeNull();
  });

  it('keeps the original palette for a review that follows HEAD', async () => {
    mockFetch(mockDiffResponse);

    const { container } = renderApp();

    await screen.findByRole('button', { name: /toggle file tree panel/i });
    expect(container.querySelector('[data-fixup-review]')).toBeNull();
  });
});

describe('App Component - Newer commits on the followed ref', () => {
  const reviewAt = (commit: string): DiffResponse => ({
    ...pinnedDiffResponse,
    baseCommitish: `${commit}^`,
    targetCommitish: commit,
    requestedBaseCommitish: `${commit}^`,
    requestedTargetCommitish: commit,
  });
  const reopenButton = () => screen.queryByRole('button', { name: /HEAD에 새 커밋 2개/ });

  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockDecisions = [];
    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/revisions') {
        return Promise.resolve({ ok: true, json: async () => null } as Response);
      }
      if (url.startsWith('/api/fixups')) {
        const onOriginal = new URLSearchParams(url.split('?')[1]).get('target') === 'abc1234';
        return Promise.resolve({
          ok: true,
          json: async () => ({
            fixups: [],
            ...(onOriginal
              ? { newerTarget: { ref: 'HEAD', commit: 'fed9876', commitCount: 2 } }
              : {}),
          }),
        } as Response);
      }
      const target = url.startsWith('/api/diff')
        ? new URLSearchParams(url.split('?')[1]).get('target')
        : null;
      return Promise.resolve({
        ok: true,
        json: async () => reviewAt(target ?? 'abc1234'),
        blob: async () => ({ size: 1024 }),
      } as Response);
    });
  });

  it('reopens the review at the commit the followed ref moved to', async () => {
    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: /HEAD에 새 커밋 2개/ }));

    await waitFor(() =>
      expect(
        vi
          .mocked(global.fetch)
          .mock.calls.map(([url]) => String(url))
          .filter((url) => url.startsWith('/api/diff'))
          .map((url) => new URLSearchParams(url.split('?')[1]).get('base'))
          .at(-1),
      ).toBe('fed9876^'),
    );
    await waitFor(() => expect(reopenButton()).toBeNull());
  });
});

describe('App Component - Direct edit', () => {
  const editableReview: DiffResponse = {
    ...pinnedDiffResponse,
    directEditAvailable: true,
    files: [
      {
        path: 'test.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        chunks: [
          {
            header: '@@ -1,1 +1,2 @@',
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 2,
            lines: [
              { type: 'normal', content: 'const a = 1;', oldLineNumber: 1, newLineNumber: 1 },
              { type: 'add', content: '// says what a is', newLineNumber: 2 },
            ],
          },
        ],
      },
    ],
  };
  const editedThread = createMockThread({
    id: 'e1',
    filePath: 'test.ts',
    line: 2,
    body: '직접 고침',
    author: 'reviewer-edit',
  });
  const approval: ReviewDecision = {
    threadId: 'e1',
    kind: 'approved',
    fixupSha: 'f'.repeat(40),
    at: '2026-01-01T00:00:00Z',
  };

  function serve(editResponse: { status: number; body: unknown }, shown = editableReview) {
    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith('/api/direct-edit')) {
        return Promise.resolve({
          ok: editResponse.status === 200,
          status: editResponse.status,
          statusText: '',
          json: async () => editResponse.body,
        } as Response);
      }
      if (url.startsWith('/api/fixups')) {
        return Promise.resolve({ ok: true, json: async () => ({ fixups: [] }) } as Response);
      }
      if (url === '/api/revisions') {
        return Promise.resolve({ ok: true, json: async () => null } as Response);
      }
      if (url.startsWith('/api/blob/')) {
        const bytes = new TextEncoder().encode('const a = 1;\n// says what a is\n');
        return Promise.resolve({
          ok: true,
          text: async () => new TextDecoder().decode(bytes),
          arrayBuffer: async () => bytes.slice().buffer,
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => shown,
        blob: async () => ({ size: 1024 }),
      } as Response);
    });
  }

  const callsTo = (prefix: string) =>
    vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url).startsWith(prefix));

  async function hoverLineTwo() {
    const { container } = renderApp();
    const rows = await waitFor(() => {
      const found = container.querySelectorAll('[data-diff-line-row="true"]');
      expect(found).toHaveLength(2);
      return found;
    });
    fireEvent.mouseEnter(rows[1]!.children[2]!);
  }

  async function editLineTwo(text: string) {
    await hoverLineTwo();
    fireEvent.click(screen.getByRole('button', { name: '줄 직접 고치기' }));
    fireEvent.change(await screen.findByLabelText('고칠 코드'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockDecisions = [];
  });

  it('posts the edit as JSON and takes in the thread and approval the server made', async () => {
    serve({
      status: 200,
      body: {
        success: true,
        sha: approval.fixupSha,
        threadId: 'e1',
        version: 3,
        threads: [editedThread],
        decisions: [approval],
      },
    });

    await editLineTwo('');

    await waitFor(() => expect(mockMergeDecisions).toHaveBeenCalledWith([approval]));
    const [url, init] = callsTo('/api/direct-edit')[0]!;
    expect(String(url)).toBe('/api/direct-edit?base=abc1234%5E&target=abc1234');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      filePath: 'test.ts',
      startLine: 2,
      endLine: 2,
      original: ['// says what a is'],
      replacement: [''],
    });
    expect(mockReplaceThreads).toHaveBeenCalledWith([editedThread]);
    await waitFor(() => expect(callsTo('/api/fixups').length).toBeGreaterThan(1));
    expect(screen.queryByLabelText('고칠 코드')).not.toBeInTheDocument();
  });

  it('edits the lines of the one commit shown and says which commit to the server', async () => {
    const full = (short: string) => short.padEnd(40, '0');
    serve(
      { status: 200, body: { success: true, threads: [], decisions: [] } },
      {
        ...editableReview,
        baseCommitish: 'def4567',
        targetCommitish: '1111111',
        requestedBaseCommitish: full('def4567'),
        requestedTargetCommitish: full('1111111'),
        review: {
          selection: { baseCommitish: 'def4567', targetCommitish: 'abc1234' },
          requested: { baseCommitish: full('def4567'), targetCommitish: full('abc1234') },
          commits: [
            { sha: full('1111111'), shortSha: '1111111', parentSha: full('def4567'), subject: 'a' },
            { sha: full('abc1234'), shortSha: 'abc1234', parentSha: full('1111111'), subject: 'b' },
          ],
        },
      },
    );

    await editLineTwo('');

    await waitFor(() => expect(callsTo('/api/direct-edit')).toHaveLength(1));
    expect(callsTo('/api/blob/').map(([url]) => String(url))).toContain(
      '/api/blob/test.ts?ref=1111111',
    );
    const [url, init] = callsTo('/api/direct-edit')[0]!;
    expect(String(url)).toBe('/api/direct-edit?base=def4567&target=abc1234');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      startLine: 2,
      original: ['// says what a is'],
      view: { base: 'def4567', target: '1111111' },
    });
  });

  it('keeps the edit open and says why when the server refuses it', async () => {
    serve({
      status: 409,
      body: { error: 'Direct edit refused: commit-failed', reason: 'commit-failed', output: 'no' },
    });

    await editLineTwo('');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('fixup 커밋을 만들지 못했습니다.');
    expect(alert).toHaveTextContent('no');
    expect(mockMergeDecisions).not.toHaveBeenCalled();
    expect(screen.getByLabelText('고칠 코드')).toBeInTheDocument();
  });

  it('offers no edit for a review that follows HEAD', async () => {
    serve({ status: 200, body: {} });
    vi.mocked(global.fetch).mockImplementation((input) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          String(input).startsWith('/api/diff')
            ? { ...editableReview, ...mockDiffResponse, files: editableReview.files }
            : null,
      } as Response),
    );

    await hoverLineTwo();

    expect(screen.queryByRole('button', { name: 'Add a comment' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '줄 직접 고치기' })).not.toBeInTheDocument();
  });
});

describe('App Component - File at the top of the diff', () => {
  const twoFileResponse: DiffResponse = {
    ...mockDiffResponse,
    files: ['first.ts', 'second.ts'].map((path) => ({
      path,
      status: 'modified',
      additions: 1,
      deletions: 0,
      chunks: [
        {
          header: '@@ -1,1 +1,2 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: [
            { type: 'normal', content: 'const a = 1;', oldLineNumber: 1, newLineNumber: 1 },
            { type: 'add', content: 'const b = 2;', newLineNumber: 2 },
          ],
        },
      ],
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    mockFetch(twoFileResponse);
  });

  afterEach(() => {
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
  });

  function stubTop(element: HTMLElement, top: number) {
    element.getBoundingClientRect = () =>
      ({ top, bottom: top + 600, left: 0, right: 0, width: 0, height: 600 }) as DOMRect;
  }

  async function putCursorOnFirstFileThenScrollToSecond() {
    const user = userEvent.setup();
    renderApp();
    await screen.findAllByTitle('second.ts');

    await user.keyboard('j');

    const main = document.querySelector('main')!;
    const first = document.getElementById(getFileElementId('first.ts'))!;
    const second = document.getElementById(getFileElementId('second.ts'))!;
    stubTop(main, 0);
    main.scrollTop = 700;
    stubTop(first, -700);
    stubTop(second, -100);
    fireEvent.scroll(main);
  }

  it('marks the file at the top in the file list and leaves the cursor where it was', async () => {
    await putCursorOnFirstFileThenScrollToSecond();

    const fileTree = document.getElementById('file-tree-panel')!;
    const rowOf = (title: string) =>
      within(fileTree).getByTitle(title).closest<HTMLElement>('[data-file-row="true"]')!;
    await waitFor(() => {
      expect(rowOf('second.ts')).toHaveAttribute('data-scroll-visible', 'true');
    });
    expect(rowOf('second.ts')).not.toHaveAttribute('aria-current');
    expect(rowOf('first.ts')).toHaveAttribute('aria-current', 'true');
    expect(rowOf('first.ts')).not.toHaveAttribute('data-scroll-visible');
  });

  it('marks the file at the top among the phone chips the same way', async () => {
    vi.mocked(useViewport).mockReturnValue({ isMobile: true, isDesktop: false });

    await putCursorOnFirstFileThenScrollToSecond();

    const chips = screen.getByRole('navigation', { name: 'Changed files' });
    await waitFor(() => {
      expect(within(chips).getByTitle('second.ts')).toHaveAttribute('data-scroll-visible', 'true');
    });
    expect(within(chips).getByTitle('second.ts')).not.toHaveAttribute('aria-current');
    expect(within(chips).getByTitle('first.ts')).toHaveAttribute('aria-current', 'true');
  });
});

describe('App Component - Commits of the review', () => {
  const full = (short: string) => short.padEnd(40, '0');
  const COMMITS = [
    {
      sha: full('1111111'),
      shortSha: '1111111',
      parentSha: full('def4567'),
      subject: 'first step',
    },
    {
      sha: full('abc1234'),
      shortSha: 'abc1234',
      parentSha: full('1111111'),
      subject: 'second step',
    },
  ];
  const REVIEW = {
    selection: { baseCommitish: 'def4567', targetCommitish: 'abc1234' },
    requested: { baseCommitish: full('def4567'), targetCommitish: full('abc1234') },
    commits: COMMITS,
  };
  const file = {
    path: 'test.ts',
    status: 'modified' as const,
    additions: 1,
    deletions: 0,
    chunks: [
      {
        header: '@@ -1,1 +1,1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { type: 'normal' as const, content: 'const a = 1;', oldLineNumber: 1, newLineNumber: 1 },
        ],
      },
    ],
  };
  let review: DiffResponse['review'] = REVIEW;
  let moreReviewFiles: DiffResponse['files'] = [];
  let directEditAvailable = false;
  let firstStepLine = 'const a = 1;';
  const fileOf = (target: string | null) =>
    target === COMMITS[0]!.sha
      ? {
          ...file,
          chunks: file.chunks.map((chunk) => ({
            ...chunk,
            lines: chunk.lines.map((line) => ({ ...line, content: firstStepLine })),
          })),
        }
      : file;
  const THIRD = {
    sha: full('2222222'),
    shortSha: '2222222',
    parentSha: full('abc1234'),
    subject: 'third step',
  };
  const THREE_COMMITS = {
    selection: { baseCommitish: 'def4567', targetCommitish: '2222222' },
    requested: { baseCommitish: full('def4567'), targetCommitish: THIRD.sha },
    commits: [...COMMITS, THIRD],
  };
  let requested = REVIEW.requested;
  const viewOf = (base: string | null, target: string | null): DiffResponse => ({
    ...mockDiffResponse,
    baseCommitish: (base ?? requested.baseCommitish).slice(0, 7),
    targetCommitish: (target ?? requested.targetCommitish).slice(0, 7),
    requestedBaseCommitish: base ?? requested.baseCommitish,
    requestedTargetCommitish: target ?? requested.targetCommitish,
    files: [fileOf(target), ...moreReviewFiles],
    ...(review ? { review } : {}),
    ...(directEditAvailable ? { directEditAvailable } : {}),
  });
  const pinnedThread = (line: string): DiffCommentThread => ({
    ...createMockThread({ id: 'c3', filePath: 'test.ts', line: 1, body: 'Pinned here' }),
    codeSnapshot: { content: line, commit: COMMITS[0]!.sha },
    view: { baseCommitish: COMMITS[0]!.parentSha, targetCommitish: COMMITS[0]!.sha },
    fixupTarget: COMMITS[0]!.sha,
  });
  const fixupsFor: { current: unknown[] } = { current: [] };
  let chosenFixupTarget: string | undefined;
  const firstRow = () =>
    waitFor(() => {
      const found = document.querySelector('[data-diff-line-row="true"]');
      expect(found).not.toBeNull();
      return found!;
    });
  const diffQueries = () =>
    vi
      .mocked(global.fetch)
      .mock.calls.map(([url]) => String(url))
      .filter((url) => url.startsWith('/api/diff'))
      .map((url) => {
        const params = new URLSearchParams(url.split('?')[1]);
        return [params.get('base'), params.get('target')];
      });
  const commitButton = (name: RegExp | string) =>
    within(
      within(screen.getByRole('region', { name: '리뷰 범위의 커밋' })).getByRole('list'),
    ).getByRole('button', { name });

  beforeEach(() => {
    vi.clearAllMocks();
    review = REVIEW;
    moreReviewFiles = [];
    directEditAvailable = false;
    firstStepLine = 'const a = 1;';
    fixupsFor.current = [];
    chosenFixupTarget = undefined;
    requested = REVIEW.requested;
    mockDecisions = [];
    mockComments = [
      createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
    ];
    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/revisions') {
        return Promise.resolve({ ok: true, json: async () => null } as Response);
      }
      if (url.startsWith('/api/fixups')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ fixups: fixupsFor.current }),
        } as Response);
      }
      if (url.startsWith('/api/fixup-target')) {
        return Promise.resolve({
          ok: chosenFixupTarget !== undefined,
          json: async () => ({ fixupTarget: chosenFixupTarget }),
        } as Response);
      }
      const params = new URLSearchParams(url.split('?')[1]);
      return Promise.resolve({
        ok: true,
        json: async () =>
          url.startsWith('/api/diff')
            ? viewOf(params.get('base'), params.get('target'))
            : { threads: [], decisions: [] },
        blob: async () => ({ size: 1024 }),
      } as Response);
    });
  });

  afterEach(() => {
    window.history.replaceState(null, '');
  });

  it('lists the commits of the review below the files', async () => {
    renderApp();

    const commits = await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    expect(commitButton('전체')).toHaveAttribute('aria-current', 'true');
    expect(commitButton(/1111111/)).toBeInTheDocument();
    const fileTree = document.getElementById('file-tree-panel')!;
    const fileRow = within(fileTree).getByTitle('test.ts');
    expect(fileRow.compareDocumentPosition(commits)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('remembers the height the commit list was dragged to', async () => {
    window.localStorage.setItem('difit.commitListHeight', '300');
    renderApp();

    const commits = await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    expect(commits.style.maxHeight).toContain('300px');

    Object.defineProperty(document.getElementById('file-tree-panel')!, 'clientHeight', {
      value: 800,
    });
    vi.spyOn(commits, 'getBoundingClientRect').mockReturnValue({ height: 300 } as DOMRect);
    Object.defineProperty(within(commits).getByRole('list'), 'scrollHeight', { value: 1000 });
    const edge = within(commits).getByRole('separator', { name: '커밋 목록 높이 조절' });
    fireEvent.mouseDown(edge, { clientY: 500 });
    fireEvent.mouseMove(document, { clientY: 400 });
    fireEvent.mouseUp(document);

    expect(commits.style.maxHeight).toContain('400px');
    expect(window.localStorage.getItem('difit.commitListHeight')).toBe('400');
    await waitFor(() => {
      const saved = vi
        .mocked(global.fetch)
        .mock.calls.filter(([url, init]) => url === '/api/user-settings' && init?.method === 'PUT')
        .map(([, init]) => JSON.parse(String(init?.body)));
      expect(saved).toContainEqual({ client: { commitListHeight: 400 } });
    });
  });

  it('saves the first height the commit list is dragged to from its default', async () => {
    renderApp();

    const commits = await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    expect(commits.style.maxHeight).toBe('40%');
    Object.defineProperty(document.getElementById('file-tree-panel')!, 'clientHeight', {
      value: 800,
    });
    vi.spyOn(commits, 'getBoundingClientRect').mockReturnValue({ height: 300 } as DOMRect);
    Object.defineProperty(within(commits).getByRole('list'), 'scrollHeight', { value: 1000 });
    const edge = within(commits).getByRole('separator', { name: '커밋 목록 높이 조절' });
    fireEvent.mouseDown(edge, { clientY: 500 });
    fireEvent.mouseMove(document, { clientY: 450 });
    fireEvent.mouseUp(document);

    expect(window.localStorage.getItem('difit.commitListHeight')).toBe('350');
    await waitFor(() => {
      const saved = vi
        .mocked(global.fetch)
        .mock.calls.filter(([url, init]) => url === '/api/user-settings' && init?.method === 'PUT')
        .map(([, init]) => JSON.parse(String(init?.body)));
      expect(saved).toContainEqual({ client: { commitListHeight: 350 } });
    });
  });

  it('counts the open comments of each commit again as comments are added or resolved', async () => {
    const onFirstStep = (id: string): DiffCommentThread => ({
      ...createMockThread({ id, filePath: 'test.ts', line: 1, body: `On the first step ${id}` }),
      fixupTarget: COMMITS[0]!.sha,
    });
    mockComments = [mockComments[0]!, onFirstStep('c2')];
    const app = () => (
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <App />
      </HotkeysProvider>
    );
    const countOn = (name: RegExp) =>
      within(commitButton(name).closest('li')!).queryByTitle(/^열린 지적/);

    const { rerender } = renderApp();
    await waitFor(() => expect(countOn(/1111111/)).toHaveTextContent('1'));
    expect(countOn(/abc1234/)).toHaveTextContent('1');

    mockComments = [...mockComments, onFirstStep('c3')];
    rerender(app());
    expect(countOn(/1111111/)).toHaveTextContent('2');

    mockDecisions = [
      { threadId: 'c1', kind: 'resolved', fixupSha: '', at: '2026-01-01T00:00:00Z' },
    ];
    rerender(app());
    expect(countOn(/abc1234/)).not.toBeInTheDocument();
    expect(countOn(/1111111/)).toHaveTextContent('2');
  });

  it('shows on a commit the subject an amend! will give it until the amend! is rejected', async () => {
    const amend = {
      sha: 'f'.repeat(40),
      shortSha: 'fffffff',
      patchId: 'patch-1',
      authoredAt: '2026-01-01T00:00:00Z',
      subject: 'amend! first step',
      threadIds: ['c1'],
      files: [],
      foldTargetSha: COMMITS[0]!.sha,
      amendedMessage: { before: 'first step', after: 'first step, renamed' },
    };
    fixupsFor.current = [amend];
    const app = () => (
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <App />
      </HotkeysProvider>
    );

    const { rerender } = renderApp();
    await waitFor(() =>
      expect(within(commitButton(/1111111/)).getByText('first step, renamed')).toBeInTheDocument(),
    );
    expect(within(commitButton(/1111111/)).getByText('first step').tagName).toBe('DEL');

    mockDecisions = [
      { threadId: 'c1', kind: 'rejected', fixupSha: amend.sha, at: '2026-01-02T00:00:00Z' },
    ];
    rerender(app());
    expect(within(commitButton(/1111111/)).queryByText('first step, renamed')).toBeNull();
  });

  it('rewords a commit from the commit list and shows the amend! it made on that commit', async () => {
    directEditAvailable = true;
    const amend = {
      sha: 'e'.repeat(40),
      shortSha: 'eeeeeee',
      patchId: 'patch-e',
      authoredAt: '2026-01-01T00:00:00Z',
      subject: `amend! ${COMMITS[0]!.sha}`,
      threadIds: ['r1'],
      files: [],
      foldTargetSha: COMMITS[0]!.sha,
      amendedMessage: { before: 'first step', after: 'first step, renamed' },
    };
    const answer = vi.mocked(global.fetch).getMockImplementation()!;
    vi.mocked(global.fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.startsWith('/api/commit-message')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ message: 'first step' }),
        } as Response);
      }
      if (url.startsWith('/api/reword')) {
        fixupsFor.current = [amend];
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            sha: amend.sha,
            threadId: 'r1',
            version: 1,
            threads: [],
            decisions: [
              { threadId: 'r1', kind: 'approved', fixupSha: amend.sha, at: '2026-01-01T00:00:00Z' },
            ],
          }),
        } as Response);
      }
      return answer(input, init);
    });

    renderApp();
    const row = (await waitFor(() => commitButton(/1111111/))).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: '메시지 고치기' }));
    const editor = await within(row).findByRole('textbox', { name: '커밋 메시지' });
    expect(editor).toHaveValue('first step');
    fireEvent.change(editor, { target: { value: 'first step, renamed' } });
    fireEvent.click(within(row).getByRole('button', { name: '저장' }));

    await waitFor(() =>
      expect(within(commitButton(/1111111/)).getByText('first step, renamed')).toBeInTheDocument(),
    );
    const posted = vi
      .mocked(global.fetch)
      .mock.calls.find(([url]) => String(url).startsWith('/api/reword'))!;
    expect(String(posted[0])).toContain(`target=${REVIEW.selection.targetCommitish}`);
    expect(JSON.parse(String(posted[1]?.body))).toEqual({
      commit: COMMITS[0]!.sha,
      original: 'first step',
      message: 'first step, renamed',
    });
    expect(within(row).queryByRole('textbox', { name: '커밋 메시지' })).toBeNull();
  });

  it('offers no rewording where direct edits are off', async () => {
    renderApp();

    await waitFor(() => commitButton(/1111111/));
    expect(screen.queryByRole('button', { name: '메시지 고치기' })).toBeNull();
  });

  it('lists no commits for a review of one commit or one that is not pinned', async () => {
    review = { ...REVIEW, commits: COMMITS.slice(1) };
    const { unmount } = renderApp();
    await screen.findByText('Look here');
    expect(screen.queryByRole('region', { name: '리뷰 범위의 커밋' })).not.toBeInTheDocument();
    unmount();

    review = undefined;
    renderApp();
    await screen.findByText('Look here');
    expect(screen.queryByRole('region', { name: '리뷰 범위의 커밋' })).not.toBeInTheDocument();
  });

  it('shows one commit on a click and the whole review again on Back', async () => {
    renderApp();
    const lengthBefore = window.history.length;

    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/1111111/));

    await waitFor(() =>
      expect(diffQueries().at(-1)).toEqual([COMMITS[0]!.parentSha, COMMITS[0]!.sha]),
    );
    expect(window.history.length).toBe(lengthBefore + 1);
    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));

    act(() => window.history.back());
    await waitFor(() => expect(commitButton('전체')).toHaveAttribute('aria-current', 'true'));
    expect(diffQueries().at(-1)).toEqual([
      REVIEW.requested.baseCommitish,
      REVIEW.requested.targetCommitish,
    ]);
  });

  it('shows the whole review on a second click of the shown commit and that commit again on Back', async () => {
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/1111111/));
    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
    const lengthBefore = window.history.length;

    fireEvent.click(commitButton(/1111111/));

    await waitFor(() => expect(commitButton('전체')).toHaveAttribute('aria-current', 'true'));
    expect(diffQueries().at(-1)).toEqual([
      REVIEW.requested.baseCommitish,
      REVIEW.requested.targetCommitish,
    ]);
    expect(window.history.length).toBe(lengthBefore + 1);

    act(() => window.history.back());
    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
    expect(diffQueries().at(-1)).toEqual([COMMITS[0]!.parentSha, COMMITS[0]!.sha]);
  });

  it('shows the message above the diff on a touch screen wider than a phone', async () => {
    const hoverQuery = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches: query.includes('min-width'),
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    onTestFinished(() => hoverQuery.mockRestore());
    const answer = vi.mocked(global.fetch).getMockImplementation()!;
    vi.mocked(global.fetch).mockImplementation((input, init) =>
      String(input).startsWith('/api/commit-message')
        ? Promise.resolve({
            ok: true,
            json: async () => ({ message: 'first step\n\nWhy this step was needed' }),
          } as Response)
        : answer(input, init),
    );
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });

    fireEvent.click(commitButton(/1111111/));

    expect(await screen.findByText(/Why this step was needed/)).toBeInTheDocument();
  });

  it('draws a comment from before commit views only on the whole review and its last commit', async () => {
    renderApp();
    await screen.findByText('Look here');

    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/1111111/));
    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));

    expect(vi.mocked(useDiffComments).mock.lastCall?.slice(0, 2)).toEqual(['def4567', 'abc1234']);
    expect(screen.queryByText('Look here')).not.toBeInTheDocument();

    fireEvent.click(commitButton(/abc1234/));
    expect(await screen.findByText('Look here')).toBeInTheDocument();

    fireEvent.click(commitButton('전체'));
    expect(await screen.findByText('Look here')).toBeInTheDocument();
  });

  it('binds a comment made on one commit to that commit', async () => {
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/1111111/));
    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));

    fireEvent.mouseEnter((await firstRow()).children[2]!);
    const addButton = screen.getByRole('button', { name: 'Add a comment' });
    fireEvent.mouseDown(addButton, { shiftKey: true });
    fireEvent.change(await screen.findByPlaceholderText(/comment/i), {
      target: { value: 'Fix this here' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(
        vi
          .mocked(useDiffComments)
          .mock.results.flatMap(({ value }) => vi.mocked(value.addThread).mock.calls),
      ).toEqual([
        [
          expect.objectContaining({
            filePath: 'test.ts',
            line: 1,
            body: 'Fix this here',
            binding: {
              view: { baseCommitish: COMMITS[0]!.parentSha, targetCommitish: COMMITS[0]!.sha },
              fixupTarget: COMMITS[0]!.sha,
              snapshotCommit: COMMITS[0]!.sha,
            },
          }),
        ],
      ]),
    );
  });

  const addCommentOnFirstLine = async (body: string) => {
    fireEvent.mouseEnter((await firstRow()).children[2]!);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Add a comment' }), { shiftKey: true });
    fireEvent.change(await screen.findByPlaceholderText(/comment/i), { target: { value: body } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  };
  const addedThreads = () =>
    vi
      .mocked(useDiffComments)
      .mock.results.flatMap(({ value }) => vi.mocked(value.addThread).mock.calls);
  const fixupTargetQueries = () =>
    vi
      .mocked(global.fetch)
      .mock.calls.map(([url]) => String(url))
      .filter((url) => url.startsWith('/api/fixup-target'))
      .map((url) => Object.fromEntries(new URLSearchParams(url.split('?')[1])));

  const showFirstTwoOfThree = async () => {
    review = THREE_COMMITS;
    requested = THREE_COMMITS.requested;
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/1111111/));
    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
    fireEvent.click(commitButton(/abc1234/), { shiftKey: true });
    await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));
  };

  it('binds a comment made on a run of commits to the run and the commit the server chose', async () => {
    chosenFixupTarget = COMMITS[0]!.sha;
    await showFirstTwoOfThree();

    await addCommentOnFirstLine('Fix this in the run');

    await waitFor(() =>
      expect(addedThreads()).toEqual([
        [
          expect.objectContaining({
            body: 'Fix this in the run',
            binding: {
              view: { baseCommitish: COMMITS[0]!.parentSha, targetCommitish: COMMITS[1]!.sha },
              fixupTarget: COMMITS[0]!.sha,
              snapshotCommit: COMMITS[1]!.sha,
            },
          }),
        ],
      ]),
    );
    expect(fixupTargetQueries()).toEqual([
      { base: 'def4567', target: 'abc1234', path: 'test.ts', start: '1', end: '1', side: 'new' },
    ]);
  });

  it('binds a comment made on a run to its last commit when the server cannot choose', async () => {
    await showFirstTwoOfThree();

    await addCommentOnFirstLine('Fix this in the run');

    await waitFor(() =>
      expect(addedThreads()).toEqual([
        [
          expect.objectContaining({
            binding: expect.objectContaining({ fixupTarget: COMMITS[1]!.sha }),
          }),
        ],
      ]),
    );
  });

  it('adds the comment through the thread list as it is once the server has answered', async () => {
    let answer: ((response: Response) => void) | undefined;
    const answered = vi.mocked(global.fetch).getMockImplementation()!;
    vi.mocked(global.fetch).mockImplementation((input, init) =>
      String(input).startsWith('/api/fixup-target')
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : answered(input, init),
    );
    const { rerender } = renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });

    await addCommentOnFirstLine('Fix this somewhere');
    await waitFor(() => expect(answer).toBeDefined());
    rerender(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <App />
      </HotkeysProvider>,
    );
    const rendersBeforeAnswer = vi.mocked(useDiffComments).mock.results.length;
    answer!({ ok: true, json: async () => ({ fixupTarget: COMMITS[0]!.sha }) } as Response);

    await waitFor(() => expect(addedThreads()).toHaveLength(1));
    const callers = vi
      .mocked(useDiffComments)
      .mock.results.map(({ value }, index) => [index, vi.mocked(value.addThread).mock.calls.length])
      .filter(([, calls]) => calls > 0)
      .map(([index]) => index);
    expect(callers).toEqual([expect.any(Number)]);
    expect(callers[0]).toBeGreaterThanOrEqual(rendersBeforeAnswer - 1);
  });

  it('binds only the chosen commit to a comment made on the whole review', async () => {
    chosenFixupTarget = COMMITS[0]!.sha;
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });

    await addCommentOnFirstLine('Fix this somewhere');

    await waitFor(() =>
      expect(addedThreads()).toEqual([
        [expect.objectContaining({ binding: { fixupTarget: COMMITS[0]!.sha } })],
      ]),
    );
  });

  it('binds a comment on the whole file to the run and the commit the server chose for the file', async () => {
    chosenFixupTarget = COMMITS[0]!.sha;
    await showFirstTwoOfThree();

    fireEvent.click(await screen.findByRole('button', { name: '파일 전체에 지적 달기' }));
    fireEvent.change(await screen.findByPlaceholderText(/comment/i), {
      target: { value: 'Split this file' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(addedThreads()).toEqual([
        [
          {
            filePath: 'test.ts',
            body: 'Split this file',
            side: 'new',
            binding: {
              view: { baseCommitish: COMMITS[0]!.parentSha, targetCommitish: COMMITS[1]!.sha },
              fixupTarget: COMMITS[0]!.sha,
              snapshotCommit: COMMITS[1]!.sha,
            },
          },
        ],
      ]),
    );
    expect(fixupTargetQueries()).toEqual([
      { base: 'def4567', target: 'abc1234', path: 'test.ts', side: 'new', scope: 'file' },
    ]);
  });

  const commitThread = (sha: string, body: string): DiffCommentThread => ({
    id: `commit-${sha.slice(0, 7)}`,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    position: { scope: 'commit' },
    fixupTarget: sha,
    messages: [
      {
        id: `commit-${sha.slice(0, 7)}`,
        body,
        author: 'User',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ],
  });

  it('binds a comment on a whole commit to the one commit shown, without asking the server', async () => {
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    expect(screen.queryByRole('button', { name: '이 커밋 전체에 지적 달기' })).toBeNull();
    fireEvent.click(commitButton(/1111111/));
    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));

    fireEvent.click(await screen.findByRole('button', { name: '이 커밋 전체에 지적 달기' }));
    fireEvent.change(await screen.findByPlaceholderText(/comment/i), {
      target: { value: 'Split this commit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(addedThreads()).toEqual([
        [
          {
            scope: 'commit',
            body: 'Split this commit',
            binding: {
              view: { baseCommitish: COMMITS[0]!.parentSha, targetCommitish: COMMITS[0]!.sha },
              fixupTarget: COMMITS[0]!.sha,
              snapshotCommit: COMMITS[0]!.sha,
            },
          },
        ],
      ]),
    );
    expect(fixupTargetQueries()).toEqual([]);
  });

  it('binds a comment added from a commit row on the whole review to that commit and its own view', async () => {
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });

    fireEvent.click(
      within(commitButton(/1111111/).closest('li')!).getByRole('button', {
        name: '커밋에 지적 달기',
      }),
    );
    fireEvent.change(await screen.findByPlaceholderText(/comment/i), {
      target: { value: 'Reword this' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(addedThreads()).toEqual([
        [
          {
            scope: 'commit',
            body: 'Reword this',
            binding: {
              view: { baseCommitish: COMMITS[0]!.parentSha, targetCommitish: COMMITS[0]!.sha },
              fixupTarget: COMMITS[0]!.sha,
              snapshotCommit: COMMITS[0]!.sha,
            },
          },
        ],
      ]),
    );
  });

  it('shows comments on whole commits above the files, by commit, on a view holding them', async () => {
    mockComments = [
      commitThread(COMMITS[0]!.sha, 'Reword the first step'),
      commitThread(COMMITS[1]!.sha, 'Split the second step'),
    ];
    renderApp();

    const section = await screen.findByRole('region', { name: '커밋 지적' });
    expect(within(section).getByText('Reword the first step')).toBeInTheDocument();
    expect(within(section).getByText('Split the second step')).toBeInTheDocument();
    expect(within(section).getAllByText('커밋 1111111 first step').length).toBeGreaterThan(0);
    expect(within(section).queryByRole('button', { name: '이 커밋 전체에 지적 달기' })).toBeNull();
    expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();

    fireEvent.click(commitButton(/abc1234/));
    await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));
    const shown = () => screen.getByRole('region', { name: '커밋 지적' });
    await waitFor(() => expect(within(shown()).queryByText('Reword the first step')).toBeNull());
    expect(within(shown()).getByText('Split the second step')).toBeInTheDocument();
  });

  it('shows the fixup answering a comment on a whole commit on its card in the whole review', async () => {
    mockComments = [commitThread(COMMITS[0]!.sha, 'Split the first step')];
    fixupsFor.current = [
      {
        sha: 'f'.repeat(40),
        shortSha: 'fffffff',
        patchId: 'patch-1',
        authoredAt: '2026-01-01T00:00:00Z',
        subject: 'fixup! first step',
        threadIds: ['commit-1111111'],
        files: [{ path: 'notes.md', status: 'added', chunks: file.chunks }],
      },
    ];
    renderApp();

    const section = await screen.findByRole('region', { name: '커밋 지적' });
    expect(await within(section).findByTestId('fixup-overlay-card')).toHaveTextContent('fffffff');
    expect(within(section).getByText('notes.md')).toBeInTheDocument();
  });

  it('takes the fixup link of a deleted file to that file on the card of the commit comment it answers', async () => {
    mockComments = [commitThread(COMMITS[0]!.sha, 'Drop the old file')];
    moreReviewFiles = [{ ...file, path: 'old.ts', status: 'deleted', additions: 0, deletions: 1 }];
    const fixupSha = 'f'.repeat(40);
    fixupsFor.current = [
      {
        sha: fixupSha,
        shortSha: 'fffffff',
        patchId: 'patch-1',
        authoredAt: '2026-01-01T00:00:00Z',
        subject: 'fixup! first step',
        threadIds: ['commit-1111111'],
        files: [{ path: 'old.ts', status: 'modified', chunks: file.chunks }],
      },
    ];
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    renderApp();

    const section = await screen.findByRole('region', { name: '커밋 지적' });
    await within(section).findByTestId('fixup-overlay-card');
    scrolled.mockClear();
    fireEvent.click(
      within(document.getElementById(getFileElementId('old.ts'))!).getByRole('button', {
        name: 'fixup 수정',
      }),
    );

    await waitFor(() =>
      expect(scrolled.mock.contexts).toContain(
        document.getElementById(fixupFileElementId(fixupSha, 'old.ts')) ?? 'no held file element',
      ),
    );
    scrolled.mockRestore();
  });

  it('shows a comment on the whole file above the code and in the panel by its file name', async () => {
    mockComments = [
      {
        ...createMockThread({ id: 'f1', filePath: 'test.ts', line: 1, body: 'About this file' }),
        position: { side: 'new', scope: 'file' },
        codeSnapshot: { content: '' },
      },
    ];
    renderApp();

    const section = await screen.findByRole('region', { name: '파일 전체 지적' });
    expect(within(section).getByText('About this file')).toBeInTheDocument();
    expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
  });

  it('draws a comment made on one commit there and leaves it off the other commit', async () => {
    mockComments = [pinnedThread('const a = 1;')];
    renderApp();
    expect(await screen.findByText('Pinned here')).toBeInTheDocument();
    expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();

    fireEvent.click(commitButton(/abc1234/));
    await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));
    expect(screen.queryByText('Pinned here')).not.toBeInTheDocument();

    fireEvent.click(commitButton(/1111111/));
    expect(await screen.findByText('Pinned here')).toBeInTheDocument();
    expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
  });

  it('lists a comment the shown commit leaves off without marking it outdated', async () => {
    mockComments = [
      {
        ...createMockThread({ id: 'c2', filePath: 'other.ts', line: 1, body: 'Elsewhere' }),
        codeSnapshot: { content: 'const b = 2;', commit: 'abc1234' },
      },
    ];
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/1111111/));
    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));

    await userEvent.keyboard('{Shift>}L{/Shift}');

    expect(await screen.findByText('Elsewhere')).toBeInTheDocument();
    expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
  });

  it('paints a run of commits shown on load and names its ends in the header', async () => {
    review = THREE_COMMITS;

    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });

    expect(commitButton('전체')).not.toHaveAttribute('aria-current');
    expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true');
    expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true');
    expect(commitButton(/2222222/)).not.toHaveAttribute('aria-current');
    expect(
      within(screen.getByRole('region', { name: '리뷰 범위의 커밋' })).getByRole('button', {
        expanded: true,
      }),
    ).toHaveTextContent('1111111~abc1234 (2개)');
  });

  describe('with three commits', () => {
    beforeEach(() => {
      review = THREE_COMMITS;
      requested = THREE_COMMITS.requested;
    });

    it('shows the run between two commits on a Shift+click from either end', async () => {
      renderApp();
      await screen.findByRole('region', { name: '리뷰 범위의 커밋' });

      fireEvent.click(commitButton(/1111111/));
      await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
      fireEvent.click(commitButton(/abc1234/), { shiftKey: true });
      await waitFor(() =>
        expect(diffQueries().at(-1)).toEqual([COMMITS[0]!.parentSha, COMMITS[1]!.sha]),
      );
      await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));
      expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true');

      fireEvent.click(commitButton(/2222222/));
      await waitFor(() => expect(commitButton(/1111111/)).not.toHaveAttribute('aria-current'));
      fireEvent.click(commitButton(/abc1234/), { shiftKey: true });
      await waitFor(() => expect(diffQueries().at(-1)).toEqual([COMMITS[0]!.sha, THIRD.sha]));
    });

    it('shows the same run after dragging from one commit to another', async () => {
      renderApp();
      await screen.findByRole('region', { name: '리뷰 범위의 커밋' });

      fireEvent.mouseDown(commitButton(/abc1234/), { button: 0 });
      fireEvent.mouseEnter(commitButton(/1111111/));
      fireEvent.mouseUp(commitButton(/1111111/));

      await waitFor(() =>
        expect(diffQueries().at(-1)).toEqual([COMMITS[0]!.parentSha, COMMITS[1]!.sha]),
      );
      await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
      expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true');
    });

    it('shows the whole review for a run that covers every commit', async () => {
      renderApp();
      await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
      fireEvent.click(commitButton(/2222222/));
      await waitFor(() => expect(commitButton(/2222222/)).toHaveAttribute('aria-current', 'true'));

      fireEvent.click(commitButton(/1111111/), { shiftKey: true });

      await waitFor(() => expect(commitButton('전체')).toHaveAttribute('aria-current', 'true'));
      expect(diffQueries().at(-1)).toEqual([
        THREE_COMMITS.requested.baseCommitish,
        THREE_COMMITS.requested.targetCommitish,
      ]);
      expect(await screen.findByText('Look here')).toBeInTheDocument();
    });

    it('moves to the previous and next commit with the keys and from the whole review to the first and last', async () => {
      renderApp();
      await screen.findByRole('region', { name: '리뷰 범위의 커밋' });

      await userEvent.keyboard('{Shift>}>{/Shift}');
      await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
      await userEvent.keyboard('{Shift>}>{/Shift}');
      await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));
      expect(diffQueries().at(-1)).toEqual([COMMITS[1]!.parentSha, COMMITS[1]!.sha]);
      await userEvent.keyboard('{Shift>}<{/Shift}');
      await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));

      fireEvent.click(commitButton('전체'));
      await waitFor(() => expect(commitButton('전체')).toHaveAttribute('aria-current', 'true'));
      await userEvent.keyboard('{Shift>}<{/Shift}');
      await waitFor(() => expect(commitButton(/2222222/)).toHaveAttribute('aria-current', 'true'));
      expect(diffQueries().at(-1)).toEqual([THIRD.parentSha, THIRD.sha]);
    });

    it('goes back from a run to the commit shown before on Back', async () => {
      renderApp();
      await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
      fireEvent.click(commitButton(/1111111/));
      await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
      fireEvent.click(commitButton(/abc1234/), { shiftKey: true });
      await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));

      act(() => window.history.back());

      await waitFor(() => expect(commitButton(/abc1234/)).not.toHaveAttribute('aria-current'));
      expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true');
      expect(diffQueries().at(-1)).toEqual([COMMITS[0]!.parentSha, COMMITS[0]!.sha]);
    });

    it('keeps the comments of the review while a run is shown, without drawing or taking any', async () => {
      renderApp();
      await screen.findByText('Look here');
      fireEvent.click(commitButton(/1111111/));
      await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
      fireEvent.click(commitButton(/abc1234/), { shiftKey: true });
      await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));

      expect(vi.mocked(useDiffComments).mock.lastCall?.slice(0, 2)).toEqual(['def4567', '2222222']);
      expect(screen.queryByText('Look here')).not.toBeInTheDocument();
      const row = await waitFor(() => {
        const found = document.querySelector('[data-diff-line-row="true"]');
        expect(found).not.toBeNull();
        return found!;
      });
      fireEvent.mouseEnter(row);
      expect(screen.queryByRole('button', { name: 'Add a comment' })).not.toBeInTheDocument();
    });

    describe('on a phone', () => {
      const drawerButton = () => screen.getByRole('button', { name: '커밋 목록' });
      const longPress = async (name: RegExp) => {
        fireEvent.touchStart(commitButton(name), { touches: [{ clientX: 10, clientY: 10 }] });
        await act(() => new Promise((resolve) => setTimeout(resolve, 550)));
        fireEvent.touchEnd(commitButton(name), { changedTouches: [{ clientX: 10, clientY: 10 }] });
      };

      beforeEach(() => {
        vi.mocked(useViewport).mockReturnValue({ isMobile: true, isDesktop: false });
        vi.spyOn(document, 'elementFromPoint').mockReturnValue(null);
      });

      afterEach(() => {
        vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
        vi.mocked(document.elementFromPoint).mockRestore();
      });

      it('opens the commits in a drawer from the header and closes it once a commit is tapped', async () => {
        renderApp();
        await screen.findByText('Look here');
        expect(drawerButton()).toHaveAttribute('aria-expanded', 'false');
        expect(drawerButton()).toHaveTextContent('전체');

        fireEvent.click(drawerButton());
        expect(drawerButton()).toHaveAttribute('aria-expanded', 'true');
        fireEvent.click(commitButton(/abc1234/));

        await waitFor(() =>
          expect(diffQueries().at(-1)).toEqual([COMMITS[1]!.parentSha, COMMITS[1]!.sha]),
        );
        await waitFor(() => expect(drawerButton()).toHaveAttribute('aria-expanded', 'false'));
        await waitFor(() => expect(drawerButton()).toHaveTextContent('abc1234'));
      });

      it('closes the drawer from outside it without changing what is shown', async () => {
        renderApp();
        await screen.findByText('Look here');
        const queries = diffQueries().length;

        fireEvent.click(drawerButton());
        fireEvent.click(screen.getByRole('button', { name: '커밋 목록 닫기' }));

        expect(drawerButton()).toHaveAttribute('aria-expanded', 'false');
        expect(diffQueries()).toHaveLength(queries);
      });

      it('closes the drawer from its own button without changing what is shown', async () => {
        renderApp();
        await screen.findByText('Look here');
        const queries = diffQueries().length;

        fireEvent.click(drawerButton());
        fireEvent.click(screen.getByRole('button', { name: '커밋 서랍 닫기' }));

        expect(drawerButton()).toHaveAttribute('aria-expanded', 'false');
        expect(diffQueries()).toHaveLength(queries);
      });

      it('closes the drawer on Escape', async () => {
        renderApp();
        await screen.findByText('Look here');

        fireEvent.click(drawerButton());
        await userEvent.keyboard('{Escape}');

        expect(drawerButton()).toHaveAttribute('aria-expanded', 'false');
      });

      it('cancels a range being picked when the drawer closes from its own button', async () => {
        renderApp();
        await screen.findByText('Look here');
        fireEvent.click(drawerButton());
        await longPress(/1111111/);
        expect(screen.getByRole('status')).toHaveTextContent('범위 고르는 중');

        fireEvent.click(screen.getByRole('button', { name: '커밋 서랍 닫기' }));

        expect(drawerButton()).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByText('범위 고르는 중')).toBeNull();
      });

      it('shows the run between a long-pressed commit and the next one tapped', async () => {
        renderApp();
        await screen.findByText('Look here');
        fireEvent.click(drawerButton());
        const queries = diffQueries().length;

        await longPress(/1111111/);
        expect(screen.getByRole('status')).toHaveTextContent('범위 고르는 중');
        expect(diffQueries()).toHaveLength(queries);
        expect(drawerButton()).toHaveAttribute('aria-expanded', 'true');
        fireEvent.click(commitButton(/abc1234/));

        await waitFor(() =>
          expect(diffQueries().at(-1)).toEqual([COMMITS[0]!.parentSha, COMMITS[1]!.sha]),
        );
        await waitFor(() => expect(drawerButton()).toHaveAttribute('aria-expanded', 'false'));
        await waitFor(() =>
          expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'),
        );
        expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true');
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
      });

      it('goes back to choosing as before on cancel', async () => {
        renderApp();
        await screen.findByText('Look here');
        fireEvent.click(drawerButton());
        fireEvent.click(commitButton(/abc1234/));
        await waitFor(() =>
          expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'),
        );
        fireEvent.click(drawerButton());
        const queries = diffQueries().length;

        await longPress(/2222222/);
        fireEvent.click(screen.getByRole('button', { name: '취소' }));

        expect(screen.queryByRole('status')).not.toBeInTheDocument();
        expect(diffQueries()).toHaveLength(queries);
        expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true');
        fireEvent.click(commitButton(/1111111/));
        await waitFor(() =>
          expect(diffQueries().at(-1)).toEqual([COMMITS[0]!.parentSha, COMMITS[0]!.sha]),
        );
      });

      it('stops choosing a run when the drawer is closed', async () => {
        renderApp();
        await screen.findByText('Look here');
        fireEvent.click(drawerButton());
        await longPress(/1111111/);

        fireEvent.click(screen.getByRole('button', { name: '커밋 목록 닫기' }));
        fireEvent.click(drawerButton());

        expect(screen.queryByRole('status')).not.toBeInTheDocument();
      });
    });
  });

  it('offers no commit drawer on a phone for a review of one commit', async () => {
    vi.mocked(useViewport).mockReturnValue({ isMobile: true, isDesktop: false });
    review = { ...REVIEW, commits: COMMITS.slice(1) };
    renderApp();
    await screen.findByText('Look here');

    expect(screen.queryByRole('button', { name: '커밋 목록' })).not.toBeInTheDocument();
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
  });

  it('goes back to the whole review to show a comment picked from the list', async () => {
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/1111111/));
    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));

    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(commitButton('전체')).toHaveAttribute('aria-current', 'true'));
    expect(diffQueries().at(-1)).toEqual([
      REVIEW.requested.baseCommitish,
      REVIEW.requested.targetCommitish,
    ]);
    expect(await (await diffMain()).findByText('Look here')).toBeInTheDocument();
  });

  it('keeps the keys in the list after going to another view to show a comment', async () => {
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/1111111/));
    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));

    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(commitButton('전체')).toHaveAttribute('aria-current', 'true'));
    expect(await (await diffMain()).findByText('Look here')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(commentsPanel()!).getByRole('button', { name: /Look here/ })).toHaveFocus(),
    );
  });

  it('keeps the keys in the list after moving to the next commit from it', async () => {
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });

    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    await userEvent.keyboard('{Shift>}>{/Shift}');

    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
  });

  it('keeps the keys in the file list after moving to the next commit from it', async () => {
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });

    await pressShiftB();
    await waitFor(() => expect(fileListHasFocus()).toBe(true));
    await userEvent.keyboard('{Shift>}>{/Shift}');

    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
    await waitFor(() => expect(fileListHasFocus()).toBe(true));
  });

  it('leaves the keys on the diff after moving to the next commit from it', async () => {
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    await userEvent.keyboard('{Escape}');
    expect(commentsPanelHasFocus()).toBe(false);

    await userEvent.keyboard('{Shift>}>{/Shift}');

    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
    expect(commentsPanel()).toBeInTheDocument();
    expect(commentsPanelHasFocus()).toBe(false);
  });

  it('leaves the keys on the diff when Back cancels going to another view to show a comment', async () => {
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/1111111/));
    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    const answer = vi.mocked(global.fetch).getMockImplementation()!;
    vi.mocked(global.fetch).mockImplementation((input, init) => {
      const url = String(input);
      const target = new URLSearchParams(url.split('?')[1]).get('target');
      return url.startsWith('/api/diff') && target === REVIEW.requested.targetCommitish
        ? new Promise<Response>(() => {})
        : answer(input, init);
    });

    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '리뷰 범위의 커밋' })).not.toBeInTheDocument(),
    );
    act(() => window.history.back());

    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
    expect(commentsPanel()).toBeInTheDocument();
    expect(commentsPanelHasFocus()).toBe(false);
  });

  it('goes back to the whole review for a comment on a file the shown commit leaves alone', async () => {
    mockComments = [
      createMockThread({ id: 'c9', filePath: 'other.ts', line: 1, body: 'Elsewhere' }),
    ];
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/abc1234/));
    await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));

    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(commitButton('전체')).toHaveAttribute('aria-current', 'true'));
    expect(diffQueries().at(-1)).toEqual([
      REVIEW.requested.baseCommitish,
      REVIEW.requested.targetCommitish,
    ]);
  });

  it('goes back to the whole review for a comment the shown commit cannot place', async () => {
    mockComments = [
      {
        ...createMockThread({ id: 'c8', filePath: 'test.ts', line: 1, body: 'Gone here' }),
        codeSnapshot: { content: 'const gone = 0;' },
      },
    ];
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/abc1234/));
    await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));

    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(commitButton('전체')).toHaveAttribute('aria-current', 'true'));
  });

  it('stays on the shown commit to show a comment drawn there', async () => {
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/abc1234/));
    await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));
    const queriesBefore = diffQueries().length;

    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    await userEvent.keyboard('{Enter}');

    expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true');
    expect(diffQueries()).toHaveLength(queriesBefore);
  });

  it('scrolls to the card of a comment on the whole file picked from the list', async () => {
    mockComments = [
      {
        ...createMockThread({ id: 'f1', filePath: 'test.ts', line: 1, body: 'About this file' }),
        position: { side: 'new', scope: 'file' },
        codeSnapshot: { content: '' },
      },
    ];
    renderApp();
    await screen.findByText('About this file');
    const main = document.querySelector('main')!;
    const scrollTo = vi.fn();
    main.scrollTo = scrollTo;
    main.getBoundingClientRect = () =>
      ({ top: 0, bottom: 800, left: 0, right: 0, width: 0, height: 800 }) as DOMRect;
    const rect = (top: number, bottom: number) => () =>
      ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top }) as DOMRect;
    document.getElementById('file-comment-f1')!.getBoundingClientRect = rect(900, 1100);
    document.getElementById('comment-thread-f1')!.getBoundingClientRect = rect(1000, 1100);

    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 900 - 8 }));
  });

  it('brings the line of a comment picked from the list right under the file header, its card below', async () => {
    mockComments = [
      createMockThread({ id: 'l1', filePath: 'test.ts', line: 1, body: 'About this line' }),
    ];
    renderApp();
    await screen.findByText('About this line');
    const main = document.querySelector('main')!;
    const scrollTo = vi.fn();
    main.scrollTo = scrollTo;
    main.getBoundingClientRect = () =>
      ({ top: 0, bottom: 800, left: 0, right: 0, width: 0, height: 800 }) as DOMRect;
    const rect = (top: number, bottom: number) => () =>
      ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top }) as DOMRect;
    for (const line of document.querySelectorAll<HTMLElement>('[id^="file-0-chunk-"]')) {
      line.getBoundingClientRect = rect(900, 920);
    }
    document.getElementById('comment-thread-l1')!.getBoundingClientRect = rect(920, 1100);

    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 900 - 8 }));
  });

  describe('with a comment on a range of lines', () => {
    const rangeThread = (extraRanges?: number[]) => {
      const thread = createMockThread({
        id: 'r1',
        filePath: 'more.ts',
        line: 4,
        body: 'These lines',
      });
      return {
        ...thread,
        position: {
          side: 'new' as const,
          line: { start: 3, end: 4 },
          ...(extraRanges && { extraRanges }),
        },
      };
    };
    // Counted from 0.
    const newLine = (index: number) =>
      document.getElementById(`file-1-chunk-0-line-${index}-right`)!;
    const layOut = () => {
      const main = document.querySelector('main')!;
      const scrollTo = vi.fn();
      main.scrollTo = scrollTo;
      main.getBoundingClientRect = () =>
        ({ top: 0, bottom: 800, left: 0, right: 0, width: 0, height: 800 }) as DOMRect;
      const rect = (top: number, bottom: number) => () =>
        ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top }) as DOMRect;
      newLine(2).getBoundingClientRect = rect(500, 520);
      newLine(3).getBoundingClientRect = rect(520, 540);
      document.getElementById('comment-thread-r1')!.getBoundingClientRect = rect(540, 700);
      return scrollTo;
    };

    it('brings the first line of the range right under the file header', async () => {
      moreReviewFiles = [linedFile('more.ts', 6)];
      mockComments = [rangeThread()];
      renderApp();
      await screen.findByText('These lines');
      const scrollTo = layOut();

      await userEvent.keyboard('{Shift>}L{/Shift}');
      await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
      await userEvent.keyboard('{Enter}');

      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 500 - 8 }));
    });

    it('picks the comment and shows its card the same way from a line of its other range', async () => {
      moreReviewFiles = [linedFile('more.ts', 6)];
      mockComments = [rangeThread([1])];
      renderApp();
      await screen.findByText('These lines');
      const scrollTo = layOut();

      fireEvent.click(screen.getByRole('button', { name: /지적으로 가기$/ }));

      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 500 - 8 }));
      expect(document.getElementById('comment-thread-r1')).toHaveAttribute('data-picked', 'true');
    });
  });

  it('keeps the card of a whole-file comment on screen when the fixups above it are taller', async () => {
    mockComments = [
      {
        ...createMockThread({ id: 'f1', filePath: 'test.ts', line: 1, body: 'About this file' }),
        position: { side: 'new', scope: 'file' },
        codeSnapshot: { content: '' },
      },
    ];
    renderApp();
    await screen.findByText('About this file');
    const main = document.querySelector('main')!;
    const scrollTo = vi.fn();
    main.scrollTo = scrollTo;
    main.getBoundingClientRect = () =>
      ({ top: 0, bottom: 800, left: 0, right: 0, width: 0, height: 800 }) as DOMRect;
    const rect = (top: number, bottom: number) => () =>
      ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top }) as DOMRect;
    document.getElementById('file-comment-f1')!.getBoundingClientRect = rect(100, 2100);
    document.getElementById('comment-thread-f1')!.getBoundingClientRect = rect(2000, 2100);

    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    await userEvent.keyboard('{Enter}');

    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith({ top: expect.toSatisfy((top: number) => top > 1800) }),
    );
  });

  it('names on the card the commit a fix for the comment goes into', async () => {
    mockComments = [pinnedThread('const a = 1;')];
    renderApp();
    await screen.findByText('Pinned here');

    const card = document.getElementById('comment-thread-c3')!;
    expect(within(card).getByText('1111111')).toHaveAttribute('title', 'first step');
  });

  it('takes a comment outdated on the whole review back to its commit, and Back returns', async () => {
    firstStepLine = 'const pinned = 0;';
    mockComments = [pinnedThread('const pinned = 0;')];
    renderApp();
    await screen.findByText('Pinned here');
    const lengthBefore = window.history.length;

    expect(screen.getByLabelText('Outdated comment')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '이 지적을 달던 시점으로' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '이 지적을 단 화면으로' }));

    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
    expect(diffQueries().at(-1)).toEqual([COMMITS[0]!.parentSha, COMMITS[0]!.sha]);
    expect(window.history.length).toBe(lengthBefore + 1);
    await screen.findByText('Pinned here');
    expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();

    act(() => window.history.back());
    await waitFor(() => expect(commitButton('전체')).toHaveAttribute('aria-current', 'true'));
    expect(await screen.findByLabelText('Outdated comment')).toBeInTheDocument();
  });

  it('shows the fixup for a comment made on one commit under it there, ready to approve', async () => {
    firstStepLine = 'const pinned = 0;';
    mockComments = [pinnedThread('const pinned = 0;')];
    fixupsFor.current = [
      {
        sha: 'f'.repeat(40),
        shortSha: 'fffffff',
        patchId: 'patch-1',
        authoredAt: '2026-01-01T00:00:00Z',
        subject: 'fixup! first step',
        threadIds: ['c3'],
        files: [{ path: 'test.ts', status: 'modified', chunks: file.chunks }],
      },
    ];
    const recordFixupDecisions = vi.fn();
    const defaultComments = vi.mocked(useDiffComments).getMockImplementation()!;
    vi.mocked(useDiffComments).mockImplementation((...args) => ({
      ...defaultComments(...args),
      recordFixupDecisions,
    }));

    try {
      renderApp();
      await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
      fireEvent.click(commitButton(/1111111/));
      await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));

      expect(await screen.findByTestId('fixup-overlay-card')).toHaveTextContent('fffffff');
      fireEvent.click(screen.getByRole('button', { name: '승인' }));
      expect(recordFixupDecisions).toHaveBeenCalledWith('c3', 'approved', [
        { fixupSha: 'f'.repeat(40), patchId: 'patch-1' },
      ]);
      expect(vi.mocked(useDiffComments).mock.lastCall?.slice(0, 2)).toEqual(['def4567', 'abc1234']);
    } finally {
      vi.mocked(useDiffComments).mockImplementation(defaultComments);
    }
  });

  it('saves a reply written on a line of the card, and goes back to that line from the reply', async () => {
    const fixupLines = {
      fixupSha: 'f'.repeat(40),
      patchId: 'patch-1',
      filePath: 'test.ts',
      ranges: [{ side: 'new' as const, line: 1, code: 'const a = 1;' }],
    };
    fixupsFor.current = [
      {
        sha: 'f'.repeat(40),
        shortSha: 'fffffff',
        patchId: 'patch-1',
        authoredAt: '2026-01-01T00:00:00Z',
        subject: 'fixup! second step',
        threadIds: ['c1'],
        files: [{ path: 'test.ts', status: 'modified', chunks: file.chunks }],
      },
    ];
    const asked = createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' });
    mockComments = [
      {
        ...asked,
        messages: [
          ...asked.messages,
          { ...asked.messages[0]!, id: 'r1', body: '이 줄은?', fixupLines },
        ],
      },
    ];
    const replyToThread = vi.fn();
    const defaultComments = vi.mocked(useDiffComments).getMockImplementation()!;
    vi.mocked(useDiffComments).mockImplementation((...args) => ({
      ...defaultComments(...args),
      replyToThread,
    }));

    try {
      renderApp();
      const card = await screen.findByTestId('fixup-overlay-card');
      const cell = card.querySelector<HTMLElement>('[data-line-number-cell]')!;
      fireEvent.mouseDown(cell, { button: 0 });
      fireEvent.mouseUp(cell);
      fireEvent.click(cell.closest('tbody')!);
      const form = await within(card).findByRole('form', { name: 'fixup 줄에 답글' });
      fireEvent.change(within(form).getByPlaceholderText('이 줄에 답글...'), {
        target: { value: '여기도 봐 주세요' },
      });
      fireEvent.click(within(form).getByRole('button', { name: '답글' }));

      await waitFor(() =>
        expect(replyToThread).toHaveBeenCalledWith({
          threadId: 'c1',
          body: '여기도 봐 주세요',
          fixupLines,
        }),
      );

      fireEvent.click(screen.getByRole('button', { name: 'fffffff · test.ts · 수정 후 L1' }));

      await waitFor(() => expect(cell.closest('tr')).toHaveAttribute('data-line-link-flash'));
    } finally {
      vi.mocked(useDiffComments).mockImplementation(defaultComments);
    }
  });

  const openCardFormOnThreeLines = async () => {
    const added = (line: number) => ({
      type: 'add' as const,
      content: `const v${line} = ${line};`,
      newLineNumber: line,
    });
    fixupsFor.current = [
      {
        sha: 'f'.repeat(40),
        shortSha: 'fffffff',
        patchId: 'patch-1',
        authoredAt: '2026-01-01T00:00:00Z',
        subject: 'fixup! second step',
        threadIds: ['c1'],
        files: [
          {
            path: 'test.ts',
            status: 'modified',
            chunks: [
              {
                header: '@@ -0,0 +1,3 @@',
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: 3,
                lines: [added(1), added(2), added(3)],
              },
            ],
          },
        ],
      },
    ];
    mockComments = [
      createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
    ];

    renderApp();
    const card = await screen.findByTestId('fixup-overlay-card');
    const cells = [...card.querySelectorAll<HTMLElement>('[data-line-number-cell]')];
    fireEvent.mouseDown(cells[0]!, { button: 0 });
    fireEvent.mouseUp(cells[0]!);
    fireEvent.click(cells[0]!.closest('tbody')!);
    await within(card).findByRole('form', { name: 'fixup 줄에 답글' });
    return { card, cells };
  };

  it.each([
    { way: 'Shift+click', modifier: { shiftKey: true }, addButton: false, picked: 'L1-L3' },
    { way: 'Ctrl+click', modifier: { ctrlKey: true }, addButton: false, picked: 'L1, L3' },
    { way: 'click after the add button', modifier: {}, addButton: true, picked: 'L1, L3' },
  ])(
    'keeps the empty reply form of the card open on a $way that adds a line',
    async ({ modifier, addButton, picked }) => {
      const { card, cells } = await openCardFormOnThreeLines();
      if (addButton) {
        const box = within(card).getByPlaceholderText('이 줄에 답글...');
        fireEvent.change(box, { target: { value: 'x' } });
        fireEvent.click(within(card).getByRole('button', { name: '줄 더하기' }));
        fireEvent.change(box, { target: { value: '' } });
      }

      fireEvent.mouseDown(cells[2]!, { button: 0, ...modifier });
      expect(within(card).getByText('fffffff · test.ts · 수정 후 L1')).toBeInTheDocument();
      fireEvent.mouseUp(cells[2]!, modifier);
      fireEvent.click(cells[2]!, modifier);

      expect(
        await within(card).findByText(`fffffff · test.ts · 수정 후 ${picked}`),
      ).toBeInTheDocument();
    },
  );

  it.each([
    { key: 'Shift', modifier: { shiftKey: true } },
    { key: 'Ctrl', modifier: { ctrlKey: true } },
  ])(
    'closes the empty reply form of the card on a $key+click in the diff around it',
    async ({ modifier }) => {
      const { card } = await openCardFormOnThreeLines();
      const diffCell = document.querySelector<HTMLElement>(
        '[data-diff-line-row="true"] [data-line-number-cell]',
      )!;

      fireEvent.mouseDown(diffCell, { button: 0, ...modifier });
      fireEvent.mouseUp(diffCell, modifier);
      fireEvent.click(diffCell, modifier);

      await waitFor(() =>
        expect(within(card).queryByRole('form', { name: 'fixup 줄에 답글' })).toBeNull(),
      );
    },
  );

  it('closes an empty comment form of the diff on a Ctrl+click in the card', async () => {
    const { card, cells } = await openCardFormOnThreeLines();
    const diffCell = document.querySelector<HTMLElement>(
      '[data-diff-line-row="true"] [data-line-number-cell]',
    )!;
    fireEvent.mouseDown(diffCell, { button: 0, ctrlKey: true });
    fireEvent.mouseUp(diffCell, { ctrlKey: true });
    fireEvent.click(diffCell, { ctrlKey: true });
    await screen.findByPlaceholderText('Leave a comment...');

    fireEvent.mouseDown(cells[2]!, { button: 0, ctrlKey: true });
    fireEvent.mouseUp(cells[2]!, { ctrlKey: true });
    fireEvent.click(cells[2]!, { ctrlKey: true });

    await waitFor(() => expect(screen.queryByPlaceholderText('Leave a comment...')).toBeNull());
    expect(within(card).getByRole('form', { name: 'fixup 줄에 답글' })).toBeInTheDocument();
  });

  it('unfolds a viewed file on the commit it opens to show a comment picked from the list', async () => {
    mockViewedFiles = new Set(['test.ts']);
    mockComments = [pinnedThread('const a = 1;')];
    const { rerender } = renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/abc1234/));
    await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));

    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    mockHasLoadedInitialViewedFiles = false;
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));

    mockHasLoadedInitialViewedFiles = true;
    rerender(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <App />
      </HotkeysProvider>,
    );

    await waitFor(() =>
      expect(document.getElementById('comment-thread-c3')).toHaveAttribute('data-picked', 'true'),
    );
    mockViewedFiles = new Set<string>();
  });

  describe('files only a fixup changed', () => {
    const FIXUP_SHA = 'f'.repeat(40);
    const added = (path: string, contents: string[]) => ({
      path,
      status: 'added' as const,
      chunks: [
        {
          header: `@@ -0,0 +1,${contents.length} @@`,
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: contents.length,
          lines: contents.map((content, index) => ({
            type: 'add' as const,
            content,
            newLineNumber: index + 1,
          })),
        },
      ],
    });
    const fixupAnsweringC1 = () => ({
      sha: FIXUP_SHA,
      shortSha: 'fffffff',
      patchId: 'patch-1',
      authoredAt: '2026-01-01T00:00:00Z',
      subject: 'fixup! second step',
      threadIds: ['c1'],
      files: [
        { path: 'test.ts', status: 'modified', chunks: file.chunks },
        added('src/new.test.ts', ['first case', 'second case']),
        { ...added('pnpm-lock.yaml', ['lock entry']), isGenerated: true },
      ],
    });
    const fixupOnlyRegion = async () =>
      (await diffMain()).findByRole('region', { name: 'fixup fffffff에서만 수정한 파일' });
    const sectionOf = (path: string) =>
      document.querySelector<HTMLElement>(`[data-fixup-only-file="${path}"]`)!;

    beforeEach(() => {
      fixupsFor.current = [fixupAnsweringC1()];
    });

    it('draws them below the review files, the generated one folded, on the whole review only', async () => {
      renderApp();

      const region = await fixupOnlyRegion();
      expect(
        within(region).getByRole('heading', {
          name: 'fixup fffffff에서만 수정한 파일 — 승인하면 원래 커밋에 합쳐진다',
        }),
      ).toBeInTheDocument();
      expect(
        document.getElementById(getFileElementId('test.ts'))!.compareDocumentPosition(region),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(sectionOf('src/new.test.ts')).toHaveTextContent('second case');
      expect(sectionOf('src/new.test.ts')).toHaveTextContent('새 파일');
      expect(sectionOf('pnpm-lock.yaml')).toHaveTextContent('생성된 파일');
      expect(sectionOf('pnpm-lock.yaml')).not.toHaveTextContent('lock entry');
      expect(within(region).queryByRole('button', { name: /Viewed/ })).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /Viewed/ })).toHaveLength(1);

      fireEvent.click(commitButton(/abc1234/));
      await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));
      expect(
        (await diffMain()).queryByRole('region', { name: 'fixup fffffff에서만 수정한 파일' }),
      ).not.toBeInTheDocument();
    });

    it('unfolds the generated file when its name on the comment card is clicked', async () => {
      renderApp();
      await fixupOnlyRegion();

      const card = await screen.findByTestId('fixup-overlay-card');
      fireEvent.click(within(card).getByRole('button', { name: 'pnpm-lock.yaml' }));

      await waitFor(() => expect(sectionOf('pnpm-lock.yaml')).toHaveTextContent('lock entry'));
    });

    it('opens the whole review to show a file named on the card of one commit', async () => {
      renderApp();
      await fixupOnlyRegion();
      fireEvent.click(commitButton(/abc1234/));
      await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));

      const card = await screen.findByTestId('fixup-overlay-card');
      fireEvent.click(within(card).getByRole('button', { name: 'pnpm-lock.yaml' }));

      await waitFor(() => expect(commitButton('전체')).toHaveAttribute('aria-current', 'true'));
      await waitFor(() => expect(sectionOf('pnpm-lock.yaml')).toHaveTextContent('lock entry'));
    });

    it.each([
      ['the commented thread', COMMITS[0]!.sha, COMMITS[0]!.sha],
      ['the review target, when the thread has none', undefined, 'abc1234'],
    ])(
      'binds a comment there to the commit of %s without asking the server',
      async (_, threadTarget, expected) => {
        mockComments = [
          {
            ...createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
            ...(threadTarget ? { fixupTarget: threadTarget } : {}),
          },
        ];
        renderApp();
        const region = await fixupOnlyRegion();

        const row = region.querySelector('[data-diff-line-row="true"]')!;
        fireEvent.mouseEnter(row.children[2]!);
        fireEvent.mouseDown(within(region).getByRole('button', { name: 'Add a comment' }), {
          shiftKey: true,
        });
        fireEvent.change(await within(region).findByPlaceholderText(/comment/i), {
          target: { value: 'Name this case' },
        });
        fireEvent.click(within(region).getByRole('button', { name: 'Submit' }));

        await waitFor(() =>
          expect(addedThreads()).toEqual([
            [
              expect.objectContaining({
                filePath: 'src/new.test.ts',
                line: 1,
                binding: { fixupTarget: expected, snapshotCommit: FIXUP_SHA },
              }),
            ],
          ]),
        );
        expect(fixupTargetQueries()).toEqual([]);
      },
    );

    it('binds a comment there to the commit of the first thread the fixup answers that names one', async () => {
      fixupsFor.current = [{ ...fixupAnsweringC1(), threadIds: ['c1', 'c2'] }];
      mockComments = [
        createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
        {
          ...createMockThread({ id: 'c2', filePath: 'test.ts', line: 1, body: 'And here' }),
          fixupTarget: COMMITS[0]!.sha,
        },
      ];
      renderApp();
      const region = await fixupOnlyRegion();

      const row = region.querySelector('[data-diff-line-row="true"]')!;
      fireEvent.mouseEnter(row.children[2]!);
      fireEvent.mouseDown(within(region).getByRole('button', { name: 'Add a comment' }), {
        shiftKey: true,
      });
      fireEvent.change(await within(region).findByPlaceholderText(/comment/i), {
        target: { value: 'Name this case' },
      });
      fireEvent.click(within(region).getByRole('button', { name: 'Submit' }));

      await waitFor(() =>
        expect(addedThreads()).toEqual([
          [
            expect.objectContaining({
              filePath: 'src/new.test.ts',
              binding: { fixupTarget: COMMITS[0]!.sha, snapshotCommit: FIXUP_SHA },
            }),
          ],
        ]),
      );
    });

    it('binds a comment there to the commit the fixup folds into over the thread’s', async () => {
      fixupsFor.current = [{ ...fixupAnsweringC1(), foldTargetSha: COMMITS[1]!.sha }];
      mockComments = [
        {
          ...createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
          fixupTarget: COMMITS[0]!.sha,
        },
      ];
      renderApp();
      const region = await fixupOnlyRegion();

      const row = region.querySelector('[data-diff-line-row="true"]')!;
      fireEvent.mouseEnter(row.children[2]!);
      fireEvent.mouseDown(within(region).getByRole('button', { name: 'Add a comment' }), {
        shiftKey: true,
      });
      fireEvent.change(await within(region).findByPlaceholderText(/comment/i), {
        target: { value: 'Name this case' },
      });
      fireEvent.click(within(region).getByRole('button', { name: 'Submit' }));

      await waitFor(() =>
        expect(addedThreads()).toEqual([
          [
            expect.objectContaining({
              binding: { fixupTarget: COMMITS[1]!.sha, snapshotCommit: FIXUP_SHA },
            }),
          ],
        ]),
      );
    });

    it('numbers a comment on a line the fixup deleted in the fixup parent and draws it there', async () => {
      fixupsFor.current = [
        {
          ...fixupAnsweringC1(),
          files: [
            { path: 'test.ts', status: 'modified', chunks: file.chunks },
            {
              path: 'src/kept.ts',
              status: 'modified',
              chunks: [
                {
                  header: '@@ -1,3 +1,2 @@',
                  oldStart: 1,
                  oldLines: 3,
                  newStart: 1,
                  newLines: 2,
                  lines: [
                    { type: 'normal', content: 'first', oldLineNumber: 1, newLineNumber: 1 },
                    { type: 'delete', content: 'dropped', oldLineNumber: 2 },
                    { type: 'normal', content: 'last', oldLineNumber: 3, newLineNumber: 2 },
                  ],
                },
              ],
            },
          ],
        },
      ];
      renderApp();
      await fixupOnlyRegion();

      const deletedRow = [
        ...sectionOf('src/kept.ts').querySelectorAll('[data-diff-line-row="true"]'),
      ].find((row) => row.textContent?.includes('dropped'))!;
      fireEvent.mouseEnter(deletedRow.children[0]!);
      fireEvent.mouseDown(
        within(sectionOf('src/kept.ts')).getByRole('button', { name: 'Add a comment' }),
        { shiftKey: true },
      );
      fireEvent.change(await within(sectionOf('src/kept.ts')).findByPlaceholderText(/comment/i), {
        target: { value: 'Why drop this' },
      });
      fireEvent.click(within(sectionOf('src/kept.ts')).getByRole('button', { name: 'Submit' }));

      await waitFor(() =>
        expect(addedThreads()).toEqual([
          [
            expect.objectContaining({
              filePath: 'src/kept.ts',
              side: 'old',
              line: 2,
              binding: expect.objectContaining({ snapshotCommit: FIXUP_SHA }),
            }),
          ],
        ]),
      );
    });

    it('draws a stored comment on a line the fixup deleted at its line, not as outdated', async () => {
      fixupsFor.current = [
        {
          ...fixupAnsweringC1(),
          files: [
            { path: 'test.ts', status: 'modified', chunks: file.chunks },
            {
              path: 'src/kept.ts',
              status: 'modified',
              chunks: [
                {
                  header: '@@ -1,3 +1,1 @@',
                  oldStart: 1,
                  oldLines: 3,
                  newStart: 1,
                  newLines: 1,
                  lines: [
                    { type: 'delete', content: 'same', oldLineNumber: 1 },
                    { type: 'delete', content: 'same', oldLineNumber: 2 },
                    { type: 'normal', content: 'last', oldLineNumber: 3, newLineNumber: 1 },
                  ],
                },
              ],
            },
          ],
        },
      ];
      mockComments = [
        createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
        {
          ...createMockThread({ id: 'c5', filePath: 'src/kept.ts', line: 2, body: 'Why drop' }),
          position: { side: 'old', line: 2 },
          codeSnapshot: { content: 'same', commit: FIXUP_SHA },
        },
      ];
      renderApp();
      await fixupOnlyRegion();

      await waitFor(() => expect(sectionOf('src/kept.ts')).toHaveTextContent('Why drop'));
      expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
    });

    it.each(['unified', 'split'])(
      'draws their header and added lines in the fixup scope in the %s view',
      async (mode) => {
        window.localStorage.setItem('difit.diffViewMode', mode);
        renderApp();
        await fixupOnlyRegion();

        const section = sectionOf('src/new.test.ts');
        expect(section.querySelector('[data-file-header]')).toHaveTextContent('src/new.test.ts');
        const addedLines = [...section.querySelectorAll('.bg-diff-addition-bg')];
        expect(addedLines.some((line) => line.textContent?.includes('first case'))).toBe(true);
        expect(
          document.getElementById(getFileElementId('test.ts'))!.closest('[data-fixup-only-file]'),
        ).toBeNull();
      },
    );

    it('offers no direct edit there, since their lines are counted in the fixup', async () => {
      directEditAvailable = true;
      renderApp();
      const region = await fixupOnlyRegion();

      const reviewFile = document.getElementById(getFileElementId('test.ts'))!;
      fireEvent.mouseEnter(reviewFile.querySelector('[data-diff-line-row="true"]')!.children[2]!);
      expect(
        within(reviewFile).getByRole('button', { name: '줄 직접 고치기' }),
      ).toBeInTheDocument();

      fireEvent.mouseEnter(region.querySelector('[data-diff-line-row="true"]')!.children[2]!);
      expect(within(region).getByRole('button', { name: 'Add a comment' })).toBeInTheDocument();
      expect(within(region).queryByRole('button', { name: '줄 직접 고치기' })).toBeNull();
      expect(within(region).queryByRole('button', { name: /hunk 고치기/ })).toBeNull();
    });

    it('keeps a file the review deletes and the fixup brings back as a review file', async () => {
      moreReviewFiles = [
        {
          path: 'gone.ts',
          status: 'deleted',
          additions: 0,
          deletions: 1,
          chunks: [
            {
              header: '@@ -1,1 +0,0 @@',
              oldStart: 1,
              oldLines: 1,
              newStart: 0,
              newLines: 0,
              lines: [{ type: 'delete', content: 'old gone', oldLineNumber: 1 }],
            },
          ],
        },
      ];
      fixupsFor.current = [
        {
          ...fixupAnsweringC1(),
          files: [
            { path: 'test.ts', status: 'modified', chunks: file.chunks },
            added('gone.ts', ['back again']),
          ],
        },
      ];
      chosenFixupTarget = COMMITS[1]!.sha;
      renderApp();

      const card = await screen.findByTestId('fixup-overlay-card');
      await waitFor(() => expect(card).toHaveTextContent('back again'));
      expect(sectionOf('gone.ts')).toBeNull();

      const deletedFile = document.getElementById(getFileElementId('gone.ts'))!;
      const row = deletedFile.querySelector('[data-diff-line-row="true"]')!;
      fireEvent.mouseEnter(row.children[0]!);
      fireEvent.mouseDown(within(deletedFile).getByRole('button', { name: 'Add a comment' }), {
        shiftKey: true,
      });
      fireEvent.change(await within(deletedFile).findByPlaceholderText(/comment/i), {
        target: { value: 'Why delete this' },
      });
      fireEvent.click(within(deletedFile).getByRole('button', { name: 'Submit' }));

      await waitFor(() =>
        expect(addedThreads()).toEqual([
          [
            expect.objectContaining({
              filePath: 'gone.ts',
              binding: expect.not.objectContaining({ snapshotCommit: FIXUP_SHA }),
            }),
          ],
        ]),
      );
      expect(fixupTargetQueries()).toEqual([expect.objectContaining({ path: 'gone.ts' })]);
    });

    it('draws a comment made there at its line, not as outdated', async () => {
      mockComments = [
        createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
        {
          ...createMockThread({
            id: 'c4',
            filePath: 'src/new.test.ts',
            line: 2,
            body: 'Name this case',
          }),
          codeSnapshot: { content: 'second case', commit: FIXUP_SHA },
          fixupTarget: COMMITS[1]!.sha,
        },
      ];
      renderApp();
      await fixupOnlyRegion();

      await waitFor(() => expect(sectionOf('src/new.test.ts')).toHaveTextContent('Name this case'));
      expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
    });

    it('shows its section when an outdated comment made there is picked from the list', async () => {
      mockComments = [
        createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
        {
          ...createMockThread({
            id: 'c4',
            filePath: 'src/new.test.ts',
            line: 2,
            body: 'Gone case',
          }),
          codeSnapshot: { content: 'vanished case', commit: FIXUP_SHA },
          fixupTarget: COMMITS[1]!.sha,
        },
      ];
      renderApp();
      await fixupOnlyRegion();
      await waitFor(() => expect(sectionOf('src/new.test.ts')).toHaveTextContent('Gone case'));
      expect(
        within(sectionOf('src/new.test.ts')).getByLabelText('Outdated comment'),
      ).toBeInTheDocument();

      fireEvent.click(await screen.findByRole('button', { name: 'Toggle comments panel' }));
      fireEvent.click(within(commentsPanel()!).getByRole('button', { name: /Gone case/ }));

      await waitFor(() => expect(sectionOf('src/new.test.ts')).toHaveClass('border-github-accent'));
    });

    it('spreads a fixup answering a thread made there like any other fixup', async () => {
      const replaced = (line: number, from: string, to: string) => ({
        header: `@@ -${line},1 +${line},1 @@`,
        oldStart: line,
        oldLines: 1,
        newStart: line,
        newLines: 1,
        lines: [
          { type: 'delete' as const, content: from, oldLineNumber: line },
          { type: 'add' as const, content: to, newLineNumber: line },
        ],
      });
      moreReviewFiles = [
        {
          path: 'src/m.ts',
          status: 'modified',
          additions: 0,
          deletions: 0,
          chunks: [
            {
              header: '@@ -1,1 +1,1 @@',
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [
                { type: 'normal', content: 'const m = 1;', oldLineNumber: 1, newLineNumber: 1 },
              ],
            },
          ],
        },
      ];
      fixupsFor.current = [
        fixupAnsweringC1(),
        {
          sha: 'e'.repeat(40),
          shortSha: 'eeeeeee',
          patchId: 'patch-2',
          authoredAt: '2026-01-02T00:00:00Z',
          subject: 'fixup! second step',
          threadIds: ['c4'],
          files: [
            {
              path: 'src/new.test.ts',
              status: 'modified',
              chunks: [replaced(2, 'second case', 'renamed case')],
            },
            {
              path: 'src/m.ts',
              status: 'modified',
              chunks: [replaced(1, 'const m = 1;', 'const m = 2;')],
            },
          ],
        },
      ];
      mockComments = [
        createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
        {
          ...createMockThread({
            id: 'c4',
            filePath: 'src/new.test.ts',
            line: 2,
            body: 'Name this case',
          }),
          codeSnapshot: { content: 'second case', commit: FIXUP_SHA },
          fixupTarget: COMMITS[1]!.sha,
        },
      ];
      renderApp();
      await fixupOnlyRegion();

      const reviewFile = document.getElementById(getFileElementId('src/m.ts'))!;
      await waitFor(() =>
        expect(within(reviewFile).getByTestId('fixup-file-box')).toHaveTextContent('const m = 2;'),
      );
      const card = within(sectionOf('src/new.test.ts')).getByTestId('fixup-overlay-card');
      expect(card).toHaveTextContent('renamed case');
      fireEvent.click(within(card).getByRole('button', { name: 'src/m.ts' }));
      await waitFor(() =>
        expect(within(reviewFile).getByTestId('fixup-file-box')).toHaveClass(
          'border-github-accent',
        ),
      );
    });

    it('keeps drawing a file there and a thread on it when the same fixup answers that thread', async () => {
      fixupsFor.current = [{ ...fixupAnsweringC1(), threadIds: ['c1', 'c4'] }];
      mockComments = [
        createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
        {
          ...createMockThread({
            id: 'c4',
            filePath: 'src/new.test.ts',
            line: 2,
            body: 'Name this case',
          }),
          codeSnapshot: { content: 'second case', commit: FIXUP_SHA },
          fixupTarget: COMMITS[1]!.sha,
        },
      ];
      renderApp();
      await fixupOnlyRegion();

      await waitFor(() => expect(sectionOf('src/new.test.ts')).toHaveTextContent('Name this case'));
      expect(sectionOf('src/new.test.ts')).toHaveTextContent('second case');
      expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
    });

    describe('a later fixup answering a thread made there and a thread on a review file', () => {
      const LATER_SHA = 'e'.repeat(40);
      const madeThere = {
        ...createMockThread({ id: 'c4', filePath: 'src/new.test.ts', line: 2, body: 'Name it' }),
        codeSnapshot: { content: 'second case', commit: FIXUP_SHA },
        fixupTarget: COMMITS[1]!.sha,
      };
      const laterFixup = (newTestFile: unknown) => ({
        sha: LATER_SHA,
        shortSha: 'eeeeeee',
        patchId: 'patch-2',
        authoredAt: '2026-01-02T00:00:00Z',
        subject: 'fixup! second step',
        threadIds: ['c2', 'c4'],
        files: [newTestFile],
      });
      const laterRegion = () =>
        screen.queryByRole('region', { name: 'fixup eeeeeee에서만 수정한 파일' });

      beforeEach(() => {
        mockComments = [
          createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
          createMockThread({ id: 'c2', filePath: 'test.ts', line: 1, body: 'And here' }),
          madeThere,
        ];
      });

      it('keeps the thread in the section it was made in and draws the change on its card', async () => {
        fixupsFor.current = [
          fixupAnsweringC1(),
          laterFixup({
            path: 'src/new.test.ts',
            status: 'modified',
            chunks: [
              {
                header: '@@ -2,1 +2,1 @@',
                oldStart: 2,
                oldLines: 1,
                newStart: 2,
                newLines: 1,
                lines: [
                  { type: 'delete', content: 'second case', oldLineNumber: 2 },
                  { type: 'add', content: 'renamed case', newLineNumber: 2 },
                ],
              },
            ],
          }),
        ];
        renderApp();
        await fixupOnlyRegion();

        await waitFor(() => expect(sectionOf('src/new.test.ts')).toHaveTextContent('Name it'));
        const card = within(sectionOf('src/new.test.ts')).getByTestId('fixup-overlay-card');
        expect(card).toHaveTextContent('renamed case');
        expect(laterRegion()).toBeNull();
        expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
      });

      it('keeps the thread at its line there when the later fixup only shifts it', async () => {
        fixupsFor.current = [
          fixupAnsweringC1(),
          laterFixup({
            path: 'src/new.test.ts',
            status: 'modified',
            chunks: [
              {
                header: '@@ -1,2 +1,3 @@',
                oldStart: 1,
                oldLines: 2,
                newStart: 1,
                newLines: 3,
                lines: [
                  { type: 'add', content: 'zeroth case', newLineNumber: 1 },
                  { type: 'normal', content: 'first case', oldLineNumber: 1, newLineNumber: 2 },
                  { type: 'normal', content: 'second case', oldLineNumber: 2, newLineNumber: 3 },
                ],
              },
            ],
          }),
        ];
        renderApp();
        await fixupOnlyRegion();

        await waitFor(() => expect(sectionOf('src/new.test.ts')).toHaveTextContent('Name it'));
        expect(sectionOf('src/new.test.ts')).toHaveTextContent('src/new.test.ts:2');
        const card = within(sectionOf('src/new.test.ts')).getByTestId('fixup-overlay-card');
        expect(card).toHaveTextContent('zeroth case');
        expect(laterRegion()).toBeNull();
      });
    });

    it('gives a later fixup renaming a file there to the card of the thread made on it', async () => {
      fixupsFor.current = [
        fixupAnsweringC1(),
        {
          sha: 'e'.repeat(40),
          shortSha: 'eeeeeee',
          patchId: 'patch-2',
          authoredAt: '2026-01-02T00:00:00Z',
          subject: 'fixup! second step',
          threadIds: ['c4'],
          files: [
            {
              path: 'src/renamed.test.ts',
              oldPath: 'src/new.test.ts',
              status: 'renamed',
              chunks: [
                {
                  header: '@@ -2,1 +2,1 @@',
                  oldStart: 2,
                  oldLines: 1,
                  newStart: 2,
                  newLines: 1,
                  lines: [
                    { type: 'delete', content: 'second case', oldLineNumber: 2 },
                    { type: 'add', content: 'renamed case', newLineNumber: 2 },
                  ],
                },
              ],
            },
          ],
        },
      ];
      mockComments = [
        createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
        {
          ...createMockThread({ id: 'c4', filePath: 'src/new.test.ts', line: 2, body: 'Name it' }),
          codeSnapshot: { content: 'second case', commit: FIXUP_SHA },
          fixupTarget: COMMITS[1]!.sha,
        },
      ];
      renderApp();
      await fixupOnlyRegion();

      await waitFor(() => expect(sectionOf('src/new.test.ts')).toHaveTextContent('Name it'));
      const card = within(sectionOf('src/new.test.ts')).getByTestId('fixup-overlay-card');
      await waitFor(() => expect(card).toHaveTextContent('renamed case'));
      expect(sectionOf('src/renamed.test.ts')).toBeNull();
      expect(
        screen.queryByRole('region', { name: 'fixup eeeeeee에서만 수정한 파일' }),
      ).not.toBeInTheDocument();
    });

    describe('a file several of their fixups changed', () => {
      const B_SHA = 'e'.repeat(40);
      const C_SHA = 'd'.repeat(40);
      const replaced = (line: number, from: string, to: string) => ({
        header: `@@ -${line},1 +${line},1 @@`,
        oldStart: line,
        oldLines: 1,
        newStart: line,
        newLines: 1,
        lines: [
          { type: 'delete' as const, content: from, oldLineNumber: line },
          { type: 'add' as const, content: to, newLineNumber: line },
        ],
      });
      const fixupOf = (sha: string, threadIds: string[], files: unknown[]) => ({
        sha,
        shortSha: sha.slice(0, 7),
        patchId: `patch-${sha}`,
        authoredAt: '2026-01-02T00:00:00Z',
        subject: 'fixup! second step',
        threadIds,
        files,
      });
      const addingP = () => ({
        ...fixupAnsweringC1(),
        files: [
          { path: 'test.ts', status: 'modified', chunks: file.chunks },
          added('p.ts', ['p one', 'p two']),
        ],
      });
      const madeOn = (id: string, path: string, line: number, content: string, sha: string) => ({
        ...createMockThread({ id, filePath: path, line, body: `Look at ${id}` }),
        codeSnapshot: { content, commit: sha },
        fixupTarget: COMMITS[1]!.sha,
      });
      const regionOf = (shortSha: string) =>
        within(screen.getByRole('main')).queryByRole('region', {
          name: `fixup ${shortSha}에서만 수정한 파일`,
        });
      const fileIn = (shortSha: string, path: string) =>
        regionOf(shortSha)?.querySelector<HTMLElement>(`[data-fixup-only-file="${path}"]`) ?? null;

      it('answers a thread made on one group with a fixup on a file a later group shows', async () => {
        fixupsFor.current = [
          addingP(),
          fixupOf(
            B_SHA,
            ['y'],
            [
              { path: 'p.ts', status: 'modified', chunks: [replaced(2, 'p two', 'p 2')] },
              added('q.ts', ['q one', 'q two']),
            ],
          ),
          fixupOf(
            C_SHA,
            ['z'],
            [{ path: 'q.ts', status: 'modified', chunks: [replaced(1, 'q one', 'q 1')] }],
          ),
        ];
        mockComments = [
          createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
          madeOn('y', 'p.ts', 2, 'p two', FIXUP_SHA),
          madeOn('z', 'q.ts', 1, 'q one', B_SHA),
        ];
        renderApp();
        await fixupOnlyRegion();

        await waitFor(() => expect(fileIn('eeeeeee', 'q.ts')).toHaveTextContent('Look at z'));
        expect(
          within(fileIn('eeeeeee', 'q.ts')!).getByTestId('fixup-overlay-card'),
        ).toHaveTextContent('q 1');
        expect(fileIn('fffffff', 'p.ts')).toHaveTextContent('Look at y');
        expect(
          within(fileIn('fffffff', 'p.ts')!).getByTestId('fixup-overlay-card'),
        ).toHaveTextContent('p 2');
        expect(regionOf('ddddddd')).toBeNull();
        expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
      });

      it('draws the card of a thread on the group it was made on when a group between changed its line', async () => {
        mockComments = [
          createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
          createMockThread({ id: 'c2', filePath: 'test.ts', line: 1, body: 'And here' }),
          madeOn('y', 'p.ts', 2, 'p two', FIXUP_SHA),
        ];
        fixupsFor.current = [
          addingP(),
          fixupOf(
            B_SHA,
            ['c2'],
            [{ path: 'p.ts', status: 'modified', chunks: [replaced(2, 'p two', 'p 2')] }],
          ),
          fixupOf(
            C_SHA,
            ['y'],
            [{ path: 'p.ts', status: 'modified', chunks: [replaced(2, 'p 2', 'p II')] }],
          ),
        ];
        renderApp();
        await fixupOnlyRegion();

        await waitFor(() => expect(fileIn('fffffff', 'p.ts')).toHaveTextContent('Look at y'));
        expect(
          within(fileIn('fffffff', 'p.ts')!).getByTestId('fixup-overlay-card'),
        ).toHaveTextContent('p II');
        expect(fileIn('eeeeeee', 'p.ts')).toHaveTextContent('p 2');
        expect(fileIn('eeeeeee', 'p.ts')).not.toHaveTextContent('Look at y');
        expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
      });

      it('takes a comment in the section of an older group, bound to its fixup, and draws it there', async () => {
        mockComments = [
          createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
          createMockThread({ id: 'c2', filePath: 'test.ts', line: 1, body: 'And here' }),
        ];
        fixupsFor.current = [
          addingP(),
          fixupOf(
            B_SHA,
            ['c2'],
            [{ path: 'p.ts', status: 'modified', chunks: [replaced(2, 'p two', 'p 2')] }],
          ),
        ];
        const { rerender } = renderApp();
        await fixupOnlyRegion();
        await waitFor(() => expect(fileIn('eeeeeee', 'p.ts')).not.toBeNull());

        const older = fileIn('fffffff', 'p.ts')!;
        fireEvent.mouseEnter(older.querySelector('[data-diff-line-row="true"]')!.children[2]!);
        fireEvent.mouseDown(within(older).getByRole('button', { name: 'Add a comment' }), {
          shiftKey: true,
        });
        fireEvent.change(await within(older).findByPlaceholderText(/comment/i), {
          target: { value: 'Name this' },
        });
        fireEvent.click(within(older).getByRole('button', { name: 'Submit' }));

        await waitFor(() =>
          expect(addedThreads()).toEqual([
            [
              expect.objectContaining({
                filePath: 'p.ts',
                line: 1,
                binding: { fixupTarget: 'abc1234', snapshotCommit: FIXUP_SHA },
              }),
            ],
          ]),
        );

        mockComments = [...mockComments, madeOn('c6', 'p.ts', 1, 'p one', FIXUP_SHA)];
        rerender(
          <HotkeysProvider initiallyActiveScopes={['navigation']}>
            <App />
          </HotkeysProvider>,
        );
        await waitFor(() => expect(fileIn('fffffff', 'p.ts')).toHaveTextContent('Look at c6'));
        expect(fileIn('eeeeeee', 'p.ts')).not.toHaveTextContent('Look at c6');
        expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
      });
    });

    it('reads the lines of a file there once for all the threads on it', async () => {
      const madeThere = (id: string, line: number, content: string) => ({
        ...createMockThread({ id, filePath: 'src/new.test.ts', line, body: `Look at ${id}` }),
        codeSnapshot: { content, commit: FIXUP_SHA },
        fixupTarget: COMMITS[1]!.sha,
      });
      mockComments = [
        createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
        madeThere('c4', 1, 'first case'),
        madeThere('c5', 2, 'second case'),
      ];
      vi.mocked(placeThread).mockClear();
      renderApp();
      await waitFor(() => expect(sectionOf('src/new.test.ts')).toHaveTextContent('Look at c5'));

      const indexes = vi
        .mocked(placeThread)
        .mock.calls.filter(([, , , indexCommit]) => indexCommit === FIXUP_SHA)
        .map(([, , index]) => index);
      expect(indexes.length).toBeGreaterThan(0);
      expect(new Set(indexes).size * 2).toBe(indexes.length);
    });

    it('scrolls to the card, not the top of the file, when its thread is picked in the panel', async () => {
      mockComments = [
        createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
        {
          ...createMockThread({
            id: 'c4',
            filePath: 'src/new.test.ts',
            line: 2,
            body: 'Name this',
          }),
          codeSnapshot: { content: 'second case', commit: FIXUP_SHA },
          fixupTarget: COMMITS[1]!.sha,
        },
      ];
      renderApp();
      await waitFor(() => expect(sectionOf('src/new.test.ts')).toHaveTextContent('Name this'));
      await userEvent.keyboard('{Shift>}L{/Shift}');
      const row = await waitFor(() => {
        const found = document.querySelector<HTMLElement>('[data-thread-id="c4"]');
        expect(found).not.toBeNull();
        return found!;
      });
      mockScrollFileIntoDiffContainer.mockClear();

      fireEvent.click(row);

      await waitFor(() =>
        expect(mockScrollFileIntoDiffContainer).toHaveBeenLastCalledWith(
          'src/new.test.ts',
          'comment-thread-c4',
        ),
      );
    });

    it('places only their threads again and keeps the fixup spread when a thread gets a reply', async () => {
      const onFixupOnlyFile = {
        ...createMockThread({ id: 'c4', filePath: 'src/new.test.ts', line: 2, body: 'Name this' }),
        codeSnapshot: { content: 'second case', commit: FIXUP_SHA },
        fixupTarget: COMMITS[1]!.sha,
      };
      mockComments = [
        createMockThread({ id: 'c1', filePath: 'test.ts', line: 1, body: 'Look here' }),
        createMockThread({ id: 'c2', filePath: 'test.ts', line: 1, body: 'And here' }),
        onFixupOnlyFile,
      ];
      const { rerender } = renderApp();
      await waitFor(() => expect(sectionOf('src/new.test.ts')).toHaveTextContent('Name this'));
      vi.mocked(placeThread).mockClear();
      vi.mocked(spreadFixups).mockClear();

      const [first, second] = mockComments;
      mockComments = [
        { ...first!, messages: [...first!.messages, { ...first!.messages[0]!, id: 'r1' }] },
        second!,
        {
          ...onFixupOnlyFile,
          messages: [
            ...onFixupOnlyFile.messages,
            { ...onFixupOnlyFile.messages[0]!, id: 'r2', body: 'Renamed it' },
          ],
        },
      ];
      rerender(
        <HotkeysProvider initiallyActiveScopes={['navigation']}>
          <App />
        </HotkeysProvider>,
      );

      expect(vi.mocked(placeThread).mock.calls.map(([thread]) => thread.id)).toEqual([
        'c1',
        'c2',
        'c4',
      ]);
      expect(spreadFixups).not.toHaveBeenCalled();
      expect(sectionOf('src/new.test.ts')).toHaveTextContent('Renamed it');
      expect(screen.queryByLabelText('Outdated comment')).not.toBeInTheDocument();
    });
  });

  it('opens the commit a comment was made on to show it from the list', async () => {
    mockComments = [pinnedThread('const a = 1;')];
    renderApp();
    await screen.findByRole('region', { name: '리뷰 범위의 커밋' });
    fireEvent.click(commitButton(/abc1234/));
    await waitFor(() => expect(commitButton(/abc1234/)).toHaveAttribute('aria-current', 'true'));
    expect(screen.queryByText('Pinned here')).not.toBeInTheDocument();

    await userEvent.keyboard('{Shift>}L{/Shift}');
    await waitFor(() => expect(commentsPanelHasFocus()).toBe(true));
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(commitButton(/1111111/)).toHaveAttribute('aria-current', 'true'));
    expect(diffQueries().at(-1)).toEqual([COMMITS[0]!.parentSha, COMMITS[0]!.sha]);
  });
});

describe.each(['unified', 'split'] as const)('App Component - picking lines (%s)', (mode) => {
  const hunk = (start: number) => ({
    header: `@@ -${start},3 +${start},3 @@`,
    oldStart: start,
    oldLines: 3,
    newStart: start,
    newLines: 3,
    lines: [0, 1, 2].map((offset) => ({
      type: 'normal' as const,
      content: `line ${start + offset}`,
      oldLineNumber: start + offset,
      newLineNumber: start + offset,
    })),
  });
  const twoHunks: DiffResponse = {
    ...mockDiffResponse,
    files: [{ ...linedFile('test.ts', 0), chunks: [hunk(1), hunk(20)] }],
  };

  beforeEach(() => {
    mockComments = [];
    window.localStorage.setItem('difit.diffViewMode', mode);
    mockFetch(twoHunks);
  });

  const newNumberCell = (lineNumber: number, file = 'test.ts') =>
    waitFor(() => {
      const section = document.querySelector(`[data-file-path="${file}"]`)!;
      // Both layouts put the old number before the new one.
      const cell = Array.from(section.querySelectorAll('[data-line-number-cell]')).find(
        (candidate, index) => index % 2 === 1 && candidate.textContent === String(lineNumber),
      );
      expect(cell).toBeDefined();
      return cell!;
    });
  const picked = () =>
    Array.from(document.querySelectorAll('[data-diff-line-row="true"]'))
      .filter(
        (row) =>
          row.classList.contains('comment-selected') ||
          row.querySelector('[class*="after:bg-diff-selected-bg"]'),
      )
      .map((row) => row.lastElementChild?.textContent?.match(/line \d+/)?.[0]);
  // What a mouse does on a line number: the hover puts the comment button over the number, so
  // a click in the middle of the number lands on that button.
  const clickNumber = async (
    lineNumber: number,
    modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
    where: 'middle' | 'edge',
    file?: string,
  ) => {
    const cell = await newNumberCell(lineNumber, file);
    fireEvent.mouseEnter(cell.closest('tr')!.lastElementChild!);
    const target =
      where === 'middle'
        ? within(cell as HTMLElement).getByRole('button', { name: 'Add a comment' })
        : cell;
    fireEvent.mouseDown(target, { button: 0, ...modifiers });
    fireEvent.mouseUp(target, { button: 0, ...modifiers });
    fireEvent.click(target, { button: 0, ...modifiers });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  // A browser renders a cancelled form before the click reaches the line, which fireEvent does
  // not, so the cancel itself is what to watch.
  const cancels = vi.fn();
  const countCancels = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('[data-comment-cancel="true"]')) {
      cancels();
    }
  };
  beforeEach(() => {
    cancels.mockClear();
    document.addEventListener('click', countCancels, true);
  });
  afterEach(() => document.removeEventListener('click', countCancels, true));

  it.each(['middle', 'edge'] as const)(
    'keeps every line Ctrl+clicked on the %s of a line number, across parts',
    async (where) => {
      renderApp();

      await clickNumber(2, { ctrlKey: true }, where);
      await clickNumber(3, { ctrlKey: true }, where);
      await clickNumber(21, { metaKey: true }, where);

      expect(picked()).toEqual(['line 2', 'line 3', 'line 21']);
      expect(screen.getByTestId('picked-ranges')).toHaveTextContent('L2-L3, L21');
      expect(cancels).not.toHaveBeenCalled();
    },
  );

  const turnOnAddMode = () => {
    // happy-dom misses that the toggle sits inside the form, so it is pressed on a form with text.
    const box = screen.getByPlaceholderText('Leave a comment...');
    fireEvent.change(box, { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: '줄 더하기' }));
    fireEvent.change(box, { target: { value: '' } });
  };

  it('keeps lines added by plain clicks while 줄 더하기 is on', async () => {
    renderApp();

    await clickNumber(2, { ctrlKey: true }, 'edge');
    turnOnAddMode();
    await clickNumber(21, {}, 'middle');
    await clickNumber(22, {}, 'edge');

    expect(picked()).toEqual(['line 2', 'line 21', 'line 22']);
    expect(cancels).not.toHaveBeenCalled();
  });

  it('grows the range with Shift+click on the comment button while 줄 더하기 is on', async () => {
    renderApp();

    await clickNumber(2, { ctrlKey: true }, 'edge');
    turnOnAddMode();
    await clickNumber(3, { shiftKey: true }, 'middle');

    expect(picked()).toEqual(['line 2', 'line 3']);
  });

  it('keeps the empty form of the file open on a Shift+click on a line number', async () => {
    renderApp();

    await clickNumber(2, { ctrlKey: true }, 'edge');
    await clickNumber(3, { shiftKey: true }, 'edge');

    expect(picked()).toEqual(['line 2', 'line 3']);
    expect(cancels).not.toHaveBeenCalled();
  });

  it('still closes an empty form in another file when lines are picked', async () => {
    mockFetch({ ...twoHunks, files: [...twoHunks.files, { ...twoHunks.files[0]!, path: 'b.ts' }] });
    renderApp();

    await clickNumber(2, { ctrlKey: true }, 'edge');
    await clickNumber(21, { ctrlKey: true }, 'edge', 'b.ts');

    expect(document.querySelectorAll('form[data-empty]')).toHaveLength(1);
    expect(document.querySelector('[data-file-path="b.ts"] form')).not.toBeNull();
  });
});
