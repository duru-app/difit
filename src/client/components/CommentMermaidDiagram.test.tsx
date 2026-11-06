import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@testing-library/jest-dom';

import { CommentMermaidDiagram } from './CommentMermaidDiagram';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg width="100%" viewBox="0 0 1600 70" style="max-width: 1600px;"><title>Mermaid</title></svg>',
      bindFunctions: undefined,
    }),
  },
}));

const originalMatchMedia = window.matchMedia;

const setPhone = (isPhone: boolean) => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: isPhone && query === '(max-width: 767px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
};

const renderDiagram = () =>
  render(
    <HotkeysProvider>
      <CommentMermaidDiagram chart={'flowchart TD\n  A --> B'} />
    </HotkeysProvider>,
  );

describe('CommentMermaidDiagram', () => {
  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  it('draws inline without an enlarge button on desktop', async () => {
    setPhone(false);
    const { container } = renderDiagram();

    await waitFor(() => expect(container.querySelector('.mermaid-diagram svg')).not.toBeNull());
    expect(screen.queryByRole('button', { name: '도식 크게 보기' })).toBeNull();
  });

  it('opens a large view on a phone and closes it with the X', async () => {
    setPhone(true);
    renderDiagram();

    fireEvent.click(screen.getByRole('button', { name: '도식 크게 보기' }));

    const dialog = await screen.findByRole('dialog', { name: '도식' });
    await waitFor(() => expect(dialog.querySelector('.mermaid-diagram svg')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('draws the large view at the size the diagram was drawn at, and the card at the card width', async () => {
    setPhone(true);
    const { container } = renderDiagram();
    await waitFor(() => expect(container.querySelector('.mermaid-diagram svg')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '도식 크게 보기' }));
    const dialog = await screen.findByRole('dialog', { name: '도식' });
    await waitFor(() => expect(dialog.querySelector('.mermaid-diagram svg')).not.toBeNull());

    const large = dialog.querySelector<SVGSVGElement>('.mermaid-diagram svg')!;
    expect(large).toHaveAttribute('width', '1600');
    expect(large).toHaveAttribute('height', '70');
    expect(large.style.maxWidth).toBe('none');
    const inCard = screen
      .getByRole('button', { name: '도식 크게 보기' })
      .querySelector<SVGSVGElement>('svg')!;
    expect(inCard).toHaveAttribute('width', '100%');
  });

  it('closes the large view on a tap outside the diagram', async () => {
    setPhone(true);
    renderDiagram();

    fireEvent.click(screen.getByRole('button', { name: '도식 크게 보기' }));
    const dialog = await screen.findByRole('dialog', { name: '도식' });
    fireEvent.click(dialog.querySelector('.overflow-auto')!);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the large view with Escape', async () => {
    setPhone(true);
    renderDiagram();

    fireEvent.click(screen.getByRole('button', { name: '도식 크게 보기' }));
    await screen.findByRole('dialog', { name: '도식' });

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
