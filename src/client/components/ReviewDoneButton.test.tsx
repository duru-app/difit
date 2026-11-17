import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ReviewDoneButton } from './ReviewDoneButton';

const doneButton = () => screen.getByRole('button', { name: /^리뷰 끝/ });

describe('ReviewDoneButton', () => {
  it('tells the agent when pressed while comments remain, without standing out', async () => {
    const onReviewDone = vi.fn();
    render(
      <ReviewDoneButton reviewDone={false} nothingRemains={false} onReviewDone={onReviewDone} />,
    );

    expect(doneButton()).toHaveTextContent(/^리뷰 끝$/);
    expect(doneButton()).toBeEnabled();
    expect(doneButton()).toHaveAttribute('aria-pressed', 'false');
    expect(doneButton()).not.toHaveAttribute('data-prominent');
    expect(doneButton()).toHaveAttribute('title', '에이전트에게 리뷰가 끝났다고 알립니다.');

    await userEvent.click(doneButton());
    expect(onReviewDone).toHaveBeenCalledTimes(1);
  });

  it('stands out once nothing remains and says why, without sending anything', () => {
    const onReviewDone = vi.fn();
    render(<ReviewDoneButton reviewDone={false} nothingRemains onReviewDone={onReviewDone} />);

    const reason =
      '남은 코멘트가 없고 fixup을 모두 승인했습니다. 리뷰를 끝내려면 「리뷰 끝」을 누르세요.';
    expect(doneButton()).toHaveAttribute('data-prominent', 'true');
    expect(doneButton()).toHaveTextContent(/^리뷰 끝$/);
    expect(doneButton()).toHaveAttribute('title', reason);
    expect(doneButton()).toHaveAttribute('aria-label', `리뷰 끝: ${reason}`);
    expect(onReviewDone).not.toHaveBeenCalled();
  });

  it('shows the review as ended, and takes a press again once that is taken back', async () => {
    const onReviewDone = vi.fn();
    const { rerender } = render(
      <ReviewDoneButton reviewDone nothingRemains onReviewDone={onReviewDone} />,
    );

    expect(doneButton()).toBeDisabled();
    expect(doneButton()).toHaveAttribute('aria-pressed', 'true');
    expect(doneButton()).not.toHaveAttribute('data-prominent');
    expect(doneButton()).toHaveAttribute(
      'title',
      '에이전트에게 리뷰가 끝났다고 알렸습니다. 코멘트를 새로 달면 풀립니다.',
    );

    rerender(
      <ReviewDoneButton reviewDone={false} nothingRemains={false} onReviewDone={onReviewDone} />,
    );
    await userEvent.click(doneButton());
    expect(onReviewDone).toHaveBeenCalledTimes(1);
  });
});
