import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SymbolSearchResponse } from '../../types/diff';

import {
  fetchLibrarySource,
  fetchSymbol,
  reselect,
  shortRef,
  symbolRequestFromTarget,
} from './symbolPeek';

const refs = { base: 'aaa1111', target: 'bbb2222' };

function wordIn(html: string): Element {
  document.body.innerHTML = html;
  const word = document.querySelector('.word-token');
  if (!word) throw new Error('fixture has no word');
  return word;
}

describe('symbolRequestFromTarget', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('looks a name on a deleted line up in the base and anything else in the target', () => {
    expect(
      symbolRequestFromTarget(
        wordIn(
          '<div data-symbol-side="old" data-symbol-path="src/a.ts"><span class="word-token" data-word="parseDiff">parseDiff</span></div>',
        ),
        refs,
      ),
    ).toEqual({ name: 'parseDiff', ref: 'aaa1111', from: 'src/a.ts' });
    expect(
      symbolRequestFromTarget(
        wordIn(
          '<div data-symbol-side="new"><span class="word-token" data-word="parseDiff">parseDiff</span></div>',
        ),
        refs,
      ),
    ).toEqual({ name: 'parseDiff', ref: 'bbb2222' });
  });

  it('uses the ref written on the code it was clicked in', () => {
    expect(
      symbolRequestFromTarget(
        wordIn(
          '<div data-symbol-ref="ccc3333" data-symbol-path="src/b.ts"><span class="word-token" data-word="helper"><b>helper</b></span></div>',
        ).firstElementChild,
        refs,
      ),
    ).toEqual({ name: 'helper', ref: 'ccc3333', from: 'src/b.ts' });
  });

  it.each([
    [
      'a number',
      '<div data-symbol-side="new"><span class="word-token" data-word="200">200</span></div>',
    ],
    [
      'code that is not searchable',
      '<div><span class="word-token" data-word="helper">helper</span></div>',
    ],
  ])('ignores %s', (_label, html) => {
    expect(symbolRequestFromTarget(wordIn(html), refs)).toBeNull();
  });

  it('ignores clicks outside a name', () => {
    document.body.innerHTML = '<div data-symbol-side="new"><span>(</span></div>';
    expect(symbolRequestFromTarget(document.querySelector('span'), refs)).toBeNull();
    expect(symbolRequestFromTarget(null, refs)).toBeNull();
  });

  it('places the name where its text starts, past whitespace inside its token', () => {
    expect(
      symbolRequestFromTarget(
        wordIn(
          '<div data-symbol-ref="ccc3333" data-symbol-path="src/A.java"><table><tbody><tr><td>3</td><td data-symbol-line="3"><span>\t</span><span class="word-token" data-word="helper">\thelper</span></td></tr></tbody></table></div>',
        ),
        refs,
      ),
    ).toEqual({ name: 'helper', ref: 'ccc3333', from: 'src/A.java', line: 3, column: 2 });
  });

  it('looks a diff line up in the ref its section names for that side', () => {
    const section = (side: string, line: number) =>
      `<div data-symbol-old-ref="ccc3333^" data-symbol-old-path="src/Old.java" data-symbol-new-ref="ccc3333"><table><tbody><tr><td data-symbol-side="${side}" data-symbol-path="src/A.java" data-symbol-line="${line}"><span class="word-token" data-word="save">save</span></td></tr></tbody></table></div>`;

    expect(symbolRequestFromTarget(wordIn(section('new', 10)), refs)).toEqual({
      name: 'save',
      ref: 'ccc3333',
      from: 'src/A.java',
      line: 10,
      column: 0,
    });
    expect(symbolRequestFromTarget(wordIn(section('old', 9)), refs)).toEqual({
      name: 'save',
      ref: 'ccc3333^',
      from: 'src/Old.java',
      line: 9,
      column: 0,
    });
  });

  it('uses the ref written on code inside a section that names its own refs', () => {
    expect(
      symbolRequestFromTarget(
        wordIn(
          '<div data-symbol-old-ref="ccc3333^" data-symbol-new-ref="ccc3333"><table><tbody><tr><td data-symbol-ref="ddd4444" data-symbol-path="src/B.java" data-symbol-line="4"><span class="word-token" data-word="save">save</span></td></tr></tbody></table></div>',
        ),
        refs,
      ),
    ).toEqual({ name: 'save', ref: 'ddd4444', from: 'src/B.java', line: 4, column: 0 });
  });

  it('sends no position for code that does not say which line it is', () => {
    expect(
      symbolRequestFromTarget(
        wordIn(
          '<div data-symbol-ref="ccc3333" data-symbol-path="src/A.java" data-symbol-line="0"><span class="word-token" data-word="helper">helper</span></div>',
        ),
        refs,
      ),
    ).toEqual({ name: 'helper', ref: 'ccc3333', from: 'src/A.java' });
  });
});

describe('shortRef', () => {
  it.each([
    ['0123456789abcdef0123456789abcdef01234567', '0123456'],
    ['0123456789abcdef0123456789abcdef01234567^', '0123456^'],
    ['HEAD', 'HEAD'],
    ['abc1234', 'abc1234'],
    [
      'feature/0123456789abcdef0123456789abcdef01234567',
      'feature/0123456789abcdef0123456789abcdef01234567',
    ],
  ])('shows %s as %s', (ref, shown) => {
    expect(shortRef(ref)).toBe(shown);
  });
});

describe('fetchSymbol', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks with the clicked line and column only when both are known', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchSymbol({ name: 'run', ref: 'HEAD', from: 'A.java', line: 4, column: 0 });
    await fetchSymbol({ name: 'run', ref: 'HEAD', from: 'A.java', line: 4 });

    expect(fetchMock.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      '/api/symbol?name=run&ref=HEAD&from=A.java&line=4&column=0',
      '/api/symbol?name=run&ref=HEAD&from=A.java',
    ]);
    vi.unstubAllGlobals();
  });
});

describe('reselect', () => {
  const result = (paths: string[]): SymbolSearchResponse => ({
    name: 'run',
    ref: 'HEAD',
    definitions: [],
    references: paths.map((path) => ({ path, line: 1, text: 'run();' })),
    truncated: false,
    source: 'index',
  });

  it('keeps the same place, or else takes the first item', () => {
    const current = { path: 'B.java', line: 1, text: 'old text' };
    expect(reselect(current, result(['A.java', 'B.java']))).toEqual({
      path: 'B.java',
      line: 1,
      text: 'run();',
    });
    expect(reselect(current, result(['A.java']))).toMatchObject({ path: 'A.java' });
    expect(reselect(current, result([]))).toBeNull();
  });

  it('takes the library declaration first, and keeps a selected place over it', () => {
    const symbol = 'semanticdb maven jdk 8 java/util/Optional#orElse().';
    const withLibrary = { ...result(['A.java']), librarySymbol: symbol };
    const library = { librarySymbol: symbol };

    expect(reselect(null, withLibrary)).toEqual(library);
    expect(reselect(library, withLibrary)).toEqual(library);
    expect(reselect({ path: 'A.java', line: 1, text: 'run();' }, withLibrary)).toMatchObject({
      path: 'A.java',
    });
    expect(reselect({ path: 'Gone.java', line: 1, text: 'run();' }, withLibrary)).toEqual(library);
    expect(reselect(library, result(['A.java']))).toMatchObject({ path: 'A.java' });
  });

  it('keeps an implementation selected, and takes it first when there is no declaration', () => {
    const implementation = { path: 'Impl.java', line: 3, text: 'class Impl {' };
    const answer = { ...result(['A.java']), implementations: [implementation] };
    expect(reselect(implementation, answer)).toEqual(implementation);
    expect(reselect(null, answer)).toEqual(implementation);
  });

  it('takes the declaration only a library holds ahead of the implementations', () => {
    const symbol = 'semanticdb maven jdk 8 java/lang/Runnable#run().';
    const implementation = { path: 'Impl.java', line: 3, text: 'public void run() {' };
    const answer = {
      ...result(['A.java']),
      librarySymbol: symbol,
      implementations: [implementation],
    };
    expect(reselect(null, answer)).toEqual({ librarySymbol: symbol });
    expect(reselect(implementation, answer)).toEqual(implementation);
  });
});

describe('fetchLibrarySource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for the source of the symbol, and fails on an error status', async () => {
    const answer = { found: false, missing: { kind: 'unknown' } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(answer), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchLibrarySource('semanticdb maven . . a/B#')).toEqual(answer);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/library-source?symbol=semanticdb+maven+.+.+a%2FB%23',
      { signal: undefined },
    );
    await expect(fetchLibrarySource('x')).rejects.toThrow();
  });
});
