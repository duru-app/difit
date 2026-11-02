import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiffCommentMessage, ReplyChoice } from '../../types/diff';

import { ReplyChoices } from './ReplyChoices';

const at = '2024-01-01T00:00:00Z';
const choices: ReplyChoice[] = [
  { id: 'A', name: '최상위 불리언 fixupOverlay', description: '가장 단순합니다.' },
  {
    id: 'B',
    name: 'review.overlay.enabled 묶음',
    description: '다른 리뷰 설정과 같은 자리에 놓입니다.',
    preview: {
      label: '~/.difit/config.json',
      text: '{\n  "review": {\n    "overlay": {\n      "enabled": false\n    }\n  }\n}',
    },
    recommended: true,
  },
  { id: 'C', name: '환경 변수 DIFIT_NO_OVERLAY', description: '설정 파일 없이 끕니다.' },
];
const ask = {
  id: 'm2',
  body: '설정 키 모양을 하나 골라 주세요.',
  author: 'Claude',
  createdAt: at,
  updatedAt: at,
  choices,
};
const reply = (body: string, answer?: DiffCommentMessage['answer']): DiffCommentMessage => ({
  id: `r-${body}`,
  body,
  author: 'User',
  createdAt: at,
  updatedAt: at,
  ...(answer ? { answer } : {}),
});

const renderChoices = (later: DiffCommentMessage[] = []) => {
  const onPick = vi.fn().mockResolvedValue(undefined);
  const result = render(<ReplyChoices message={ask} later={later} onPick={onPick} />);
  return { ...result, onPick };
};
const card = (id: string) =>
  screen.getAllByRole('radio').find((element) => element.dataset.choice === id)!;

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

describe('ReplyChoices', () => {
  it('picks a choice when its card is clicked', async () => {
    const user = userEvent.setup();
    const { onPick } = renderChoices();

    expect(screen.getByText(/하나를 고르세요 · 고를 거리 밖의 답은 아래 답글로/)).toBeVisible();
    expect(within(card('B')).getByText('추천')).toBeVisible();
    await user.click(within(card('B')).getByText('다른 리뷰 설정과 같은 자리에 놓입니다.'));

    expect(onPick).toHaveBeenCalledWith('고름: B — review.overlay.enabled 묶음', {
      messageId: 'm2',
      choice: 'B',
    });
  });

  it('cuts a long preview to three lines and opens it without picking', async () => {
    const user = userEvent.setup();
    const { onPick } = renderChoices();
    const preview = () => card('B').querySelector('pre')!.textContent;

    expect(preview()).toBe('{\n  "review": {\n    "overlay": {\n…');
    await user.click(screen.getByRole('button', { name: '더 보기 (7줄)' }));

    expect(preview()).toBe(choices[1]!.preview!.text);
    expect(screen.getByRole('button', { name: '접기' })).toBeVisible();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('does not pick when the click ends a text selection inside the card', () => {
    const { onPick } = renderChoices();
    const description = within(card('A')).getByText('가장 단순합니다.');
    const range = document.createRange();
    range.selectNodeContents(description);
    window.getSelection()!.addRange(range);

    fireEvent.click(description);

    expect(onPick).not.toHaveBeenCalled();
  });

  it('picks with Enter or Space on a focused card', async () => {
    const user = userEvent.setup();
    const { onPick } = renderChoices();

    card('A').focus();
    await user.keyboard('{Enter}');
    card('C').focus();
    await user.keyboard(' ');

    expect(onPick.mock.calls.map(([body]) => body)).toEqual([
      '고름: A — 최상위 불리언 fixupOverlay',
      '고름: C — 환경 변수 DIFIT_NO_OVERLAY',
    ]);
  });

  it('marks the pick, dims the rest and stops taking clicks', async () => {
    const user = userEvent.setup();
    const { onPick } = renderChoices([
      reply('고름: B — review.overlay.enabled 묶음', { messageId: 'm2', choice: 'B' }),
    ]);

    expect(card('B')).toHaveAttribute('aria-checked', 'true');
    expect(within(card('B')).getByText('고름')).toBeVisible();
    expect(card('A')).toHaveClass('opacity-45');
    expect(card('B')).not.toHaveClass('opacity-45');
    await user.click(card('A'));

    expect(onPick).not.toHaveBeenCalled();
  });

  it('adds a change as a new reply and can leave the pick as it is', async () => {
    const user = userEvent.setup();
    const { onPick } = renderChoices([
      reply('고름: B — review.overlay.enabled 묶음', { messageId: 'm2', choice: 'B' }),
    ]);

    await user.click(screen.getByRole('button', { name: '다른 걸로 바꾸기' }));
    expect(screen.getByText(/바꿀 것을 고르세요 · 지금은 B/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '그대로 두기' }));
    expect(screen.getByRole('button', { name: '다른 걸로 바꾸기' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '다른 걸로 바꾸기' }));
    await user.click(card('C'));

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('바꿈: C — 환경 변수 DIFIT_NO_OVERLAY', {
      messageId: 'm2',
      choice: 'C',
    });
  });

  it('follows the latest pick when the reviewer changed it', () => {
    renderChoices([
      reply('고름: B — review.overlay.enabled 묶음', { messageId: 'm2', choice: 'B' }),
      reply('바꿈: C — 환경 변수 DIFIT_NO_OVERLAY', { messageId: 'm2', choice: 'C' }),
    ]);

    expect(card('C')).toHaveAttribute('aria-checked', 'true');
    expect(card('B')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('C 고름')).toBeVisible();
  });

  it('dims the cards after an answer in words and still lets the reviewer pick', async () => {
    const user = userEvent.setup();
    const { onPick } = renderChoices([reply('둘 다 받으면 안 되나요?')]);

    expect(screen.getByText(/글로 답했습니다/)).toBeVisible();
    for (const element of screen.getAllByRole('radio')) expect(element).toHaveClass('opacity-45');
    await user.click(card('A'));
    expect(onPick).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '그래도 고르기' }));
    await user.click(card('A'));

    expect(onPick).toHaveBeenCalledWith('고름: A — 최상위 불리언 fixupOverlay', {
      messageId: 'm2',
      choice: 'A',
    });
  });

  it('closes the cards once the reviewer answers by editing the code', async () => {
    const user = userEvent.setup();
    const { onPick } = renderChoices([
      { ...reply('src/a.ts 를 고쳤습니다'), author: 'reviewer-edit' },
    ]);

    expect(screen.getByText(/코드를 고쳐 답했습니다/)).toBeVisible();
    for (const element of screen.getAllByRole('radio')) {
      expect(element).toHaveAttribute('aria-disabled', 'true');
    }
    await user.click(card('A'));

    expect(onPick).not.toHaveBeenCalled();
  });

  it('closes the cards for good once the agent offers newer choices', async () => {
    const user = userEvent.setup();
    const newer: DiffCommentMessage = { ...ask, id: 'm4', body: '다시 골라 주세요.' };
    const { onPick } = renderChoices([
      reply('고름: B — review.overlay.enabled 묶음', { messageId: 'm2', choice: 'B' }),
      newer,
    ]);

    expect(screen.getByText(/아래 새 고를 거리로 넘어갔습니다/)).toBeVisible();
    expect(card('B')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('button', { name: '다른 걸로 바꾸기' })).not.toBeInTheDocument();
    await user.click(card('A'));

    expect(onPick).not.toHaveBeenCalled();
  });

  it('closes unpicked cards once the agent says a fixup follows', async () => {
    const user = userEvent.setup();
    const { onPick } = renderChoices([
      { ...reply('A로 고치겠습니다.'), author: 'Claude', fixPending: true },
    ]);

    expect(screen.getByText('에이전트가 고치겠다고 답했습니다')).toBeVisible();
    await user.click(card('A'));

    expect(onPick).not.toHaveBeenCalled();
  });

  it('points to newer choices that came after a reply saying a fixup follows', () => {
    renderChoices([
      { ...reply('A로 고치겠습니다.'), author: 'Claude', fixPending: true },
      { ...ask, id: 'm4' },
    ]);

    expect(screen.getByText(/아래 새 고를 거리로 넘어갔습니다/)).toBeVisible();
  });

  it('keeps the pick changeable when the agent says a fixup follows after it', () => {
    renderChoices([
      reply('고름: B — review.overlay.enabled 묶음', { messageId: 'm2', choice: 'B' }),
      { ...reply('B로 고치겠습니다.'), author: 'Claude', fixPending: true },
    ]);

    expect(screen.queryByText('에이전트가 고치겠다고 답했습니다')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다른 걸로 바꾸기' })).toBeInTheDocument();
  });

  it('closes unpicked cards when newer choices come after them', async () => {
    const user = userEvent.setup();
    const { onPick } = renderChoices([{ ...ask, id: 'm4' }]);

    expect(screen.queryByText(/하나를 고르세요/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '그래도 고르기' })).not.toBeInTheDocument();
    await user.click(card('A'));

    expect(onPick).not.toHaveBeenCalled();
  });

  it('ignores a pick that answers another question', () => {
    renderChoices([reply('고름: A — x', { messageId: 'other', choice: 'A' })]);

    expect(screen.getByText(/하나를 고르세요/)).toBeVisible();
    expect(card('A')).toHaveAttribute('aria-checked', 'false');
  });
});
