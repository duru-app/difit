import { render as renderPlain, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WordHighlightProvider } from '../contexts/WordHighlightContext';

import { referenceLineId, WalkthroughReferenceFiles } from './WalkthroughReferenceFiles';

const render = (ui: ReactElement) =>
  renderPlain(<WordHighlightProvider>{ui}</WordHighlightProvider>);

const fileOf = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');

const serve = (text: string | null) =>
  vi
    .mocked(global.fetch)
    .mockImplementation(() =>
      Promise.resolve(
        text === null
          ? ({ ok: false, text: async () => '' } as Response)
          : ({ ok: true, text: async () => text } as Response),
      ),
    );

const shownLines = () =>
  [...document.querySelectorAll<HTMLElement>('tr[data-reference-line]')].map((row) =>
    Number(row.dataset.referenceLine),
  );
const stepLines = () =>
  [...document.querySelectorAll<HTMLElement>('tr[data-walkthrough-step]')].map((row) =>
    Number(row.dataset.referenceLine),
  );

describe('WalkthroughReferenceFiles', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the file at the walkthrough commit and shows only the parts the steps need', async () => {
    serve(fileOf(20));
    render(
      <WalkthroughReferenceFiles
        files={[
          {
            file: 'lib/util.ts',
            parts: [
              { start: 1, end: 5 },
              { start: 10, end: 14 },
            ],
          },
        ]}
        gitRef="abc1234"
        step={{ file: 'lib/util.ts', line: 3, endLine: 3 }}
        onShowLine={() => {}}
      />,
    );

    await waitFor(() => expect(shownLines()).toEqual([1, 2, 3, 4, 5, 10, 11, 12, 13, 14]));
    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
      '/api/blob/lib%2Futil.ts?ref=abc1234',
      expect.anything(),
    );
    expect(screen.getByText('⋯ 4줄 생략')).toBeInTheDocument();
    expect(stepLines()).toEqual([3]);
  });

  it('heads the section and each file apart from the changed files', async () => {
    serve(fileOf(5));
    render(
      <WalkthroughReferenceFiles
        files={[{ file: 'lib/util.ts', parts: [{ start: 1, end: 4 }] }]}
        gitRef="abc1234"
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
    serve(fileOf(20));
    const onShowLine = vi.fn();
    render(
      <WalkthroughReferenceFiles
        files={[{ file: 'lib/util.ts', parts: [{ start: 4, end: 12 }] }]}
        gitRef="abc1234"
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
    serve(fileOf(20));
    const onShowLine = vi.fn();
    render(
      <WalkthroughReferenceFiles
        files={[{ file: 'lib/util.ts', parts: [{ start: 4, end: 12 }] }]}
        gitRef="abc1234"
        step={{ file: 'lib/other.ts', line: 7, endLine: 7 }}
        onShowLine={onShowLine}
      />,
    );

    await waitFor(() => expect(shownLines()).toHaveLength(9));
    expect(stepLines()).toEqual([]);
    expect(onShowLine).not.toHaveBeenCalled();
  });

  it('cuts a part at the end of the file', async () => {
    serve(`${fileOf(20)}\n`);
    render(
      <WalkthroughReferenceFiles
        files={[{ file: 'lib/util.ts', parts: [{ start: 17, end: 2 ** 40 }] }]}
        gitRef="abc1234"
        step={{ file: 'lib/util.ts', line: 20, endLine: 2 ** 40 - 3 }}
        onShowLine={() => {}}
      />,
    );

    await waitFor(() => expect(shownLines()).toEqual([17, 18, 19, 20]));
    expect(stepLines()).toEqual([20]);
  });

  it('says so when the file cannot be read', async () => {
    serve(null);
    render(
      <WalkthroughReferenceFiles
        files={[{ file: 'lib/util.ts', parts: [{ start: 1, end: 4 }] }]}
        gitRef="abc1234"
        step={{ file: 'lib/util.ts', line: 2, endLine: 2 }}
        onShowLine={() => {}}
      />,
    );

    expect(await screen.findByText('파일을 읽지 못했습니다.')).toBeInTheDocument();
  });

  it('offers no comment on its lines', async () => {
    serve(fileOf(5));
    render(
      <WalkthroughReferenceFiles
        files={[{ file: 'lib/util.ts', parts: [{ start: 1, end: 5 }] }]}
        gitRef="abc1234"
        step={{ file: 'lib/util.ts', line: 2, endLine: 2 }}
        onShowLine={() => {}}
      />,
    );

    await waitFor(() => expect(shownLines()).toHaveLength(5));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
