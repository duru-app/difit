import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, type ComponentProps } from 'react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';

import type { CommentThread, DiffFile, ThreadFixup } from '../../types/diff';
import type { FixupOnlyFiles } from '../utils/fixupSpread';

import { FileList, type FileListHandle } from './FileList';

const createFile = (
  path: string,
  totals: { additions?: number; deletions?: number } = {},
): DiffFile => ({
  path,
  status: 'modified',
  additions: totals.additions ?? 1,
  deletions: totals.deletions ?? 1,
  chunks: [],
});

const createThread = (id: string, file: string): CommentThread => ({
  id,
  file,
  line: 1,
  side: 'new',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  messages: [],
});

function getTreeRow(title: string): HTMLElement {
  const row = screen.getByTitle(title).closest<HTMLElement>('[data-tree-row="true"]');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

function getLabel(title: string): HTMLElement {
  return screen.getByTitle(title);
}

describe('FileList', () => {
  it('marks the file of the picked comment apart from the cursor', () => {
    render(
      <FileList
        files={[createFile('a.ts'), createFile('b.ts')]}
        onScrollToFile={vi.fn()}
        comments={[]}
        resolvedThreadIds={new Set()}
        reviewedFiles={new Set()}
        onToggleReviewed={vi.fn()}
        onToggleFolderReviewed={vi.fn()}
        selectedFileIndex={0}
        pickedCommentFilePath="b.ts"
      />,
    );

    expect(getTreeRow('b.ts')).toHaveAttribute('data-picked-comment', 'true');
    expect(getTreeRow('b.ts')).not.toHaveAttribute('aria-current');
    expect(getTreeRow('a.ts')).not.toHaveAttribute('data-picked-comment');
  });

  it('renders total additions and deletions beside the file count', () => {
    render(
      <FileList
        files={[
          createFile('README.md', { additions: 3, deletions: 1 }),
          createFile('src/client/App.tsx', { additions: 2, deletions: 4 }),
        ]}
        onScrollToFile={vi.fn()}
        comments={[]}
        resolvedThreadIds={new Set()}
        reviewedFiles={new Set()}
        onToggleReviewed={vi.fn()}
        onToggleFolderReviewed={vi.fn()}
        selectedFileIndex={null}
      />,
    );

    expect(screen.getByText('Files changed (2)')).toBeInTheDocument();
    expect(screen.getByLabelText('5 additions and 5 deletions')).toBeInTheDocument();
    expect(screen.getByText('+5')).toBeInTheDocument();
    expect(screen.getByText('-5')).toBeInTheDocument();
  });

  it('strikes through directories when all descendant files are reviewed', () => {
    const files = [
      createFile('src/cli/index.ts'),
      createFile('src/client/App.tsx'),
      createFile('README.md'),
    ];
    const props = {
      files,
      onScrollToFile: vi.fn(),
      comments: [],
      resolvedThreadIds: new Set<string>(),
      onToggleReviewed: vi.fn(),
      onToggleFolderReviewed: vi.fn(),
      selectedFileIndex: null,
    };
    const { rerender } = render(
      <FileList {...props} reviewedFiles={new Set(['README.md', 'src/cli/index.ts'])} />,
    );

    expect(getLabel('src')).not.toHaveClass('line-through');
    expect(getTreeRow('src')).not.toHaveClass('opacity-70');
    expect(getLabel('cli')).toHaveClass('line-through');
    expect(getTreeRow('cli')).toHaveClass('opacity-70');
    expect(getLabel('client')).not.toHaveClass('line-through');
    expect(getTreeRow('client')).not.toHaveClass('opacity-70');

    rerender(
      <FileList
        {...props}
        reviewedFiles={new Set(['README.md', 'src/cli/index.ts', 'src/client/App.tsx'])}
      />,
    );

    expect(getLabel('src')).toHaveClass('line-through');
    expect(getTreeRow('src')).toHaveClass('opacity-70');
    expect(getLabel('cli')).toHaveClass('line-through');
    expect(getTreeRow('cli')).toHaveClass('opacity-70');
    expect(getLabel('client')).toHaveClass('line-through');
    expect(getTreeRow('client')).toHaveClass('opacity-70');
  });

  it('marks all files in a folder as reviewed via the directory checkbox', () => {
    const onToggleFolderReviewed = vi.fn();
    render(
      <FileList
        files={[
          createFile('src/cli/index.ts'),
          createFile('src/client/App.tsx'),
          createFile('README.md'),
        ]}
        onScrollToFile={vi.fn()}
        comments={[]}
        resolvedThreadIds={new Set()}
        reviewedFiles={new Set()}
        onToggleReviewed={vi.fn()}
        onToggleFolderReviewed={onToggleFolderReviewed}
        selectedFileIndex={null}
      />,
    );

    const checkbox = within(getTreeRow('src')).getByRole('checkbox');
    expect(checkbox).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(checkbox);
    expect(onToggleFolderReviewed).toHaveBeenCalledWith('src', true);
  });

  it('renders both a file row and directory children when a path is both a file and a directory prefix', () => {
    const onScrollToFile = vi.fn();
    render(
      <FileList
        files={[
          { ...createFile('vendor'), status: 'deleted' },
          createFile('vendor/lib.ts'),
          createFile('vendor/utils.ts'),
        ]}
        onScrollToFile={onScrollToFile}
        comments={[]}
        resolvedThreadIds={new Set()}
        reviewedFiles={new Set()}
        onToggleReviewed={vi.fn()}
        onToggleFolderReviewed={vi.fn()}
        selectedFileIndex={null}
      />,
    );

    expect(screen.getByTitle('vendor/lib.ts')).toBeInTheDocument();
    expect(screen.getByTitle('vendor/utils.ts')).toBeInTheDocument();

    const vendorElements = screen.getAllByTitle('vendor');
    const vendorFileRow = vendorElements
      .map((el) => el.closest('[data-file-row="true"]'))
      .find(Boolean);
    expect(vendorFileRow).toBeDefined();
    fireEvent.click(vendorFileRow!);
    expect(onScrollToFile).toHaveBeenCalledWith('vendor');
  });

  it('unmarks all files in a fully reviewed folder via the directory checkbox', () => {
    const onToggleFolderReviewed = vi.fn();
    render(
      <FileList
        files={[createFile('src/cli/index.ts'), createFile('src/client/App.tsx')]}
        onScrollToFile={vi.fn()}
        comments={[]}
        resolvedThreadIds={new Set()}
        reviewedFiles={new Set(['src/cli/index.ts', 'src/client/App.tsx'])}
        onToggleReviewed={vi.fn()}
        onToggleFolderReviewed={onToggleFolderReviewed}
        selectedFileIndex={null}
      />,
    );

    const checkbox = within(getTreeRow('src')).getByRole('checkbox');
    expect(checkbox).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(checkbox);
    expect(onToggleFolderReviewed).toHaveBeenCalledWith('src', false);
  });

  it('counts only the threads not shown as resolved', () => {
    render(
      <FileList
        files={[createFile('README.md'), createFile('calc.js')]}
        onScrollToFile={vi.fn()}
        comments={[
          createThread('a', 'README.md'),
          createThread('b', 'calc.js'),
          createThread('c', 'calc.js'),
          createThread('d', 'calc.js'),
        ]}
        resolvedThreadIds={new Set(['a', 'b'])}
        reviewedFiles={new Set()}
        onToggleReviewed={vi.fn()}
        onToggleFolderReviewed={vi.fn()}
        selectedFileIndex={null}
      />,
    );

    expect(getTreeRow('README.md')).toHaveTextContent(/^README\.md$/);
    expect(getTreeRow('calc.js')).toHaveTextContent(/^calc\.js2$/);
  });
  describe('file at the top of the diff', () => {
    const baseProps = {
      onScrollToFile: vi.fn(),
      comments: [],
      resolvedThreadIds: new Set<string>(),
      reviewedFiles: new Set<string>(),
      onToggleReviewed: vi.fn(),
      onToggleFolderReviewed: vi.fn(),
    };

    function stubBox(element: HTMLElement, top: number, height: number) {
      element.getBoundingClientRect = () =>
        ({ top, bottom: top + height, left: 0, right: 0, width: 0, height }) as DOMRect;
    }

    function stubListViewport(scrollTop: number) {
      const list = document
        .querySelector<HTMLElement>('[data-tree-row="true"]')!
        .closest<HTMLElement>('.overflow-y-auto')!;
      stubBox(list, 100, 200);
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
      list.scrollTop = scrollTop;
      return list;
    }

    it('marks the file at the top apart from the cursor file', () => {
      render(
        <FileList
          {...baseProps}
          files={[createFile('README.md'), createFile('calc.js')]}
          selectedFileIndex={0}
          scrollVisibleFileIndex={1}
        />,
      );

      const cursorRow = getTreeRow('README.md');
      const visibleRow = getTreeRow('calc.js');
      expect(cursorRow).toHaveAttribute('aria-current', 'true');
      expect(cursorRow).toHaveClass('bg-github-bg-tertiary');
      expect(cursorRow).not.toHaveAttribute('data-scroll-visible');
      expect(visibleRow).toHaveAttribute('data-scroll-visible', 'true');
      expect(visibleRow).not.toHaveAttribute('aria-current');
      expect(visibleRow).not.toHaveClass('bg-github-bg-tertiary');
    });

    it('shows both marks on one row when they point at the same file', () => {
      render(
        <FileList
          {...baseProps}
          files={[createFile('README.md'), createFile('calc.js')]}
          selectedFileIndex={1}
          scrollVisibleFileIndex={1}
        />,
      );

      const row = getTreeRow('calc.js');
      expect(row).toHaveAttribute('aria-current', 'true');
      expect(row).toHaveAttribute('data-scroll-visible', 'true');
      expect(getTreeRow('README.md')).not.toHaveAttribute('data-scroll-visible');
    });

    const flatFiles = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'].map((path) =>
      createFile(path),
    );

    it('scrolls the list down until the marked row fits', () => {
      const { rerender } = render(
        <FileList {...baseProps} files={flatFiles} selectedFileIndex={null} />,
      );
      const list = stubListViewport(0);
      stubBox(getTreeRow('f.ts'), 500, 36);

      rerender(
        <FileList
          {...baseProps}
          files={flatFiles}
          selectedFileIndex={null}
          scrollVisibleFileIndex={5}
        />,
      );

      expect(list.scrollTop).toBe(236);
    });

    it('leaves the list alone when the marked row is already in view', () => {
      const { rerender } = render(
        <FileList {...baseProps} files={flatFiles} selectedFileIndex={null} />,
      );
      const list = stubListViewport(40);
      stubBox(getTreeRow('c.ts'), 150, 36);

      rerender(
        <FileList
          {...baseProps}
          files={flatFiles}
          selectedFileIndex={null}
          scrollVisibleFileIndex={2}
        />,
      );

      expect(list.scrollTop).toBe(40);
    });

    it('scrolls up so a nested row clears the sticky folder headers', () => {
      const nestedFiles = [createFile('src/a.ts'), createFile('src/b.ts'), createFile('src/c.ts')];
      const { rerender } = render(
        <FileList {...baseProps} files={nestedFiles} selectedFileIndex={null} />,
      );
      const list = stubListViewport(300);
      stubBox(getTreeRow('src'), 100, 36);
      stubBox(getTreeRow('src/b.ts'), 110, 36);

      rerender(
        <FileList
          {...baseProps}
          files={nestedFiles}
          selectedFileIndex={null}
          scrollVisibleFileIndex={1}
        />,
      );

      expect(list.scrollTop).toBe(274);
    });

    it('does not scroll the list while the filter is typed', () => {
      const { rerender } = render(
        <FileList {...baseProps} files={flatFiles} selectedFileIndex={null} />,
      );
      const list = stubListViewport(0);
      stubBox(getTreeRow('f.ts'), 500, 36);
      rerender(
        <FileList
          {...baseProps}
          files={flatFiles}
          selectedFileIndex={null}
          scrollVisibleFileIndex={5}
        />,
      );
      list.scrollTop = 0;

      fireEvent.change(screen.getByPlaceholderText('Filter files...'), {
        target: { value: '.ts' },
      });

      expect(list.scrollTop).toBe(0);
    });

    it('does not scroll the list when the same files arrive as a new array', () => {
      const { rerender } = render(
        <FileList {...baseProps} files={flatFiles} selectedFileIndex={null} />,
      );
      const list = stubListViewport(0);
      stubBox(getTreeRow('f.ts'), 500, 36);
      rerender(
        <FileList
          {...baseProps}
          files={flatFiles}
          selectedFileIndex={null}
          scrollVisibleFileIndex={5}
        />,
      );
      list.scrollTop = 0;

      rerender(
        <FileList
          {...baseProps}
          files={flatFiles.map((file) => ({ ...file }))}
          selectedFileIndex={null}
          scrollVisibleFileIndex={5}
        />,
      );

      expect(list.scrollTop).toBe(0);
    });
  });
});

describe('FileList unviewed filter', () => {
  const files = [
    createFile('README.md'),
    createFile('docs/guide.md'),
    createFile('src/a.ts'),
    createFile('src/b.ts'),
  ];
  const renderList = (
    reviewedFiles: Set<string>,
    extra: Partial<ComponentProps<typeof FileList>> = {},
  ) => {
    const props = {
      files,
      onScrollToFile: vi.fn(),
      comments: [],
      resolvedThreadIds: new Set<string>(),
      onToggleReviewed: vi.fn(),
      onToggleFolderReviewed: vi.fn(),
      selectedFileIndex: null,
      ...extra,
    };
    const view = render(<FileList {...props} reviewedFiles={reviewedFiles} />);
    return {
      rerender: (next: Set<string>) => view.rerender(<FileList {...props} reviewedFiles={next} />),
    };
  };
  const toggle = () =>
    screen.getByRole('button', { name: /확인 안 한 파일만 보기|전체 파일 보기/ });

  it('shows only the files not viewed, with the count left, and the whole list again when off', () => {
    renderList(new Set(['README.md', 'docs/guide.md', 'src/a.ts']));

    fireEvent.click(toggle());

    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: '미확인 파일 (1 / 4)' })).toBeInTheDocument();
    expect(screen.getByTitle('src/b.ts')).toBeInTheDocument();
    expect(screen.queryByTitle('src/a.ts')).not.toBeInTheDocument();
    expect(screen.queryByTitle('README.md')).not.toBeInTheDocument();
    expect(screen.queryByText('docs')).not.toBeInTheDocument();

    fireEvent.click(toggle());

    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('heading', { name: 'Files changed (4)' })).toBeInTheDocument();
    expect(screen.getByTitle('README.md')).toBeInTheDocument();
    expect(screen.getByTitle('src/a.ts')).toBeInTheDocument();
  });

  it('applies the file filter to the files not viewed', () => {
    renderList(new Set(['src/a.ts']));
    fireEvent.click(toggle());

    fireEvent.change(screen.getByPlaceholderText('Filter files...'), { target: { value: 'src' } });

    expect(screen.getByTitle('src/b.ts')).toBeInTheDocument();
    expect(screen.queryByTitle('src/a.ts')).not.toBeInTheDocument();
    expect(screen.queryByTitle('README.md')).not.toBeInTheDocument();
  });

  it('moves focus to the next row when a focused file is marked viewed from the keyboard', () => {
    const onToggleReviewed = vi.fn();
    const { rerender } = renderList(new Set(), { onToggleReviewed });
    fireEvent.click(toggle());
    const checkbox = within(getTreeRow('src/a.ts')).getByRole('checkbox');
    checkbox.focus();

    fireEvent.keyDown(checkbox, { key: 'Enter' });
    expect(onToggleReviewed).toHaveBeenCalledWith('src/a.ts');
    rerender(new Set(['src/a.ts']));

    expect(document.activeElement).toBe(getTreeRow('src/b.ts'));
  });

  it('says when the file filter leaves no file not viewed', () => {
    renderList(new Set(['src/a.ts']));
    fireEvent.click(toggle());

    fireEvent.change(screen.getByPlaceholderText('Filter files...'), { target: { value: 'zzz' } });

    expect(screen.getByText('조건에 맞는 파일이 없습니다')).toBeInTheDocument();
    expect(screen.queryByText('모든 파일을 확인했습니다')).not.toBeInTheDocument();
  });

  it('says only the files a fixup alone changed are left when every listed file is viewed', () => {
    const fixupFiles: ThreadFixup['files'] = [{ path: 'src/c.ts', status: 'added', chunks: [] }];
    const fixup: ThreadFixup = {
      sha: 'abc1234def5678',
      shortSha: 'abc1234',
      patchId: 'patch',
      authoredAt: '2026-01-02T00:00:00.000Z',
      subject: 'fixup! add a',
      threadIds: [],
      files: fixupFiles,
    };
    renderList(new Set(files.map((file) => file.path)), {
      fixupOnly: [{ fixup, threads: [], files: fixupFiles }],
    });
    fireEvent.click(toggle());

    expect(screen.getByText('fixup에서만 수정한 파일만 남았습니다')).toBeInTheDocument();
    expect(screen.queryByText('모든 파일을 확인했습니다')).not.toBeInTheDocument();
  });

  it('focuses the row that takes the place of a file marked viewed from outside the list', () => {
    const { rerender } = renderList(new Set());
    fireEvent.click(toggle());
    getTreeRow('src/a.ts').focus();

    rerender(new Set(['src/a.ts']));

    expect(document.activeElement).toBe(getTreeRow('src/b.ts'));
  });

  it('focuses the row that takes the place of a folder whose files are all marked viewed', () => {
    const { rerender } = renderList(new Set(['README.md']));
    fireEvent.click(toggle());
    within(getTreeRow('docs')).getByRole('checkbox').focus();

    rerender(new Set(['README.md', 'docs/guide.md']));

    expect(document.activeElement).toBe(getTreeRow('src'));
  });

  it('skips the rows that leave together with the focused one', () => {
    const { rerender } = renderList(new Set(['README.md']));
    fireEvent.click(toggle());
    getTreeRow('docs/guide.md').focus();

    rerender(new Set(['README.md', 'docs/guide.md']));

    expect(document.activeElement).toBe(getTreeRow('src'));
  });

  it('focuses the row above when the last row is marked viewed', () => {
    const { rerender } = renderList(new Set(['README.md']));
    fireEvent.click(toggle());
    getTreeRow('src/b.ts').focus();

    rerender(new Set(['README.md', 'src/b.ts']));

    expect(document.activeElement).toBe(getTreeRow('src/a.ts'));
  });

  it('focuses the row that comes back where the focused one was', () => {
    const { rerender } = renderList(new Set(['README.md', 'src/a.ts']));
    fireEvent.click(toggle());
    getTreeRow('src/b.ts').focus();

    rerender(new Set(['README.md', 'src/b.ts']));

    expect(document.activeElement).toBe(getTreeRow('src/a.ts'));
  });

  it('focuses the nearest row above when the last folder leaves with the focused file', () => {
    const { rerender } = renderList(new Set(['README.md']));
    fireEvent.click(toggle());
    getTreeRow('src/b.ts').focus();

    rerender(new Set(['README.md', 'src/a.ts', 'src/b.ts']));

    expect(document.activeElement).toBe(getTreeRow('docs/guide.md'));
  });

  it('focuses the first row when no row around the focused one is left', () => {
    const { rerender } = renderList(new Set(['README.md', 'docs/guide.md']));
    fireEvent.click(toggle());
    getTreeRow('src/a.ts').focus();

    rerender(new Set(['README.md', 'src/a.ts', 'src/b.ts']));

    expect(document.activeElement).toBe(getTreeRow('docs'));
  });

  it('says when the file filter leaves no file, also with the unviewed filter off', () => {
    renderList(new Set());

    fireEvent.change(screen.getByPlaceholderText('Filter files...'), { target: { value: 'zzz' } });

    expect(screen.getByText('조건에 맞는 파일이 없습니다')).toBeInTheDocument();
  });

  it('drops a file once it is marked viewed and says when none are left', () => {
    const { rerender } = renderList(new Set(['README.md', 'docs/guide.md', 'src/a.ts']));
    fireEvent.click(toggle());
    expect(screen.queryByText('모든 파일을 확인했습니다')).not.toBeInTheDocument();

    rerender(new Set(files.map((file) => file.path)));

    expect(screen.queryByTitle('src/b.ts')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '미확인 파일 (0 / 4)' })).toBeInTheDocument();
    expect(screen.getByText('모든 파일을 확인했습니다')).toBeInTheDocument();
  });
});

describe('FileList keys', () => {
  const files = [createFile('src/a.ts'), createFile('src/b.ts'), createFile('README.md')];
  const documentKeys: string[] = [];
  const recordKey = (event: KeyboardEvent) => documentKeys.push(event.key);

  beforeEach(() => {
    documentKeys.length = 0;
    document.addEventListener('keydown', recordKey);
  });

  afterEach(() => {
    document.removeEventListener('keydown', recordKey);
  });

  const renderList = (props: Partial<ComponentProps<typeof FileList>> = {}) => {
    const ref = createRef<FileListHandle>();
    const onScrollToFile = vi.fn();
    render(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <FileList
          ref={ref}
          files={files}
          onScrollToFile={onScrollToFile}
          comments={[]}
          resolvedThreadIds={new Set()}
          reviewedFiles={new Set()}
          onToggleReviewed={vi.fn()}
          onToggleFolderReviewed={vi.fn()}
          selectedFileIndex={null}
          {...props}
        />
      </HotkeysProvider>,
    );
    return { ref, onScrollToFile };
  };

  const renderFocused = (props: Partial<ComponentProps<typeof FileList>> = {}) => {
    const rendered = renderList(props);
    act(() => rendered.ref.current!.focus());
    return rendered;
  };

  it('moves between folders and files with j and k, and keeps those keys from the diff', async () => {
    const user = userEvent.setup();
    renderFocused();

    expect(getTreeRow('src')).toHaveFocus();
    await user.keyboard('k');
    expect(getTreeRow('src')).toHaveFocus();
    await user.keyboard('j');
    expect(getTreeRow('src/a.ts')).toHaveFocus();
    await user.keyboard('jj');
    expect(getTreeRow('README.md')).toHaveFocus();
    await user.keyboard('j');
    expect(getTreeRow('README.md')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(getTreeRow('src/b.ts')).toHaveFocus();

    expect(documentKeys).not.toContain('j');
    expect(documentKeys).not.toContain('k');
    expect(documentKeys).not.toContain('ArrowUp');
  });

  it('moves with the j and k keys while Korean input is on', () => {
    renderFocused();

    fireEvent.keyDown(getTreeRow('src'), { key: 'ㅓ', code: 'KeyJ' });
    expect(getTreeRow('src/a.ts')).toHaveFocus();
    fireEvent.keyDown(getTreeRow('src/a.ts'), { key: 'ㅏ', code: 'KeyK' });
    expect(getTreeRow('src')).toHaveFocus();

    expect(documentKeys).not.toContain('ㅓ');
    expect(documentKeys).not.toContain('ㅏ');
  });

  it('starts from the file the diff is on', () => {
    const { ref } = renderFocused({ selectedFileIndex: 1 });

    expect(getTreeRow('src/b.ts')).toHaveFocus();
    expect(ref.current!.hasFocus()).toBe(true);
  });

  it('goes to the file on Enter and keeps the keys in the list', async () => {
    const user = userEvent.setup();
    const onFileSelected = vi.fn();
    const { onScrollToFile } = renderFocused({ onFileSelected });

    await user.keyboard('j{Enter}');

    expect(onScrollToFile).toHaveBeenCalledWith('src/a.ts');
    expect(onFileSelected).toHaveBeenCalledTimes(1);
    expect(getTreeRow('src/a.ts')).toHaveFocus();
  });

  it('folds and unfolds a folder on Enter', async () => {
    const user = userEvent.setup();
    const { onScrollToFile } = renderFocused();

    await user.keyboard('{Enter}');
    expect(screen.queryByTitle('src/a.ts')).not.toBeInTheDocument();
    expect(getTreeRow('src')).toHaveFocus();
    await user.keyboard('j');
    expect(getTreeRow('README.md')).toHaveFocus();

    await user.keyboard('k{Enter}');
    expect(screen.getByTitle('src/a.ts')).toBeInTheDocument();
    expect(onScrollToFile).not.toHaveBeenCalled();
  });

  it('hands the keys back to the diff on Escape', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    const { ref } = renderFocused({ onEscape });

    await user.keyboard('{Escape}');

    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(ref.current!.hasFocus()).toBe(false);
  });

  it('leaves j and k typed in the filter to the filter', async () => {
    const user = userEvent.setup();
    renderFocused();
    const filter = screen.getByPlaceholderText('Filter files...');

    await user.click(filter);
    await user.keyboard('jk');

    expect(filter).toHaveValue('jk');
    expect(filter).toHaveFocus();
  });

  it('leaves j and k to the diff after a file row is clicked', async () => {
    const user = userEvent.setup();
    const { ref, onScrollToFile } = renderList();

    await user.click(getTreeRow('src/b.ts'));
    await user.keyboard('j');

    expect(onScrollToFile).toHaveBeenCalledWith('src/b.ts');
    expect(ref.current!.hasFocus()).toBe(false);
    expect(documentKeys).toContain('j');
  });

  it('leaves j and k to the diff after a folder row or the collapse-all button is clicked', async () => {
    const user = userEvent.setup();
    const { ref } = renderList();

    await user.click(getTreeRow('src'));
    expect(ref.current!.hasFocus()).toBe(false);
    await user.click(screen.getByTitle(/(Collapse|Expand) all/));
    expect(ref.current!.hasFocus()).toBe(false);
    await user.keyboard('j');

    expect(documentKeys).toContain('j');
  });

  it('keeps the keys in the list when a row is clicked while the list holds them', async () => {
    const user = userEvent.setup();
    renderFocused();

    await user.click(getTreeRow('README.md'));
    expect(getTreeRow('README.md')).toHaveFocus();
    await user.click(screen.getByTitle(/(Collapse|Expand) all/));
    expect(getTreeRow('README.md')).toHaveFocus();
    await user.keyboard('k');

    expect(getTreeRow('src')).toHaveFocus();
    expect(documentKeys).not.toContain('k');
  });

  it('lets a key with Shift held through to the page', async () => {
    const user = userEvent.setup();
    renderFocused();

    await user.keyboard('{Shift>}B{/Shift}');

    expect(documentKeys).toContain('B');
    expect(getTreeRow('src')).toHaveFocus();
  });
});

describe('FileList fixups', () => {
  const fixupFiles: ThreadFixup['files'] = [
    { path: 'src/a.test.ts', status: 'added', chunks: [] },
    { path: 'pnpm-lock.yaml', status: 'modified', isGenerated: true, chunks: [] },
    { path: 'src/old.ts', status: 'deleted', chunks: [] },
  ];
  const fixup: ThreadFixup = {
    sha: 'abc1234def5678',
    shortSha: 'abc1234',
    patchId: 'patch',
    authoredAt: '2026-01-02T00:00:00.000Z',
    subject: 'fixup! add a',
    threadIds: ['t1'],
    files: fixupFiles,
  };
  const fixupOnly: FixupOnlyFiles[] = [
    { fixup, threads: [{ id: 't1', file: 'src/a.ts', line: 3 }], files: fixupFiles },
  ];
  const touched = new Map([
    ['src/a.ts', { fixupSha: fixup.sha, path: 'src/a.ts' }],
    ['src/b.ts', { fixupSha: fixup.sha, path: 'src/b.ts' }],
  ]);

  const renderList = (props: Partial<ComponentProps<typeof FileList>> = {}) => {
    const ref = createRef<FileListHandle>();
    const onScrollToFile = vi.fn();
    const onRevealFixupFile = vi.fn();
    const onFileSelected = vi.fn();
    const view = render(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <FileList
          ref={ref}
          files={[createFile('src/a.ts'), createFile('src/b.ts'), createFile('README.md')]}
          onScrollToFile={onScrollToFile}
          onFileSelected={onFileSelected}
          comments={[createThread('t1', 'src/a.ts')]}
          resolvedThreadIds={new Set()}
          reviewedFiles={new Set()}
          onToggleReviewed={vi.fn()}
          onToggleFolderReviewed={vi.fn()}
          selectedFileIndex={null}
          fixupTouchedFiles={touched}
          fixupOnly={fixupOnly}
          onRevealFixupFile={onRevealFixupFile}
          {...props}
        />
      </HotkeysProvider>,
    );
    return { ...view, ref, onScrollToFile, onRevealFixupFile, onFileSelected };
  };

  const group = () => screen.getByRole('region', { name: 'fixup abc1234에서만 수정한 파일' });

  it('marks every reviewed file a fixup touched, the commented one included', () => {
    renderList();

    expect(
      within(getTreeRow('src/a.ts')).getByRole('button', { name: 'fixup 수정' }),
    ).toBeVisible();
    expect(getTreeRow('src/a.ts')).toHaveTextContent(/^a\.tsfixup 수정1$/);
    expect(
      within(getTreeRow('src/b.ts')).getByRole('button', { name: 'fixup 수정' }),
    ).toBeVisible();
    expect(within(getTreeRow('README.md')).queryByRole('button')).toBeNull();
  });

  it('dims a file a fixup brought back to the review base and marks it with that fixup', async () => {
    const user = userEvent.setup();
    const { onRevealFixupFile } = renderList({
      fixupRevertedFiles: new Map([['src/b.ts', { fixupSha: 'f2f2f2f2', path: 'src/b.ts' }]]),
    });

    const row = getTreeRow('src/b.ts');
    expect(within(row).queryByRole('button', { name: 'fixup 수정' })).toBeNull();
    const name = within(row).getByText('b.ts');
    expect(name).toHaveClass('text-github-text-muted');
    expect(name).not.toHaveClass('line-through');
    await user.click(within(row).getByRole('button', { name: 'fixup 되돌림' }));
    expect(onRevealFixupFile).toHaveBeenCalledWith('f2f2f2f2', 'src/b.ts');
    expect(
      within(getTreeRow('src/a.ts')).queryByRole('button', { name: 'fixup 되돌림' }),
    ).toBeNull();
  });

  it('reveals the fixup file from the marker instead of going to the file', async () => {
    const user = userEvent.setup();
    const { onRevealFixupFile, onScrollToFile, onFileSelected } = renderList();

    await user.click(within(getTreeRow('src/b.ts')).getByRole('button', { name: 'fixup 수정' }));

    expect(onRevealFixupFile).toHaveBeenCalledWith(fixup.sha, 'src/b.ts');
    expect(onScrollToFile).not.toHaveBeenCalled();
    expect(onFileSelected).toHaveBeenCalledTimes(1);
  });

  it('lists the files only the fixup changed below the tree, outside the file count', () => {
    renderList();

    expect(screen.getByText('Files changed (3)')).toBeInTheDocument();
    expect(
      within(group()).getByRole('heading', { name: 'fixup abc1234에서만 수정한 파일 (3)' }),
    ).toBeVisible();
    const rows = within(group()).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      'src/a.test.ts새 파일',
      'pnpm-lock.yaml생성된 파일',
      'src/old.ts지운 파일',
    ]);
    expect(rows[0]).toHaveAccessibleName(/^src\/a\.test\.ts\s*새 파일$/);
    expect(rows[1]).toHaveAccessibleName(/^pnpm-lock\.yaml\s*생성된 파일$/);
    expect(rows[2]).toHaveAccessibleName(/^src\/old\.ts\s*지운 파일$/);
    for (const row of rows) expect(row.closest('[data-tree-row="true"]')).toBeNull();
  });

  it('reveals a file of the group and marks the focused one', async () => {
    const user = userEvent.setup();
    const { onRevealFixupFile, onFileSelected, rerender } = renderList();

    await user.click(within(group()).getByRole('button', { name: /pnpm-lock\.yaml/ }));

    expect(onRevealFixupFile).toHaveBeenCalledWith(fixup.sha, 'pnpm-lock.yaml');
    expect(onFileSelected).toHaveBeenCalledTimes(1);

    rerender(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <FileList
          files={[createFile('src/a.ts')]}
          onScrollToFile={vi.fn()}
          comments={[]}
          resolvedThreadIds={new Set()}
          reviewedFiles={new Set()}
          onToggleReviewed={vi.fn()}
          onToggleFolderReviewed={vi.fn()}
          selectedFileIndex={null}
          fixupOnly={fixupOnly}
          focusedFixupFile={{ fixupSha: fixup.sha, path: 'pnpm-lock.yaml' }}
        />
      </HotkeysProvider>,
    );

    expect(within(group()).getByRole('button', { name: /pnpm-lock\.yaml/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(within(group()).getByRole('button', { name: /src\/a\.test\.ts/ })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('filters the group with the file filter and drops it when nothing matches', async () => {
    const user = userEvent.setup();
    renderList();

    await user.type(screen.getByPlaceholderText('Filter files...'), 'test');
    const rows = within(group()).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual(['src/a.test.ts새 파일']);
    expect(rows[0]).toHaveAccessibleName(/^src\/a\.test\.ts\s*새 파일$/);

    await user.clear(screen.getByPlaceholderText('Filter files...'));
    await user.type(screen.getByPlaceholderText('Filter files...'), 'README');
    expect(
      screen.queryByRole('region', { name: 'fixup abc1234에서만 수정한 파일' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the group out of the j and k moves over the review files', async () => {
    const user = userEvent.setup();
    const { ref } = renderList();
    act(() => ref.current!.focus());

    await user.keyboard('jjjj');

    expect(getTreeRow('README.md')).toHaveFocus();
  });

  it('shows no marker and no group without fixups', () => {
    renderList({ fixupTouchedFiles: new Map(), fixupOnly: [] });

    expect(screen.queryByRole('button', { name: 'fixup 수정' })).not.toBeInTheDocument();
    expect(screen.queryByText(/에서만 수정한 파일/)).not.toBeInTheDocument();
  });
});
