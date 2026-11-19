import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WalkthroughCase } from '../../types/diff';
import { DiffLineLinkProvider, type DiffLineLinks } from '../contexts/DiffLineLinkContext';

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

const failingSave: WalkthroughCase = {
  steps: [
    {
      file: 'src/store.ts',
      line: 20,
      description: '디스크가 차서 쓰기가 실패한다.',
      callPath: ['src/main.ts:12', 'store.ts:40-42', 'src/gone.ts:3'],
      variables: { path: '"/tmp/x"', size: '0' },
      stateChanges: { 'cache.dirty': 'false → true' },
      error: true,
    },
  ],
};

afterEach(cleanup);

const DIFF_PATHS = new Set(['src/main.ts', 'src/store.ts']);

function renderBar(
  index: number,
  shown = true,
  cases: WalkthroughCase[] = [normalFlow],
  caseIndex = 0,
  isMobile = false,
) {
  const onPlay = vi.fn();
  const onClose = vi.fn();
  const openLine = vi.fn<DiffLineLinks['open']>();
  const links: DiffLineLinks = {
    resolve: (written) =>
      DIFF_PATHS.has(written) ? written : written === 'store.ts' ? 'src/store.ts' : null,
    open: openLine,
  };
  render(
    <DiffLineLinkProvider value={links}>
      <WalkthroughBar
        cases={cases}
        caseIndex={caseIndex}
        index={index}
        shown={shown}
        isMobile={isMobile}
        onPlay={onPlay}
        onClose={onClose}
      />
    </DiffLineLinkProvider>,
  );
  return { onPlay, onClose, openLine };
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

  it('shows the call path, the variable values and the changing state of the step', () => {
    renderBar(0, true, [failingSave]);

    const callPath = screen.getByRole('list', { name: '호출 경로' });
    expect(
      within(callPath)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['src/main.ts:12', 'store.ts:40-42', 'src/gone.ts:3']);
    const variables = screen.getByRole('list', { name: '변수' });
    expect(
      within(variables)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['path = "/tmp/x"', 'size = 0']);
    const changes = screen.getByRole('list', { name: '바뀌는 상태' });
    expect(within(changes).getByRole('listitem')).toHaveTextContent('cache.dirty = false → true');
  });

  it('shows no call path, variables or changing state for a step without them', () => {
    renderBar(0);

    expect(screen.queryByText('호출 경로')).not.toBeInTheDocument();
    expect(screen.queryByText('변수')).not.toBeInTheDocument();
    expect(screen.queryByText('바뀌는 상태')).not.toBeInTheDocument();
  });

  it('opens a call path entry like a line link in a reply, and leaves one off the diff as text', () => {
    const { openLine } = renderBar(0, true, [failingSave]);

    const entry = screen.getByRole('button', { name: 'store.ts:40-42' });
    fireEvent.click(entry);

    expect(openLine).toHaveBeenCalledExactlyOnceWith(
      { file: 'src/store.ts', line: 40, endLine: 42 },
      entry,
    );
    expect(screen.queryByRole('button', { name: 'src/gone.ts:3' })).not.toBeInTheDocument();
    expect(screen.getByText('src/gone.ts:3')).toBeInTheDocument();
  });

  it('marks a step that ends in an error in words and in the error color', () => {
    renderBar(0, true, [failingSave]);

    expect(screen.getByText('오류로 끝나는 단계')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '따라가기' }).className).toContain(
      'border-l-[var(--color-walkthrough-error-border)]',
    );
  });

  it('keeps the step color on a step that does not end in an error', () => {
    renderBar(0);

    expect(screen.queryByText('오류로 끝나는 단계')).not.toBeInTheDocument();
    const { className } = screen.getByRole('region', { name: '따라가기' });
    expect(className).toContain('border-l-[var(--color-walkthrough-step-border)]');
    expect(className).not.toContain('--color-walkthrough-error-border');
  });

  describe('on a phone', () => {
    const TOUCH_TARGET = ['min-h-[44px]', 'min-w-[44px]'];
    const foldToggle = () => screen.getByRole('button', { name: '따라가기 설명' });

    it('gives every control in the bar a touch target of at least 44px', () => {
      renderBar(0, true, [failingSave, normalFlow], 0, true);

      const controls = [
        screen.getByRole('button', { name: '이전 단계' }),
        screen.getByRole('button', { name: '다음 단계' }),
        screen.getByRole('button', { name: '따라가기 닫기' }),
        foldToggle(),
        screen.getByRole('combobox', { name: '경우' }),
        screen.getByRole('button', { name: 'store.ts:40-42' }),
      ];
      for (const control of controls) {
        expect(control.className.split(' ')).toEqual(expect.arrayContaining(TOUCH_TARGET));
      }
    });

    it('keeps the desktop controls at their size', () => {
      renderBar(0, true, [failingSave, normalFlow]);

      for (const name of ['이전 단계', '다음 단계', '따라가기 닫기']) {
        expect(screen.getByRole('button', { name }).className).not.toContain('min-h-[44px]');
      }
    });

    it('folds the description area away and unfolds it, leaving the step count and step buttons', () => {
      renderBar(1, true, [normalFlow], 0, true);

      expect(foldToggle()).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(foldToggle());

      expect(foldToggle()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByText('값을 검사한다.')).not.toBeVisible();
      expect(screen.getByText('로그인한 사용자가 저장을 누른다.')).not.toBeVisible();
      expect(screen.getByText('2 / 3')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '이전 단계' })).toBeEnabled();
      expect(screen.getByRole('button', { name: '다음 단계' })).toBeEnabled();

      fireEvent.click(foldToggle());

      expect(foldToggle()).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('값을 검사한다.')).toBeVisible();
    });

    it('stays folded while the reviewer steps on', () => {
      const props = {
        cases: [normalFlow],
        caseIndex: 0,
        shown: true,
        isMobile: true,
        onPlay: vi.fn(),
        onClose: vi.fn(),
      };
      const { rerender } = render(<WalkthroughBar {...props} index={0} />);
      fireEvent.click(foldToggle());

      rerender(<WalkthroughBar {...props} index={1} />);

      expect(foldToggle()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByText('2 / 3')).toBeInTheDocument();
      expect(screen.getByText('값을 검사한다.')).not.toBeVisible();
    });

    it('keeps the description area to part of the screen and scrolls inside it', () => {
      renderBar(0, true, [failingSave], 0, true);

      const area = document.getElementById(foldToggle().getAttribute('aria-controls')!)!;
      expect(area).toHaveTextContent('디스크가 차서 쓰기가 실패한다.');
      expect(area.className.split(' ')).toEqual(
        expect.arrayContaining(['max-h-[35dvh]', 'overflow-y-auto']),
      );
    });

    it('offers no fold on a desktop, where the description sits beside the buttons', () => {
      renderBar(0);

      expect(screen.queryByRole('button', { name: '따라가기 설명' })).not.toBeInTheDocument();
      expect(screen.getByText('요청을 받는다.')).toBeInTheDocument();
    });
  });
});
