import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSymbolPeek } from './useSymbolPeek';

const scopes = vi.hoisted(() => ({ enableScope: vi.fn(), disableScope: vi.fn() }));
vi.mock('react-hotkeys-hook', () => ({ useHotkeysContext: () => scopes }));

describe('useSymbolPeek', () => {
  let word: HTMLElement;
  let plain: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML =
      '<div data-symbol-side="new" data-symbol-path="src/a.ts"><span class="word-token" data-word="helper">helper</span><span id="plain">(</span></div>';
    word = document.querySelector<HTMLElement>('.word-token')!;
    plain = document.querySelector<HTMLElement>('#plain')!;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  const click = (target: HTMLElement, init: MouseEventInit = {}) =>
    act(() => {
      target.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 50, ...init }),
      );
    });

  it('offers to look up a clicked name without opening anything yet', () => {
    const { result } = renderHook(() =>
      useSymbolPeek({ base: 'aaa', target: 'bbb', enabled: true }),
    );

    click(word);

    expect(result.current.offer).toEqual({
      request: { name: 'helper', ref: 'bbb', from: 'src/a.ts' },
      x: 40,
      y: 50,
    });
    expect(result.current.stack).toEqual([]);
  });

  it('withdraws the offer on a click elsewhere, a scroll, or Escape', () => {
    const { result } = renderHook(() =>
      useSymbolPeek({ base: 'aaa', target: 'bbb', enabled: true }),
    );

    click(word);
    click(plain);
    expect(result.current.offer).toBeNull();

    click(word);
    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.offer).toBeNull();

    click(word);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(result.current.offer).toBeNull();
  });

  it('looks the name up straight away with Ctrl or Cmd held', () => {
    const { result } = renderHook(() =>
      useSymbolPeek({ base: 'aaa', target: 'bbb', enabled: true }),
    );

    click(word, { ctrlKey: true });

    expect(result.current.offer).toBeNull();
    expect(result.current.stack).toEqual([{ name: 'helper', ref: 'bbb', from: 'src/a.ts' }]);
  });

  it('goes to the only declaration instead of opening the popup when it can', async () => {
    const jumpToOnlyDeclaration = vi.fn(() => Promise.resolve(true));
    const { result } = renderHook(() =>
      useSymbolPeek({ base: 'aaa', target: 'bbb', enabled: true, jumpToOnlyDeclaration }),
    );

    click(word, { ctrlKey: true });
    await act(async () => {});

    expect(jumpToOnlyDeclaration).toHaveBeenCalledWith({
      name: 'helper',
      ref: 'bbb',
      from: 'src/a.ts',
    });
    expect(result.current.stack).toEqual([]);
  });

  it('opens the popup when it cannot go to one declaration', async () => {
    const outcomes = [() => Promise.resolve(false), () => Promise.reject(new Error('offline'))];
    for (const jumpToOnlyDeclaration of outcomes) {
      const { result, unmount } = renderHook(() =>
        useSymbolPeek({ base: 'aaa', target: 'bbb', enabled: true, jumpToOnlyDeclaration }),
      );

      click(word, { ctrlKey: true });
      await act(async () => {});

      expect(result.current.stack).toEqual([{ name: 'helper', ref: 'bbb', from: 'src/a.ts' }]);
      unmount();
    }
  });

  it('leaves Shift clicks to line selection', () => {
    const { result } = renderHook(() =>
      useSymbolPeek({ base: 'aaa', target: 'bbb', enabled: true }),
    );

    click(word, { shiftKey: true });

    expect(result.current.offer).toBeNull();
    expect(result.current.stack).toEqual([]);
  });

  it('offers nothing when the server cannot search', () => {
    const { result } = renderHook(() =>
      useSymbolPeek({ base: 'aaa', target: 'bbb', enabled: false }),
    );

    click(word);
    click(word, { ctrlKey: true });

    expect(result.current.offer).toBeNull();
    expect(result.current.stack).toEqual([]);
  });

  it('keeps diff shortcuts off until the last popup closes', () => {
    const { result } = renderHook(() =>
      useSymbolPeek({ base: 'aaa', target: 'bbb', enabled: true }),
    );

    act(() => result.current.open({ name: 'first', ref: 'bbb' }));
    act(() => result.current.open({ name: 'second', ref: 'bbb' }));
    act(() => result.current.back());
    expect(scopes.disableScope).toHaveBeenCalledTimes(1);
    expect(scopes.enableScope).not.toHaveBeenCalled();

    act(() => result.current.close());
    expect(scopes.enableScope).toHaveBeenCalledWith('navigation');
  });

  it('goes one level deeper per lookup and back out one at a time', () => {
    const { result } = renderHook(() =>
      useSymbolPeek({ base: 'aaa', target: 'bbb', enabled: true }),
    );

    act(() => result.current.open({ name: 'first', ref: 'bbb' }));
    act(() => result.current.open({ name: 'second', ref: 'bbb' }));
    expect(result.current.stack.map((request) => request.name)).toEqual(['first', 'second']);

    act(() => result.current.back());
    expect(result.current.stack.map((request) => request.name)).toEqual(['first']);

    act(() => result.current.close());
    expect(result.current.stack).toEqual([]);
  });

  it('keeps the last index change of each commit in the order heard', () => {
    const { result } = renderHook(() =>
      useSymbolPeek({ base: 'aaa', target: 'bbb', enabled: true }),
    );

    act(() => result.current.noteIndexChange('c1', { status: 'building', startedAt: 1 }));
    act(() => result.current.noteIndexChange('c2', { status: 'queued', after: 'c1' }));
    act(() => result.current.noteIndexChange('c1', { status: 'ready' }));

    expect(result.current.indexUpdates.seq).toBe(3);
    expect(Object.fromEntries(result.current.indexUpdates.byCommit)).toEqual({
      c1: { state: { status: 'ready' }, seq: 3 },
      c2: { state: { status: 'queued', after: 'c1' }, seq: 2 },
    });
  });
});
