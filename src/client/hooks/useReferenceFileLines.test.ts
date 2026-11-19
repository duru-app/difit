import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useReferenceFileLines } from './useReferenceFileLines';

describe('useReferenceFileLines', () => {
  beforeEach(() => {
    global.fetch = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).startsWith('/api/blob/missing.ts?')
          ? ({ ok: false, text: async () => '' } as Response)
          : ({ ok: true, text: async () => 'one\r\ntwo\n' } as Response),
      ),
    );
  });

  it('reads each file once and tells an unreadable file from one still loading', async () => {
    const { result, rerender } = renderHook(
      ({ files }) => useReferenceFileLines(files, 'abc1234'),
      { initialProps: { files: ['a.ts', 'missing.ts'] } },
    );

    expect(result.current.has('a.ts')).toBe(false);
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get('a.ts')).toEqual(['one', 'two']);
    expect(result.current.get('missing.ts')).toBeNull();

    rerender({ files: ['missing.ts', 'a.ts', 'b.ts'] });
    await waitFor(() => expect(result.current.size).toBe(3));
    expect(vi.mocked(global.fetch).mock.calls.map(([url]) => String(url))).toEqual([
      '/api/blob/a.ts?ref=abc1234',
      '/api/blob/missing.ts?ref=abc1234',
      '/api/blob/b.ts?ref=abc1234',
    ]);
  });

  it('reads the files again once the commit is forgotten', async () => {
    const { result, rerender } = renderHook(
      ({ gitRef }: { gitRef: string | undefined }) => useReferenceFileLines(['a.ts'], gitRef),
      { initialProps: { gitRef: 'abc1234' as string | undefined } },
    );
    await waitFor(() => expect(result.current.size).toBe(1));

    rerender({ gitRef: undefined });
    expect(result.current.size).toBe(0);
    rerender({ gitRef: 'abc1234' });

    await waitFor(() => expect(result.current.size).toBe(1));
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);
  });
});
