import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WalkthroughCase } from '../../types/diff';

import { WalkthroughBar } from './WalkthroughBar';

const walkthroughCase: WalkthroughCase = {
  title: '정상 흐름',
  steps: [
    { file: 'src/a.ts', line: 3, description: '요청을 받는다.' },
    { file: 'src/b.ts', line: 10, endLine: 12, description: '값을 검사한다.' },
    { file: 'src/a.ts', line: 8, description: '결과를 돌려준다.' },
  ],
};

afterEach(cleanup);

function renderBar(index: number, shown = true) {
  const onMove = vi.fn();
  const onClose = vi.fn();
  render(
    <WalkthroughBar
      walkthroughCase={walkthroughCase}
      index={index}
      shown={shown}
      onMove={onMove}
      onClose={onClose}
    />,
  );
  return { onMove, onClose };
}

describe('WalkthroughBar', () => {
  it('shows the step description, where it is and how many steps there are', () => {
    renderBar(1);

    expect(screen.getByText('값을 검사한다.')).toBeInTheDocument();
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts:10-12')).toBeInTheDocument();
    expect(screen.queryByText('diff 에 안 보이는 줄')).not.toBeInTheDocument();
  });

  it('moves to the step before and after', () => {
    const { onMove } = renderBar(1);

    fireEvent.click(screen.getByRole('button', { name: '이전 단계' }));
    fireEvent.click(screen.getByRole('button', { name: '다음 단계' }));

    expect(onMove.mock.calls).toEqual([[0], [2]]);
  });

  it('offers no step before the first one', () => {
    renderBar(0);

    expect(screen.getByRole('button', { name: '이전 단계' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '다음 단계' })).toBeEnabled();
  });

  it('offers no step after the last one', () => {
    renderBar(2);

    expect(screen.getByRole('button', { name: '이전 단계' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '다음 단계' })).toBeDisabled();
  });

  it('closes', () => {
    const { onClose } = renderBar(0);

    fireEvent.click(screen.getByRole('button', { name: '따라가기 닫기' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('says so when the diff does not show the step line', () => {
    renderBar(0, false);

    expect(screen.getByText('diff 에 안 보이는 줄')).toBeInTheDocument();
  });
});
