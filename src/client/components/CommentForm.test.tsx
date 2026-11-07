import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CommentForm } from './CommentForm';

function renderWithBody(body: string) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  render(<CommentForm onSubmit={onSubmit} onCancel={onCancel} location="src/a.ts:12" />);
  const textarea = screen.getByRole('textbox');
  fireEvent.change(textarea, { target: { value: body } });
  return { onSubmit, onCancel, textarea };
}

describe('CommentForm', () => {
  it('marks the cancel action independently from other form buttons', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <CommentForm
        onSubmit={vi.fn()}
        onCancel={onCancel}
        location="src/a.ts:12"
        selectedCode="const value = 1;"
      />,
    );

    const cancelButton = container.querySelector<HTMLButtonElement>('[data-comment-cancel="true"]');
    expect(cancelButton).toBe(screen.getByRole('button', { name: '취소' }));

    fireEvent.click(cancelButton!);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('names where the comment goes on its top line', () => {
    renderWithBody('');

    expect(screen.getByText('› src/a.ts:12')).toBeInTheDocument();
  });

  it('sends with the green main button and cancels with a quiet one', () => {
    const { onSubmit } = renderWithBody('looks good');

    const send = screen.getByRole('button', { name: '보내기' });
    expect(send).toHaveClass('bg-github-accent', 'rounded');
    expect(screen.getByRole('button', { name: '취소' })).toHaveClass('bg-transparent', 'rounded');
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledWith('looks good');
  });

  it('offers no button that inserts a suggestion block, even with selected code', () => {
    render(
      <CommentForm
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        location="src/a.ts:12"
        selectedCode="const value = 1;"
      />,
    );

    expect(screen.queryByRole('button', { name: /suggestion/i })).toBeNull();
  });

  describe('keyboard shortcuts', () => {
    it('submits on Enter without inserting a newline', () => {
      const { onSubmit, textarea } = renderWithBody('looks good');

      const notPrevented = fireEvent.keyDown(textarea, { key: 'Enter' });

      expect(notPrevented).toBe(false);
      expect(onSubmit).toHaveBeenCalledWith('looks good');
    });

    it('leaves Shift+Enter to the textarea so it inserts a newline', () => {
      const { onSubmit, textarea } = renderWithBody('first line');

      const notPrevented = fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

      expect(notPrevented).toBe(true);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it.each([
      ['Ctrl', { ctrlKey: true }],
      ['Cmd', { metaKey: true }],
    ])('still submits on %s+Enter', (_label, modifier) => {
      const { onSubmit, textarea } = renderWithBody('looks good');

      fireEvent.keyDown(textarea, { key: 'Enter', ...modifier });

      expect(onSubmit).toHaveBeenCalledWith('looks good');
    });

    it.each([
      ['isComposing is true', { isComposing: true }],
      ['keyCode is 229', { keyCode: 229 }],
    ])('ignores Enter while an IME is composing (%s)', (_label, composition) => {
      const { onSubmit, textarea } = renderWithBody('한글');

      const notPrevented = fireEvent.keyDown(textarea, { key: 'Enter', ...composition });

      expect(notPrevented).toBe(true);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('cancels on Escape', () => {
      const { onSubmit, onCancel, textarea } = renderWithBody('draft');

      fireEvent.keyDown(textarea, { key: 'Escape' });

      expect(onCancel).toHaveBeenCalledOnce();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('cancels on Escape even where every key reports keyCode 229', () => {
      const { onCancel, textarea } = renderWithBody('draft');

      fireEvent.keyDown(textarea, { key: 'Escape', keyCode: 229 });

      expect(onCancel).toHaveBeenCalledOnce();
    });
  });
});
