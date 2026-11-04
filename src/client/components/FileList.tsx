import {
  ChevronRight,
  ChevronDown,
  FileDiff,
  FolderOpen,
  Folder,
  FilePlus,
  FileX,
  FilePen,
  Search,
  ChevronsDownUp,
  ChevronsUpDown,
  EyeOff,
} from 'lucide-react';
import {
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
} from 'react';
import { useHotkeysContext } from 'react-hotkeys-hook';

import { type DiffFile, type CommentThread } from '../../types/diff';
import {
  combineChangeKinds,
  LEAVES_CODE_ALONE_LABEL,
  LEAVES_CODE_ALONE_TITLE,
  leavesCodeAlone,
} from '../../utils/changeKind';
import { isSafariBrowser } from '../utils/browser';
import {
  type FixupFileRef,
  type FixupOnlyFiles,
  fixupFileLabels,
  fixupFileName,
} from '../utils/fixupSpread';
import { keyByPosition } from '../utils/keyByPosition';

import { Checkbox } from './Checkbox';
import { CommentCount } from './CommentCount';
import { FilePathText } from './FilePathText';

export interface FileListHandle {
  focus: () => void;
  hasFocus: () => boolean;
}

interface FileListProps {
  ref?: Ref<FileListHandle>;
  files: DiffFile[];
  onScrollToFile: (path: string) => void;
  onFileSelected?: () => void;
  comments: CommentThread[];
  resolvedThreadIds: ReadonlySet<string>;
  reviewedFiles: Set<string>;
  onToggleReviewed: (path: string) => void;
  onToggleFolderReviewed: (path: string, reviewed: boolean) => void;
  selectedFileIndex: number | null;
  scrollVisibleFileIndex?: number | null;
  pickedCommentFilePath?: string | null;
  onEscape?: () => void;
  fixupTouchedFiles?: ReadonlyMap<string, FixupFileRef>;
  fixupRevertedFiles?: ReadonlyMap<string, FixupFileRef>;
  fixupOnly?: FixupOnlyFiles[];
  focusedFixupFile?: FixupFileRef | null;
  onRevealFixupFile?: (fixupSha: string, path: string) => void;
}

const NO_FIXUP_TOUCHED_FILES: ReadonlyMap<string, FixupFileRef> = new Map();
const NO_FIXUP_ONLY: FixupOnlyFiles[] = [];

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
  file?: DiffFile;
}

const TREE_ROW_PADDING_LEFT_PX = 16;
const TREE_ICON_SIZE_PX = 16;
const TREE_ROW_GAP_PX = 8;
const TREE_INDENT_STEP_PX = TREE_ICON_SIZE_PX + TREE_ROW_GAP_PX;
const SCROLL_VISIBLE_BAR_CLASS = 'shadow-[inset_3px_0_0_0_var(--color-github-text-secondary)]';
const PICKED_COMMENT_RING_CLASS = 'ring-1 ring-inset ring-blue-500';
const ROW_FOCUS_CLASS = 'focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500';

interface ShownRow {
  key: string;
  path: string;
  isDirectory: boolean;
}

const dirRowKey = (path: string) => `dir:${path}`;
const fileRowKey = (path: string) => `file:${path}`;

function getTreeRowPaddingLeft(depth: number): string {
  return `${depth * TREE_INDENT_STEP_PX + TREE_ROW_PADDING_LEFT_PX}px`;
}

function getAllDirectoryPaths(node: TreeNode): string[] {
  if (!node.isDirectory || !node.children) return [];
  const paths: string[] = [];
  if (node.path) paths.push(node.path);
  node.children.forEach((child) => {
    paths.push(...getAllDirectoryPaths(child));
  });
  return paths;
}

function getReviewedDirectoryPaths(node: TreeNode, reviewedFiles: Set<string>): Set<string> {
  const reviewedDirectoryPaths = new Set<string>();

  const visit = (currentNode: TreeNode): boolean => {
    if (currentNode.file) {
      return reviewedFiles.has(currentNode.file.path);
    }

    if (!currentNode.isDirectory || !currentNode.children || currentNode.children.length === 0) {
      return false;
    }

    const childrenReviewed = currentNode.children.map((child) => visit(child));
    const areAllChildrenReviewed = childrenReviewed.every(Boolean);
    if (areAllChildrenReviewed && currentNode.path) {
      reviewedDirectoryPaths.add(currentNode.path);
    }
    return areAllChildrenReviewed;
  };

  visit(node);
  return reviewedDirectoryPaths;
}

function getShownRows(node: TreeNode, expandedDirs: Set<string>): ShownRow[] {
  const rows: ShownRow[] = [];
  const visit = (current: TreeNode) => {
    if (current.isDirectory && current.children) {
      if (current.name) {
        rows.push({ key: dirRowKey(current.path), path: current.path, isDirectory: true });
        if (!expandedDirs.has(current.path)) return;
      }
      current.children.forEach(visit);
    } else if (current.file) {
      rows.push({
        key: fileRowKey(current.file.path),
        path: current.file.path,
        isDirectory: false,
      });
    }
  };
  visit(node);
  return rows;
}

// scrollIntoView would also scroll the sidebar's overflow-hidden wrapper sideways.
function scrollRowIntoList(container: HTMLElement, row: HTMLElement, hasStickyHeaders: boolean) {
  const containerRect = container.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const rowTop = rowRect.top - containerRect.top;
  const rowBottom = rowRect.bottom - containerRect.top;
  const depth = Number.parseInt(row.dataset.depth || '0', 10);
  const dirHeaderHeight = hasStickyHeaders
    ? (container.querySelector('[data-dir-header="true"]')?.getBoundingClientRect().height ?? 0)
    : 0;
  const stickyHeadersBottom = depth * dirHeaderHeight;

  if (rowTop < stickyHeadersBottom) {
    container.scrollTop += rowTop - stickyHeadersBottom;
  } else if (rowBottom > container.clientHeight) {
    container.scrollTop += rowBottom - container.clientHeight;
  }
}

function buildFileTree(files: DiffFile[]): TreeNode {
  const root: TreeNode = {
    name: '',
    path: '',
    isDirectory: true,
    children: [],
  };

  files.forEach((file) => {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      const isLast = i === parts.length - 1;
      const pathSoFar = parts.slice(0, i + 1).join('/');

      if (!current.children) {
        current.children = [];
      }

      let child = current.children.find((c) => c.name === part && c.isDirectory === !isLast);

      if (!child) {
        child = {
          name: part,
          path: pathSoFar,
          isDirectory: !isLast,
          children: isLast ? undefined : [],
          file: isLast ? file : undefined,
        };
        current.children.push(child);
      }

      current = child;
    }
  });

  // Collapse single child directories
  const collapseDirectories = (node: TreeNode): TreeNode => {
    if (!node.isDirectory || !node.children) {
      return node;
    }

    // First, recursively collapse children
    node.children = node.children.map(collapseDirectories);

    // If this directory has only one child directory (no files), collapse them
    if (node.children.length === 1 && node.children[0]?.isDirectory && node.children[0]?.children) {
      const child = node.children[0];
      if (child) {
        // Don't collapse the root node - keep the full path structure
        if (!node.name) {
          return node;
        }
        return {
          ...node,
          name: `${node.name}/${child.name}`,
          path: child.path,
          children: child.children,
        };
      }
    }

    return node;
  };

  return collapseDirectories(root);
}

export const FileList = memo(function FileList({
  ref,
  files,
  onScrollToFile,
  onFileSelected,
  comments,
  resolvedThreadIds,
  reviewedFiles,
  onToggleReviewed,
  onToggleFolderReviewed,
  selectedFileIndex,
  scrollVisibleFileIndex = null,
  pickedCommentFilePath = null,
  onEscape,
  fixupTouchedFiles = NO_FIXUP_TOUCHED_FILES,
  fixupRevertedFiles = NO_FIXUP_TOUCHED_FILES,
  fixupOnly = NO_FIXUP_ONLY,
  focusedFixupFile = null,
  onRevealFixupFile,
}: FileListProps) {
  const fileTree = useMemo(() => buildFileTree(files), [files]);
  const shouldUseStickyDirectoryHeaders = useMemo(
    () => !isSafariBrowser(typeof navigator === 'undefined' ? '' : navigator.userAgent),
    [],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const dirContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const fileRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const stickyContainerStyle = {
    '--dir-row-height': 'calc(var(--spacing, 0.25rem) * 9)',
  } as CSSProperties;

  // Initialize with all directories expanded
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set(getAllDirectoryPaths(fileTree)),
  );
  const [filterText, setFilterText] = useState('');
  const [onlyUnviewed, setOnlyUnviewed] = useState(false);

  const commentCountMap = useMemo(() => {
    const counts = new Map<string, number>();
    comments.forEach((comment) => {
      if (resolvedThreadIds.has(comment.id)) return;
      counts.set(comment.file, (counts.get(comment.file) ?? 0) + 1);
    });
    return counts;
  }, [comments, resolvedThreadIds]);

  const fileIndexMap = useMemo(() => {
    const indices = new Map<string, number>();
    files.forEach((file, index) => {
      indices.set(file.path, index);
    });
    return indices;
  }, [files]);
  const diffTotals = useMemo(
    () =>
      files.reduce(
        (totals, file) => ({
          additions: totals.additions + file.additions,
          deletions: totals.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  );
  const unviewedCount = useMemo(
    () => files.filter((file) => !reviewedFiles.has(file.path)).length,
    [files, reviewedFiles],
  );
  const reviewedDirectoryPaths = useMemo(
    () => getReviewedDirectoryPaths(fileTree, reviewedFiles),
    [fileTree, reviewedFiles],
  );

  const filteredFileTree = useMemo(() => {
    const normalizedFilter = filterText.trim().toLowerCase();

    const filterTreeNode = (node: TreeNode): TreeNode | null => {
      if (!normalizedFilter && !onlyUnviewed) return node;

      if (node.isDirectory && node.children) {
        const filteredChildren = node.children
          .map((child) => filterTreeNode(child))
          .filter((child) => child !== null);

        if (filteredChildren.length > 0) {
          return { ...node, children: filteredChildren };
        }
        return null;
      } else if (node.file) {
        if (onlyUnviewed && reviewedFiles.has(node.file.path)) return null;
        // Check if file name matches filter
        if (node.file.path.toLowerCase().includes(normalizedFilter)) {
          return node;
        }
        return null;
      }

      return null;
    };

    return (
      filterTreeNode(fileTree) || {
        ...fileTree,
        children: [],
      }
    );
  }, [fileTree, filterText, onlyUnviewed, reviewedFiles]);

  const filteredFixupOnly = useMemo(() => {
    const normalizedFilter = filterText.trim().toLowerCase();
    return fixupOnly
      .map((group) => ({
        ...group,
        files: group.files.filter((file) => file.path.toLowerCase().includes(normalizedFilter)),
      }))
      .filter((group) => group.files.length > 0);
  }, [fixupOnly, filterText]);

  const emptyListMessage = (() => {
    if ((filteredFileTree.children?.length ?? 0) > 0) return null;
    if (onlyUnviewed && unviewedCount === 0) {
      return filteredFixupOnly.length > 0
        ? 'fixup에서만 수정한 파일만 남았습니다'
        : '모든 파일을 확인했습니다';
    }
    if (filteredFixupOnly.length > 0 || (!onlyUnviewed && !filterText.trim())) return null;
    return '조건에 맞는 파일이 없습니다';
  })();

  const revealFixupFile = ({ fixupSha, path }: FixupFileRef) => {
    onRevealFixupFile?.(fixupSha, path);
    onFileSelected?.();
  };

  const scrollVisiblePath =
    scrollVisibleFileIndex === null ? undefined : files[scrollVisibleFileIndex]?.path;
  useEffect(() => {
    const container = scrollContainerRef.current;
    const row =
      scrollVisiblePath === undefined ? undefined : fileRowRefs.current.get(scrollVisiblePath);
    if (!container || !row) return;
    scrollRowIntoList(container, row, shouldUseStickyDirectoryHeaders);
  }, [scrollVisiblePath, shouldUseStickyDirectoryHeaders]);

  const getFileIcon = (status: DiffFile['status']) => {
    switch (status) {
      case 'added':
        return <FilePlus size={16} className="text-github-accent" />;
      case 'deleted':
        return <FileX size={16} className="text-github-danger" />;
      case 'renamed':
        return (
          <FilePen
            size={16}
            className="text-github-warning fixup-review:text-github-text-secondary"
          />
        );
      default:
        return <FileDiff size={16} className="text-github-text-secondary" />;
    }
  };

  const toggleDirectory = (path: string) => {
    setExpandedDirs((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  };

  const { activeScopes } = useHotkeysContext();
  const takesKeys = activeScopes.includes('navigation') || activeScopes.includes('*');
  const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
  const lastActiveIndexRef = useRef(0);
  const shownRows = useMemo(
    () => getShownRows(filteredFileTree, expandedDirs),
    [filteredFileTree, expandedDirs],
  );

  let activeIndex = shownRows.findIndex((row) => row.key === activeRowKey);
  if (activeIndex === -1 && shownRows.length > 0) {
    activeIndex = Math.min(lastActiveIndexRef.current, shownRows.length - 1);
  }
  const activeRow = shownRows[activeIndex];
  useEffect(() => {
    if (activeIndex !== -1) lastActiveIndexRef.current = activeIndex;
  });

  const focusRow = (shownRow: ShownRow | undefined) => {
    const container = scrollContainerRef.current;
    const row = shownRow && rowRefs.current.get(shownRow.key);
    if (!shownRow || !row) {
      container?.focus({ preventScroll: true });
      return;
    }
    setActiveRowKey(shownRow.key);
    row.focus({ preventScroll: true });
    if (container) scrollRowIntoList(container, row, shouldUseStickyDirectoryHeaders);
  };

  // Read during render: once the commit removes the focused row, focus has already left it.
  const committedRowsRef = useRef(shownRows);
  const focusedRowIndex =
    activeRowKey !== null && rowRefs.current.get(activeRowKey)?.contains(document.activeElement)
      ? committedRowsRef.current.findIndex((row) => row.key === activeRowKey)
      : -1;
  useLayoutEffect(() => {
    const oldRows = committedRowsRef.current;
    committedRowsRef.current = shownRows;
    if (focusedRowIndex === -1 || activeRowKey === null || rowRefs.current.has(activeRowKey)) {
      return;
    }
    // Focus goes to the row now below the nearest old row above that is still shown, so rows that
    // left together are skipped; with no such row below, to that row itself.
    const shownIndexOf = new Map(shownRows.map((row, index) => [row.key, index]));
    let aboveIndex = -1;
    for (let index = focusedRowIndex - 1; index >= 0 && aboveIndex === -1; index -= 1) {
      const key = oldRows[index]?.key;
      if (key !== undefined) aboveIndex = shownIndexOf.get(key) ?? -1;
    }
    focusRow(shownRows[aboveIndex + 1] ?? shownRows[aboveIndex]);
  });

  const shownRowOfFile = (fileIndex: number | null) => {
    const path = fileIndex === null ? undefined : files[fileIndex]?.path;
    return path === undefined ? undefined : shownRows.find((row) => row.key === fileRowKey(path));
  };

  useImperativeHandle(ref, () => ({
    focus: () =>
      focusRow(
        shownRowOfFile(selectedFileIndex) ?? shownRowOfFile(scrollVisibleFileIndex) ?? activeRow,
      ),
    hasFocus: () => rootRef.current?.contains(document.activeElement) ?? false,
  }));

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!takesKeys || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLInputElement && event.key !== 'Escape') return;
    switch (keyByPosition(event)) {
      case 'j':
      case 'ArrowDown':
        focusRow(shownRows[Math.min(activeIndex + 1, shownRows.length - 1)]);
        break;
      case 'k':
      case 'ArrowUp':
        focusRow(shownRows[Math.max(activeIndex - 1, 0)]);
        break;
      case 'Enter':
        if (!activeRow || event.target !== rowRefs.current.get(activeRow.key)) return;
        if (activeRow.isDirectory) {
          toggleDirectory(activeRow.path);
        } else {
          onScrollToFile(activeRow.path);
          onFileSelected?.();
        }
        break;
      case 'Escape':
        (document.activeElement as HTMLElement | null)?.blur();
        onEscape?.();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    const rowsHaveKeys = scrollContainerRef.current?.contains(document.activeElement) ?? false;
    if (rowsHaveKeys && scrollContainerRef.current?.contains(event.target as Node)) return;
    event.preventDefault();
    if (!rowsHaveKeys) (document.activeElement as HTMLElement | null)?.blur();
  };

  const rowFocusProps = (key: string) => ({
    tabIndex: key === activeRow?.key ? 0 : -1,
    onFocus: () => setActiveRowKey(key),
  });
  const setRowRef = (key: string, element: HTMLDivElement | null) => {
    if (element) rowRefs.current.set(key, element);
    else rowRefs.current.delete(key);
  };

  const allPaths = useMemo(() => getAllDirectoryPaths(fileTree), [fileTree]);
  const isAllExpanded = expandedDirs.size === allPaths.length && allPaths.length > 0;

  const toggleAllDirectories = () => {
    // If all directories are expanded, collapse all. Otherwise, expand all.
    if (isAllExpanded) {
      setExpandedDirs(new Set());
    } else {
      setExpandedDirs(new Set(allPaths));
    }
  };

  const handleDirectoryClick = (event: MouseEvent<HTMLDivElement>, path: string) => {
    if (!shouldUseStickyDirectoryHeaders) {
      toggleDirectory(path);
      return;
    }

    const container = scrollContainerRef.current;
    const row = event.currentTarget;

    if (!container) {
      toggleDirectory(path);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const topOffset = Number.parseFloat(getComputedStyle(row).top || '0');
    const relativeTop = rowRect.top - containerRect.top;
    const isSticky = relativeTop <= topOffset + 1;

    if (isSticky) {
      const wrapper = dirContainerRefs.current.get(path);
      const firstChild = wrapper?.querySelector<HTMLElement>(
        '[data-tree-row="true"]:not([data-dir-header="true"])',
      );
      const rowHeight = row.getBoundingClientRect().height || 0;
      const target = firstChild ?? row;
      const depthValue = Number.parseInt(target.dataset.depth || row.dataset.depth || '0', 10);
      const stackedOffset = rowHeight * depthValue;
      const targetScrollTop = Math.max(0, target.offsetTop - stackedOffset);

      if (Math.abs(container.scrollTop - targetScrollTop) <= 1) {
        toggleDirectory(path);
        return;
      }

      container.scrollTo({ top: targetScrollTop });
      return;
    }

    toggleDirectory(path);
  };

  const renderTreeNode = (node: TreeNode, depth: number = 0): React.ReactNode => {
    if (node.isDirectory && node.children) {
      const isExpanded = expandedDirs.has(node.path);
      const isReviewed = reviewedDirectoryPaths.has(node.path);

      return (
        <div
          key={node.path}
          data-dir-container={node.path || undefined}
          ref={(el) => {
            if (!node.path) return;
            if (el) {
              dirContainerRefs.current.set(node.path, el);
            } else {
              dirContainerRefs.current.delete(node.path);
            }
          }}
        >
          {node.name && (
            <div
              ref={(el) => setRowRef(dirRowKey(node.path), el)}
              {...rowFocusProps(dirRowKey(node.path))}
              className={`${shouldUseStickyDirectoryHeaders ? 'sticky ' : ''}group flex h-9 items-center gap-2 bg-github-bg-secondary px-4 hover:bg-github-bg-tertiary cursor-pointer ${ROW_FOCUS_CLASS} ${
                isReviewed ? 'opacity-70' : ''
              }`}
              data-dir-header="true"
              data-tree-row="true"
              data-depth={depth}
              style={{
                paddingLeft: getTreeRowPaddingLeft(depth),
                top: shouldUseStickyDirectoryHeaders
                  ? `calc(${depth} * var(--dir-row-height))`
                  : undefined,
                zIndex: shouldUseStickyDirectoryHeaders ? 1000 - depth : undefined,
              }}
              onClick={(event) => handleDirectoryClick(event, node.path)}
            >
              {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span className="flex items-center group-hover:hidden">
                {isExpanded ? (
                  <FolderOpen size={16} className="text-github-text-secondary" />
                ) : (
                  <Folder size={16} className="text-github-text-secondary" />
                )}
              </span>
              <span className="hidden items-center pl-[2px] group-hover:flex">
                <Checkbox
                  checked={isReviewed}
                  onChange={() => {
                    onToggleFolderReviewed(node.path, !isReviewed);
                  }}
                  title={
                    isReviewed ? 'Mark all files as not reviewed' : 'Mark all files as reviewed'
                  }
                  className="z-10"
                />
              </span>
              <span
                className={`text-sm text-github-text-primary font-medium flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${
                  isReviewed ? 'line-through text-github-text-muted' : ''
                }`}
                title={node.name}
              >
                {node.name}
              </span>
            </div>
          )}
          {(isExpanded || !node.name) &&
            node.children.map((child) => renderTreeNode(child, node.name ? depth + 1 : depth))}
        </div>
      );
    } else if (node.file) {
      const file = node.file;
      const commentCount = commentCountMap.get(file.path) ?? 0;
      const isReviewed = reviewedFiles.has(file.path);
      const fileIndex = fileIndexMap.get(file.path) ?? -1;
      const isSelected = selectedFileIndex !== null && selectedFileIndex === fileIndex;
      const isScrollVisible = scrollVisibleFileIndex === fileIndex;
      const isPickedCommentFile = pickedCommentFilePath === file.path;
      const changeKind = combineChangeKinds(file.chunks.map((chunk) => chunk.changeKind));
      const revertedBy = fixupRevertedFiles.get(file.path);
      const fixupRef = revertedBy ?? fixupTouchedFiles.get(file.path);

      return (
        <div
          key={`file:${file.path}`}
          ref={(el) => {
            if (el) {
              fileRowRefs.current.set(file.path, el);
            } else {
              fileRowRefs.current.delete(file.path);
            }
            setRowRef(fileRowKey(file.path), el);
          }}
          {...rowFocusProps(fileRowKey(file.path))}
          className={`flex items-center gap-2 px-4 py-2 hover:bg-github-bg-tertiary cursor-pointer transition-colors ${ROW_FOCUS_CLASS} ${
            isReviewed ? 'opacity-70' : ''
          } ${isSelected ? 'bg-github-bg-tertiary' : ''} ${isScrollVisible ? SCROLL_VISIBLE_BAR_CLASS : ''} ${
            isPickedCommentFile ? PICKED_COMMENT_RING_CLASS : ''
          }`}
          aria-current={isSelected ? 'true' : undefined}
          data-scroll-visible={isScrollVisible ? 'true' : undefined}
          data-picked-comment={isPickedCommentFile ? 'true' : undefined}
          data-file-row="true"
          data-tree-row="true"
          data-depth={depth}
          style={{ paddingLeft: getTreeRowPaddingLeft(depth) }}
          onClick={() => {
            onScrollToFile(file.path);
            onFileSelected?.();
          }}
        >
          <Checkbox
            checked={isReviewed}
            onChange={() => {
              onToggleReviewed(file.path);
            }}
            title={isReviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}
            className="z-10"
          />
          {getFileIcon(node.file.status)}
          <span
            className={`text-sm flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${
              isReviewed ? 'line-through' : ''
            } ${isReviewed || revertedBy ? 'text-github-text-muted' : 'text-github-text-primary'}`}
            title={node.file.path}
          >
            {node.name}
          </span>
          {leavesCodeAlone(changeKind) && (
            <span
              title={LEAVES_CODE_ALONE_TITLE[changeKind]}
              className="shrink-0 rounded px-1.5 text-xs bg-github-bg-tertiary text-github-text-secondary"
            >
              {LEAVES_CODE_ALONE_LABEL[changeKind]}
            </span>
          )}
          {fixupRef && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                revealFixupFile(fixupRef);
              }}
              className="shrink-0 text-xs text-github-warning hover:underline"
            >
              {revertedBy ? 'fixup 되돌림' : 'fixup 수정'}
            </button>
          )}
          {commentCount > 0 && <CommentCount count={commentCount} />}
        </div>
      );
    }

    return null;
  };

  return (
    <div
      ref={rootRef}
      className="relative h-full flex flex-col after:pointer-events-none after:absolute after:inset-0 after:z-10 focus-within:after:ring-2 focus-within:after:ring-inset focus-within:after:ring-blue-500"
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
    >
      <div className="px-4 py-3 border-b border-github-border bg-github-bg-tertiary">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-github-text-primary m-0">
            {onlyUnviewed
              ? `미확인 파일 (${unviewedCount} / ${files.length})`
              : `Files changed (${files.length})`}
          </h3>
          <div className="ml-auto flex items-center gap-2">
            <span
              className="inline-flex gap-1 text-right text-xs font-medium whitespace-nowrap"
              title="Total additions and deletions"
              aria-label={`${diffTotals.additions} additions and ${diffTotals.deletions} deletions`}
            >
              <span className="text-github-accent">+{diffTotals.additions}</span>
              <span className="text-github-danger">-{diffTotals.deletions}</span>
            </span>
            <button
              type="button"
              onClick={() => setOnlyUnviewed((on) => !on)}
              aria-pressed={onlyUnviewed}
              className={`p-1 rounded transition-colors ${
                onlyUnviewed ? 'bg-github-bg-primary' : 'hover:bg-github-bg-primary'
              }`}
              title={onlyUnviewed ? '전체 파일 보기' : '확인 안 한 파일만 보기'}
            >
              <EyeOff
                size={16}
                className={onlyUnviewed ? 'text-github-accent' : 'text-github-text-secondary'}
              />
            </button>
            <button
              onClick={toggleAllDirectories}
              className="p-1 hover:bg-github-bg-primary rounded transition-colors"
              title={isAllExpanded ? 'Collapse all' : 'Expand all'}
            >
              {isAllExpanded ? (
                <ChevronsDownUp size={16} className="text-github-text-secondary" />
              ) : (
                <ChevronsUpDown size={16} className="text-github-text-secondary" />
              )}
            </button>
          </div>
        </div>
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 transform -translate-y-1/2 text-github-text-muted"
          />
          <input
            type="text"
            placeholder="Filter files..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm bg-github-bg-primary border border-github-border rounded-md focus:outline-none focus:border-github-accent text-github-text-primary placeholder-github-text-muted"
          />
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto relative z-0 focus:outline-none"
        style={stickyContainerStyle}
        ref={scrollContainerRef}
        tabIndex={-1}
      >
        {filteredFileTree.children?.map((child) => renderTreeNode(child))}
        {emptyListMessage !== null && (
          <p className="m-0 px-4 py-3 text-sm text-github-text-muted">{emptyListMessage}</p>
        )}
        {filteredFixupOnly.map(({ fixup, files: fixupFiles }) => (
          <section
            key={fixup.sha}
            aria-label={`fixup ${fixup.shortSha}에서만 수정한 파일`}
            className="mt-2 border-t border-github-border pb-2"
          >
            <h4 className="m-0 px-4 py-2 text-xs font-semibold text-github-warning">
              fixup {fixup.shortSha}에서만 수정한 파일 ({fixupFiles.length})
            </h4>
            {fixupFiles.map((file) => {
              const ref = { fixupSha: fixup.sha, path: file.path };
              const isFocused =
                focusedFixupFile?.fixupSha === fixup.sha && focusedFixupFile.path === file.path;
              return (
                <button
                  key={file.path}
                  type="button"
                  aria-current={isFocused ? 'true' : undefined}
                  onClick={() => revealFixupFile(ref)}
                  className={`flex w-full min-w-0 items-center gap-2 px-4 py-1.5 text-left hover:bg-github-bg-tertiary ${ROW_FOCUS_CLASS} ${
                    isFocused ? 'bg-github-bg-tertiary' : ''
                  }`}
                >
                  <FilePathText
                    path={fixupFileName(file)}
                    className="flex-1 font-mono text-sm text-github-text-primary"
                  />
                  {fixupFileLabels(file).map((label) => (
                    <span key={label} className="shrink-0 text-xs text-github-text-secondary">
                      {label}
                    </span>
                  ))}
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
});
