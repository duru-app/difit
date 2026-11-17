import { describe, expect, it } from 'vitest';

import { SESSION_GRACE_MS, isSessionConnected, sessionCheckedAgoMs } from './sessionStatus';

describe('isSessionConnected', () => {
  it('is connected while a wait is open, however long ago it was checked', () => {
    expect(isSessionConnected({ waits: 1, checkedAgoMs: 25_000 }, SESSION_GRACE_MS * 2)).toBe(true);
  });

  it('stays connected after the last wait closed until the grace time passes', () => {
    const status = { waits: 0, checkedAgoMs: 60_000 };

    expect(isSessionConnected(status, SESSION_GRACE_MS - 60_001)).toBe(true);
    expect(isSessionConnected(status, SESSION_GRACE_MS - 60_000)).toBe(false);
  });

  it('is not connected when no wait was ever open', () => {
    expect(isSessionConnected({ waits: 0, checkedAgoMs: null }, 0)).toBe(false);
  });
});

describe('sessionCheckedAgoMs', () => {
  it('counts the time since the status arrived on top of what it reported', () => {
    expect(sessionCheckedAgoMs({ waits: 0, checkedAgoMs: 4000 }, 3000)).toBe(7000);
    expect(sessionCheckedAgoMs({ waits: 0, checkedAgoMs: null }, 3000)).toBeNull();
  });
});
