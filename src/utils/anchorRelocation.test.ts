import { describe, expect, it } from 'vitest';

import { relocateAnchor } from './anchorRelocation';

const fileLines = (lines: string[], firstLineNumber = 1) =>
  new Map(lines.map((content, index) => [firstLineNumber + index, content]));

describe('relocateAnchor', () => {
  it('keeps the saved line when its content still sits there and nowhere else', () => {
    const lines = fileLines(['const a = 1;', 'const b = 2;', 'const c = 3;']);

    expect(relocateAnchor({ line: 2, content: 'const b = 2;' }, lines)).toEqual({
      kind: 'located',
      line: 2,
    });
  });

  it('moves to the new line number when lines were inserted above', () => {
    const lines = fileLines(['import x;', 'import y;', 'const a = 1;', 'const b = 2;']);

    expect(relocateAnchor({ line: 2, content: 'const b = 2;' }, lines)).toEqual({
      kind: 'located',
      line: 4,
    });
  });

  it('moves a range as a whole and keeps its length', () => {
    const lines = fileLines(['// new', 'function f() {', '  return 1;', '}']);

    expect(
      relocateAnchor(
        { line: { start: 1, end: 3 }, content: 'function f() {\n  return 1;\n}' },
        lines,
      ),
    ).toEqual({ kind: 'located', line: { start: 2, end: 4 } });
  });

  it('keeps a repeated line at its saved number when viewing the anchor commit', () => {
    const lines = fileLines(['if (a) {', '}', 'if (b) {', '}']);

    expect(relocateAnchor({ line: 4, content: '}' }, lines, true)).toEqual({
      kind: 'located',
      line: 4,
    });
    expect(relocateAnchor({ line: 4, content: '}' }, lines)).toEqual({
      kind: 'stale',
      reason: 'ambiguous',
    });
  });

  it('still searches when the anchor commit no longer holds the content at the saved number', () => {
    const lines = fileLines(['const a = 1;', 'const b = 2;']);

    expect(relocateAnchor({ line: 1, content: 'const b = 2;' }, lines, true)).toEqual({
      kind: 'located',
      line: 2,
    });
  });

  it('is stale as missing when the saved content is gone', () => {
    const lines = fileLines(['const a = 1;', 'const b = 20;']);

    expect(relocateAnchor({ line: 2, content: 'const b = 2;' }, lines)).toEqual({
      kind: 'stale',
      reason: 'missing',
    });
  });

  it('is stale as ambiguous when the saved content occurs more than once, even at the saved line', () => {
    const lines = fileLines(['}', 'const a = 1;', '}']);

    expect(relocateAnchor({ line: 1, content: '}' }, lines)).toEqual({
      kind: 'stale',
      reason: 'ambiguous',
    });
  });

  it('does not treat a partial range match as a match', () => {
    const lines = fileLines(['function f() {', '  return 2;', '}']);

    expect(
      relocateAnchor(
        { line: { start: 1, end: 3 }, content: 'function f() {\n  return 1;\n}' },
        lines,
      ),
    ).toEqual({ kind: 'stale', reason: 'missing' });
  });

  describe('a range with lines hidden inside it', () => {
    const content = 'first;\nhidden 1;\nhidden 2;\nlast;';
    const shown = (entries: [number, string][]) => new Map(entries);

    it('moves as a whole when its visible lines match', () => {
      const lines = shown([
        [9, 'above;'],
        [10, 'first;'],
        [13, 'last;'],
      ]);

      expect(relocateAnchor({ line: { start: 4, end: 7 }, content }, lines)).toEqual({
        kind: 'located',
        line: { start: 10, end: 13 },
      });
    });

    it('is stale as missing when a visible line inside it differs', () => {
      const lines = shown([
        [4, 'first;'],
        [5, 'changed;'],
        [7, 'last;'],
      ]);

      expect(relocateAnchor({ line: { start: 4, end: 7 }, content }, lines)).toEqual({
        kind: 'stale',
        reason: 'missing',
      });
    });

    it.each([
      ['first', [[7, 'last;']]],
      ['last', [[4, 'first;']]],
    ] as const)('is stale as missing when its %s line is hidden too', (_, entries) => {
      const lines = shown(entries.map(([line, text]) => [line, text]));

      expect(relocateAnchor({ line: { start: 4, end: 7 }, content }, lines)).toEqual({
        kind: 'stale',
        reason: 'missing',
      });
    });

    it('is stale as missing when lines were added inside it', () => {
      const lines = shown([
        [4, 'first;'],
        [9, 'last;'],
      ]);

      expect(relocateAnchor({ line: { start: 4, end: 7 }, content }, lines)).toEqual({
        kind: 'stale',
        reason: 'missing',
      });
    });

    it('is stale as ambiguous when its visible lines match in two places', () => {
      const lines = shown([
        [4, 'first;'],
        [7, 'last;'],
        [20, 'first;'],
        [23, 'last;'],
      ]);

      expect(relocateAnchor({ line: { start: 4, end: 7 }, content }, lines)).toEqual({
        kind: 'stale',
        reason: 'ambiguous',
      });
    });
  });

  it('ignores trailing whitespace and CRLF line endings', () => {
    const lines = fileLines(['const a = 1;  ', 'const b = 2;']);

    expect(
      relocateAnchor(
        { line: { start: 1, end: 2 }, content: 'const a = 1;\r\nconst b = 2;' },
        lines,
      ),
    ).toEqual({ kind: 'located', line: { start: 1, end: 2 } });
  });
});
