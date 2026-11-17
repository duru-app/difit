import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDiffSelection } from '../../utils/diffSelection';

import { type ReviewPlace, useReviewTargetHistory } from './useReviewTargetHistory';

describe('useReviewTargetHistory', () => {
  const selection = createDiffSelection('aaa', 'bbb');
  const shown: ReviewPlace = { kind: 'file', file: 'src/top.ts' };
  const clicked: ReviewPlace = {
    kind: 'line',
    file: 'src/a.ts',
    line: 7,
    side: 'new',
    cursor: true,
  };
  const declaration: ReviewPlace = {
    kind: 'line',
    file: 'src/b.ts',
    line: 3,
    side: 'new',
    cursor: true,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const jumpTo = (to: ReviewPlace, from?: ReviewPlace) => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const pushState = vi.spyOn(window.history, 'pushState');
    const { result } = renderHook(() =>
      useReviewTargetHistory({
        current: () => ({ selection, place: shown }),
        restore: () => {},
      }),
    );
    result.current({ selection, place: to }, from);
    return {
      backTo: replaceState.mock.calls.at(-1)?.[0],
      at: pushState.mock.calls.at(-1)?.[0],
    };
  };

  it('leaves the shown place to go back to', () => {
    expect(jumpTo(declaration)).toEqual({
      backTo: expect.objectContaining({ difitPlace: shown }),
      at: expect.objectContaining({ difitPlace: declaration }),
    });
  });

  it('leaves the given place to go back to instead of the shown one', () => {
    expect(jumpTo(declaration, clicked)).toEqual({
      backTo: expect.objectContaining({ difitPlace: clicked }),
      at: expect.objectContaining({ difitPlace: declaration }),
    });
  });
});
