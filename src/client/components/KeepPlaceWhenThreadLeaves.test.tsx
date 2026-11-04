import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommentThread, DiffChunk } from '../../types/diff';
import { WordHighlightProvider } from '../contexts/WordHighlightContext';

import { KeepPlaceWhenThreadLeaves } from './KeepPlaceWhenThreadLeaves';
import { SideBySideDiffChunk } from './SideBySideDiffChunk';

const FILE_HEADER_HEIGHT = 50;
const HEADER_COVER = FILE_HEADER_HEIGHT + 8;
const START_SCROLL = 3000;

type Tops = Record<string, [top: number, bottom: number]>;

describe('KeepPlaceWhenThreadLeaves', () => {
  let tops: Tops = {};

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        const key = this.id || this.getAttribute('data-test-key') || this.tagName;
        const [top, bottom] = this.tagName === 'MAIN' ? [0, 600] : (tops[key] ?? [0, 0]);
        if (this.hasAttribute('data-file-header')) {
          return DOMRect.fromRect({ y: 0, height: FILE_HEADER_HEIGHT });
        }
        return DOMRect.fromRect({ x: 0, y: top, width: 800, height: bottom - top });
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const codeRow = (
    <tr id="code-row">
      <td data-line-number-cell>290</td>
    </tr>
  );
  const cardRow = (id: string, withOverlay = false) => (
    <>
      <KeepPlaceWhenThreadLeaves threadId={id} />
      {withOverlay && (
        <tr id={`overlay-${id}`} data-thread-overlay={id}>
          <td />
        </tr>
      )}
      <tr id={`row-${id}`}>
        <td>
          <div id={`comment-thread-${id}`} />
        </td>
      </tr>
    </>
  );
  const page = (rows: React.ReactNode) => (
    <main className="overflow-y-auto">
      <div data-file-path="a.ts">
        <div data-file-header />
        <table>
          <tbody>{rows}</tbody>
        </table>
      </div>
    </main>
  );

  const leave = async (before: React.ReactNode, after: React.ReactNode, positions: Tops) => {
    tops = positions;
    const { container, rerender } = render(page(before));
    const diff = container.querySelector('main');
    if (!diff) throw new Error('diff container missing');
    diff.scrollTop = START_SCROLL;
    rerender(page(after));
    await Promise.resolve();
    return diff.scrollTop;
  };

  it('puts the code line the thread hung from under the file header', async () => {
    const scrollTop = await leave(
      <>
        {codeRow}
        {cardRow('a')}
      </>,
      codeRow,
      { 'comment-thread-a': [-1500, 300], 'code-row': [-1520, -1500] },
    );
    expect(scrollTop).toBe(START_SCROLL - 1520 - HEADER_COVER);
  });

  it('counts a fixup overlay above the card as part of what the reader is in', async () => {
    const scrollTop = await leave(
      <>
        {codeRow}
        {cardRow('a', true)}
      </>,
      codeRow,
      {
        'overlay-a': [-900, 150],
        'comment-thread-a': [200, 700],
        'code-row': [-920, -900],
      },
    );
    expect(scrollTop).toBe(START_SCROLL - 920 - HEADER_COVER);
  });

  it('puts the folded row under the file header when the thread leaves with its lines folded', async () => {
    const scrollTop = await leave(
      <>
        {codeRow}
        {cardRow('a')}
      </>,
      <tr id="fold-row" data-folded-lines>
        <td />
      </tr>,
      { 'comment-thread-a': [-1500, 300], 'code-row': [-1520, -1500], 'fold-row': [-1520, -1490] },
    );
    expect(scrollTop).toBe(START_SCROLL - 1520 - HEADER_COVER);
  });

  it('puts the end of the thread above it under the file header, not the code line past it', async () => {
    const scrollTop = await leave(
      <>
        {codeRow}
        {cardRow('a')}
        {cardRow('b')}
      </>,
      <>
        {codeRow}
        {cardRow('a')}
      </>,
      {
        'comment-thread-a': [-3000, -1000],
        'row-a': [-3000, -1000],
        'comment-thread-b': [-1000, 300],
        'code-row': [-3020, -3000],
      },
    );
    expect(scrollTop).toBe(START_SCROLL - 1000 - HEADER_COVER);
  });

  it('stays put when the whole thread was already above the screen', async () => {
    const scrollTop = await leave(
      <>
        {codeRow}
        {cardRow('a')}
      </>,
      codeRow,
      { 'comment-thread-a': [-2500, -1500], 'code-row': [-2520, -2500] },
    );
    expect(scrollTop).toBe(START_SCROLL);
  });

  it('stays put when the head of the thread was on screen', async () => {
    const scrollTop = await leave(
      <>
        {codeRow}
        {cardRow('a')}
      </>,
      codeRow,
      { 'comment-thread-a': [200, 1200], 'code-row': [180, 200] },
    );
    expect(scrollTop).toBe(START_SCROLL);
  });

  it('stays put when the code line leaves the page with the thread', async () => {
    const scrollTop = await leave(
      <>
        {codeRow}
        {cardRow('a')}
      </>,
      null,
      { 'comment-thread-a': [-1500, 300], 'code-row': [-1520, -1500] },
    );
    expect(scrollTop).toBe(START_SCROLL);
  });

  it('stays put when the card is drawn again elsewhere', async () => {
    const scrollTop = await leave(
      <>
        {codeRow}
        {cardRow('a')}
      </>,
      <>
        {codeRow}
        <tr>
          <td>
            <div id="comment-thread-a" />
          </td>
        </tr>
      </>,
      { 'comment-thread-a': [-1500, 300], 'code-row': [-1520, -1500] },
    );
    expect(scrollTop).toBe(START_SCROLL);
  });

  it('puts a file-level thread that was the only one back at the top of its file', async () => {
    tops = {
      'comment-thread-f': [-1500, 300],
      'file-comment-f': [-1500, 300],
      'file-section': [-1560, 3000],
    };
    const fileLevel = (
      <main className="overflow-y-auto">
        <div data-file-path="a.ts" data-test-key="file-section">
          <div data-file-header />
          <section>
            <div id="file-comment-f" data-thread-overlay="f">
              <KeepPlaceWhenThreadLeaves threadId="f" />
              <div id="comment-thread-f" />
            </div>
          </section>
        </div>
      </main>
    );
    const { container, rerender } = render(fileLevel);
    const diff = container.querySelector('main');
    if (!diff) throw new Error('diff container missing');
    diff.scrollTop = START_SCROLL;
    rerender(
      <main className="overflow-y-auto">
        <div data-file-path="a.ts" data-test-key="file-section">
          <div data-file-header />
        </div>
      </main>,
    );
    await Promise.resolve();
    expect(diff.scrollTop).toBe(START_SCROLL - 1560);
  });
  describe('when several threads share the place', () => {
    const sideBySide = (ids: string[], overlays: string[] = []) => (
      <>
        {ids.map((id) => (
          <KeepPlaceWhenThreadLeaves key={id} threadId={id} />
        ))}
        {overlays.map((id) => (
          <tr key={id} id={`overlay-${id}`} data-thread-overlay={id}>
            <td />
          </tr>
        ))}
        <tr>
          <td>
            {ids.map((id) => (
              <div key={id} id={`holder-${id}`}>
                <div id={`comment-thread-${id}`} />
              </div>
            ))}
          </td>
        </tr>
      </>
    );

    it('puts the end of the card above in the same row under the file header', async () => {
      const scrollTop = await leave(
        <>
          {codeRow}
          {sideBySide(['a', 'b'])}
        </>,
        <>
          {codeRow}
          {sideBySide(['a'])}
        </>,
        {
          'holder-a': [-3000, -1500],
          'comment-thread-a': [-3000, -1500],
          'holder-b': [-1500, 300],
          'comment-thread-b': [-1500, 300],
          'code-row': [-3020, -3000],
        },
      );
      expect(scrollTop).toBe(START_SCROLL - 1500 - HEADER_COVER);
    });

    it('falls back to the code line when the threads above leave too', async () => {
      const scrollTop = await leave(
        <>
          {codeRow}
          {cardRow('a')}
          {cardRow('b')}
        </>,
        codeRow,
        {
          'comment-thread-a': [-3000, -1000],
          'row-a': [-3000, -1000],
          'comment-thread-b': [-1000, 300],
          'row-b': [-1000, 300],
          'code-row': [-3020, -3000],
        },
      );
      expect(scrollTop).toBe(START_SCROLL - 3020 - HEADER_COVER);
    });

    it('leaves the view alone when a thread elsewhere in the row leaves', async () => {
      const scrollTop = await leave(
        <>
          {codeRow}
          {sideBySide(['a', 'b'], ['a', 'b'])}
        </>,
        <>
          {codeRow}
          {sideBySide(['a'], ['a'])}
        </>,
        {
          'overlay-a': [-3000, -2000],
          'overlay-b': [-4000, -3500],
          'holder-a': [-1500, 300],
          'comment-thread-a': [-1500, 300],
          'holder-b': [350, 600],
          'comment-thread-b': [350, 600],
          'code-row': [-3020, -3000],
        },
      );
      expect(scrollTop).toBe(START_SCROLL);
    });

    it('aims at the code line, not at a marker or fixup box row between', async () => {
      const between = (
        <>
          <tr id="marker-row">
            <td />
          </tr>
          <tr id="box-row">
            <td />
          </tr>
        </>
      );
      const scrollTop = await leave(
        <>
          {codeRow}
          {between}
          {cardRow('a')}
        </>,
        <>
          {codeRow}
          {between}
        </>,
        {
          'comment-thread-a': [-1400, 300],
          'row-a': [-1400, 300],
          'code-row': [-1520, -1500],
          'marker-row': [-1500, -1480],
          'box-row': [-1480, -1400],
        },
      );
      expect(scrollTop).toBe(START_SCROLL - 1520 - HEADER_COVER);
    });

    it('keeps the file-level thread that stays under the file header', async () => {
      tops = {
        'file-comment-f1': [-1500, 300],
        'comment-thread-f1': [-1500, 300],
        'file-comment-f2': [300, 900],
        'comment-thread-f2': [300, 900],
        'file-list': [-1560, 900],
      };
      const fileLevel = (ids: string[]) => (
        <main className="overflow-y-auto">
          <div data-file-path="a.ts">
            <div data-file-header />
            <section id="file-list">
              {ids.map((id) => (
                <div key={id} id={`file-comment-${id}`} data-thread-overlay={id}>
                  <KeepPlaceWhenThreadLeaves threadId={id} />
                  <div id={`comment-thread-${id}`} />
                </div>
              ))}
            </section>
          </div>
        </main>
      );
      const { container, rerender } = render(fileLevel(['f1', 'f2']));
      const diff = container.querySelector('main');
      if (!diff) throw new Error('diff container missing');
      diff.scrollTop = START_SCROLL;
      rerender(fileLevel(['f2']));
      await Promise.resolve();
      expect(diff.scrollTop).toBe(START_SCROLL - 1560 - HEADER_COVER);
    });
  });

  describe('in the real side-by-side chunk', () => {
    const chunk: DiffChunk = {
      header: '@@ -10,2 +10,3 @@',
      oldStart: 10,
      oldLines: 2,
      newStart: 10,
      newLines: 3,
      lines: [
        { type: 'normal', content: 'const first = 1;', oldLineNumber: 10, newLineNumber: 10 },
        { type: 'normal', content: 'const second = 2;', oldLineNumber: 11, newLineNumber: 11 },
        { type: 'add', content: 'const third = 3;', newLineNumber: 12 },
      ],
    };
    const thread: CommentThread = {
      id: 't1',
      file: 'src/example.ts',
      line: 12,
      side: 'new',
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
      messages: [
        {
          id: 'm1',
          body: 'Explain the constant',
          createdAt: '2026-09-18T00:00:00.000Z',
          updatedAt: '2026-09-18T00:00:00.000Z',
        },
      ],
    };
    const noop = () => {};
    const asyncNoop = async () => {};
    const chunkWith = (threads: CommentThread[]) => (
      <WordHighlightProvider>
        <main className="overflow-y-auto">
          <div data-file-path="src/example.ts">
            <div data-file-header />
            <SideBySideDiffChunk
              chunk={chunk}
              chunkIndex={0}
              threads={threads}
              onAddComment={asyncNoop}
              onResolveThread={noop}
              onReplyToThread={asyncNoop}
              onRemoveMessage={noop}
              onUpdateMessage={noop}
              filename="src/example.ts"
            />
          </div>
        </main>
      </WordHighlightProvider>
    );

    it('still aligns when the last thread on a line leaves with the row of cards', async () => {
      vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(
        function (this: Element) {
          const at = (top: number, bottom: number) =>
            DOMRect.fromRect({ y: top, height: bottom - top, width: 800 });
          if (this.tagName === 'MAIN') return at(0, 600);
          if (this.hasAttribute('data-file-header')) return at(0, FILE_HEADER_HEIGHT);
          if (this.querySelector('#comment-thread-t1') || this.id === 'comment-thread-t1') {
            return at(-1500, 300);
          }
          if (this.tagName === 'TR' && this.textContent?.includes('const third')) {
            const moved = START_SCROLL - (this.closest('main')?.scrollTop ?? START_SCROLL);
            return at(-1520 + moved, -1500 + moved);
          }
          return at(0, 0);
        },
      );
      const { container, rerender } = render(chunkWith([thread]));
      const diff = container.querySelector('main');
      if (!diff) throw new Error('diff container missing');
      diff.scrollTop = START_SCROLL;
      rerender(chunkWith([]));
      await Promise.resolve();
      expect(diff.scrollTop).toBe(START_SCROLL - 1520 - HEADER_COVER);
    });
  });
});
