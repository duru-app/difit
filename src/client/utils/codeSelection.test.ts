import { afterEach, describe, expect, it } from 'vitest';

import { clipToFile, quoteSelection, selectionInCode } from './codeSelection';

function codeTable(lines: Array<[side: 'old' | 'new', lineNumber: number, text: string]>) {
  const table = document.createElement('table');
  for (const [side, lineNumber, text] of lines) {
    const row = table.insertRow();
    const cell = row.insertCell();
    cell.dataset.codeSide = side;
    cell.dataset.codeLine = String(lineNumber);
    const prefix = document.createElement('span');
    prefix.dataset.diffPrefix = '';
    prefix.textContent = side === 'old' ? '-' : '+';
    cell.append(prefix, document.createTextNode(text));
  }
  document.body.append(table);
  return table;
}

const textOf = (table: HTMLTableElement, row: number) => table.rows[row]!.cells[0]!.lastChild!;

afterEach(() => {
  document.body.replaceChildren();
});

describe('selectionInCode', () => {
  it('leaves out a line the selection only touches at its start', () => {
    const table = codeTable([
      ['new', 4, 'alpha();'],
      ['new', 5, 'beta();'],
    ]);
    const range = document.createRange();
    range.setStart(textOf(table, 0), 0);
    range.setEnd(table.rows[1]!.cells[0]!, 0);

    expect(selectionInCode(range, table, 'unified')).toEqual({
      side: 'new',
      lineNumber: 4,
      text: 'alpha();',
    });
  });

  it('counts the lines of a unified selection on the new side when it reaches one', () => {
    const table = codeTable([
      ['old', 7, 'gone();'],
      ['new', 7, 'kept();'],
      ['new', 8, 'next();'],
    ]);
    const range = document.createRange();
    range.setStart(textOf(table, 0), 0);
    range.setEnd(textOf(table, 2), 4);

    expect(selectionInCode(range, table, 'unified')).toEqual({
      side: 'new',
      lineNumber: [7, 8],
      text: 'gone();\nkept();\nnext',
    });
  });

  it('keeps the old side when only deleted lines are picked', () => {
    const table = codeTable([
      ['old', 3, 'one();'],
      ['old', 4, 'two();'],
    ]);
    const range = document.createRange();
    range.setStart(textOf(table, 0), 0);
    range.setEnd(textOf(table, 1), 3);

    expect(selectionInCode(range, table, 'unified')).toEqual({
      side: 'old',
      lineNumber: [3, 4],
      text: 'one();\ntwo',
    });
  });

  it('keeps a split selection in the column it starts in, even past the end of that line', () => {
    const table = document.createElement('table');
    for (const lineNumber of [20, 21, 22]) {
      const row = table.insertRow();
      for (const side of ['old', 'new'] as const) {
        const cell = row.insertCell();
        cell.dataset.codeSide = side;
        cell.dataset.codeLine = String(lineNumber);
        cell.textContent = `${side}${lineNumber}();`;
      }
    }
    document.body.append(table);
    const newText = (row: number) => table.rows[row]!.cells[1]!.firstChild!;
    const range = document.createRange();
    range.setStart(newText(0), 'new20();'.length);
    range.setEnd(newText(2), 3);

    expect(selectionInCode(range, table, 'split')).toEqual({
      side: 'new',
      lineNumber: [21, 22],
      text: 'new21();\nnew',
    });
  });

  it('ignores a selection that leaves the container', () => {
    const table = codeTable([['new', 1, 'only();']]);
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.append(outside);
    const range = document.createRange();
    range.setStart(textOf(table, 0), 0);
    range.setEnd(outside.firstChild!, 4);

    expect(selectionInCode(range, table, 'unified')).toBeNull();
  });

  describe('across two tables of one file', () => {
    function twoSplitTables() {
      const file = document.createElement('div');
      for (const lineNumbers of [
        [4, 5],
        [37, 38],
      ]) {
        const table = document.createElement('table');
        for (const lineNumber of lineNumbers) {
          const row = table.insertRow();
          for (const side of ['old', 'new'] as const) {
            const cell = row.insertCell();
            cell.dataset.codeSide = side;
            cell.dataset.codeLine = String(lineNumber);
            cell.textContent = `${side}${lineNumber};`;
          }
        }
        file.append(table);
      }
      document.body.append(file);
      return file;
    }

    const cellText = (file: Element, side: 'old' | 'new', lineNumber: number) =>
      file.querySelector(`[data-code-side="${side}"][data-code-line="${lineNumber}"]`)!.firstChild!;

    it('counts a unified selection from the first line picked to the last', () => {
      const file = document.createElement('div');
      const hunks = [
        codeTable([
          ['new', 4, 'alpha();'],
          ['new', 5, 'beta();'],
        ]),
        codeTable([
          ['old', 37, 'gone();'],
          ['new', 37, 'kept();'],
          ['new', 38, 'omega();'],
        ]),
      ] as const;
      file.append(...hunks);
      document.body.append(file);
      const range = document.createRange();
      range.setStart(textOf(hunks[0], 0), 0);
      range.setEnd(textOf(hunks[1], 2), 5);

      expect(selectionInCode(range, file, 'unified')).toEqual({
        side: 'new',
        lineNumber: [4, 38],
        text: 'alpha();\nbeta();\n… 31 lines\ngone();\nkept();\nomega',
      });
    });

    it('says one hidden line in the singular', () => {
      const table = codeTable([
        ['new', 4, 'alpha();'],
        ['new', 6, 'gamma();'],
      ]);
      const range = document.createRange();
      range.setStart(textOf(table, 0), 0);
      range.setEnd(textOf(table, 1), 8);

      expect(selectionInCode(range, table, 'unified')).toMatchObject({
        text: 'alpha();\n… 1 line\ngamma();',
      });
    });

    it('counts hidden lines on the old side when only deleted lines are picked', () => {
      const table = codeTable([
        ['old', 4, 'alpha();'],
        ['old', 9, 'omega();'],
      ]);
      const range = document.createRange();
      range.setStart(textOf(table, 0), 0);
      range.setEnd(textOf(table, 1), 8);

      expect(selectionInCode(range, table, 'unified')).toEqual({
        side: 'old',
        lineNumber: [4, 9],
        text: 'alpha();\n… 4 lines\nomega();',
      });
    });

    it.each(['old', 'new'] as const)('keeps a split selection in the %s column', (side) => {
      const file = twoSplitTables();
      const range = document.createRange();
      range.setStart(cellText(file, side, 4), 0);
      range.setEnd(cellText(file, side, 38), 3);

      expect(selectionInCode(range, file, 'split')).toEqual({
        side,
        lineNumber: [4, 38],
        text: `${side}4;\n${side}5;\n… 31 lines\n${side}37;\n${side}`,
      });
    });

    it.each(['old', 'new'] as const)(
      'takes the %s column from the far end of a range starting outside every code cell',
      (side) => {
        const file = twoSplitTables();
        const range = document.createRange();
        range.setStart(file, 1);
        range.setEnd(cellText(file, side, 38), 3);

        expect(selectionInCode(range, file, 'split')).toEqual({
          side,
          lineNumber: [37, 38],
          text: `${side}37;\n${side}`,
        });
      },
    );

    it.each(['old', 'new'] as const)(
      'takes the %s column from the far end of a range starting on a blank cell',
      (side) => {
        const file = twoSplitTables();
        const row = file.querySelector('tr')!;
        const blank = row.insertCell(0);
        blank.textContent = ' ';
        const range = document.createRange();
        range.setStart(blank.firstChild!, 0);
        range.setEnd(cellText(file, side, 37), 3);

        expect(selectionInCode(range, file, 'split')).toMatchObject({
          side,
          lineNumber: [4, 37],
        });
      },
    );

    it('falls back to the first column with text when neither end is in a code cell', () => {
      const file = twoSplitTables();
      const range = document.createRange();
      range.setStart(file, 0);
      range.setEnd(file, 1);

      expect(selectionInCode(range, file, 'split')).toEqual({
        side: 'old',
        lineNumber: [4, 5],
        text: 'old4;\nold5;',
      });
    });

    it('ignores a selection that reaches into another file', () => {
      const first = twoSplitTables();
      const second = twoSplitTables();
      const range = document.createRange();
      range.setStart(cellText(first, 'new', 4), 0);
      range.setEnd(cellText(second, 'new', 4), 3);

      expect(selectionInCode(range, first, 'split')).toBeNull();
      expect(selectionInCode(range, second, 'split')).toBeNull();
    });
  });
});

describe('clipToFile', () => {
  function fileWith(lineNumber: number, text: string) {
    const file = document.createElement('div');
    file.append(codeTable([['new', lineNumber, text]]));
    document.body.append(file);
    return file;
  }

  const emptyArea = () => {
    const area = document.createElement('div');
    area.textContent = 'area';
    document.body.append(area);
    return area;
  };

  it('returns a range inside the file as it is', () => {
    const file = fileWith(4, 'alpha();');
    const range = document.createRange();
    range.selectNodeContents(file);

    expect(clipToFile(range, file)).toBe(range);
  });

  it('ends a range running past the file at the end of the file', () => {
    const file = fileWith(4, 'alpha();');
    const area = emptyArea();
    const range = document.createRange();
    range.setStart(textOf(file.querySelector('table')!, 0), 0);
    range.setEnd(area.firstChild!, 2);

    const clipped = clipToFile(range, file);

    expect(clipped?.commonAncestorContainer).toBe(file);
    expect(selectionInCode(clipped!, file, 'unified')).toMatchObject({
      lineNumber: 4,
      text: 'alpha();',
    });
  });

  it('starts a range running in from above at the start of the file', () => {
    const area = emptyArea();
    const file = fileWith(4, 'alpha();');
    const range = document.createRange();
    range.setStart(area.firstChild!, 2);
    range.setEnd(textOf(file.querySelector('table')!, 0), 5);

    const clipped = clipToFile(range, file);

    expect(clipped?.commonAncestorContainer).toBe(file);
    expect(selectionInCode(clipped!, file, 'unified')).toMatchObject({
      lineNumber: 4,
      text: 'alpha',
    });
  });

  it('leaves out a range reaching the code of another file', () => {
    const file = fileWith(4, 'alpha();');
    const other = fileWith(9, 'omega();');
    const range = document.createRange();
    range.setStart(textOf(file.querySelector('table')!, 0), 0);
    range.setEnd(textOf(other.querySelector('table')!, 0), 3);

    expect(clipToFile(range, file)).toBeNull();
    expect(clipToFile(range, other)).toBeNull();
  });

  it('keeps a range that only touches the start of the next file', () => {
    const file = fileWith(4, 'alpha();');
    const other = fileWith(9, 'omega();');
    const range = document.createRange();
    range.setStart(textOf(file.querySelector('table')!, 0), 0);
    range.setEnd(other.querySelector('[data-code-line]')!, 0);

    expect(clipToFile(range, file)?.commonAncestorContainer).toBe(file);
  });

  it('leaves out a range with both ends outside the file', () => {
    const before = emptyArea();
    const file = fileWith(4, 'alpha();');
    const after = emptyArea();
    const range = document.createRange();
    range.setStart(before.firstChild!, 0);
    range.setEnd(after.firstChild!, 2);

    expect(clipToFile(range, file)).toBeNull();
  });
});

describe('quoteSelection', () => {
  it('quotes every picked line above the comment, blank ones included', () => {
    expect(quoteSelection('if (a) {\n\n}', 'Fold this')).toBe('> if (a) {\n>\n> }\n\nFold this');
  });
});
