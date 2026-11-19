import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WalkthroughCase } from '../../types/diff';

import { WalkthroughBar } from './WalkthroughBar';

const normalFlow: WalkthroughCase = {
  title: '정상 흐름',
  setup: '로그인한 사용자가 저장을 누른다.',
  steps: [
    { file: 'src/a.ts', line: 3, description: '요청을 받는다.' },
    { file: 'src/b.ts', line: 10, endLine: 12, description: '값을 검사한다.' },
    { file: 'src/a.ts', line: 8, description: '결과를 돌려준다.' },
  ],
};
const errorFlow: WalkthroughCase = {
  setup: '디스크가 가득 찼다.',
  steps: [{ file: 'src/c.ts', line: 1, description: '쓰기에 실패한다.' }],
};

afterEach(cleanup);

function renderBar(
  index: number,
  shown = true,
  cases: WalkthroughCase[] = [normalFlow],
  caseIndex = 0,
) {
  const onPlay = vi.fn();
  const onClose = vi.fn();
  render(
    <WalkthroughBar
      cases={cases}
      caseIndex={caseIndex}
      index={index}
      shown={shown}
      onPlay={onPlay}
      onClose={onClose}
    />,
  );
  return { onPlay, onClose };
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
    const { onPlay } = renderBar(1);

    fireEvent.click(screen.getByRole('button', { name: '이전 단계' }));
    fireEvent.click(screen.getByRole('button', { name: '다음 단계' }));

    expect(onPlay.mock.calls).toEqual([[{ type: 'previous' }], [{ type: 'next' }]]);
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

  it('shows no case picker when the walkthrough has one case', () => {
    renderBar(0);

    expect(screen.queryByRole('combobox', { name: '경우' })).not.toBeInTheDocument();
  });

  it('lets the reviewer pick a case by its title, or by its number when it has none', () => {
    const { onPlay } = renderBar(0, true, [normalFlow, errorFlow]);
    const picker = screen.getByRole('combobox', { name: '경우' });

    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['정상 흐름', '경우 2']);
    expect(picker).toHaveValue('0');

    fireEvent.change(picker, { target: { value: '1' } });

    expect(onPlay.mock.calls).toEqual([[{ type: 'selectCase', caseIndex: 1 }]]);
  });

  it('shows the setup, the step and the step count of the picked case', () => {
    renderBar(0, true, [normalFlow, errorFlow], 1);

    expect(screen.getByRole('combobox', { name: '경우' })).toHaveValue('1');
    expect(screen.getByText('디스크가 가득 찼다.')).toBeInTheDocument();
    expect(screen.queryByText('로그인한 사용자가 저장을 누른다.')).not.toBeInTheDocument();
    expect(screen.getByText('쓰기에 실패한다.')).toBeInTheDocument();
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
  });

  it('shows the setup of a walkthrough with one case', () => {
    renderBar(2);

    expect(screen.getByText('처음 상태')).toBeInTheDocument();
    expect(screen.getByText('로그인한 사용자가 저장을 누른다.')).toBeInTheDocument();
  });

  it('shows no setup line for a case without one', () => {
    renderBar(0, true, [{ steps: normalFlow.steps }]);

    expect(screen.queryByText('처음 상태')).not.toBeInTheDocument();
  });
});
