import { afterEach, describe, expect, it, vi } from 'vitest';

import { stickyHeaderCover } from './domUtils';

describe('stickyHeaderCover', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const cardInside = (fileAttribute: string) => {
    document.body.innerHTML = `
      <div ${fileAttribute}="c.js">
        <div data-file-header></div>
        <div id="card"></div>
      </div>`;
    vi.spyOn(
      document.querySelector<HTMLElement>('[data-file-header]')!,
      'getBoundingClientRect',
    ).mockReturnValue({ height: 50 } as DOMRect);
    return document.getElementById('card')!;
  };

  it.each(['data-file-path', 'data-fixup-only-file'])(
    'keeps a card below the header of a %s section',
    (fileAttribute) => {
      expect(stickyHeaderCover(cardInside(fileAttribute))).toBe(58);
    },
  );

  it('leaves no room when the target holds the header itself', () => {
    cardInside('data-fixup-only-file');

    const section = document.querySelector<HTMLElement>('[data-fixup-only-file]')!;

    expect(stickyHeaderCover(section)).toBe(0);
  });
});
