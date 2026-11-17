import { useEffect, useRef } from 'react';

import {
  canNotify,
  newReviewerTurns,
  requestNotificationPermission,
  showReplyNotification,
  type ReviewerTurn,
} from '../utils/replyNotifications';

interface UseReplyNotificationsOptions {
  contextKey: string | null;
  ready: boolean;
  enabled: boolean;
  turns: ReviewerTurn[];
  onOpenThread: (threadId: string) => void;
}

export function useReplyNotifications({
  contextKey,
  ready,
  enabled,
  turns,
  onOpenThread,
}: UseReplyNotificationsOptions): void {
  const seenRef = useRef<{ contextKey: string | null; keys: Map<string, string> } | null>(null);
  const onOpenThreadRef = useRef(onOpenThread);
  onOpenThreadRef.current = onOpenThread;

  useEffect(() => {
    if (!ready) {
      seenRef.current = null;
      return;
    }
    const seen = seenRef.current;
    const fresh = seen?.contextKey === contextKey ? newReviewerTurns(seen.keys, turns) : [];
    seenRef.current = {
      contextKey,
      keys: new Map(turns.map((turn) => [turn.threadId, turn.key])),
    };
    if (!enabled) return;
    for (const turn of fresh) {
      showReplyNotification(turn, () => onOpenThreadRef.current(turn.threadId));
    }
  }, [contextKey, ready, enabled, turns]);

  useEffect(() => {
    if (!enabled || !canNotify() || Notification.permission !== 'default') return;
    requestNotificationPermission();
    // Firefox and Safari ignore a prompt that no click asked for.
    const askOnFirstClick = () => requestNotificationPermission();
    document.addEventListener('pointerdown', askOnFirstClick, { once: true });
    document.addEventListener('keydown', askOnFirstClick, { once: true });
    return () => {
      document.removeEventListener('pointerdown', askOnFirstClick);
      document.removeEventListener('keydown', askOnFirstClick);
    };
  }, [enabled]);
}
