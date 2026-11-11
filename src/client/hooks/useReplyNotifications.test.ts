import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewerTurn } from '../utils/replyNotifications';

import { useReplyNotifications } from './useReplyNotifications';

const turn = (key: string): ReviewerTurn => ({ threadId: 't', key, title: '답변 완료', body: 'b' });

describe('useReplyNotifications', () => {
  const created: Array<{ title: string; options: NotificationOptions; onclick?: () => void }> = [];
  const requestPermission = vi.fn(() => Promise.resolve('granted'));
  let permission = 'granted';

  beforeEach(() => {
    created.length = 0;
    permission = 'granted';
    requestPermission.mockClear();
    class FakeNotification {
      static get permission() {
        return permission;
      }
      static requestPermission = requestPermission;
      onclick?: () => void;
      close = vi.fn();
      constructor(title: string, options: NotificationOptions) {
        created.push(Object.assign(this, { title, options }));
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  });

  afterEach(() => vi.unstubAllGlobals());

  const render = (initial: { turns: ReviewerTurn[]; enabled?: boolean; ready?: boolean }) =>
    renderHook((props) => useReplyNotifications({ contextKey: 'c', onOpenThread, ...props }), {
      initialProps: { enabled: true, ready: true, ...initial },
    });
  const onOpenThread = vi.fn();

  it('stays quiet for turns already there when the review loads', () => {
    render({ turns: [turn('a')] });
    expect(created).toHaveLength(0);
  });

  it('notifies once for a new turn and again for a newer one', () => {
    const { rerender } = render({ turns: [] });
    rerender({ turns: [turn('a')], enabled: true, ready: true });
    rerender({ turns: [turn('a')], enabled: true, ready: true });
    expect(created).toHaveLength(1);
    rerender({ turns: [turn('b')], enabled: true, ready: true });
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ title: '답변 완료', options: { tag: 't' } });
  });

  it('sends nothing while turned off, and does not replay them on turning on', () => {
    const { rerender } = render({ turns: [], enabled: false });
    rerender({ turns: [turn('a')], enabled: false, ready: true });
    rerender({ turns: [turn('a')], enabled: true, ready: true });
    expect(created).toHaveLength(0);
  });

  it('sends nothing without granted permission or outside a secure context', () => {
    permission = 'denied';
    const { rerender } = render({ turns: [] });
    rerender({ turns: [turn('a')], enabled: true, ready: true });
    expect(created).toHaveLength(0);

    permission = 'granted';
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    rerender({ turns: [turn('b')], enabled: true, ready: true });
    expect(created).toHaveLength(0);
  });

  it('opens the thread when the notification is clicked', () => {
    const { rerender } = render({ turns: [] });
    rerender({ turns: [turn('a')], enabled: true, ready: true });
    created[0]?.onclick?.();
    expect(onOpenThread).toHaveBeenCalledWith('t');
  });

  it('asks for permission on start, and again on the first click while still undecided', () => {
    permission = 'default';
    render({ turns: [] });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('pointerdown'));
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });
});
