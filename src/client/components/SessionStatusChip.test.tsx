import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_GRACE_MS } from '../../utils/sessionStatus';

import { SessionStatusChip } from './SessionStatusChip';

describe('SessionStatusChip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a connected session and how long ago it was checked', () => {
    render(<SessionStatusChip status={{ waits: 1, checkedAgoMs: 4000 }} receivedAt={Date.now()} />);
    act(() => vi.advanceTimersByTime(3000));

    const chip = screen.getByRole('status');
    expect(chip).toHaveTextContent('세션 연결됨');
    expect(chip).toHaveAttribute('title', '세션 연결됨 · 마지막 확인 7초 전');
    expect(chip).toHaveAttribute('aria-label', '세션 연결됨 · 마지막 확인 7초 전');
  });

  it('turns to disconnected once the grace time passes with no wait open', () => {
    render(<SessionStatusChip status={{ waits: 0, checkedAgoMs: 0 }} receivedAt={Date.now()} />);
    expect(screen.getByRole('status')).toHaveTextContent('세션 연결됨');

    act(() => vi.advanceTimersByTime(SESSION_GRACE_MS));

    const chip = screen.getByRole('status');
    expect(chip).toHaveTextContent('세션 끊김');
    expect(chip).toHaveAttribute(
      'title',
      '세션 끊김 · 지금 남긴 지적은 아직 아무 세션도 받지 않음',
    );
  });

  it('shows a disconnected session when no wait was ever open', () => {
    render(<SessionStatusChip status={{ waits: 0, checkedAgoMs: null }} receivedAt={Date.now()} />);

    expect(screen.getByRole('status')).toHaveTextContent('세션 끊김');
  });
});
