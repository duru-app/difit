import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DiffMode,
  type ClientWatchState,
  type SymbolIndexState,
  type WatchEvent,
} from '../../types/watch.js';
import { resolveLiveSocketUrl } from '../utils/liveSocketUrl';

interface FileWatchHook {
  shouldReload: boolean;
  isConnected: boolean;
  error: string | null;
  reload: () => void;
  watchState: ClientWatchState;
}

export function useFileWatch(
  onReload?: () => Promise<void>,
  onCommentsChanged?: () => Promise<void>,
  onSymbolIndexChanged?: (commit: string, state: SymbolIndexState) => void,
  onHeadMoved?: () => void,
): FileWatchHook {
  const socketRef = useRef<WebSocket | null>(null);
  // Read through a ref so a new callback identity never closes and reopens the connection,
  // which would drop events sent while reconnecting.
  const onCommentsChangedRef = useRef(onCommentsChanged);
  const onSymbolIndexChangedRef = useRef(onSymbolIndexChanged);
  useEffect(() => {
    onSymbolIndexChangedRef.current = onSymbolIndexChanged;
  }, [onSymbolIndexChanged]);
  const onHeadMovedRef = useRef(onHeadMoved);
  useEffect(() => {
    onHeadMovedRef.current = onHeadMoved;
  }, [onHeadMoved]);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 15;
  const reconnectDelay = 1000;

  const [watchState, setWatchState] = useState<ClientWatchState>({
    isWatchEnabled: false,
    diffMode: DiffMode.DEFAULT,
    shouldReload: false,
    isReloading: false,
    lastChangeTime: null,
    lastChangeType: null,
    connectionStatus: 'disconnected',
  });

  const [error, setError] = useState<string | null>(null);

  const connectToWatch = useCallback(() => {
    if (socketRef.current) {
      return; // Already connected
    }

    try {
      const socket = new WebSocket(resolveLiveSocketUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        console.log('Connected to file watch service');
        setWatchState((prev) => ({
          ...prev,
          connectionStatus: 'connected',
        }));
        reconnectAttemptsRef.current = 0;
        setError(null);
      };

      socket.onmessage = (event) => {
        try {
          // oxlint-disable-next-line typescript/no-unsafe-assignment
          const data: WatchEvent = JSON.parse(event.data as string);

          switch (data.type) {
            case 'connected':
              setWatchState((prev) => ({
                ...prev,
                isWatchEnabled: true,
                diffMode: data.diffMode,
                connectionStatus: 'connected',
              }));
              break;

            case 'reload':
              console.log('File changes detected, showing reload button:', data.changeType);
              setWatchState((prev) => ({
                ...prev,
                shouldReload: true,
                lastChangeTime: new Date(),
                lastChangeType: data.changeType,
              }));
              break;

            case 'error':
              console.error('File watch error:', data.message);
              setError(data.message || 'File watch error occurred');
              break;

            case 'commentsChanged':
              void onCommentsChangedRef.current?.();
              break;

            case 'headMoved':
              onHeadMovedRef.current?.();
              break;

            case 'symbolIndexChanged':
              onSymbolIndexChangedRef.current?.(data.commit, data.state);
              break;
          }
        } catch (parseError) {
          console.error('Error parsing watch event:', parseError);
        }
      };

      socket.onclose = () => {
        console.log('File watch connection lost');
        setWatchState((prev) => ({
          ...prev,
          connectionStatus: 'disconnected',
        }));
        socketRef.current = null;

        // Attempt to reconnect
        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          setWatchState((prev) => ({
            ...prev,
            connectionStatus: 'reconnecting',
          }));

          reconnectAttemptsRef.current += 1;

          reconnectTimeoutRef.current = setTimeout(() => {
            console.log(
              `Attempting to reconnect to file watch service (${reconnectAttemptsRef.current}/${maxReconnectAttempts})...`,
            );
            // oxlint-disable-next-line react-hooks-js/immutability -- connectToWatch is defined when setTimeout callback runs
            connectToWatch();
          }, reconnectDelay);
        } else {
          console.error('Max reconnection attempts reached');
          setError('Lost connection to file watch service');
        }
      };
    } catch (connectionError) {
      console.error('Failed to connect to file watch service:', connectionError);
      setError('Failed to connect to file watch service');
    }
  }, [maxReconnectAttempts, reconnectDelay]);

  const handleReload = useCallback(async () => {
    if (watchState.isReloading) {
      return; // Already reloading
    }

    setWatchState((prev) => ({
      ...prev,
      isReloading: true,
    }));

    try {
      if (onReload) {
        await onReload();
      }

      // Reset reload state after successful reload
      setWatchState((prev) => ({
        ...prev,
        shouldReload: false,
        isReloading: false,
        lastChangeTime: null,
        lastChangeType: null,
      }));
    } catch (reloadError) {
      console.error('Reload failed:', reloadError);
      setError('Failed to reload diff data');

      setWatchState((prev) => ({
        ...prev,
        isReloading: false,
      }));
    }
  }, [onReload, watchState.isReloading]);

  const cleanup = () => {
    if (socketRef.current) {
      socketRef.current.onclose = null;
      socketRef.current.close();
      socketRef.current = null;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  };

  // Initialize connection
  useEffect(() => {
    connectToWatch();

    return cleanup;
  }, [connectToWatch]);

  useEffect(() => {
    onCommentsChangedRef.current = onCommentsChanged;
    // Only a closed connection is reopened here, so one that ran out of retries still recovers.
    if (!socketRef.current) {
      cleanup();
      connectToWatch();
    }
  }, [onCommentsChanged, connectToWatch]);

  // Cleanup on unmount
  useEffect(() => {
    return cleanup;
  }, []);

  return {
    shouldReload: watchState.shouldReload,
    isConnected: watchState.connectionStatus === 'connected',
    error,
    reload: handleReload,
    watchState,
  };
}
