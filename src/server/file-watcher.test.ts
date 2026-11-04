import type { Event } from '@parcel/watcher';
import { resolve } from 'path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { DiffMode } from '../types/watch.js';

import { FileWatcherService } from './file-watcher.js';

// Mock @parcel/watcher
vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn(),
}));

// Mock simple-git
vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    checkIgnore: vi.fn(),
    revparse: vi.fn().mockResolvedValue('.git'),
  })),
}));

const { subscribe } = await import('@parcel/watcher');
const { simpleGit } = await import('simple-git');
const TEST_REPO_PATH = resolve('/test/path');
const TEST_WORKTREE_PATH = resolve('/worktree/path');
const TEST_REPOS_WORKTREE_PATH = resolve('/repos/worktree');

describe('FileWatcherService', () => {
  let fileWatcher: FileWatcherService;
  let mockClient: { send: Mock };
  let mockSubscription: { unsubscribe: () => Promise<void> };

  beforeEach(() => {
    vi.clearAllMocks();
    fileWatcher = new FileWatcherService();

    mockClient = { send: vi.fn() };

    // Mock subscription
    mockSubscription = {
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(subscribe).mockResolvedValue(mockSubscription);
  });

  describe('start', () => {
    it('should start watching for DEFAULT mode', async () => {
      await fileWatcher.start(DiffMode.DEFAULT, TEST_REPO_PATH, 300);

      expect(subscribe).toHaveBeenCalledWith(
        resolve(TEST_REPO_PATH, '.git'),
        expect.any(Function),
        {
          ignore: ['.git/objects/**', '.git/refs/**', 'node_modules/**'],
        },
      );
    });

    it('should start watching for WORKING mode', async () => {
      await fileWatcher.start(DiffMode.WORKING, TEST_REPO_PATH, 300);

      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(subscribe).toHaveBeenCalledWith(TEST_REPO_PATH, expect.any(Function), {
        ignore: ['.git/objects/**', '.git/refs/**', 'node_modules/**'],
      });
      expect(subscribe).toHaveBeenCalledWith(
        resolve(TEST_REPO_PATH, '.git'),
        expect.any(Function),
        {
          ignore: ['.git/objects/**', '.git/refs/**', 'node_modules/**'],
        },
      );
    });

    it('should start watching for DOT mode', async () => {
      await fileWatcher.start(DiffMode.DOT, TEST_REPO_PATH, 300);

      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(subscribe).toHaveBeenCalledWith(TEST_REPO_PATH, expect.any(Function), {
        ignore: [
          '.git/objects/**',
          '.git/refs/**',
          '.git/FETCH_HEAD',
          '.git/ORIG_HEAD',
          '.git/logs/**',
          'node_modules/**',
        ],
      });
    });

    it('watches only the git directory in SPECIFIC mode', async () => {
      await fileWatcher.start(DiffMode.SPECIFIC, TEST_REPO_PATH, 300);

      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledWith(
        resolve(TEST_REPO_PATH, '.git'),
        expect.any(Function),
        { ignore: ['.git/objects/**', '.git/refs/**'] },
      );
    });

    it('should initialize git instance for gitignore checking', async () => {
      await fileWatcher.start(DiffMode.DOT, TEST_REPO_PATH, 300);

      expect(simpleGit).toHaveBeenCalledWith(TEST_REPO_PATH);
    });
  });

  describe('stop', () => {
    it('should unsubscribe all watchers', async () => {
      await fileWatcher.start(DiffMode.WORKING, TEST_REPO_PATH, 300);
      await fileWatcher.stop();

      expect(mockSubscription.unsubscribe).toHaveBeenCalledTimes(2);
    });

    it('should clear clients', async () => {
      fileWatcher.addClient(mockClient);
      await fileWatcher.stop();

      // After stop, adding client should work normally (clients array should be cleared)
      expect(() => fileWatcher.addClient(mockClient)).not.toThrow();
    });
  });

  describe('client management', () => {
    it('should add and remove clients', () => {
      const mockClient1 = { send: vi.fn() };
      const mockClient2 = { send: vi.fn() };

      fileWatcher.addClient(mockClient1);
      fileWatcher.addClient(mockClient2);

      // Should send connected event to new clients
      expect(mockClient1.send).toHaveBeenCalledWith(expect.stringContaining('"type":"connected"'));
      expect(mockClient2.send).toHaveBeenCalledWith(expect.stringContaining('"type":"connected"'));

      fileWatcher.removeClient(mockClient1);

      // mockClient1 should be removed, but this is tested indirectly
      // by checking that only one client receives broadcasts
    });
  });

  describe('gitignore checking', () => {
    it('should check gitignore correctly', async () => {
      const mockGit = {
        checkIgnore: vi.fn().mockResolvedValue(['ignored-file.txt']),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit as any);

      await fileWatcher.start(DiffMode.DOT, TEST_REPO_PATH, 300);

      // Get the callback function passed to subscribe
      const subscribeCall = vi.mocked(subscribe).mock.calls[0];
      const callback = subscribeCall[1];

      // Simulate file change event
      const mockEvents: Event[] = [
        { path: `${TEST_REPO_PATH}/ignored-file.txt`, type: 'update' },
        { path: `${TEST_REPO_PATH}/normal-file.txt`, type: 'update' },
      ];

      await callback(null, mockEvents);

      expect(mockGit.checkIgnore).toHaveBeenCalledWith(['ignored-file.txt']);
      expect(mockGit.checkIgnore).toHaveBeenCalledWith(['normal-file.txt']);
    });

    it('should handle gitignore check errors gracefully', async () => {
      const mockGit = {
        checkIgnore: vi.fn().mockRejectedValue(new Error('No ignored files')),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit as any);

      await fileWatcher.start(DiffMode.DOT, TEST_REPO_PATH, 300);

      const subscribeCall = vi.mocked(subscribe).mock.calls[0];
      const callback = subscribeCall[1];

      const mockEvents: Event[] = [{ path: `${TEST_REPO_PATH}/some-file.txt`, type: 'update' }];

      // Should not throw when gitignore check fails
      await expect(callback(null, mockEvents)).resolves.not.toThrow();
    });
  });

  describe('file filtering', () => {
    beforeEach(async () => {
      const mockGit = {
        checkIgnore: vi.fn().mockRejectedValue(new Error('No ignored files')),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit as any);

      await fileWatcher.start(DiffMode.DEFAULT, TEST_REPO_PATH, 300);
      fileWatcher.addClient(mockClient);
    });

    it('should filter relevant git files for DEFAULT mode', async () => {
      const subscribeCall = vi.mocked(subscribe).mock.calls[0];
      const callback = subscribeCall[1];

      const mockEvents: Event[] = [
        { path: `${TEST_REPO_PATH}/.git/HEAD`, type: 'update' },
        { path: `${TEST_REPO_PATH}/.git/index`, type: 'update' },
        { path: `${TEST_REPO_PATH}/.git/objects/abc123`, type: 'update' },
      ];

      await callback(null, mockEvents);

      // Wait for debounce period
      await new Promise((resolve) => setTimeout(resolve, 350));

      // Should only broadcast for HEAD file in DEFAULT mode
      expect(mockClient.send).toHaveBeenCalledWith(expect.stringContaining('"type":"reload"'));
    });

    it('should filter out ignored patterns', async () => {
      const subscribeCall = vi.mocked(subscribe).mock.calls[0];
      const callback = subscribeCall[1];

      const mockEvents: Event[] = [
        { path: `${TEST_REPO_PATH}/.git/objects/abc123`, type: 'update' },
        { path: `${TEST_REPO_PATH}/.git/refs/heads/main`, type: 'update' },
        { path: `${TEST_REPO_PATH}/node_modules/package/file.js`, type: 'update' },
      ];

      await callback(null, mockEvents);

      // Should not broadcast for ignored files
      expect(mockClient.send).not.toHaveBeenCalledWith(expect.stringContaining('"type":"reload"'));
    });
  });

  describe('debounce functionality', () => {
    beforeEach(async () => {
      const mockGit = {
        checkIgnore: vi.fn().mockRejectedValue(new Error('No ignored files')),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit as any);

      await fileWatcher.start(DiffMode.DEFAULT, TEST_REPO_PATH, 100); // Short debounce for testing
      fileWatcher.addClient(mockClient);
    });

    it('should debounce multiple file changes', async () => {
      const subscribeCall = vi.mocked(subscribe).mock.calls[0];
      const callback = subscribeCall[1];

      const mockEvents: Event[] = [{ path: `${TEST_REPO_PATH}/.git/HEAD`, type: 'update' }];

      // Trigger multiple events quickly
      await callback(null, mockEvents);
      await callback(null, mockEvents);
      await callback(null, mockEvents);

      // Wait for debounce period
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should only send one reload event due to debouncing
      const reloadCalls = vi
        .mocked(mockClient.send)
        .mock.calls.filter((call) => call[0].toString().includes('"type":"reload"'));
      expect(reloadCalls).toHaveLength(1);
    });
  });

  describe('following HEAD', () => {
    const sentTypes = () =>
      vi
        .mocked(mockClient.send)
        .mock.calls.map((call) => (JSON.parse(String(call[0])) as { type: string }).type);

    const startFollowing = async (mode: DiffMode) => {
      vi.mocked(simpleGit).mockReturnValue({
        checkIgnore: vi.fn().mockRejectedValue(new Error('No ignored files')),
        revparse: vi.fn().mockResolvedValue('.git'),
      } as any);
      await fileWatcher.start(mode, TEST_REPO_PATH, 50);
      fileWatcher.addClient(mockClient);
      return vi.mocked(subscribe).mock.calls.find((call) => call[0].includes('.git'))![1];
    };

    const waitForDebounce = () => new Promise((resolve) => setTimeout(resolve, 100));

    it('tells clients HEAD moved, without a reload, when a commit lands in SPECIFIC mode', async () => {
      const callback = await startFollowing(DiffMode.SPECIFIC);

      await callback(null, [
        { path: `${TEST_REPO_PATH}/.git/logs/HEAD`, type: 'update' },
        { path: `${TEST_REPO_PATH}/.git/index`, type: 'update' },
      ]);
      await waitForDebounce();

      expect(sentTypes()).toEqual(['connected', 'headMoved']);
    });

    it('ignores git files other than the HEAD of the watched checkout in SPECIFIC mode', async () => {
      const callback = await startFollowing(DiffMode.SPECIFIC);

      await callback(null, [
        { path: `${TEST_REPO_PATH}/.git/index`, type: 'update' },
        { path: `${TEST_REPO_PATH}/.git/ORIG_HEAD`, type: 'update' },
        { path: `${TEST_REPO_PATH}/.git/worktrees/other/logs/HEAD`, type: 'update' },
        { path: `${TEST_REPO_PATH}/.git/logs/refs/remotes/origin/HEAD`, type: 'update' },
      ]);
      await waitForDebounce();

      expect(sentTypes()).toEqual(['connected']);
    });

    it('sends the reload and the HEAD move together in DEFAULT mode', async () => {
      const callback = await startFollowing(DiffMode.DEFAULT);

      await callback(null, [{ path: `${TEST_REPO_PATH}/.git/logs/HEAD`, type: 'update' }]);
      await waitForDebounce();

      expect(sentTypes()).toEqual(['connected', 'reload', 'headMoved']);
    });
  });

  describe('change type determination', () => {
    it('should determine correct change type for each mode', async () => {
      const modes = [
        { mode: DiffMode.DEFAULT, expectedType: 'commit' },
        { mode: DiffMode.DOT, expectedType: 'commit' },
        { mode: DiffMode.STAGED, expectedType: 'staging' },
        { mode: DiffMode.WORKING, expectedType: 'file' },
      ];

      for (const { mode, expectedType } of modes) {
        const mockGit = {
          checkIgnore: vi.fn().mockRejectedValue(new Error('No ignored files')),
          revparse: vi.fn().mockResolvedValue('.git'),
        };
        vi.mocked(simpleGit).mockReturnValue(mockGit as any);

        await fileWatcher.start(mode, TEST_REPO_PATH, 300);
        const modeClient = { send: vi.fn() };
        fileWatcher.addClient(modeClient);

        const subscribeCall = vi
          .mocked(subscribe)
          .mock.calls.find((call) => call[0].includes('.git'));
        if (subscribeCall) {
          const callback = subscribeCall[1];
          const mockEvents: Event[] = [{ path: `${TEST_REPO_PATH}/.git/HEAD`, type: 'update' }];

          await callback(null, mockEvents);

          await new Promise((resolve) => setTimeout(resolve, 350)); // Wait for debounce

          expect(modeClient.send).toHaveBeenCalledWith(
            expect.stringContaining(`"changeType":"${expectedType}"`),
          );
        }

        await fileWatcher.stop();
        vi.clearAllMocks();
      }
    });
  });

  describe('git worktree support', () => {
    it('should use resolved git directory for normal repository', async () => {
      const mockGit = {
        checkIgnore: vi.fn(),
        revparse: vi.fn().mockResolvedValue('.git'),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit as any);

      await fileWatcher.start(DiffMode.DEFAULT, TEST_REPO_PATH, 300);

      expect(mockGit.revparse).toHaveBeenCalledWith(['--git-dir']);
      expect(subscribe).toHaveBeenCalledWith(
        resolve(TEST_REPO_PATH, '.git'),
        expect.any(Function),
        {
          ignore: ['.git/objects/**', '.git/refs/**', 'node_modules/**'],
        },
      );
    });

    it('should resolve worktree git directory path', async () => {
      const mockGit = {
        checkIgnore: vi.fn(),
        revparse: vi.fn().mockResolvedValue('/main/repo/.git/worktrees/feature'),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit as any);

      await fileWatcher.start(DiffMode.DEFAULT, TEST_WORKTREE_PATH, 300);

      expect(mockGit.revparse).toHaveBeenCalledWith(['--git-dir']);
      expect(subscribe).toHaveBeenCalledWith(
        resolve('/main/repo/.git/worktrees/feature'),
        expect.any(Function),
        {
          ignore: ['.git/objects/**', '.git/refs/**', 'node_modules/**'],
        },
      );
    });

    it('should resolve relative git directory path', async () => {
      const mockGit = {
        checkIgnore: vi.fn(),
        revparse: vi.fn().mockResolvedValue('../.git/worktrees/feature'),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit as any);

      await fileWatcher.start(DiffMode.DEFAULT, TEST_REPOS_WORKTREE_PATH, 300);

      expect(mockGit.revparse).toHaveBeenCalledWith(['--git-dir']);
      // path.resolve(TEST_REPOS_WORKTREE_PATH, '../.git/worktrees/feature')
      expect(subscribe).toHaveBeenCalledWith(
        resolve(TEST_REPOS_WORKTREE_PATH, '../.git/worktrees/feature'),
        expect.any(Function),
        {
          ignore: ['.git/objects/**', '.git/refs/**', 'node_modules/**'],
        },
      );
    });

    it('should fallback to default .git path on error', async () => {
      const mockGit = {
        checkIgnore: vi.fn(),
        revparse: vi.fn().mockRejectedValue(new Error('Not a git repository')),
      };
      vi.mocked(simpleGit).mockReturnValue(mockGit as any);

      await fileWatcher.start(DiffMode.DEFAULT, TEST_REPO_PATH, 300);

      expect(subscribe).toHaveBeenCalledWith(
        resolve(TEST_REPO_PATH, '.git'),
        expect.any(Function),
        {
          ignore: ['.git/objects/**', '.git/refs/**', 'node_modules/**'],
        },
      );
    });
  });
});
