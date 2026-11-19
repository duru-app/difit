import { render as renderPlain, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { WordHighlightProvider } from '../contexts/WordHighlightContext';

import { referenceLineId, WalkthroughReferenceFiles } from './WalkthroughReferenceFiles';

const render = (ui: ReactElement) =>
  renderPlain(<WordHighlightProvider>{ui}</WordHighlightProvider>);

const fileOf = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

const shownLines = () =>
  [...document.querySelectorAll<HTMLElement>('tr[data-reference-line]')].map((row) =>
    Number(row.dataset.referenceLine),
  );
const stepLines = () =>
  [...document.querySelectorAll<HTMLElement>('tr[data-walkthrough-step]')].map((row) =>
    Number(row.dataset.referenceLine),
  );

describe('WalkthroughReferenceFiles', () => {
  it('shows only the parts the steps need', async () => {
    render(
      <WalkthroughReferenceFiles
        files={[
          {
            file: 'lib/util.ts',
            parts: [
              { start: 1, end: 5 },
              { start: 10, end: 14 },
            ],
            lines: fileOf(20),
          },
        ]}
        step={{ file: 'lib/util.ts', line: 3, endLine: 3 }}
        onShowLine={() => {}}
      />,
    );

    await waitFor(() => expect(shownLines()).toEqual([1, 2, 3, 4, 5, 10, 11, 12, 13, 14]));
    expect(screen.getByText('⋯ 4줄 생략')).toBeInTheDocument();
    expect(stepLines()).toEqual([3]);
  });

  it('heads the section and each file apart from the changed files', async () => {
    render(
      <WalkthroughReferenceFiles
        files={[{ file: 'lib/util.ts', parts: [{ start: 1, end: 4 }], lines: fileOf(5) }]}
        step={null}
        onShowLine={() => {}}
      />,
    );

    const section = screen.getByRole('region', { name: '따라가기 참고 파일' });
    expect(
      within(section).getByText(
        '따라가기 참고 파일 — 이번 리뷰에서 바뀌지 않은 파일, 따라가기를 닫으면 사라진다',
      ),
    ).toBeInTheDocument();
    const file = within(section).getByRole('region', { name: '참고 파일 lib/util.ts' });
    expect(within(file).getByText('참고')).toBeInTheDocument();
    expect(within(file).getByTitle('lib/util.ts')).toBeInTheDocument();
    expect(document.querySelector('[data-file-path]')).toBeNull();
  });

  it('highlights every line of a step range and asks to be shown at its first line', async () => {
    const onShowLine = vi.fn();
    render(
      <WalkthroughReferenceFiles
        files={[{ file: 'lib/util.ts', parts: [{ start: 4, end: 12 }], lines: fileOf(20) }]}
        step={{ file: 'lib/util.ts', line: 7, endLine: 9 }}
        onShowLine={onShowLine}
      />,
    );

    await waitFor(() => expect(stepLines()).toEqual([7, 8, 9]));
    expect(onShowLine).toHaveBeenCalledWith('lib/util.ts', referenceLineId('lib/util.ts', 7));
    expect(document.getElementById(referenceLineId('lib/util.ts', 7))).toHaveAttribute(
      'data-walkthrough-step',
    );
  });

  it('does not ask to be shown while the step is in another file', async () => {
    const onShowLine = vi.fn();
    render(
      <WalkthroughReferenceFiles
        files={[{ file: 'lib/util.ts', parts: [{ start: 4, end: 12 }], lines: fileOf(20) }]}
        step={{ file: 'lib/other.ts', line: 7, endLine: 7 }}
        onShowLine={onShowLine}
      />,
    );

    await waitFor(() => expect(shownLines()).toHaveLength(9));
    expect(stepLines()).toEqual([]);
    expect(onShowLine).not.toHaveBeenCalled();
  });

  it('cuts a part at the end of the file', async () => {
    render(
      <WalkthroughReferenceFiles
        files={[{ file: 'lib/util.ts', parts: [{ start: 17, end: 2 ** 40 }], lines: fileOf(20) }]}
        step={{ file: 'lib/util.ts', line: 20, endLine: 2 ** 40 - 3 }}
        onShowLine={() => {}}
      />,
    );

    await waitFor(() => expect(shownLines()).toEqual([17, 18, 19, 20]));
    expect(stepLines()).toEqual([20]);
  });

  it('offers no comment on its lines', async () => {
    render(
      <WalkthroughReferenceFiles
        files={[{ file: 'lib/util.ts', parts: [{ start: 1, end: 5 }], lines: fileOf(5) }]}
        step={{ file: 'lib/util.ts', line: 2, endLine: 2 }}
        onShowLine={() => {}}
      />,
    );

    await waitFor(() => expect(shownLines()).toHaveLength(5));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
