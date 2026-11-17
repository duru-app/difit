import type { SessionStatus } from '../types/watch.js';

// A wait ends when it hands threads to the agent, and the agent starts the next one after
// answering them, so a session stays connected for a while after its last wait closed.
export const SESSION_GRACE_MS = 120_000;

export function sessionCheckedAgoMs(status: SessionStatus, elapsedMs: number): number | null {
  return status.checkedAgoMs === null ? null : status.checkedAgoMs + elapsedMs;
}

export function isSessionConnected(status: SessionStatus, elapsedMs: number): boolean {
  if (status.waits > 0) return true;
  const ago = sessionCheckedAgoMs(status, elapsedMs);
  return ago !== null && ago < SESSION_GRACE_MS;
}
