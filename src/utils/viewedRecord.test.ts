import { describe, expect, it } from 'vitest';

import { isMarkedAfterUnmark } from './viewedRecord';

describe('isMarkedAfterUnmark', () => {
  it('is true for a mark later than the unmark', () => {
    expect(isMarkedAfterUnmark('2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(true);
  });

  it('is false for a mark earlier than the unmark', () => {
    expect(isMarkedAfterUnmark('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')).toBe(false);
  });

  it('lets the unmark win a tie', () => {
    expect(isMarkedAfterUnmark('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(false);
  });

  it('compares instants, not the text of the timestamps', () => {
    expect(isMarkedAfterUnmark('2026-01-01T09:00:00+09:00', '2026-01-01T00:00:00Z')).toBe(false);
    expect(isMarkedAfterUnmark('2026-01-01T09:00:01+09:00', '2026-01-01T00:00:00Z')).toBe(true);
  });

  it('lets the unmark win when either time cannot be read', () => {
    expect(isMarkedAfterUnmark('not a date', '2026-01-01T00:00:00Z')).toBe(false);
    expect(isMarkedAfterUnmark('2026-01-01T00:00:00Z', 'not a date')).toBe(false);
  });
});
