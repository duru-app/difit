import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiffFile } from '../../types/diff';

import { rangesAroundNewLines, useExpandedLines } from './useExpandedLines';

function createMockDiffFile(): DiffFile {
  return {
    path: 'src/app.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    chunks: [
      {
        header: '@@ -2 +2 @@',
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 1,
        lines: [
          {
            type: 'delete',
            content: 'old changed line',
            oldLineNumber: 2,
          },
          {
            type: 'add',
            content: 'new changed line',
            newLineNumber: 2,
          },
        ],
      },
    ],
  };
}

describe('useExpandedLines', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(global.fetch).mockImplementation((input: string | URL | Request) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, 'http://localhost');
      const ref = url.searchParams.get('ref');

      const contentByRef: Record<string, string> = {
        'base-a': 'base a line 1\nold changed line\n',
        'base-b': 'base b line 1\nold changed line\n',
        target: 'target line 1\nnew changed line\n',
      };
      const body = ref ? contentByRef[ref] : undefined;

      if (!body) {
        return Promise.resolve({
          ok: false,
          statusText: `missing fixture for ${rawUrl}`,
          text: async () => '',
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        text: async () => body,
      } as Response);
    });
  });

  it('clears expanded state and refetches content when the revision changes', async () => {
    const file = createMockDiffFile();
    const { result, rerender } = renderHook(
      ({ baseCommitish, targetCommitish, diffIdentity }) =>
        useExpandedLines({
          baseCommitish,
          targetCommitish,
          diffIdentity,
        }),
      {
        initialProps: {
          baseCommitish: 'base-a',
          targetCommitish: 'target',
          diffIdentity: 'diff-a',
        },
      },
    );

    await act(async () => {
      await result.current.openLines(file, [{ start: 1, end: 1 }]);
    });

    expect(result.current.getMergedChunks(file)[0]?.lines[0]?.content).toBe('base a line 1');

    rerender({
      baseCommitish: 'base-b',
      targetCommitish: 'target',
      diffIdentity: 'diff-b',
    });

    await waitFor(() => {
      expect(result.current.expandedState).toEqual({});
    });

    await act(async () => {
      await result.current.openLines(file, [{ start: 1, end: 1 }]);
    });

    expect(result.current.getMergedChunks(file)[0]?.lines[0]?.content).toBe('base b line 1');
  });

  it('clears expanded state and refetches content when the diff identity changes', async () => {
    const file = createMockDiffFile();
    let baseAContent = 'base a line 1\nold changed line\n';

    vi.mocked(global.fetch).mockImplementation((input: string | URL | Request) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, 'http://localhost');
      const ref = url.searchParams.get('ref');

      const contentByRef: Record<string, string> = {
        'base-a': baseAContent,
        target: 'target line 1\nnew changed line\n',
      };
      const body = ref ? contentByRef[ref] : undefined;

      if (!body) {
        return Promise.resolve({
          ok: false,
          statusText: `missing fixture for ${rawUrl}`,
          text: async () => '',
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        text: async () => body,
      } as Response);
    });

    const { result, rerender } = renderHook(
      ({ diffIdentity }) =>
        useExpandedLines({
          baseCommitish: 'base-a',
          targetCommitish: 'target',
          diffIdentity,
        }),
      {
        initialProps: {
          diffIdentity: 'diff-a',
        },
      },
    );

    await act(async () => {
      await result.current.openLines(file, [{ start: 1, end: 1 }]);
    });

    expect(result.current.getMergedChunks(file)[0]?.lines[0]?.content).toBe('base a line 1');

    baseAContent = 'base a rewritten line 1\nold changed line\n';

    rerender({
      diffIdentity: 'diff-b',
    });

    await waitFor(() => {
      expect(result.current.expandedState).toEqual({});
    });

    await act(async () => {
      await result.current.openLines(file, [{ start: 1, end: 1 }]);
    });

    expect(result.current.getMergedChunks(file)[0]?.lines[0]?.content).toBe(
      'base a rewritten line 1',
    );
  });

  it('does not request unavailable blob data for stdin diffs', async () => {
    const file = createMockDiffFile();
    const { result } = renderHook(() =>
      useExpandedLines({
        baseCommitish: 'stdin',
        targetCommitish: 'stdin',
        diffIdentity: 'stdin-diff',
      }),
    );

    await act(async () => {
      await result.current.prefetchFileContent(file);
      await result.current.openLines(file, [{ start: 1, end: 1 }]);
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.current.expandedState).toEqual({});
  });
});

describe('useExpandedLines change kinds', () => {
  const chunkAt = (line: number, changeKind: 'comment' | 'whitespace' | 'code') => ({
    header: `@@ -${line} +${line} @@`,
    oldStart: line,
    oldLines: 1,
    newStart: line,
    newLines: 1,
    changeKind,
    lines: [
      { type: 'delete' as const, content: `old ${line}`, oldLineNumber: line },
      { type: 'add' as const, content: `new ${line}`, newLineNumber: line },
    ],
  });

  const fileOf = (...chunks: ReturnType<typeof chunkAt>[]): DiffFile => ({
    path: 'src/two.ts',
    status: 'modified',
    additions: chunks.length,
    deletions: chunks.length,
    chunks,
  });

  const renderExpanded = () =>
    renderHook(() => useExpandedLines({ baseCommitish: 'base', targetCommitish: 'target' }));

  beforeEach(() => {
    vi.mocked(global.fetch).mockImplementation(() =>
      Promise.resolve({ ok: true, text: async () => 'old 1\nkept\nold 3\n' } as Response),
    );
  });

  it.each([
    ['whitespace', 'comment'],
    ['code', 'code'],
  ] as const)('merges a comment chunk with a %s chunk into %s', async (second, merged) => {
    const file = fileOf(chunkAt(1, 'comment'), chunkAt(3, second));
    const { result } = renderExpanded();

    expect(result.current.getMergedChunks(file).map((chunk) => chunk.changeKind)).toEqual([
      'comment',
      second,
    ]);

    await act(async () => {
      await result.current.openLines(file, [{ start: 2, end: 2 }]);
    });

    expect(result.current.getMergedChunks(file).map((chunk) => chunk.changeKind)).toEqual([merged]);
  });

  it('records where each original chunk sits among the merged lines', async () => {
    const file = fileOf(chunkAt(1, 'code'), chunkAt(3, 'comment'));
    const { result } = renderExpanded();

    expect(result.current.getMergedChunks(file).map((chunk) => chunk.originalLineRanges)).toEqual([
      [{ originalIndex: 0, start: 0, end: 1, changeKind: 'code' }],
      [{ originalIndex: 1, start: 0, end: 1, changeKind: 'comment' }],
    ]);

    await act(async () => {
      await result.current.openLines(file, [{ start: 2, end: 2 }]);
    });

    const [merged] = result.current.getMergedChunks(file);
    expect(merged?.lines.map((line) => line.content)).toEqual([
      'old 1',
      'new 1',
      'kept',
      'old 3',
      'new 3',
    ]);
    expect(merged?.originalLineRanges).toEqual([
      { originalIndex: 0, start: 0, end: 1, changeKind: 'code' },
      { originalIndex: 1, start: 3, end: 4, changeKind: 'comment' },
    ]);
  });

  it('leaves the lines opened above a lone chunk out of its range', async () => {
    vi.mocked(global.fetch).mockImplementation(() =>
      Promise.resolve({ ok: true, text: async () => 'l1\nl2\nold 3\nl4\nl5\n' } as Response),
    );
    const file = fileOf(chunkAt(3, 'comment'));
    const { result } = renderExpanded();

    await act(async () => {
      await result.current.openLines(file, [{ start: 2, end: 2 }]);
      await result.current.openLines(file, [{ start: 4, end: 4 }]);
    });

    const [merged] = result.current.getMergedChunks(file);
    expect(merged?.lines.map((line) => line.content)).toEqual(['l2', 'old 3', 'new 3', 'l4']);
    expect(merged?.originalLineRanges).toEqual([
      { originalIndex: 0, start: 1, end: 2, changeKind: 'comment' },
    ]);
    expect(merged?.hiddenLinesBefore).toBe(1);
    expect(merged?.hiddenLinesAfter).toBe(1);
  });
});

describe('useExpandedLines lines opened inside a gap', () => {
  const content = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');

  const changeAt = (line: number, newStart: number, added: number) => ({
    header: `@@ -${line} +${newStart},${added} @@`,
    oldStart: line,
    oldLines: 1,
    newStart,
    newLines: added,
    lines: [
      { type: 'delete' as const, content: `old ${line}`, oldLineNumber: line },
      ...Array.from({ length: added }, (_, index) => ({
        type: 'add' as const,
        content: `new ${newStart + index}`,
        newLineNumber: newStart + index,
      })),
    ],
  });

  // Old line 2 becomes new lines 2-4, so every later new line is two past its old line.
  const file: DiffFile = {
    path: 'src/gap.ts',
    status: 'modified',
    additions: 4,
    deletions: 2,
    chunks: [changeAt(2, 2, 3), changeAt(30, 32, 1)],
  };

  const shape = (chunks: ReturnType<ReturnType<typeof useExpandedLines>['getMergedChunks']>) =>
    chunks.map((chunk) => ({
      originalIndices: chunk.originalIndices,
      hiddenLinesBefore: chunk.hiddenLinesBefore,
      hiddenLinesAfter: chunk.hiddenLinesAfter,
      oldLines: chunk.lines.flatMap((line) => line.oldLineNumber ?? []),
    }));

  beforeEach(() => {
    vi.mocked(global.fetch).mockImplementation(() =>
      Promise.resolve({ ok: true, text: async () => `${content}\n` } as Response),
    );
  });

  const renderOpened = async (newLines: number[]) => {
    const hook = renderHook(() =>
      useExpandedLines({ baseCommitish: 'base', targetCommitish: 'target' }),
    );
    await act(async () => {
      await hook.result.current.openLines(file, rangesAroundNewLines(file, newLines, 3));
    });
    return hook;
  };

  it('opens three lines on each side of a hidden new line, mapped to its old line', () => {
    expect(rangesAroundNewLines(file, [17], 3)).toEqual([{ start: 12, end: 18 }]);
    expect(rangesAroundNewLines(file, [6, 30], 3)).toEqual([
      { start: 3, end: 7 },
      { start: 25, end: 29 },
    ]);
    expect(rangesAroundNewLines(file, [1, 3, 32], 3)).toEqual([{ start: 1, end: 1 }]);
    expect(rangesAroundNewLines(file, [40], 3)).toEqual([{ start: 35, end: 41 }]);
    expect(rangesAroundNewLines({ ...file, status: 'added' }, [17], 3)).toEqual([]);
  });

  it('shows the opened lines as their own chunk and keeps the hidden counts around it', async () => {
    const { result } = await renderOpened([17]);
    const merged = result.current.getMergedChunks(file);

    expect(shape(merged)).toEqual([
      { originalIndices: [0], hiddenLinesBefore: 1, hiddenLinesAfter: 0, oldLines: [2] },
      {
        originalIndices: [],
        hiddenLinesBefore: 9,
        hiddenLinesAfter: 0,
        oldLines: [12, 13, 14, 15, 16, 17, 18],
      },
      { originalIndices: [1], hiddenLinesBefore: 11, hiddenLinesAfter: 10, oldLines: [30] },
    ]);
    const band = merged[1];
    expect(band?.lines[0]).toMatchObject({
      type: 'normal',
      content: 'line 12',
      newLineNumber: 14,
      isExpanded: true,
    });
    expect(band).toMatchObject({ oldStart: 12, oldLines: 7, newStart: 14, newLines: 7 });
    expect(band?.originalLineRanges).toEqual([]);
  });

  it('merges later manual expansion with the opened lines', async () => {
    const { result } = await renderOpened([17]);

    await act(async () => {
      await result.current.openLines(file, [{ start: 3, end: 11 }]);
    });
    expect(
      shape(result.current.getMergedChunks(file)).map((chunk) => chunk.hiddenLinesBefore),
    ).toEqual([1, 11]);
    const [first] = result.current.getMergedChunks(file);
    expect(first?.originalLineRanges).toEqual([
      { originalIndex: 0, start: 0, end: 3, changeKind: undefined },
    ]);

    await act(async () => {
      await result.current.openLines(file, [{ start: 19, end: 22 }]);
    });
    expect(
      shape(result.current.getMergedChunks(file)).map((chunk) => chunk.hiddenLinesBefore),
    ).toEqual([1, 7]);

    await act(async () => {
      await result.current.openLines(file, [{ start: 23, end: 29 }]);
    });
    const [whole] = result.current.getMergedChunks(file);
    expect(shape(result.current.getMergedChunks(file))).toEqual([
      {
        originalIndices: [0, 1],
        hiddenLinesBefore: 1,
        hiddenLinesAfter: 10,
        oldLines: Array.from({ length: 29 }, (_, index) => index + 2),
      },
    ]);
    expect(whole?.originalLineRanges.map((range) => [range.start, range.end])).toEqual([
      [0, 3],
      [31, 32],
    ]);
  });

  it('opens lines before the first chunk and after the last one', async () => {
    const tail = await renderOpened([42]);
    expect(shape(tail.result.current.getMergedChunks(file)).slice(1)).toEqual([
      { originalIndices: [1], hiddenLinesBefore: 27, hiddenLinesAfter: 0, oldLines: [30] },
      {
        originalIndices: [],
        hiddenLinesBefore: 6,
        hiddenLinesAfter: 0,
        oldLines: [37, 38, 39, 40],
      },
    ]);

    const lead = await renderOpened([1]);
    expect(shape(lead.result.current.getMergedChunks(file))[0]).toEqual({
      originalIndices: [0],
      hiddenLinesBefore: 0,
      hiddenLinesAfter: 0,
      oldLines: [1, 2],
    });
  });

  it('marks opened lines whose content could not be read', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      statusText: 'Internal Server Error',
      text: async () => '',
    } as Response);
    const file = createMockDiffFile();
    const { result } = renderHook(() =>
      useExpandedLines({ baseCommitish: 'base-a', targetCommitish: 'target' }),
    );

    await act(async () => {
      await result.current.openLines(file, [{ start: 1, end: 1 }]);
    });

    expect(result.current.getMergedChunks(file)[0]?.lines[0]).toMatchObject({
      content: '',
      contentUnread: true,
    });
  });

  it('reads hidden lines without opening them', async () => {
    const { result } = renderHook(() =>
      useExpandedLines({ baseCommitish: 'base-a', targetCommitish: 'target' }),
    );
    const before = result.current.getMergedChunks(file);

    await act(async () => {
      await expect(result.current.readLines(file, 'new', [6, 8])).resolves.toBe(
        'line 6\nline 7\nline 8',
      );
      await expect(result.current.readLines(file, 'old', 6)).resolves.toBe('line 6');
    });

    expect(result.current.getMergedChunks(file)).toEqual(before);
  });

  it('reads nothing when a line of the range is past the end of the file', async () => {
    const { result } = renderHook(() =>
      useExpandedLines({ baseCommitish: 'base-a', targetCommitish: 'target' }),
    );

    await act(async () => {
      await expect(result.current.readLines(file, 'new', [2, 90])).resolves.toBeUndefined();
    });
  });

  it('leaves no mark on opened lines that were read', async () => {
    const file = createMockDiffFile();
    const { result } = renderHook(() =>
      useExpandedLines({ baseCommitish: 'base-a', targetCommitish: 'target' }),
    );

    await act(async () => {
      await result.current.openLines(file, [{ start: 1, end: 1 }]);
    });

    expect(result.current.getMergedChunks(file)[0]?.lines[0]).not.toHaveProperty('contentUnread');
  });

  it('does nothing for lines that are already open', async () => {
    const { result } = await renderOpened([17]);
    const fetches = vi.mocked(global.fetch).mock.calls.length;
    const updatedAt = result.current.lastUpdatedAt;

    await act(async () => {
      await result.current.openLines(file, [{ start: 13, end: 15 }]);
    });

    expect(vi.mocked(global.fetch).mock.calls.length).toBe(fetches);
    expect(result.current.lastUpdatedAt).toBe(updatedAt);
  });
});
