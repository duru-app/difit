import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CLIENT_GONE_GRACE_MS } from '../../server/client-presence.js';
import { DiffMode } from '../../types/watch.js';

import { useFileWatch } from './useFileWatch.js';

class MockWebSocket {
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  public readyState: number = 0;
  // A real socket reports its own close() through onclose too.
  public close = vi.fn(() => {
    setTimeout(() => this.dispatchClose(), 0);
  });

  constructor(public url: string) {
    MockWebSocket.instances.push(this);

    setTimeout(() => {
      this.readyState = 1; // OPEN
      if (this.onopen) {
        this.onopen(new Event('open'));
      }
    }, 10);
  }

  dispatchMessage(data: string) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data }));
    }
  }

  dispatchClose() {
    this.readyState = 3; // CLOSED
    if (this.onclose) {
      this.onclose(new CloseEvent('close'));
    }
  }

  static instances: MockWebSocket[] = [];
  static clearInstances() {
    MockWebSocket.instances = [];
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);

// Mock console methods
vi.stubGlobal('console', {
  log: vi.fn(),
  error: vi.fn(),
});

describe('useFileWatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.clearAllTimers();
    vi.unstubAllEnvs();
    MockWebSocket.clearInstances();
  });

  describe('initial state', () => {
    it('should initialize with default state', () => {
      const { result } = renderHook(() => useFileWatch());

      expect(result.current.shouldReload).toBe(false);
      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toBe(null);
      expect(result.current.watchState).toEqual({
        isWatchEnabled: false,
        diffMode: DiffMode.DEFAULT,
        shouldReload: false,
        isReloading: false,
        lastChangeTime: null,
        lastChangeType: null,
        connectionStatus: 'disconnected',
      });
    });
  });

  describe('live connection', () => {
    it('connects to the page origin by default', () => {
      renderHook(() => useFileWatch());

      expect(MockWebSocket.instances[0]?.url).toBe(`ws://${window.location.host}/api/live`);
    });

    it('uses the direct API url when configured for development', () => {
      vi.stubEnv('VITE_DIFIT_API_URL', 'http://localhost:4969');

      renderHook(() => useFileWatch());

      expect(MockWebSocket.instances[0]?.url).toBe('ws://localhost:4969/api/live');
    });

    it('should establish connection on mount', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      expect(result.current.watchState.connectionStatus).toBe('connected');
    });

    it('should handle connection events', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const socket = MockWebSocket.instances[0]!;

      act(() => {
        socket.dispatchMessage(
          JSON.stringify({
            type: 'connected',
            diffMode: DiffMode.WORKING,
            changeType: 'file',
            timestamp: new Date().toISOString(),
            message: 'Connected to file watcher',
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.watchState.isWatchEnabled).toBe(true);
        expect(result.current.watchState.diffMode).toBe(DiffMode.WORKING);
      });
    });

    it('should handle reload events', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const socket = MockWebSocket.instances[0]!;

      act(() => {
        socket.dispatchMessage(
          JSON.stringify({
            type: 'reload',
            diffMode: DiffMode.DOT,
            changeType: 'commit',
            timestamp: new Date().toISOString(),
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.shouldReload).toBe(true);
        expect(result.current.watchState.shouldReload).toBe(true);
        expect(result.current.watchState.lastChangeType).toBe('commit');
      });
    });

    it('should handle error events', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const socket = MockWebSocket.instances[0]!;

      act(() => {
        socket.dispatchMessage(
          JSON.stringify({
            type: 'error',
            diffMode: DiffMode.DEFAULT,
            changeType: 'file',
            timestamp: new Date().toISOString(),
            message: 'Watch error occurred',
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.error).toBe('Watch error occurred');
      });
    });

    it('should handle malformed messages gracefully', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const socket = MockWebSocket.instances[0]!;

      act(() => {
        socket.dispatchMessage('invalid json');
      });

      // Should not throw or crash
      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });
    });

    it('keeps the connection when the comments callback changes and calls the latest one', () => {
      const first = vi.fn(async () => {});
      const second = vi.fn(async () => {});
      const { rerender } = renderHook(
        ({ onCommentsChanged }) => useFileWatch(undefined, onCommentsChanged),
        {
          initialProps: { onCommentsChanged: first },
        },
      );

      rerender({ onCommentsChanged: second });
      act(() => {
        MockWebSocket.instances[0]!.dispatchMessage(
          JSON.stringify({
            type: 'commentsChanged',
            version: 2,
            timestamp: new Date().toISOString(),
          }),
        );
      });

      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.instances[0]!.close).not.toHaveBeenCalled();
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('passes on a HEAD move to the latest callback without reconnecting', () => {
      const first = vi.fn();
      const second = vi.fn();
      const { rerender } = renderHook(
        ({ onHeadMoved }) => useFileWatch(undefined, undefined, undefined, onHeadMoved),
        { initialProps: { onHeadMoved: first } },
      );

      rerender({ onHeadMoved: second });
      act(() => {
        MockWebSocket.instances[0]!.dispatchMessage(
          JSON.stringify({ type: 'headMoved', timestamp: new Date().toISOString() }),
        );
      });

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('tells of a rewritten history to the callback of the latest render', () => {
      const first = vi.fn(async () => {});
      const second = vi.fn(async () => {});
      const { rerender } = renderHook(
        ({ onHistoryRewritten }) =>
          useFileWatch(undefined, undefined, undefined, undefined, onHistoryRewritten),
        { initialProps: { onHistoryRewritten: first } },
      );

      rerender({ onHistoryRewritten: second });
      act(() => {
        MockWebSocket.instances[0]!.dispatchMessage(
          JSON.stringify({ type: 'historyRewritten', timestamp: new Date().toISOString() }),
        );
      });

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('passes on a change of a commit index without reconnecting', () => {
      const onSymbolIndexChanged = vi.fn();
      renderHook(() => useFileWatch(undefined, undefined, onSymbolIndexChanged));

      act(() => {
        MockWebSocket.instances[0]!.dispatchMessage(
          JSON.stringify({
            type: 'symbolIndexChanged',
            commit: 'a'.repeat(40),
            state: {
              status: 'failed',
              reason: 'timeout',
              detail: 'scip-java timed out',
              hasLog: true,
            },
            timestamp: new Date().toISOString(),
          }),
        );
      });

      expect(onSymbolIndexChanged).toHaveBeenCalledWith('a'.repeat(40), {
        status: 'failed',
        reason: 'timeout',
        detail: 'scip-java timed out',
        hasLog: true,
      });
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('reconnects after giving up when the comments callback changes', () => {
      vi.useFakeTimers();
      try {
        const { result, rerender } = renderHook(
          ({ onCommentsChanged }) => useFileWatch(undefined, onCommentsChanged),
          { initialProps: { onCommentsChanged: vi.fn(async () => {}) } },
        );

        for (let attempt = 0; attempt <= 15; attempt += 1) {
          const socket = MockWebSocket.instances.at(-1)!;
          socket.onopen = null;
          act(() => {
            socket.dispatchClose();
            vi.advanceTimersByTime(1000);
          });
        }
        expect(MockWebSocket.instances).toHaveLength(16);
        expect(result.current.error).toBe('Lost connection to file watch service');

        rerender({ onCommentsChanged: vi.fn(async () => {}) });

        expect(MockWebSocket.instances).toHaveLength(17);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('reload functionality', () => {
    it('should call onReload callback when reload is triggered', async () => {
      const mockOnReload = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileWatch(mockOnReload));

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      // Set shouldReload state first
      const socket = MockWebSocket.instances[0]!;
      act(() => {
        socket.dispatchMessage(
          JSON.stringify({
            type: 'reload',
            diffMode: DiffMode.DEFAULT,
            changeType: 'file',
            timestamp: new Date().toISOString(),
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.shouldReload).toBe(true);
      });

      // Trigger reload
      act(() => {
        result.current.reload();
      });

      await waitFor(() => {
        expect(mockOnReload).toHaveBeenCalled();
        expect(result.current.watchState.isReloading).toBe(true);
      });

      // Wait for reload to complete
      await waitFor(() => {
        expect(result.current.watchState.isReloading).toBe(false);
        expect(result.current.shouldReload).toBe(false);
      });
    });

    it('should handle reload errors', async () => {
      const mockOnReload = vi.fn().mockRejectedValue(new Error('Reload failed'));
      const { result } = renderHook(() => useFileWatch(mockOnReload));

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      // Set shouldReload state first
      const socket = MockWebSocket.instances[0]!;
      act(() => {
        socket.dispatchMessage(
          JSON.stringify({
            type: 'reload',
            diffMode: DiffMode.DEFAULT,
            changeType: 'file',
            timestamp: new Date().toISOString(),
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.shouldReload).toBe(true);
      });

      // Trigger reload
      act(() => {
        result.current.reload();
      });

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to reload diff data');
        expect(result.current.watchState.isReloading).toBe(false);
      });
    });

    it('should not reload if already reloading', async () => {
      const mockOnReload = vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));
      const { result } = renderHook(() => useFileWatch(mockOnReload));

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      // Set shouldReload state first
      const socket = MockWebSocket.instances[0]!;
      act(() => {
        socket.dispatchMessage(
          JSON.stringify({
            type: 'reload',
            diffMode: DiffMode.DEFAULT,
            changeType: 'file',
            timestamp: new Date().toISOString(),
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.shouldReload).toBe(true);
      });

      // Trigger first reload
      act(() => {
        result.current.reload();
      });

      await waitFor(() => {
        expect(result.current.watchState.isReloading).toBe(true);
      });

      // Try to trigger second reload while first is in progress
      act(() => {
        result.current.reload();
      });

      // Should only call onReload once
      expect(mockOnReload).toHaveBeenCalledTimes(1);
    });
  });

  describe('reconnection logic', () => {
    it('reconnects before the server gives up on the page', () => {
      vi.useFakeTimers();
      try {
        renderHook(() => useFileWatch());

        act(() => {
          MockWebSocket.instances[0]!.dispatchClose();
          vi.advanceTimersByTime(CLIENT_GONE_GRACE_MS / 2);
        });

        expect(MockWebSocket.instances).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not reconnect once unmounted', () => {
      vi.useFakeTimers();
      try {
        const { unmount } = renderHook(() => useFileWatch());

        unmount();
        act(() => {
          vi.advanceTimersByTime(CLIENT_GONE_GRACE_MS * 2);
        });

        expect(MockWebSocket.instances).toHaveLength(1);
        expect(MockWebSocket.instances[0]!.close).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should set reconnecting status on connection error', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const socket = MockWebSocket.instances[0]!;

      // Simulate connection error
      act(() => {
        socket.dispatchClose();
      });

      // Should show reconnecting status
      expect(result.current.watchState.connectionStatus).toBe('reconnecting');
    });

    it('should show error after max reconnection attempts', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const socket = MockWebSocket.instances[0]!;

      // Simulate connection error
      act(() => {
        socket.dispatchClose();
      });

      // Should show reconnecting status initially
      expect(result.current.watchState.connectionStatus).toBe('reconnecting');
    });
  });

  describe('cleanup', () => {
    it('should close connection on unmount', async () => {
      const { result, unmount } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const socket = MockWebSocket.instances[0]!;

      unmount();

      expect(socket.close).toHaveBeenCalled();
    });

    it('should clear timeouts on unmount', async () => {
      const { result, unmount } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const socket = MockWebSocket.instances[0]!;

      unmount();

      // Should close the connection
      expect(socket.close).toHaveBeenCalled();
    });
  });
});
