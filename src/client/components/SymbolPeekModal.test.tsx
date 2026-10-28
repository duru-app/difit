import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  LibrarySourceResponse,
  SymbolCallersResponse,
  SymbolSearchResponse,
} from '../../types/diff';
import type { SymbolIndexState } from '../../types/watch';
import { WordHighlightProvider } from '../contexts/WordHighlightContext';
import type { SymbolIndexUpdates } from '../hooks/useSymbolPeek';
import { symbolRequestFromTarget } from '../utils/symbolPeek';

import { SymbolPeekModal } from './SymbolPeekModal';

vi.mock('react-hotkeys-hook', () => ({ useHotkeys: vi.fn() }));

const tokenized = vi.hoisted(() => ({ lengths: [] as number[] }));
vi.mock('../utils/fileTokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/fileTokens')>();
  return {
    ...actual,
    tokenizeContent: (...args: Parameters<typeof actual.tokenizeContent>) => {
      tokenized.lengths.push(args[0].length);
      return actual.tokenizeContent(...args);
    },
  };
});

const found: SymbolSearchResponse = {
  name: 'addOne',
  ref: 'abc1234',
  definitions: [{ path: 'src/math.ts', line: 2, text: 'export function addOne(n) {' }],
  references: [{ path: 'src/use.ts', line: 1, text: 'const two = addOne(1);' }],
  truncated: false,
  source: 'name',
};

const files: Record<string, string> = {
  'src/math.ts': '// math\nexport function addOne(n) {\n  return n + 1;\n}\n',
  'src/use.ts': 'const two = addOne(1);\n',
};

function respond(search: SymbolSearchResponse | null) {
  vi.mocked(global.fetch).mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/symbol') {
      return search
        ? new Response(JSON.stringify(search), { status: 200 })
        : new Response('{}', { status: 404 });
    }
    const path = decodeURIComponent(url.pathname.replace('/api/blob/', ''));
    const content = files[path];
    return content === undefined
      ? new Response('', { status: 404 })
      : new Response(new TextEncoder().encode(content), { status: 200 });
  });
}

async function shownRows(): Promise<string[]> {
  let rows: string[] = [];
  await waitFor(() => {
    rows = Array.from(document.querySelectorAll('[data-symbol-ref] tr')).map(
      (row) => row.textContent ?? '',
    );
    expect(rows.length).toBeGreaterThan(0);
  });
  return rows;
}

function renderModal(props: Partial<React.ComponentProps<typeof SymbolPeekModal>> = {}) {
  return render(
    <WordHighlightProvider>
      <SymbolPeekModal
        request={{ name: 'addOne', ref: 'abc1234', from: 'src/use.ts' }}
        canGoBack={false}
        onBack={vi.fn()}
        onClose={vi.fn()}
        {...props}
      />
    </WordHighlightProvider>,
  );
}

describe('SymbolPeekModal', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    tokenized.lengths = [];
  });

  afterEach(() => {
    delete files['src/big.ts'];
    delete files['src/cr.ts'];
    delete files['src/huge.ts'];
    delete files['src/mixed.ts'];
    vi.restoreAllMocks();
  });

  it('searches the requested revision and opens the first declaration at its line', async () => {
    respond(found);
    renderModal();

    expect(await shownRows()).toEqual([
      '1// math',
      '2export function addOne(n) {',
      '3  return n + 1;',
      '4}',
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/symbol?name=addOne&ref=abc1234&from=src%2Fuse.ts',
      { signal: expect.any(AbortSignal) },
    );
    expect(global.fetch).toHaveBeenCalledWith('/api/blob/src%2Fmath.ts?ref=abc1234', {
      signal: expect.any(AbortSignal),
    });
    const highlighted = screen.getByText('2').closest('tr');
    expect(highlighted).toHaveClass('bg-github-accent/15');
  });

  it('keeps the shown file searchable at the same revision', async () => {
    respond(found);
    const { container } = renderModal();

    await shownRows();
    const file = container.ownerDocument.querySelector('[data-symbol-ref]');
    expect(file).toHaveAttribute('data-symbol-ref', 'abc1234');
    expect(file).toHaveAttribute('data-symbol-path', 'src/math.ts');
  });

  it('opens a use when it is picked from the list', async () => {
    respond(found);
    renderModal();
    await shownRows();

    fireEvent.click(screen.getByText('src/use.ts:1'));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/blob/src%2Fuse.ts?ref=abc1234', {
        signal: expect.any(AbortSignal),
      }),
    );
    expect(await screen.findByText('src/use.ts')).toBeInTheDocument();
  });

  it('marks the uses that go through a getter or a builder method', async () => {
    respond({
      ...found,
      references: [
        { path: 'src/use.ts', line: 1, text: 'const two = addOne(1);' },
        { path: 'src/use.ts', line: 2, text: 'foo.getAddOne();', via: 'getter' },
        { path: 'src/use.ts', line: 3, text: 'Foo.builder().addOne(1);', via: 'builder' },
      ],
    });
    renderModal();

    const list = await screen.findByRole('navigation');
    await waitFor(() => expect(within(list).getByText('쓰인 곳 3')).toBeInTheDocument());
    const row = (path: string) =>
      within(within(list).getByRole('button', { name: new RegExp(path) }));
    expect(row('src/use.ts:1').queryByText(/게터|빌더/)).toBeNull();
    expect(row('src/use.ts:2').getByText('게터')).toBeInTheDocument();
    expect(row('src/use.ts:3').getByText('빌더')).toBeInTheDocument();
  });

  it('moves to another line of the shown file without downloading it again', async () => {
    respond({
      ...found,
      references: [{ path: 'src/math.ts', line: 3, text: '  return n + 1;' }],
    });
    renderModal();
    await shownRows();

    fireEvent.click(screen.getByText('src/math.ts:3'));

    await waitFor(() =>
      expect(screen.getByText('3').closest('tr')).toHaveClass('bg-github-accent/15'),
    );
    const blobRequests = vi
      .mocked(global.fetch)
      .mock.calls.filter(([url]) => String(url).startsWith('/api/blob/'));
    expect(blobRequests).toHaveLength(1);
  });

  it('shows a large file as 2000 lines that still include the selected one near the end', async () => {
    files['src/big.ts'] = Array.from({ length: 2500 }, (_, i) => {
      const lineNumber = i + 1;
      if (lineNumber === 400) return '/*';
      if (lineNumber === 600) return '*/';
      return `const v${lineNumber} = ${lineNumber};`;
    }).join('\n');
    respond({
      ...found,
      definitions: [{ path: 'src/big.ts', line: 2400, text: 'const v2400 = 2400;' }],
      references: [],
    });
    renderModal();

    const rows = await shownRows();

    expect(rows).toHaveLength(2000);
    expect(rows[0]).toBe('501const v501 = 501;');
    // The window starts inside a block comment that opened on line 400.
    const firstCode = document.querySelector('[data-symbol-ref] tr td:last-child');
    expect(firstCode?.querySelector('.comment')?.textContent).toBe('const v501 = 501;');
    expect(rows.at(-1)).toBe('2500const v2500 = 2500;');
    expect(document.querySelector('tr.bg-github-accent\\/15')?.textContent).toBe(
      '2400const v2400 = 2400;',
    );
    expect(screen.getByText('src/big.ts · 501-2500줄만 보여 줍니다')).toBeInTheDocument();
  }, 120_000);

  it('shows a single line of over a million characters without tokenizing it', async () => {
    files['src/huge.ts'] = `const bundle = '${'x'.repeat(1_100_000)}';\n`;
    respond({
      ...found,
      definitions: [{ path: 'src/huge.ts', line: 1, text: 'const bundle' }],
      references: [],
    });
    renderModal();

    const [row] = await shownRows();

    expect(row?.startsWith('1const bundle = ')).toBe(true);
    expect(tokenized.lengths).toEqual([]);
  });

  it('highlights a file of over a million characters row by row', async () => {
    const filler = 'x'.repeat(430);
    files['src/huge.ts'] = Array.from(
      { length: 2500 },
      (_, i) => `const v${i + 1} = '${filler}';`,
    ).join('\n');
    respond({
      ...found,
      definitions: [{ path: 'src/huge.ts', line: 2400, text: 'const v2400' }],
      references: [],
    });
    renderModal();

    const rows = await shownRows();

    expect(rows.at(-1)).toBe(`2500const v2500 = '${filler}';`);
    expect(tokenized.lengths).toEqual([]);
    expect(document.querySelector('[data-symbol-ref] tr .token')).not.toBeNull();
  }, 120_000);

  it('shows a window of over a million characters as plain text', async () => {
    const filler = 'x'.repeat(600);
    files['src/huge.ts'] = Array.from(
      { length: 2500 },
      (_, i) => `const v${i + 1} = '${filler}';`,
    ).join('\n');
    respond({
      ...found,
      definitions: [{ path: 'src/huge.ts', line: 10, text: 'const v10' }],
      references: [],
    });
    renderModal();

    const rows = await shownRows();

    expect(rows).toHaveLength(2000);
    expect(document.querySelector('[data-symbol-ref] tr .token')).toBeNull();
  }, 120_000);

  it('shows a very long line as plain text and tokenizes the lines around it in runs', async () => {
    files['src/mixed.ts'] = `/*\nconst a = 1;\n*/\nconst b = '${'x'.repeat(20_000)}';\n`;
    respond({
      ...found,
      definitions: [{ path: 'src/mixed.ts', line: 2, text: 'const a = 1;' }],
      references: [],
    });
    renderModal();

    await shownRows();
    const cells = document.querySelectorAll('[data-symbol-ref] tr td:last-child');

    expect(tokenized.lengths.length).toBeGreaterThan(0);
    expect(Math.max(...tokenized.lengths)).toBeLessThan(20_000);
    expect(cells[1]?.querySelector('.comment')?.textContent).toBe('const a = 1;');
    expect(cells[3]?.querySelector('.token')).toBeNull();
    expect(cells[3]?.textContent).toBe(`const b = '${'x'.repeat(20_000)}';`);
  });

  it('tokenizes the short lines of a file that is large only by one long line', async () => {
    files['src/huge.ts'] = [
      ...Array.from({ length: 300 }, (_, i) => `const v${i + 1} = ${i + 1};`),
      `const data = '${'x'.repeat(1_100_000)}';`,
    ].join('\n');
    respond({
      ...found,
      definitions: [{ path: 'src/huge.ts', line: 1, text: 'const v1 = 1;' }],
      references: [],
    });
    renderModal();

    await shownRows();
    const [first] = document.querySelectorAll('[data-symbol-ref] tr td:last-child');

    expect(tokenized.lengths).toHaveLength(1);
    expect(tokenized.lengths[0]).toBeLessThan(10_000);
    expect(first?.querySelector('.token')).not.toBeNull();
  });

  it('numbers lines as git grep does when a line holds a lone carriage return', async () => {
    files['src/cr.ts'] = 'const a = 1;\rconst b = 2;\nconst c = 3;\n';
    respond({
      ...found,
      definitions: [{ path: 'src/cr.ts', line: 2, text: 'const c = 3;' }],
      references: [],
    });
    renderModal();

    const rows = await shownRows();
    expect(rows).toHaveLength(2);
    expect(document.querySelector('tr.bg-github-accent\\/15')?.textContent).toBe('2const c = 3;');
  });

  it('says so when the name appears nowhere', async () => {
    respond({ ...found, definitions: [], references: [] });
    renderModal();

    expect(await screen.findByText('찾지 못했습니다.')).toBeInTheDocument();
  });

  it('says so when the revision cannot be searched', async () => {
    respond(null);
    renderModal();

    expect(await screen.findByText('이 리비전에서는 찾을 수 없습니다.')).toBeInTheDocument();
  });

  it('stays mounted but out of sight while a deeper lookup is shown', async () => {
    respond(found);
    renderModal({ hidden: true });

    await shownRows();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers a way back only after going deeper', async () => {
    respond(found);
    const onBack = vi.fn();
    const { rerender } = renderModal();
    expect(screen.queryByRole('button', { name: '뒤로' })).not.toBeInTheDocument();

    rerender(
      <WordHighlightProvider>
        <SymbolPeekModal
          request={{ name: 'addOne', ref: 'abc1234' }}
          canGoBack
          onBack={onBack}
          onClose={vi.fn()}
        />
      </WordHighlightProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '뒤로' }));

    expect(onBack).toHaveBeenCalled();
  });

  it('shows a full commit hash shortened but searches with the whole of it', async () => {
    const ref = '0123456789abcdef0123456789abcdef01234567^';
    respond({ ...found, ref });
    renderModal({ request: { name: 'addOne', ref } });

    expect(screen.getByRole('heading')).toHaveTextContent('addOne@ 0123456^');
    await shownRows();
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/symbol?name=addOne&ref=${encodeURIComponent(ref)}`,
      { signal: expect.any(AbortSignal) },
    );
  });
});

describe('SymbolPeekModal with a commit index', () => {
  const commit = 'a'.repeat(40);
  const request = { name: 'addOne', ref: 'abc1234', from: 'src/use.ts', line: 1, column: 12 };
  const byName: SymbolSearchResponse = {
    ...found,
    references: [
      { path: 'src/use.ts', line: 1, text: 'const two = addOne(1);' },
      { path: 'src/other.ts', line: 5, text: 'other.addOne(2);' },
    ],
    index: { commit, status: 'building', startedAt: Date.now() },
  };
  const byIndex: SymbolSearchResponse = {
    ...found,
    references: [{ path: 'src/use.ts', line: 1, text: 'const two = addOne(1);' }],
    source: 'index',
  };

  // `null` answers the search with a failure.
  let answers: ((value: SymbolSearchResponse | null) => void)[];
  // `null` fails the request.
  let librarySource: LibrarySourceResponse | null;
  // By the method whose callers they are; a method left out is answered with 404.
  let callersOf: Record<string, SymbolCallersResponse>;

  beforeEach(() => {
    global.fetch = vi.fn();
    answers = [];
    librarySource = null;
    callersOf = {};
    files['src/other.ts'] = 'const other = {};\n\n\n\nother.addOne(2);\n';
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/symbol-callers') {
        const callers = callersOf[url.searchParams.get('symbol') ?? ''];
        return callers
          ? new Response(JSON.stringify(callers), { status: 200 })
          : new Response('{}', { status: 404 });
      }
      if (url.pathname === '/api/symbol') {
        const search = await new Promise<SymbolSearchResponse | null>((resolve) =>
          answers.push(resolve),
        );
        return search === null
          ? new Response('', { status: 404 })
          : new Response(JSON.stringify(search), { status: 200 });
      }
      if (url.pathname === '/api/library-source') {
        return librarySource === null
          ? new Response('', { status: 500 })
          : new Response(JSON.stringify(librarySource), { status: 200 });
      }
      const content = files[decodeURIComponent(url.pathname.replace('/api/blob/', ''))];
      return content === undefined
        ? new Response('', { status: 404 })
        : new Response(new TextEncoder().encode(content), { status: 200 });
    });
  });

  afterEach(() => {
    delete files['src/other.ts'];
    vi.restoreAllMocks();
  });

  const symbolRequests = () =>
    vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url).startsWith('/api/symbol'));

  async function answer(search: SymbolSearchResponse | null, count: number) {
    await waitFor(() => expect(answers).toHaveLength(count));
    answers[count - 1]!(search);
  }

  function modal(indexUpdates?: SymbolIndexUpdates, hidden?: boolean) {
    return (
      <WordHighlightProvider>
        <SymbolPeekModal
          request={request}
          hidden={hidden}
          canGoBack={false}
          onBack={vi.fn()}
          onClose={vi.fn()}
          indexUpdates={indexUpdates}
        />
      </WordHighlightProvider>
    );
  }

  const building: SymbolIndexState = { status: 'building', startedAt: Date.now() };
  const ready: SymbolIndexState = { status: 'ready' };
  const updates = (state: SymbolIndexState, seq: number, on = commit): SymbolIndexUpdates => ({
    seq,
    byCommit: new Map([[on, { state, seq }]]),
  });

  const timedOut: SymbolIndexState = {
    status: 'failed',
    reason: 'timeout',
    detail: 'scip-java timed out',
    hasLog: false,
  };
  const selectedItem = () => document.querySelector('nav [aria-current="true"]')?.textContent;

  it('sends where the name was clicked', async () => {
    render(modal());
    await answer(byIndex, 1);

    expect(symbolRequests()[0]?.[0]).toBe(
      '/api/symbol?name=addOne&ref=abc1234&from=src%2Fuse.ts&line=1&column=12',
    );
  });

  it('says the index is being built only while the answer says so', async () => {
    const { unmount } = render(modal());
    await answer(byName, 1);
    expect(await screen.findByRole('status')).toHaveTextContent('색인을 만드는 중');
    unmount();

    render(modal());
    await answer(byIndex, 2);
    await shownRows();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('swaps in the index answer when the index is ready and keeps the selected line', async () => {
    const { rerender } = render(modal(updates(building, 1)));
    await answer(byName, 1);
    await shownRows();
    fireEvent.click(screen.getByText('src/use.ts:1'));
    expect(await screen.findByText('src/use.ts')).toBeInTheDocument();

    rerender(modal(updates(building, 2)));
    rerender(modal(updates(building, 2, 'b'.repeat(40))));
    expect(symbolRequests()).toHaveLength(1);

    rerender(modal(updates(ready, 3)));
    await answer(byIndex, 2);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.queryByText('src/other.ts:5')).not.toBeInTheDocument();
    expect(selectedItem()).toContain('src/use.ts:1');
    expect(screen.getByText('src/use.ts')).toBeInTheDocument();
    const useFileRequests = vi
      .mocked(global.fetch)
      .mock.calls.filter(([url]) => String(url).startsWith('/api/blob/src%2Fuse.ts'));
    expect(useFileRequests).toHaveLength(1);
  });

  it('selects the first item when the selected line is gone from the index answer', async () => {
    const { rerender } = render(modal());
    await answer(byName, 1);
    await shownRows();
    fireEvent.click(screen.getByText('src/other.ts:5'));
    expect(await screen.findByText('src/other.ts')).toBeInTheDocument();

    rerender(modal(updates(ready, 1)));
    await answer(byIndex, 2);

    await waitFor(() => expect(selectedItem()).toContain('src/math.ts:2'));
    expect(await screen.findByText('src/math.ts')).toBeInTheDocument();
  });

  it('keeps the name search answer but drops the status line when asking again fails', async () => {
    const { rerender } = render(modal());
    await answer(byName, 1);
    await shownRows();
    fireEvent.click(screen.getByText('src/other.ts:5'));
    expect(await screen.findByText('src/other.ts')).toBeInTheDocument();

    rerender(modal(updates(ready, 1)));
    await answer(null, 2);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(selectedItem()).toContain('src/other.ts:5');
    expect(screen.getByText('src/use.ts:1')).toBeInTheDocument();
    expect(screen.queryByText('이 리비전에서는 찾을 수 없습니다.')).not.toBeInTheDocument();
  });

  it('asks again when the index was finished before the first answer arrived', async () => {
    const { rerender } = render(modal());
    await waitFor(() => expect(answers).toHaveLength(1));
    rerender(modal(updates(ready, 1)));
    answers[0]!(byName);

    await answer(byIndex, 2);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('follows the index from waiting to building, and asks again once it failed', async () => {
    const { rerender } = render(modal());
    await answer({ ...byName, index: { commit, status: 'queued', after: 'b'.repeat(40) } }, 1);
    expect(await screen.findByRole('status')).toHaveTextContent(
      '색인 기다리는 중 · 앞 커밋 bbbbbbb의 색인이 끝나면 시작합니다',
    );

    rerender(modal(updates(building, 1)));
    expect(screen.getByRole('status')).toHaveTextContent('색인을 만드는 중');
    expect(symbolRequests()).toHaveLength(1);

    rerender(modal(updates(timedOut, 2)));
    expect(screen.getByRole('status')).toHaveTextContent(
      '색인을 만들 수 없음 · 빌드가 1시간 안에 끝나지 않아 멈췄습니다',
    );
    expect(screen.getByText('scip-java timed out')).toBeInTheDocument();
    await answer({ ...byName, index: { commit, ...timedOut } }, 2);
    expect(screen.getByText('src/other.ts:5')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('색인을 만들 수 없음');
    expect(symbolRequests()).toHaveLength(2);
  });

  it('asks again when the index of an ancestor it waited for cannot be built', async () => {
    const ancestor = 'c'.repeat(40);
    const { rerender } = render(modal());
    await answer({ ...byName, index: { commit: ancestor, ...building } }, 1);

    rerender(modal(updates(timedOut, 1, ancestor)));
    await answer(byIndex, 2);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('says why the answer came from name search', async () => {
    render(modal());
    await answer({ ...found, unindexed: 'not-java' }, 1);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Java 파일이 아니라 색인을 쓰지 않습니다 · 이름으로 찾은 결과입니다',
    );
  });

  it('does not ask again over an index change heard before it searched', async () => {
    render(modal(updates(ready, 1)));
    await answer(byName, 1);
    await shownRows();

    expect(symbolRequests()).toHaveLength(1);
  });

  const LIBRARY_SYMBOL = 'semanticdb maven jdk 8 java/util/Optional#orElse().';
  const OPTIONAL_SOURCE = [
    'package java.util;',
    'public final class Optional<T> {',
    '    public T orElse(T other) {',
    '        return value != null ? value : other;',
    '    }',
    '}',
  ].join('\n');
  const byLibrary: SymbolSearchResponse = {
    ...byIndex,
    name: 'orElse',
    definitions: [],
    library: 'java.util.Optional#orElse()',
    librarySymbol: LIBRARY_SYMBOL,
  };
  const libraryFound = (
    origin: Extract<LibrarySourceResponse, { found: true }>['origin'],
  ): LibrarySourceResponse => ({
    found: true,
    path: 'java/util/Optional.java',
    line: 3,
    text: OPTIONAL_SOURCE,
    origin,
  });
  const libraryRequests = () =>
    vi
      .mocked(global.fetch)
      .mock.calls.filter(([url]) => String(url).startsWith('/api/library-source'));
  const libraryPane = () =>
    screen.findByText((_, element) => element?.textContent === 'java/util/Optional.java · JDK 8');

  it('opens the source of a declaration that only a library holds at its line', async () => {
    librarySource = libraryFound({ kind: 'jdk', installed: '8', indexed: '8' });
    render(modal());
    await answer(byLibrary, 1);

    const list = await screen.findByRole('navigation');
    expect(within(list).getByText('선언 1')).toBeInTheDocument();
    expect(within(list).getByText('라이브러리 선언')).toBeInTheDocument();
    expect(selectedItem()).toContain('java.util.Optional#orElse()');
    expect(within(list).getByText('쓰인 곳 1')).toBeInTheDocument();
    expect(list.textContent?.indexOf('java.util.Optional#orElse()')).toBeLessThan(
      list.textContent?.indexOf('src/use.ts:1') ?? -1,
    );
    expect(await libraryPane()).toBeInTheDocument();
    expect(libraryRequests()[0]?.[0]).toBe(
      `/api/library-source?${new URLSearchParams({ symbol: LIBRARY_SYMBOL }).toString()}`,
    );
    const target = await screen.findByText('3');
    expect(target.closest('tr')).toHaveClass('bg-github-accent/15');
    expect(target.closest('tr')?.textContent).toContain('public T orElse(T other) {');
    expect(screen.queryByText(/선언이 다를 수 있습니다/)).not.toBeInTheDocument();
  });

  it('selects the library declaration once the index answers, unless a use was picked', async () => {
    librarySource = libraryFound({ kind: 'jdk', installed: '8', indexed: '8' });
    const byNameOnly: SymbolSearchResponse = { ...byName, name: 'orElse', definitions: [] };

    const first = render(modal(updates(building, 1)));
    await answer(byNameOnly, 1);
    await waitFor(() => expect(selectedItem()).toContain('src/use.ts:1'));
    first.rerender(modal(updates(ready, 2)));
    await answer(byLibrary, 2);

    await waitFor(() => expect(selectedItem()).toContain('java.util.Optional#orElse()'));
    expect(await libraryPane()).toBeInTheDocument();
    first.unmount();

    const second = render(modal(updates(building, 1)));
    await answer(byNameOnly, 3);
    await shownRows();
    fireEvent.click(screen.getByText('src/use.ts:1'));
    second.rerender(modal(updates(ready, 2)));
    await answer(byLibrary, 4);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(selectedItem()).toContain('src/use.ts:1');
  });

  it('keeps the item a deeper lookup was opened from when the index answers meanwhile', async () => {
    librarySource = libraryFound({ kind: 'jdk', installed: '8', indexed: '8' });
    const byNameOnly: SymbolSearchResponse = { ...byName, name: 'orElse', definitions: [] };
    const { rerender } = render(modal(updates(building, 1)));
    await answer(byNameOnly, 1);
    await waitFor(() => expect(selectedItem()).toContain('src/use.ts:1'));
    await shownRows();

    rerender(modal(updates(building, 1), true));
    rerender(modal(updates(ready, 2), true));
    await answer(byLibrary, 2);
    await screen.findByText('라이브러리 선언');
    rerender(modal(updates(ready, 2)));

    expect(selectedItem()).toContain('src/use.ts:1');
    expect(screen.getByText('src/use.ts')).toBeInTheDocument();
    expect(libraryRequests()).toHaveLength(0);
  });

  it('does not search names clicked in a library source', async () => {
    librarySource = libraryFound({ kind: 'jdk', installed: '8', indexed: '8' });
    render(modal());
    await answer(byLibrary, 1);
    await libraryPane();

    const word = await waitFor(() => {
      const found = document.querySelector(
        '[data-symbol-line="3"] .word-token[data-word="orElse"]',
      );
      expect(found).not.toBeNull();
      return found;
    });

    expect(symbolRequestFromTarget(word, { base: 'abc1234^', target: 'abc1234' })).toBeNull();
  });

  it('moves between the library declaration and a use in the repository', async () => {
    librarySource = libraryFound({ kind: 'gradle', jar: 'x-1.0-sources.jar' });
    render(modal());
    await answer(byLibrary, 1);
    const list = await screen.findByRole('navigation');

    fireEvent.click(within(list).getByText('src/use.ts:1'));
    expect(await shownRows()).toEqual(['1const two = addOne(1);']);
    fireEvent.click(within(list).getByText('java.util.Optional#orElse()'));

    expect(
      await screen.findByText(
        (_, element) => element?.textContent === 'java/util/Optional.java · x-1.0-sources.jar',
      ),
    ).toBeInTheDocument();
    expect(selectedItem()).toContain('java.util.Optional#orElse()');
  });

  it.each([
    [
      { kind: 'jdk', installed: '17', indexed: '8' } as const,
      '색인은 JDK 8로 만들었지만 JDK 17의 소스를 보여 줍니다. 선언이 다를 수 있습니다.',
    ],
    [
      { kind: 'jdk', installed: null, indexed: '8' } as const,
      '색인은 JDK 8로 만들었지만 버전을 알 수 없는 JDK의 소스를 보여 줍니다. 선언이 다를 수 있습니다.',
    ],
  ])('notes a JDK source of another version than the index', async (origin, note) => {
    librarySource = libraryFound(origin);
    render(modal());
    await answer(byLibrary, 1);

    expect(await screen.findByText(note)).toBeInTheDocument();
  });

  it.each([
    [
      { kind: 'jdk', indexed: '8', sourcePackage: 'openjdk-8-source' } as const,
      '설치된 JDK에서 JDK 8의 소스(src.zip)를 찾지 못했습니다. sudo apt install openjdk-8-source로 설치하면 볼 수 있습니다.',
    ],
    [
      { kind: 'jdk', indexed: '8' } as const,
      '설치된 JDK에서 JDK 8의 소스(src.zip)를 찾지 못했습니다.',
    ],
    [
      { kind: 'jar', artifact: 'org.example:lib:1.0' } as const,
      'Gradle 캐시와 Maven 저장소에 org.example:lib:1.0의 소스 jar가 없습니다.',
    ],
    [
      { kind: 'file', archive: '/jdk/lib/src.zip', path: 'java/util/Optional.java' } as const,
      '/jdk/lib/src.zip 안에 java/util/Optional.java 파일이 없습니다.',
    ],
    [{ kind: 'unknown' } as const, '어느 라이브러리의 선언인지 알 수 없어 소스를 찾지 못했습니다.'],
  ])('says why a library source is not shown', async (missing, reason) => {
    librarySource = { found: false, missing };
    render(modal());
    await answer(byLibrary, 1);

    expect(
      await screen.findByText(
        (_, element) => element?.tagName === 'P' && element.textContent === reason,
      ),
    ).toBeInTheDocument();
  });

  it('says when the library source could not be read', async () => {
    render(modal());
    await answer(byLibrary, 1);

    expect(await screen.findByText('라이브러리 소스를 읽지 못했습니다.')).toBeInTheDocument();
  });

  it('lists the implementations between the declarations and the uses', async () => {
    files['src/impl.ts'] = '\n\nclass Impl { addOne(n) { return n + 1; } }\n';
    try {
      render(modal());
      await answer(
        {
          ...byIndex,
          implementations: [
            { path: 'src/impl.ts', line: 3, text: 'class Impl { addOne(n) { return n + 1; } }' },
          ],
        },
        1,
      );

      const list = await screen.findByRole('navigation');
      expect(
        within(list)
          .getAllByRole('heading')
          .map((heading) => heading.textContent),
      ).toEqual(['선언 1', '구현 1', '쓰인 곳 1']);
      fireEvent.click(within(list).getByText('src/impl.ts:3'));
      expect(selectedItem()).toContain('src/impl.ts:3');
      expect(await shownRows()).toContainEqual(expect.stringContaining('class Impl'));
    } finally {
      delete files['src/impl.ts'];
    }
  });

  it('shows no implementations without any in the answer', async () => {
    render(modal());
    await answer(byIndex, 1);

    const list = await screen.findByRole('navigation');
    await waitFor(() => expect(within(list).getByText('쓰인 곳 1')).toBeInTheDocument());
    expect(within(list).queryByText(/^구현/)).toBeNull();
  });

  describe('callers of the method a use sits in', () => {
    const RUN = 'semanticdb maven . . demo/Use#run().';
    const START = 'semanticdb maven . . demo/App#start().';
    const withCallers: SymbolSearchResponse = {
      ...byIndex,
      references: [
        { path: 'src/use.ts', line: 1, text: 'const two = addOne(1);', caller: RUN },
        { path: 'src/other.ts', line: 5, text: 'other.addOne(2);' },
      ],
    };
    const callerRequests = () =>
      vi
        .mocked(global.fetch)
        .mock.calls.map(([url]) => String(url))
        .filter((url) => url.startsWith('/api/symbol-callers'));
    const rowOf = (text: string) => {
      const row = within(screen.getByRole('navigation')).getByText(text).closest('li');
      if (!row) throw new Error(`no row holds ${text}`);
      return row;
    };
    const ownLine = (row: HTMLElement) => row.firstElementChild as HTMLElement;

    beforeEach(() => {
      files['src/app.ts'] = 'class App {\n  start() { run(); }\n}\n';
      files['src/port.ts'] = '\n\nport.run();\n';
      callersOf[RUN] = {
        callers: [
          { path: 'src/app.ts', line: 2, text: '  start() { run(); }', caller: START },
          { path: 'src/port.ts', line: 3, text: 'port.run();', via: 'interface', caller: RUN },
        ],
        truncated: false,
      };
      callersOf[START] = { callers: [], truncated: false };
    });

    afterEach(() => {
      delete files['src/app.ts'];
      delete files['src/port.ts'];
    });

    it('offers to expand only the uses whose method the index named', async () => {
      render(modal());
      await answer(withCallers, 1);

      await waitFor(() => expect(rowOf('src/use.ts:1')).toBeInTheDocument());
      expect(
        within(rowOf('src/use.ts:1')).getByRole('button', { name: '호출하는 곳 펼치기' }),
      ).toHaveAttribute('aria-expanded', 'false');
      expect(
        within(rowOf('src/other.ts:5')).queryByRole('button', { name: /호출하는 곳/ }),
      ).toBeNull();
    });

    it('shows no toggle when no use names its method', async () => {
      render(modal());
      await answer(byIndex, 1);

      await waitFor(() => expect(rowOf('src/use.ts:1')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /호출하는 곳/ })).toBeNull();
    });

    it('expands the callers one level at a time, each level indented', async () => {
      render(modal());
      await answer(withCallers, 1);
      const toggle = await waitFor(() =>
        within(rowOf('src/use.ts:1')).getByRole('button', { name: '호출하는 곳 펼치기' }),
      );

      fireEvent.click(toggle);
      await waitFor(() => expect(rowOf('src/app.ts:2')).toBeInTheDocument());
      expect(callerRequests()).toEqual([
        `/api/symbol-callers?${new URLSearchParams({ ref: 'abc1234', symbol: RUN }).toString()}`,
      ]);
      expect(toggle).toHaveAccessibleName('호출하는 곳 접기');
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(ownLine(rowOf('src/use.ts:1')).style.paddingLeft).toBe('0px');
      expect(ownLine(rowOf('src/app.ts:2')).style.paddingLeft).toBe('16px');
      expect(within(rowOf('src/port.ts:3')).getByText('인터페이스로')).toBeInTheDocument();

      fireEvent.click(
        within(rowOf('src/app.ts:2')).getByRole('button', { name: '호출하는 곳 펼치기' }),
      );
      expect(await screen.findByText('호출하는 곳이 없습니다.')).toBeInTheDocument();

      fireEvent.click(within(rowOf('src/app.ts:2')).getByText('src/app.ts:2'));
      expect(selectedItem()).toContain('src/app.ts:2');
      expect(await shownRows()).toContainEqual(expect.stringContaining('start() { run(); }'));
    });

    it('indents callers past the toggle above them even when none of them has a toggle', async () => {
      callersOf[RUN] = {
        callers: [{ path: 'src/app.ts', line: 2, text: '  start() { run(); }' }],
        truncated: false,
      };
      render(modal());
      await answer(withCallers, 1);
      fireEvent.click(
        await waitFor(() =>
          within(rowOf('src/use.ts:1')).getByRole('button', { name: '호출하는 곳 펼치기' }),
        ),
      );

      const nested = ownLine(await waitFor(() => rowOf('src/app.ts:2')));
      expect(nested.style.paddingLeft).toBe('16px');
      expect(nested.firstElementChild).toHaveClass('w-11');
      expect(within(nested).queryByRole('button', { name: /호출하는 곳/ })).toBeNull();
    });

    it('marks a caller in a method whose callers are already shown, with nothing to expand', async () => {
      render(modal());
      await answer(withCallers, 1);
      fireEvent.click(
        await waitFor(() =>
          within(rowOf('src/use.ts:1')).getByRole('button', { name: '호출하는 곳 펼치기' }),
        ),
      );

      const again = await waitFor(() => rowOf('src/port.ts:3'));
      expect(within(again).getByText('재귀')).toBeInTheDocument();
      expect(within(again).queryByRole('button', { name: /호출하는 곳/ })).toBeNull();
      expect(within(rowOf('src/app.ts:2')).queryByText('재귀')).toBeNull();
    });

    it('collapses the callers and shows them again without asking twice', async () => {
      render(modal());
      await answer(withCallers, 1);
      const toggle = await waitFor(() =>
        within(rowOf('src/use.ts:1')).getByRole('button', { name: '호출하는 곳 펼치기' }),
      );

      fireEvent.click(toggle);
      await waitFor(() => expect(rowOf('src/app.ts:2')).toBeInTheDocument());
      fireEvent.click(toggle);
      expect(screen.queryByText('src/app.ts:2')).toBeNull();
      expect(toggle).toHaveAccessibleName('호출하는 곳 펼치기');
      fireEvent.click(toggle);
      expect(rowOf('src/app.ts:2')).toBeInTheDocument();
      expect(callerRequests()).toHaveLength(1);
    });

    it('says so when the callers cannot be found', async () => {
      delete callersOf[RUN];
      render(modal());
      await answer(withCallers, 1);
      fireEvent.click(
        await waitFor(() =>
          within(rowOf('src/use.ts:1')).getByRole('button', { name: '호출하는 곳 펼치기' }),
        ),
      );

      expect(await screen.findByText('호출하는 곳을 찾지 못했습니다.')).toBeInTheDocument();
    });
  });

  it('marks only the uses that were found by name in an index answer', async () => {
    render(modal());
    await answer(
      {
        ...byIndex,
        references: [
          { path: 'src/use.ts', line: 1, text: 'const two = addOne(1);' },
          { path: 'src/other.ts', line: 5, text: 'other.addOne(2);', source: 'name' },
        ],
      },
      1,
    );

    const list = await screen.findByRole('navigation');
    const rows = within(list).getAllByRole('listitem');
    const marked = rows.filter((row) => within(row).queryByText('이름 검색'));
    expect(marked.map((row) => row.textContent)).toEqual([
      expect.stringContaining('src/other.ts:5'),
    ]);
  });

  it('gives a name clicked inside the window its line and column', async () => {
    render(modal());
    await answer(byIndex, 1);
    await shownRows();

    const word = await waitFor(() => {
      const found = document.querySelector(
        '[data-symbol-line="2"] .word-token[data-word="addOne"]',
      );
      expect(found).not.toBeNull();
      return found;
    });

    expect(symbolRequestFromTarget(word, {})).toEqual({
      name: 'addOne',
      ref: 'abc1234',
      from: 'src/math.ts',
      line: 2,
      column: 'export function '.length,
    });
  });
});
