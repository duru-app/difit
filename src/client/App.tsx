import {
  Columns,
  AlignLeft,
  Settings,
  PanelLeftClose,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  Keyboard,
  GitCommitHorizontal,
  MessageSquare,
} from 'lucide-react';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import {
  type ChoiceAnswer,
  type CommitMessageResponse,
  type DiffCommentThread,
  type DiffResponse,
  type DiffSelection,
  type DiffViewMode,
  type DirectEditRequest,
  type DirectEditResponse,
  type ReviewDecision,
  type DiffSide,
  type ExtraCommentLines,
  type LineNumber,
  type SidedLine,
  type CommentThread,
  type RevisionsResponse,
  type ReviewScope,
  type ReviewView,
  type ReviewViewAction,
  type RewordRequest,
  type RewordResponse,
} from '../types/diff';
import { amendedMessagesByCommit } from '../utils/amendedMessages';
import { inStoredOrder, positionOfLines, rangeOfLineNumber } from '../utils/commentPosition';
import { DEFAULT_DIFF_VIEW_MODE, normalizeDiffViewMode } from '../utils/diffMode';
import { mergeCommentThreads } from '../utils/commentImports';
import {
  bindingForView,
  createDiffSelection,
  diffSelectionsEqual,
  fixupCommitOf,
  getDiffSelectionKey,
  isCommitHash,
  isViewOfReview,
  madeViewElsewhere,
  normalizeBaseMode,
  reviewViewShown,
  selectReviewView,
  selectionAtCommit,
  type ViewBinding,
} from '../utils/diffSelection';
import { countOpenThreadsByCommit } from '../utils/openCommentCounts';
import {
  appearsResolved,
  commentPanelStatus,
  isThreadDeleted,
  mergeReviewDecisions,
  selectOpenThreads,
  type CommentPanelStatus,
} from '../utils/reviewDecisions';

import { Checkbox } from './components/Checkbox';
import { CommentsDropdown, type CopyAllNotice } from './components/CommentsDropdown';
import {
  CommentsPanel,
  type CommentsPanelFilter,
  type CommentsPanelHandle,
} from './components/CommentsPanel';
import { DiffQuickMenu } from './components/DiffQuickMenu';
import { DiffViewer } from './components/DiffViewer';
import { FileChips } from './components/FileChips';
import { FilePathText } from './components/FilePathText';
import { CommitList, ShownCommits } from './components/CommitList';
import { type RewordControls } from './components/CommitMessageForm';
import { FileList, type FileListHandle } from './components/FileList';
import { FixupOnlySections } from './components/FixupOnlySections';
import { GitHubIcon } from './components/GitHubIcon';
import { HelpModal } from './components/HelpModal';
import { Logo } from './components/Logo';
import { NewerTargetButton } from './components/NewerTargetButton';
import { ReloadButton } from './components/ReloadButton';
import { RevisionDetailModal } from './components/RevisionDetailModal';
import { SettingsModal } from './components/SettingsModal';
import { SparkleAnimation } from './components/SparkleAnimation';
import { SymbolPeekChip } from './components/SymbolPeekChip';
import { SymbolPeekModal } from './components/SymbolPeekModal';
import {
  type DirectEditControls,
  type DirectEditFailure,
  type FixupOverlayState,
} from './contexts/FixupOverlayContext';
import { PickedThreadProvider } from './contexts/PickedThreadContext';
import { WordHighlightProvider } from './contexts/WordHighlightContext';
import { useAppearanceSettings } from './hooks/useAppearanceSettings';
import { useDiffComments } from './hooks/useDiffComments';
import { useExpandedLines, type MergedChunk } from './hooks/useExpandedLines';
import { useFileWatch } from './hooks/useFileWatch';
import { useKeyboardNavigation } from './hooks/useKeyboardNavigation';
import { useChunkChangeKinds } from './hooks/useChunkChangeKinds';
import { useLazyDiffRendering } from './hooks/useLazyDiffRendering';
import {
  type ReviewHistoryEntry,
  type ReviewPlace,
  reviewEntryRestoredByHistory,
  useReviewTargetHistory,
} from './hooks/useReviewTargetHistory';
import { useScrollVisibleFile } from './hooks/useScrollVisibleFile';
import { useSymbolPeek } from './hooks/useSymbolPeek';
import { useViewedFiles } from './hooks/useViewedFiles';
import { useThreadFixups } from './hooks/useThreadFixups';
import { useViewport } from './hooks/useViewport';
import { fetchClientSettings, saveClientSettings } from './services/userSettings';
import { hasMultipleCommentAuthors } from './utils/commentAuthors';
import { copyTextToClipboard } from './utils/clipboard';
import { fixupFileElementId, getFileElementId } from './utils/domUtils';
import {
  getElementId,
  getFileLineIdPrefix,
  positionFromElementId,
} from './utils/navigation/domHelpers';
import {
  findCommentPosition,
  findLinePlacePosition,
  linePlaceAt,
} from './utils/navigation/positionHelpers';
import {
  EMPTY_MERGED_CHUNKS_STATE,
  buildMergedChunksState,
  getMergedChunksForVersion,
} from './utils/mergedChunks';
import { directEditFailureMessage, rewordFailureMessage } from './utils/directEdit';
import {
  type AnsweredThread,
  fixupFileKey,
  type FixupFileRef,
  type FixupSpread,
  reviewPathsOf,
  sameAnsweredThread,
  spreadFixups,
} from './utils/fixupSpread';
import { fetchFixupTarget } from './utils/fixupTarget';
import { keepWhileSame } from './utils/keepWhileSame';
import {
  buildFileLineIndex,
  type FileLineIndex,
  type Placement,
  placeThread,
  type ThreadPlacement,
} from './utils/outdatedComments';

const EMPTY_COMMENT_THREADS: CommentThread[] = [];
const EMPTY_MERGED_CHUNKS: MergedChunk[] = [];
const DIFF_VIEW_MODE_STORAGE_KEY = 'difit.diffViewMode';
const SIDEBAR_WIDTH_STORAGE_KEY = 'difit.sidebarWidth';
const SIDEBAR_OPEN_STORAGE_KEY = 'difit.sidebarOpen';
const COMMIT_LIST_HEIGHT_STORAGE_KEY = 'difit.commitListHeight';
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 600;
const SIDEBAR_DEFAULT_WIDTH = 280;
const COMMENTS_PANEL_OPEN_STORAGE_KEY = 'difit.commentsPanelOpen';
const COMMENTS_PANEL_WIDTH_STORAGE_KEY = 'difit.commentsPanelWidth';
const COMMENTS_PANEL_MIN_WIDTH = 240;
const COMMENTS_PANEL_MAX_WIDTH = 600;
const COMMENTS_PANEL_DEFAULT_WIDTH = 320;
const RESIZE_HANDLE_WIDTH = 4;
const DIFF_MIN_WIDTH = 640;
// The panel not resized last gives way first. The one resized last keeps a factor of 1, because
// flex lets a lone item with a factor below 1 absorb only that fraction of the overflow.
const YIELDING_PANEL_SHRINK = 1000;

const parseDiffViewMode = (value: unknown): DiffViewMode | null => {
  switch (value) {
    case 'split':
    case 'side-by-side':
    case 'unified':
    case 'inline':
      return normalizeDiffViewMode(value);
    default:
      return null;
  }
};

const getStoredDiffViewMode = (): DiffViewMode | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return parseDiffViewMode(window.localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY));
  } catch {
    return null;
  }
};

const getInitialDiffViewMode = () => getStoredDiffViewMode() ?? DEFAULT_DIFF_VIEW_MODE;

const clampSidebarWidth = (width: number) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));

const getStoredWidth = (key: string, clamp: (width: number) => number): number | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = window.localStorage.getItem(key);
  if (!stored) {
    return null;
  }
  const parsed = Number.parseInt(stored, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return clamp(parsed);
};

const getStoredSidebarWidth = () => getStoredWidth(SIDEBAR_WIDTH_STORAGE_KEY, clampSidebarWidth);

const getInitialSidebarWidth = () => getStoredSidebarWidth() ?? SIDEBAR_DEFAULT_WIDTH;

const getStoredBoolean = (key: string): boolean | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = window.localStorage.getItem(key);
  if (stored === 'true') {
    return true;
  }
  if (stored === 'false') {
    return false;
  }
  return null;
};

const getStoredSidebarOpen = () => getStoredBoolean(SIDEBAR_OPEN_STORAGE_KEY);

const getInitialFileTreeOpen = () => getStoredSidebarOpen() ?? true;

const parseCommitListHeight = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const getStoredCommitListHeight = (): number | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = window.localStorage.getItem(COMMIT_LIST_HEIGHT_STORAGE_KEY);
  return stored ? parseCommitListHeight(Number.parseInt(stored, 10)) : null;
};

const storeCommitListHeight = (height: number) => {
  try {
    window.localStorage.setItem(COMMIT_LIST_HEIGHT_STORAGE_KEY, String(height));
  } catch {}
};

const clampCommentsPanelWidth = (width: number) =>
  Math.min(COMMENTS_PANEL_MAX_WIDTH, Math.max(COMMENTS_PANEL_MIN_WIDTH, width));

const getStoredCommentsPanelWidth = () =>
  getStoredWidth(COMMENTS_PANEL_WIDTH_STORAGE_KEY, clampCommentsPanelWidth);

const getInitialCommentsPanelWidth = () =>
  getStoredCommentsPanelWidth() ?? COMMENTS_PANEL_DEFAULT_WIDTH;

const getStoredCommentsPanelOpen = () => getStoredBoolean(COMMENTS_PANEL_OPEN_STORAGE_KEY);

const getInitialCommentsPanelOpen = () => getStoredCommentsPanelOpen() ?? false;

const placedLine = (placement: Placement): ThreadPlacement => ({
  line: placement.line,
  ...(placement.extraLines ? { extraLines: placement.extraLines } : {}),
  isOutdated: placement.kind === 'stale',
  ...(placement.kind === 'stale' ? { outdatedReason: placement.reason } : {}),
});

const withPlacement = (
  { outdatedReason: _outdatedReason, extraLines: _extraLines, ...thread }: CommentThread,
  placement: ThreadPlacement,
): CommentThread => ({ ...thread, ...placement });

function placeThreads(
  threads: readonly DiffCommentThread[],
  view: DiffSelection | null,
  review: ReviewScope | undefined,
  targetCommit: string | null,
  lineIndexOf: (path: string) => FileLineIndex | undefined,
): { normalizedThreads: CommentThread[]; hiddenThreadIds: Set<string> } {
  const hidden = new Set<string>();
  const placed = threads.map((thread): CommentThread => {
    const placement = placeThread(
      thread,
      { view, review, targetCommit },
      lineIndexOf(thread.filePath),
    );
    if (placement.kind === 'hidden') hidden.add(thread.id);
    const madeView = review && view ? madeViewElsewhere(thread, view, review) : undefined;
    return {
      id: thread.id,
      file: thread.filePath,
      ...placedLine(placement),
      side: thread.position.side,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      codeContent: thread.codeSnapshot?.content,
      anchorCommit: thread.codeSnapshot?.commit,
      messages: thread.messages,
      ...(thread.fixupTarget
        ? { fixupCommit: fixupCommitOf(thread.fixupTarget, review?.commits ?? []) }
        : {}),
      ...(madeView ? { madeView } : {}),
    };
  });
  return { normalizedThreads: placed, hiddenThreadIds: hidden };
}

const anchorKeyOf = ({
  id,
  filePath,
  position,
  codeSnapshot,
  fixupTarget,
  view,
}: DiffCommentThread) => JSON.stringify([id, filePath, position, codeSnapshot, fixupTarget, view]);

const newThread = (
  filePath: string,
  line: LineNumber,
  body: string,
  codeContent: string | undefined,
  side: DiffSide | undefined,
  binding: ViewBinding | undefined,
  extra: ExtraCommentLines | undefined,
) => ({
  filePath,
  body,
  ...placedNewThread(side ?? 'new', line, codeContent, extra),
  binding,
});

function placedNewThread(
  side: DiffSide,
  line: LineNumber,
  codeContent: string | undefined,
  extra: ExtraCommentLines | undefined,
) {
  const ordered = inStoredOrder(
    side,
    (extra?.lines ?? []).map((range, index) => ({ ...range, content: extra?.contents[index] })),
  );
  const { extraRanges } = positionOfLines(side, line, ordered);
  return {
    side,
    line: rangeOfLineNumber(line),
    ...(extraRanges ? { extraRanges } : {}),
    codeSnapshot:
      codeContent !== undefined
        ? {
            content: codeContent,
            ...(extraRanges ? { extraContents: ordered.map(({ content }) => content ?? '') } : {}),
            language: undefined,
          }
        : undefined,
  };
}

function App() {
  const [diffData, setDiffData] = useState<DiffResponse | null>(null);
  const [diffDataVersion, setDiffDataVersion] = useState(0);
  const [diffMode, setDiffMode] = useState<DiffViewMode>(getInitialDiffViewMode);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(true);
  const [foldCommentChanges, setFoldCommentChanges] = useState(true);
  const [showResolvedThreads, setShowResolvedThreads] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyAllNotice, setCopyAllNotice] = useState<CopyAllNotice | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
  const [commitListHeight, setCommitListHeight] = useState(getStoredCommitListHeight);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFileTreeOpen, setIsFileTreeOpen] = useState(getInitialFileTreeOpen);
  // The phone drawer covers the diff, so it starts closed and does not touch the saved PC preference.
  const [isFileDrawerOpen, setIsFileDrawerOpen] = useState(false);
  const [fileListFocusRequest, setFileListFocusRequest] = useState(0);
  const fileListRef = useRef<FileListHandle>(null);
  const [isCommitDrawerOpen, setIsCommitDrawerOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [lastResizedPanel, setLastResizedPanel] = useState<'fileList' | 'comments' | null>(null);
  const fileListBoxRef = useRef<HTMLDivElement>(null);
  const commentsPanelBoxRef = useRef<HTMLDivElement>(null);
  const headerFileListAreaRef = useRef<HTMLDivElement>(null);
  const [showSparkles, setShowSparkles] = useState(false);
  const [hasTriggeredSparkles, setHasTriggeredSparkles] = useState(false);
  const [isCommentsPanelOpen, setIsCommentsPanelOpen] = useState(getInitialCommentsPanelOpen);
  const [isCommentsDrawerOpen, setIsCommentsDrawerOpen] = useState(false);
  const [commentsPanelWidth, setCommentsPanelWidth] = useState(getInitialCommentsPanelWidth);
  const [commentsPanelFilter, setCommentsPanelFilter] = useState<CommentsPanelFilter>('remaining');
  const [commentsPanelFocusRequest, setCommentsPanelFocusRequest] = useState(0);
  const commentsPanelRef = useRef<CommentsPanelHandle>(null);
  const [pickedThreadId, setPickedThreadId] = useState<string | null>(null);
  const [isRevisionModalOpen, setIsRevisionModalOpen] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const collapsedInitializedRef = useRef(false);
  const diffScrollContainerRef = useRef<HTMLElement | null>(null);

  // Revision selector state
  const [revisionOptions, setRevisionOptions] = useState<RevisionsResponse | null>(null);
  const [restoredEntry] = useState(reviewEntryRestoredByHistory);
  const restoredReviewTarget = restoredEntry?.selection ?? null;
  const [selectedRevision, setSelectedRevision] = useState<DiffSelection>(
    restoredReviewTarget ?? createDiffSelection('', ''),
  );
  const [resolvedBaseRevision, setResolvedBaseRevision] = useState<string>('');
  const [resolvedTargetRevision, setResolvedTargetRevision] = useState<string>('');
  const hasUserSelectedRevisionRef = useRef(restoredReviewTarget !== null);
  const currentRequestedBaseModeRef = useRef(selectedRevision.baseMode);
  currentRequestedBaseModeRef.current = diffData?.requestedBaseMode ?? selectedRevision.baseMode;
  const selectedRevisionRef = useRef(selectedRevision);
  selectedRevisionRef.current = selectedRevision;
  const diffRequestIdRef = useRef(0);
  const pendingPlaceRef = useRef<{ place: ReviewPlace; restoring: boolean } | null>(
    restoredEntry?.place ? { place: restoredEntry.place, restoring: true } : null,
  );
  const activeDiffAbortControllerRef = useRef<AbortController | null>(null);
  const resolvedSelection = useMemo<DiffSelection | null>(() => {
    if (!diffData?.baseCommitish || !diffData?.targetCommitish) {
      return null;
    }

    return createDiffSelection(
      diffData.baseCommitish,
      diffData.targetCommitish,
      diffData.requestedBaseMode,
    );
  }, [diffData]);
  const resolvedSelectionKey = useMemo(() => {
    if (!resolvedSelection) {
      return null;
    }

    return getDiffSelectionKey(resolvedSelection);
  }, [resolvedSelection]);
  const review = diffData?.review;
  const commentSelection = review?.selection ?? resolvedSelection;
  const commentSelectionKey = commentSelection ? getDiffSelectionKey(commentSelection) : null;
  const showsPartOfReview =
    review !== undefined &&
    resolvedSelection !== null &&
    !diffSelectionsEqual(resolvedSelection, review.selection);
  const shownView: ReviewView = useMemo(
    () =>
      (review && resolvedSelection && reviewViewShown(resolvedSelection, review)) || {
        kind: 'all',
      },
    [review, resolvedSelection],
  );
  const [viewAnchor, setViewAnchor] = useState<{ view: ReviewView; sha: string | null } | null>(
    null,
  );
  const shownAnchor =
    viewAnchor && JSON.stringify(viewAnchor.view) === JSON.stringify(shownView)
      ? viewAnchor.sha
      : null;
  const [rangePick, setRangePick] = useState<{ view: ReviewView; sha: string } | null>(null);
  const rangeStart =
    rangePick && JSON.stringify(rangePick.view) === JSON.stringify(shownView)
      ? rangePick.sha
      : undefined;
  const takesComments = !showsPartOfReview || shownView.kind !== 'all';

  const { settings, updateSettings } = useAppearanceSettings();
  const { isMobile, isDesktop } = useViewport();
  const isFileTreeShown = isMobile ? isFileDrawerOpen : isFileTreeOpen;
  const setFileTreeShown = isMobile ? setIsFileDrawerOpen : setIsFileTreeOpen;
  useHotkeys('escape', () => setIsFileDrawerOpen(false), {
    scopes: 'navigation',
    enabled: isMobile && isFileDrawerOpen,
  });
  const isCommentsPanelShown = isMobile ? isCommentsDrawerOpen : isCommentsPanelOpen;
  const setCommentsPanelShown = isMobile ? setIsCommentsDrawerOpen : setIsCommentsPanelOpen;
  useHotkeys('escape', () => setIsCommentsDrawerOpen(false), {
    scopes: 'navigation',
    enabled: isMobile && isCommentsDrawerOpen,
  });
  const hasCommitList = review !== undefined && review.commits.length > 1;
  const showsCommitList = !isMobile && hasCommitList;
  const reservedPanelWidth =
    (isFileTreeOpen ? SIDEBAR_MIN_WIDTH + RESIZE_HANDLE_WIDTH : 0) +
    (isCommentsPanelOpen ? COMMENTS_PANEL_MIN_WIDTH + RESIZE_HANDLE_WIDTH : 0);
  const panelFlex = (panel: 'fileList' | 'comments', isOpen: boolean, width: number) =>
    `0 ${lastResizedPanel === null || lastResizedPanel === panel ? 1 : YIELDING_PANEL_SHRINK} ${isOpen ? width : 0}px`;
  const attachFileListBox = useCallback((box: HTMLDivElement | null) => {
    fileListBoxRef.current = box;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      headerFileListAreaRef.current?.style.setProperty(
        '--file-list-width',
        `${entry.contentRect.width}px`,
      );
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // New diff-aware comment system
  const {
    hasLoadedComments,
    threads: storedThreads,
    decisions,
    replaceThreads,
    mergeDecisions,
    recordDecision,
    recordFixupDecisions,
    undoApproval,
    addThread,
    replyToThread,
    removeMessage,
    updateMessage,
    clearAllComments,
    generateAllCommentsPrompt,
  } = useDiffComments(
    commentSelection?.baseCommitish,
    commentSelection?.targetCommitish,
    review ? undefined : diffData?.commit, // Using commit as currentCommitHash
    undefined, // branchToHash map - could be populated from server data
    diffData?.repositoryId, // Repository identifier for storage isolation
    commentSelection?.baseMode,
  );
  const threads = useMemo(
    () => storedThreads.filter((thread) => !isThreadDeleted(thread.id, decisions)),
    [storedThreads, decisions],
  );
  const decisionsRef = useRef(decisions);
  decisionsRef.current = decisions;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const addThreadRef = useRef(addThread);
  addThreadRef.current = addThread;

  const showMobileCommentsBar = isMobile && threads.length > 0;
  const commentsContextKey = useMemo(() => {
    if (!commentSelectionKey) {
      return null;
    }

    return `${diffData?.repositoryId ?? 'default'}:${commentSelectionKey}`;
  }, [diffData?.repositoryId, commentSelectionKey]);
  const commentSessionQueryString = (() => {
    if (!commentSelection) {
      return null;
    }

    const params = new URLSearchParams({
      base: commentSelection.baseCommitish,
      target: commentSelection.targetCommitish,
    });
    if (commentSelection.baseMode === 'merge-base') {
      params.set('baseMode', commentSelection.baseMode);
    }

    return params.toString();
  })();
  const getCommentApiUrl = useCallback(
    (path: string) => {
      if (!commentSessionQueryString) {
        return path;
      }
      return `${path}?${commentSessionQueryString}`;
    },
    [commentSessionQueryString],
  );
  // Only a review pinned to a hash shows fixups; HEAD or a branch moves along with them.
  const targetCommit = useMemo(() => {
    const target = commentSelection?.targetCommitish;
    const requested = review?.requested.targetCommitish ?? diffData?.requestedTargetCommitish;
    return target && requested && isCommitHash(requested) ? target : null;
  }, [
    diffData?.requestedTargetCommitish,
    review?.requested.targetCommitish,
    commentSelection?.targetCommitish,
  ]);
  const [showFixupOverlay, setShowFixupOverlay] = useState(true);
  const [directEditCount, setDirectEditCount] = useState(0);
  const {
    fixups,
    fixupsByThread,
    newerTarget,
    loaded: fixupsLoaded,
  } = useThreadFixups(
    diffData && targetCommit ? getCommentApiUrl('/api/fixups') : null,
    diffDataVersion + directEditCount,
  );
  const openThreads = useMemo(
    () => selectOpenThreads(threads, fixupsByThread, decisions),
    [threads, fixupsByThread, decisions],
  );
  const openCountsByCommit = useMemo(
    () =>
      review && fixupsLoaded
        ? countOpenThreadsByCommit(threads, fixupsByThread, decisions, review)
        : undefined,
    [review, fixupsLoaded, threads, fixupsByThread, decisions],
  );
  const amendedMessages = useMemo(
    () => amendedMessagesByCommit(fixups, decisions),
    [fixups, decisions],
  );
  const resolvedThreadIds = useMemo(
    () =>
      new Set(
        threads
          .filter((thread) =>
            appearsResolved(thread.id, fixupsByThread.get(thread.id) ?? [], decisions),
          )
          .map(({ id }) => id),
      ),
    [threads, fixupsByThread, decisions],
  );
  if (resolvedThreadIds.size === 0 && !showResolvedThreads) setShowResolvedThreads(true);
  const commentPanelStatusById = useMemo(() => {
    const map = new Map<string, CommentPanelStatus>();
    threads.forEach((thread) => {
      const status = commentPanelStatus(thread, fixupsByThread.get(thread.id) ?? [], decisions);
      if (status) map.set(thread.id, status);
    });
    return map;
  }, [threads, fixupsByThread, decisions]);
  const resolveThread = useCallback(
    (threadId: string) => recordDecision(threadId, 'resolved', ''),
    [recordDecision],
  );
  const [bootstrappedCommentsKey, setBootstrappedCommentsKey] = useState<string | null>(null);
  const hasBootstrappedComments =
    commentsContextKey !== null && commentsContextKey === bootstrappedCommentsKey;
  const bootstrappingCommentsKeyRef = useRef<string | null>(null);
  const skipNextCommentSyncRef = useRef(false);
  // Last server comment version seen; echoed back as baseVersion so the server can detect concurrent writes.
  const serverCommentVersionRef = useRef<number | null>(null);
  const pendingBootstrapAfterLocalResetRef = useRef(false);

  useEffect(() => {
    if (commentsContextKey !== bootstrappedCommentsKey) {
      skipNextCommentSyncRef.current = false;
    }
  }, [bootstrappedCommentsKey, commentsContextKey]);

  const fetchServerComments = useCallback(async (): Promise<{
    threads: DiffCommentThread[];
    decisions: ReviewDecision[];
  }> => {
    const response = await fetch(getCommentApiUrl('/api/comments-json'));
    if (!response.ok) {
      throw new Error(`Failed to fetch comments: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      version?: number;
      threads?: DiffCommentThread[];
      decisions?: ReviewDecision[];
    };
    if (typeof payload.version === 'number') {
      serverCommentVersionRef.current = payload.version;
    }
    const decisions = Array.isArray(payload.decisions) ? payload.decisions : [];
    if (decisions.length > 0) {
      mergeDecisions(decisions);
    }
    return { threads: Array.isArray(payload.threads) ? payload.threads : [], decisions };
  }, [getCommentApiUrl, mergeDecisions]);

  const syncThreadsToServer = useCallback(
    async (nextThreads: DiffCommentThread[], nextDecisions?: ReviewDecision[]) => {
      const response = await fetch(getCommentApiUrl('/api/comments'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threads: nextThreads,
          decisions: nextDecisions,
          baseVersion: serverCommentVersionRef.current ?? undefined,
        }),
      });
      if (!response.ok) {
        return;
      }

      const result = (await response.json()) as {
        version?: number;
        merged?: boolean;
        threads?: DiffCommentThread[];
        decisions?: ReviewDecision[];
      };
      if (typeof result.version === 'number') {
        serverCommentVersionRef.current = result.version;
      }
      // Server merged in a concurrent change; adopt it so we don't push a stale set back.
      if (result.merged && Array.isArray(result.threads)) {
        skipNextCommentSyncRef.current = true;
        replaceThreads(result.threads);
        if (Array.isArray(result.decisions)) {
          mergeDecisions(result.decisions);
        }
      }
    },
    [getCommentApiUrl, mergeDecisions, replaceThreads],
  );

  // Viewed files management
  const {
    viewedFiles,
    changedSinceViewedFiles,
    hasLoadedInitialViewedFiles,
    toggleFileViewed,
    setFilesViewed,
    clearViewedFiles,
  } = useViewedFiles(
    resolvedSelection?.baseCommitish,
    resolvedSelection?.targetCommitish,
    diffData?.commit,
    undefined,
    diffData?.files,
    diffData?.repositoryId, // Repository identifier for storage isolation
    settings.autoViewedPatterns,
    resolvedSelection?.baseMode,
  );

  // Reset initialization flag when diff context changes
  useEffect(() => {
    collapsedInitializedRef.current = false;
  }, [diffData?.repositoryId, resolvedSelectionKey, diffData?.commit]);

  // Initialize collapsed files from viewed files (only once per diff)
  useEffect(() => {
    if (!collapsedInitializedRef.current && hasLoadedInitialViewedFiles) {
      setCollapsedFiles(new Set(viewedFiles));
      collapsedInitializedRef.current = true;
    }
  }, [viewedFiles, hasLoadedInitialViewedFiles]);
  const {
    renderedFilePaths,
    ensureFileRendered,
    ensureFilesRenderedUpTo,
    registerLazyFileContainer,
    scrollFileIntoDiffContainer,
    isFileScrolledPastContainerTop,
  } = useLazyDiffRendering({
    diffData,
    diffScrollContainerRef,
    setDiffData,
  });
  useChunkChangeKinds({ diffData, renderedFilePaths, setDiffData });
  const scrollVisibleFileIndex = useScrollVisibleFile({
    diffScrollContainerRef,
    files: diffData?.files,
  });

  const toggleFileReviewed = useCallback(
    async (filePath: string) => {
      if (!diffData) return;

      const file = diffData.files.find((f) => f.path === filePath);
      if (!file) return;

      const wasViewed = viewedFiles.has(filePath);
      // Measure before the collapse re-renders: only re-anchor the header when
      // the user is scrolled past it (deep inside a long file), so the viewport
      // doesn't land in unrelated content after collapsing (#164). If the header
      // is already visible, stay stationary and let files below fill up (#402).
      const shouldScrollToHeader = !wasViewed && isFileScrolledPastContainerTop(filePath);
      await toggleFileViewed(filePath, file);

      // Update collapsed state based on viewed state
      setCollapsedFiles((prev) => {
        const newSet = new Set(prev);
        if (!wasViewed) {
          // Marking as viewed -> collapse the file
          newSet.add(filePath);
        } else {
          // Marking as not viewed -> expand the file
          newSet.delete(filePath);
        }
        return newSet;
      });

      if (shouldScrollToHeader) {
        setTimeout(() => {
          scrollFileIntoDiffContainer(filePath);
        }, 100);
      }
    },
    [
      diffData,
      isFileScrolledPastContainerTop,
      scrollFileIntoDiffContainer,
      toggleFileViewed,
      viewedFiles,
    ],
  );

  const toggleFolderReviewed = useCallback(
    async (folderPath: string, reviewed: boolean) => {
      if (!diffData) return;

      const folderFiles = diffData.files.filter((file) => file.path.startsWith(`${folderPath}/`));
      if (folderFiles.length === 0) return;

      await setFilesViewed(folderFiles, reviewed);

      // Keep the collapse state of every file in the folder in sync with its viewed state
      setCollapsedFiles((prev) => {
        const newSet = new Set(prev);
        folderFiles.forEach((file) => {
          if (reviewed) {
            newSet.add(file.path);
          } else {
            newSet.delete(file.path);
          }
        });
        return newSet;
      });
    },
    [diffData, setFilesViewed],
  );

  const toggleFileCollapsed = useCallback((filePath: string) => {
    setCollapsedFiles((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(filePath)) {
        newSet.delete(filePath);
      } else {
        newSet.add(filePath);
      }
      return newSet;
    });
  }, []);

  const toggleAllFilesCollapsed = useCallback(
    (shouldCollapse: boolean) => {
      if (!diffData) return;

      if (shouldCollapse) {
        // Collapse all files
        setCollapsedFiles(new Set(diffData.files.map((f) => f.path)));
      } else {
        // Expand all files
        setCollapsedFiles(new Set());
      }
    },
    [diffData],
  );

  const handleMobileFileSelected = useCallback(() => {
    setIsFileDrawerOpen(false);
  }, []);

  const handleDiffModeChange = useCallback((mode: DiffViewMode) => {
    setDiffMode(mode);
    try {
      window.localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore localStorage errors (e.g. disabled storage).
    }
    saveClientSettings({ diffViewMode: mode });
  }, []);

  // Lift expand state to App level so navigation and rendering share the same merged chunks
  const {
    isLoading: isExpandLoading,
    openLines,
    prefetchFileContent,
    getMergedChunks,
    lastUpdatedAt,
  } = useExpandedLines({
    baseCommitish: diffData?.baseCommitish,
    targetCommitish: diffData?.targetCommitish,
    diffIdentity: diffDataVersion,
  });

  const symbolPeek = useSymbolPeek({
    base: diffData?.baseCommitish,
    target: diffData?.targetCommitish,
    enabled: diffData?.symbolSearchAvailable === true,
  });

  const getMergedChunksRef = useRef(getMergedChunks);
  useEffect(() => {
    getMergedChunksRef.current = getMergedChunks;
  }, [getMergedChunks]);

  const [mergedChunksState, setMergedChunksState] = useState(EMPTY_MERGED_CHUNKS_STATE);
  const filesByPath = useMemo(() => {
    const map = new Map<string, DiffResponse['files'][number]>();
    diffData?.files.forEach((file) => {
      map.set(file.path, file);
    });
    return map;
  }, [diffData]);

  // Recompute merged chunks for the current fetched diff only.
  useEffect(() => {
    if (!diffData) {
      setMergedChunksState(EMPTY_MERGED_CHUNKS_STATE);
      return;
    }

    setMergedChunksState(
      buildMergedChunksState(diffDataVersion, renderedFilePaths, filesByPath, (file) =>
        getMergedChunksRef.current(file),
      ),
    );
  }, [diffData, diffDataVersion, filesByPath, renderedFilePaths, lastUpdatedAt]);

  // Create files with merged chunks for keyboard navigation
  const navigableFiles = useMemo(() => {
    if (!diffData) return [];
    return diffData.files.map((file) => ({
      ...file,
      chunks:
        getMergedChunksForVersion(mergedChunksState, diffDataVersion, file.path) || file.chunks,
    }));
  }, [diffData, diffDataVersion, mergedChunksState]);
  const navigableFilesRef = useRef(navigableFiles);
  navigableFilesRef.current = navigableFiles;

  const fileLineIndexByPath = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildFileLineIndex>>();
    navigableFiles.forEach((file) => {
      map.set(file.path, buildFileLineIndex(file));
    });
    return map;
  }, [navigableFiles]);

  // Threads on files only a fixup changed are placed once the spread says which fixup shows them.
  const reviewPlacement = useMemo(
    () =>
      placeThreads(threads, resolvedSelection, review, targetCommit, (path) =>
        fileLineIndexByPath.get(path),
      ),
    [threads, fileLineIndexByPath, targetCommit, resolvedSelection, review],
  );
  const answeredThreadsRef = useRef<readonly AnsweredThread[]>([]);
  const answeredThreads = useMemo(() => {
    answeredThreadsRef.current = keepWhileSame(
      answeredThreadsRef.current,
      reviewPlacement.normalizedThreads
        .filter((thread) => !reviewPlacement.hiddenThreadIds.has(thread.id))
        .map(({ id, file, line, extraLines, side, isOutdated }) => ({
          id,
          file,
          line,
          ...(extraLines ? { extraLines } : {}),
          ...(side ? { side } : {}),
          isOutdated,
        })),
      sameAnsweredThread,
    );
    return answeredThreadsRef.current;
  }, [reviewPlacement]);
  const outsideThreadsRef = useRef<readonly DiffCommentThread[]>([]);
  const outsideThreads = useMemo(() => {
    outsideThreadsRef.current = keepWhileSame(
      outsideThreadsRef.current,
      threads.filter((thread) => !fileLineIndexByPath.has(thread.filePath)),
      (thread, before) => anchorKeyOf(thread) === anchorKeyOf(before),
    );
    return outsideThreadsRef.current;
  }, [threads, fileLineIndexByPath]);
  // Fixup line numbers are counted on the review target, so only the whole review shows them.
  const fixupSpread = useMemo<FixupSpread>(() => {
    const overlay = { enabled: showFixupOverlay && !showsPartOfReview, fixupsByThread, decisions };
    const context = { view: resolvedSelection, review, targetCommit };
    const lineIndexes = new Map<string, FileLineIndex>();
    return spreadFixups(overlay, fixups, answeredThreads, diffData?.files ?? [], {
      threads: outsideThreads.map((thread) => ({
        id: thread.id,
        file: thread.filePath,
        snapshotCommit: thread.codeSnapshot?.commit,
        thread,
      })),
      place: ({ thread }, file, fixup) => {
        const key = fixupFileKey({ fixupSha: fixup.sha, path: file.path });
        const index = lineIndexes.get(key) ?? buildFileLineIndex(file);
        lineIndexes.set(key, index);
        const placement = placeThread(thread, context, index, fixup.sha);
        return placement.kind === 'hidden' ? null : placedLine(placement);
      },
    });
  }, [
    showFixupOverlay,
    showsPartOfReview,
    fixupsByThread,
    decisions,
    fixups,
    answeredThreads,
    diffData,
    outsideThreads,
    resolvedSelection,
    review,
    targetCommit,
  ]);
  const fixupOnlyRef = useRef(fixupSpread.fixupOnly);
  fixupOnlyRef.current = fixupSpread.fixupOnly;
  const fixupReviewPaths = useMemo(() => reviewPathsOf(fixups), [fixups]);
  const { normalizedThreads, hiddenThreadIds } = useMemo(() => {
    const { outsidePlacements } = fixupSpread;
    if (outsidePlacements.size === 0) return reviewPlacement;
    return {
      normalizedThreads: reviewPlacement.normalizedThreads.map((thread) => {
        const placed = outsidePlacements.get(thread.id);
        return placed ? withPlacement(thread, placed.placement) : thread;
      }),
      hiddenThreadIds: reviewPlacement.hiddenThreadIds,
    };
  }, [reviewPlacement, fixupSpread.outsidePlacements]);
  const drawnThreads = useMemo(
    () => normalizedThreads.filter((thread) => !hiddenThreadIds.has(thread.id)),
    [normalizedThreads, hiddenThreadIds],
  );
  const showAuthorBadges = useMemo(
    () => hasMultipleCommentAuthors(normalizedThreads.flatMap((thread) => thread.messages)),
    [normalizedThreads],
  );
  const unresolvedThreads = useMemo(
    () => drawnThreads.filter((thread) => !resolvedThreadIds.has(thread.id)),
    [drawnThreads, resolvedThreadIds],
  );
  const unresolvedLineThreads = useMemo(
    () =>
      unresolvedThreads.filter(
        (thread): thread is CommentThread & { line: LineNumber } => thread.line !== undefined,
      ),
    [unresolvedThreads],
  );
  const pickedThread = useMemo(
    () => normalizedThreads.find((thread) => thread.id === pickedThreadId) ?? null,
    [normalizedThreads, pickedThreadId],
  );
  const keptPickedThreadId =
    !showResolvedThreads && pickedThread && resolvedThreadIds.has(pickedThread.id)
      ? pickedThread.id
      : null;
  const threadsByFile = useMemo(() => {
    const map = new Map<string, CommentThread[]>();
    const shown = showResolvedThreads
      ? drawnThreads
      : keptPickedThreadId
        ? drawnThreads.filter(
            (thread) => !resolvedThreadIds.has(thread.id) || thread.id === keptPickedThreadId,
          )
        : unresolvedThreads;
    shown.forEach((thread) => {
      const entry = map.get(thread.file);
      if (entry) {
        entry.push(thread);
      } else {
        map.set(thread.file, [thread]);
      }
    });
    return map;
  }, [drawnThreads, unresolvedThreads, showResolvedThreads, keptPickedThreadId, resolvedThreadIds]);
  const threadsByFixupOnlyFile = useMemo(() => {
    const map = new Map<string, CommentThread[]>();
    for (const [path, fileThreads] of threadsByFile) {
      for (const thread of fileThreads) {
        const placed = fixupSpread.outsidePlacements.get(thread.id);
        if (!placed) continue;
        const key = fixupFileKey({ fixupSha: placed.fixupSha, path });
        map.set(key, [...(map.get(key) ?? []), thread]);
      }
    }
    return map;
  }, [threadsByFile, fixupSpread.outsidePlacements]);

  // State to trigger comment creation from keyboard
  const [commentTrigger, setCommentTrigger] = useState<{
    fileIndex: number;
    chunkIndex: number;
    lineIndex: number;
  } | null>(null);
  const fetchDiffDataRef = useRef<((selection?: DiffSelection) => Promise<void>) | null>(null);
  const handleWatchReload = useCallback(async () => {
    await fetchDiffDataRef.current?.();
  }, []);
  const handleCommentsChanged = useCallback(async () => {
    try {
      const { threads: serverThreads } = await fetchServerComments();
      skipNextCommentSyncRef.current = true;
      replaceThreads(serverThreads);
      if (commentsContextKey) {
        setBootstrappedCommentsKey(commentsContextKey);
      }
    } catch (commentsError) {
      console.error('Failed to refresh comments from server:', commentsError);
    }
  }, [commentsContextKey, fetchServerComments, replaceThreads]);

  // File watch for reload functionality - initialize with callback
  const { shouldReload, reload, watchState } = useFileWatch(
    handleWatchReload,
    handleCommentsChanged,
    symbolPeek.noteIndexChange,
  );

  const openCommentsPanelWithKeys = useCallback(() => {
    setCommentsPanelShown(true);
    setCommentsPanelFocusRequest((count) => count + 1);
  }, [setCommentsPanelShown]);
  useEffect(() => {
    if (commentsPanelFocusRequest > 0) commentsPanelRef.current?.focus();
  }, [commentsPanelFocusRequest]);
  const refocusCommentsPanelAfterLoadRef = useRef(false);
  useEffect(() => {
    if (loading || !refocusCommentsPanelAfterLoadRef.current) return;
    refocusCommentsPanelAfterLoadRef.current = false;
    commentsPanelRef.current?.focus();
  }, [loading]);
  useEffect(() => {
    if (fileListFocusRequest > 0) fileListRef.current?.focus();
  }, [fileListFocusRequest]);
  const refocusFileListAfterLoadRef = useRef(false);
  useEffect(() => {
    if (loading || !refocusFileListAfterLoadRef.current) return;
    refocusFileListAfterLoadRef.current = false;
    fileListRef.current?.focus();
  }, [loading]);

  // Track which file the mouse is over so `v` works without a cursor
  const hoveredFileIndexRef = useRef<number | null>(null);
  const getHoveredFileIndex = useCallback(() => hoveredFileIndexRef.current, []);

  const { cursor, isHelpOpen, setIsHelpOpen, setCursorPosition, rememberFilePosition } =
    useKeyboardNavigation({
      files: navigableFiles,
      comments: unresolvedLineThreads,
      viewMode: diffMode,
      reviewedFiles: viewedFiles,
      onToggleReviewed: toggleFileReviewed,
      getHoveredFileIndex,
      onCreateComment: () => {
        if (cursor && takesComments) {
          setCommentTrigger({
            fileIndex: cursor.fileIndex,
            chunkIndex: cursor.chunkIndex,
            lineIndex: cursor.lineIndex,
          });
        }
      },
      onCopyAllComments: () => {
        if (threads.length > 0) {
          void handleCopyAllComments();
        }
      },
      onDeleteAllComments: () => {
        if (threads.length > 0 && confirm('Delete all comments?')) {
          clearAllComments();
        }
      },
      onToggleCommentsPanel: () => {
        if (!isCommentsPanelShown) {
          openCommentsPanelWithKeys();
        } else if (!commentsPanelRef.current?.hasFocus()) {
          setCommentsPanelFocusRequest((count) => count + 1);
        } else {
          (document.activeElement as HTMLElement | null)?.blur();
          setCommentsPanelShown(false);
        }
      },
      onToggleFileList: () => {
        if (!isFileTreeShown) {
          setFileTreeShown(true);
          setFileListFocusRequest((count) => count + 1);
        } else if (!fileListRef.current?.hasFocus()) {
          setFileListFocusRequest((count) => count + 1);
        } else {
          (document.activeElement as HTMLElement | null)?.blur();
          setFileTreeShown(false);
        }
      },
      onRefresh: () => {
        reload();
      },
      ...(showsCommitList && {
        onPreviousCommit: () => selectView({ kind: 'previous' }),
        onNextCommit: () => selectView({ kind: 'next' }),
      }),
      onJump: (to) => {
        const line = linePlaceAt(to, navigableFiles);
        if (line) jumpWithinReview({ kind: 'line', ...line, cursor: true });
      },
    });

  // Viewed button in the diff header: silently remember the toggled file as
  // the navigation position, so keyboard navigation resumes from it without
  // showing any keyboard UI for a mouse interaction
  const handleViewedButtonToggle = useCallback(
    (filePath: string) => {
      void toggleFileReviewed(filePath);
      if (diffData) {
        const fileIndex = diffData.files.findIndex((f) => f.path === filePath);
        if (fileIndex !== -1) {
          rememberFilePosition(fileIndex);
        }
      }
    },
    [toggleFileReviewed, diffData, rememberFilePosition],
  );

  useEffect(() => {
    if (!diffData || !cursor) return;

    const filePath = diffData.files[cursor.fileIndex]?.path;
    if (!filePath || renderedFilePaths.has(filePath)) return;

    ensureFilesRenderedUpTo(filePath);
    requestAnimationFrame(() => {
      setCursorPosition(cursor);
    });
  }, [cursor, diffData, ensureFilesRenderedUpTo, renderedFilePaths, setCursorPosition]);

  const handleLineClick = useCallback(
    (fileIndex: number, chunkIndex: number, lineIndex: number, side: 'left' | 'right') => {
      setCursorPosition({
        fileIndex,
        chunkIndex,
        lineIndex,
        side,
      });
    },
    [setCursorPosition],
  );

  const handleCommentTriggerHandled = useCallback(() => {
    setCommentTrigger(null);
  }, [setCommentTrigger]);

  const startResize =
    (
      panel: 'fileList' | 'comments',
      setWidth: (width: number) => void,
      clamp: (width: number) => number,
      direction: 1 | -1,
    ) =>
    (e: React.MouseEvent) => {
      const [box, isOpen, minWidth] =
        panel === 'fileList'
          ? [fileListBoxRef.current, isFileTreeOpen, SIDEBAR_MIN_WIDTH]
          : [commentsPanelBoxRef.current, isCommentsPanelOpen, COMMENTS_PANEL_MIN_WIDTH];
      const row = diffScrollContainerRef.current?.parentElement;
      e.preventDefault();
      if (!box || !row || !isOpen) return;
      setIsDragging(true);
      // A panel caught mid open or close starts from the width it settles at.
      for (const child of row.children) {
        for (const animation of child.getAnimations?.() ?? []) animation.finish();
      }
      const startX = e.clientX;
      const startWidth = box.getBoundingClientRect().width;
      const rowWidth = row.getBoundingClientRect().width;
      const maxWidth = Math.floor(
        minWidth + Math.max(0, rowWidth - reservedPanelWidth - DIFF_MIN_WIDTH),
      );

      const handleMouseMove = (e: MouseEvent) => {
        const dragged = direction * (e.clientX - startX);
        setLastResizedPanel(panel);
        setWidth(Math.round(clamp(Math.min(startWidth + dragged, maxWidth))));
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    };

  const fetchDiffData = useCallback(
    async (selection?: DiffSelection) => {
      const requestId = diffRequestIdRef.current + 1;
      diffRequestIdRef.current = requestId;
      activeDiffAbortControllerRef.current?.abort();
      const controller = new AbortController();
      activeDiffAbortControllerRef.current = controller;
      try {
        const requestedSelection =
          selection ??
          (hasUserSelectedRevisionRef.current ? selectedRevisionRef.current : undefined);
        const params = new URLSearchParams({
          ignoreWhitespace: String(ignoreWhitespace),
        });
        if (requestedSelection?.baseCommitish) params.set('base', requestedSelection.baseCommitish);
        if (requestedSelection?.targetCommitish)
          params.set('target', requestedSelection.targetCommitish);
        if (requestedSelection?.baseMode === 'merge-base')
          params.set('baseMode', requestedSelection.baseMode);

        const response = await fetch(`/api/diff?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Failed to fetch diff data');
        const data = (await response.json()) as DiffResponse;
        if (diffRequestIdRef.current !== requestId) {
          return;
        }
        setDiffData(data);
        setDiffDataVersion((prev) => prev + 1);

        // Update resolved revision state from server response
        setResolvedBaseRevision(
          data.baseCommitish && data.requestedBaseMode !== 'merge-base' ? data.baseCommitish : '',
        );
        if (data.targetCommitish) setResolvedTargetRevision(data.targetCommitish);

        if (!hasUserSelectedRevisionRef.current) {
          const requestedBase = data.requestedBaseCommitish ?? data.baseCommitish;
          const requestedTarget = data.requestedTargetCommitish ?? data.targetCommitish;
          if (requestedBase && requestedTarget) {
            setSelectedRevision(
              createDiffSelection(requestedBase, requestedTarget, data.requestedBaseMode),
            );
          }
        }

        // Lock files are now automatically marked as viewed by useViewedFiles hook
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError') {
          return;
        }
        if (diffRequestIdRef.current !== requestId) {
          return;
        }
        pendingPlaceRef.current = null;
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        if (activeDiffAbortControllerRef.current === controller) {
          activeDiffAbortControllerRef.current = null;
        }
        if (diffRequestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [ignoreWhitespace],
  );
  fetchDiffDataRef.current = fetchDiffData;

  useEffect(() => {
    void fetchDiffData();
  }, [fetchDiffData]);

  useEffect(() => {
    return () => {
      activeDiffAbortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (isMobile && diffMode !== 'unified') {
      setDiffMode('unified');
    }
  }, [diffMode, isMobile]);

  // Hydrate UI settings from the server-persisted config so they survive
  // across ports (localStorage is origin-scoped and resets on a new port).
  // Settings the server doesn't know yet are seeded from localStorage.
  useEffect(() => {
    let cancelled = false;

    void fetchClientSettings().then((client) => {
      if (cancelled || !client) {
        return;
      }

      const seed: Record<string, unknown> = {};

      const remoteDiffViewMode = parseDiffViewMode(client.diffViewMode);
      if (remoteDiffViewMode) {
        setDiffMode(remoteDiffViewMode);
      } else {
        const localDiffViewMode = getStoredDiffViewMode();
        if (localDiffViewMode) {
          seed.diffViewMode = localDiffViewMode;
        }
      }

      if (typeof client.sidebarWidth === 'number' && Number.isFinite(client.sidebarWidth)) {
        setSidebarWidth(clampSidebarWidth(client.sidebarWidth));
      } else {
        const localSidebarWidth = getStoredSidebarWidth();
        if (localSidebarWidth !== null) {
          seed.sidebarWidth = localSidebarWidth;
        }
      }

      if (typeof client.sidebarOpen === 'boolean') {
        setIsFileTreeOpen(client.sidebarOpen);
      } else {
        const localSidebarOpen = getStoredSidebarOpen();
        if (localSidebarOpen !== null) {
          seed.sidebarOpen = localSidebarOpen;
        }
      }

      const remoteCommitListHeight = parseCommitListHeight(client.commitListHeight);
      if (remoteCommitListHeight !== null) {
        setCommitListHeight(remoteCommitListHeight);
        storeCommitListHeight(remoteCommitListHeight);
      } else {
        const localCommitListHeight = getStoredCommitListHeight();
        if (localCommitListHeight !== null) {
          seed.commitListHeight = localCommitListHeight;
        }
      }

      if (
        typeof client.commentsPanelWidth === 'number' &&
        Number.isFinite(client.commentsPanelWidth)
      ) {
        setCommentsPanelWidth(clampCommentsPanelWidth(client.commentsPanelWidth));
      } else {
        const localCommentsPanelWidth = getStoredCommentsPanelWidth();
        if (localCommentsPanelWidth !== null) {
          seed.commentsPanelWidth = localCommentsPanelWidth;
        }
      }

      if (typeof client.commentsPanelOpen === 'boolean') {
        setIsCommentsPanelOpen(client.commentsPanelOpen);
      } else {
        const localCommentsPanelOpen = getStoredCommentsPanelOpen();
        if (localCommentsPanelOpen !== null) {
          seed.commentsPanelOpen = localCommentsPanelOpen;
        }
      }

      if (Object.keys(seed).length > 0) {
        saveClientSettings(seed);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const skipInitialSidebarWidthSaveRef = useRef(true);
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // Ignore localStorage errors (e.g. disabled storage).
    }
    // Skip the mount run so simply opening difit doesn't write the config file.
    if (skipInitialSidebarWidthSaveRef.current) {
      skipInitialSidebarWidthSaveRef.current = false;
      return;
    }
    saveClientSettings({ sidebarWidth });
  }, [sidebarWidth]);

  const handleCommitListResize = useCallback((height: number) => {
    const rounded = Math.round(height);
    setCommitListHeight(rounded);
    storeCommitListHeight(rounded);
    saveClientSettings({ commitListHeight: rounded });
  }, []);

  const skipInitialSidebarOpenSaveRef = useRef(true);
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(isFileTreeOpen));
    } catch {
      // Ignore localStorage errors (e.g. disabled storage).
    }
    if (skipInitialSidebarOpenSaveRef.current) {
      skipInitialSidebarOpenSaveRef.current = false;
      return;
    }
    saveClientSettings({ sidebarOpen: isFileTreeOpen });
  }, [isFileTreeOpen]);

  const skipInitialCommentsPanelWidthSaveRef = useRef(true);
  useEffect(() => {
    try {
      window.localStorage.setItem(COMMENTS_PANEL_WIDTH_STORAGE_KEY, String(commentsPanelWidth));
    } catch {}
    if (skipInitialCommentsPanelWidthSaveRef.current) {
      skipInitialCommentsPanelWidthSaveRef.current = false;
      return;
    }
    saveClientSettings({ commentsPanelWidth });
  }, [commentsPanelWidth]);

  const skipInitialCommentsPanelOpenSaveRef = useRef(true);
  useEffect(() => {
    try {
      window.localStorage.setItem(COMMENTS_PANEL_OPEN_STORAGE_KEY, String(isCommentsPanelOpen));
    } catch {
      // Ignore localStorage errors (e.g. disabled storage).
    }
    if (skipInitialCommentsPanelOpenSaveRef.current) {
      skipInitialCommentsPanelOpenSaveRef.current = false;
      return;
    }
    saveClientSettings({ commentsPanelOpen: isCommentsPanelOpen });
  }, [isCommentsPanelOpen]);

  // Fetch revision options on mount
  useEffect(() => {
    fetch('/api/revisions')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: RevisionsResponse | null) => {
        setRevisionOptions(data);
        if (
          data?.resolvedBase &&
          normalizeBaseMode(currentRequestedBaseModeRef.current) !== 'merge-base'
        ) {
          setResolvedBaseRevision((prev) => prev || data.resolvedBase || '');
        }
        if (data?.resolvedTarget) {
          setResolvedTargetRevision((prev) => prev || data.resolvedTarget || '');
        }
      })
      .catch(() => setRevisionOptions(null));
  }, []);

  // Handle revision change
  const handleRevisionChange = useCallback(
    async (nextSelection: DiffSelection) => {
      // Skip if no actual change
      if (diffSelectionsEqual(nextSelection, selectedRevision)) return;

      hasUserSelectedRevisionRef.current = true;
      pendingPlaceRef.current = null;
      selectedRevisionRef.current = nextSelection;
      setSelectedRevision(nextSelection);
      refocusCommentsPanelAfterLoadRef.current = commentsPanelRef.current?.hasFocus() ?? false;
      refocusFileListAfterLoadRef.current = fileListRef.current?.hasFocus() ?? false;
      setLoading(true);
      setError(null);
      await fetchDiffData(nextSelection);
    },
    [fetchDiffData, selectedRevision],
  );

  // The cursor line while it is on screen, otherwise the first line showing under the file header.
  const currentPlace = (): ReviewPlace | null => {
    const container = diffScrollContainerRef.current;
    const files = navigableFilesRef.current;
    if (!container) return null;
    const containerRect = container.getBoundingClientRect();
    const headerBottom = (element: HTMLElement) => {
      const header = element
        .closest('[data-file-path]')
        ?.querySelector<HTMLElement>('[data-file-header]');
      return Math.max(containerRect.top, header?.getBoundingClientRect().bottom ?? 0);
    };
    const onScreen = (element: HTMLElement) => {
      const { top } = element.getBoundingClientRect();
      return top >= headerBottom(element) - 1 && top < containerRect.bottom;
    };
    const cursorElement = cursor && document.getElementById(getElementId(cursor, diffMode));
    if (cursor && cursorElement && onScreen(cursorElement)) {
      const line = linePlaceAt(cursor, files);
      if (line) return { kind: 'line', ...line, cursor: true };
    }
    const fileIndex = scrollVisibleFileIndex ?? 0;
    const file = files[fileIndex];
    if (!file) return null;
    if (collapsedFiles.has(file.path)) return { kind: 'file', file: file.path };
    const section = document.getElementById(getFileElementId(file.path));
    if (section?.dataset.rendered !== 'true') return { kind: 'file', file: file.path };
    const below = headerBottom(section);
    // In page order, so their tops never go back up.
    const lines = section.querySelectorAll<HTMLElement>(
      `[id^="${getFileLineIdPrefix(fileIndex)}"]`,
    );
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((lines[middle]?.getBoundingClientRect().top ?? 0) >= below - 1) high = middle;
      else low = middle + 1;
    }
    const first = lines[low];
    const shown =
      first
        ?.closest('tr')
        ?.querySelector<HTMLElement>(`[id^="${getFileLineIdPrefix(fileIndex)}"][id$="-right"]`) ??
      first;
    const position = shown ? positionFromElementId(shown.id) : null;
    if (shown && position && onScreen(shown)) {
      const line = linePlaceAt(position, files);
      if (line) return { kind: 'line', ...line, cursor: false };
    }
    return { kind: 'file', file: file.path };
  };
  const restoreEntryRef = useRef<(entry: ReviewHistoryEntry) => void>(() => {});
  const recordJump = useReviewTargetHistory({
    current: () => ({ selection: selectedRevisionRef.current, place: currentPlace() }),
    restore: (entry) => restoreEntryRef.current(entry),
  });
  const jumpWithinReview = useCallback(
    (place: ReviewPlace) => {
      pendingPlaceRef.current = null;
      recordJump({ selection: selectedRevisionRef.current, place });
    },
    [recordJump],
  );
  const showDiff = useCallback(
    (nextSelection: DiffSelection, place: ReviewPlace | null = null) => {
      if (diffSelectionsEqual(nextSelection, selectedRevision)) return;
      recordJump({ selection: nextSelection, place });
      void handleRevisionChange(nextSelection);
      if (place) pendingPlaceRef.current = { place, restoring: false };
    },
    [handleRevisionChange, recordJump, selectedRevision],
  );
  const jumpToFile = useCallback(
    (filePath: string) => {
      jumpWithinReview({ kind: 'file', file: filePath });
      scrollFileIntoDiffContainer(filePath);
    },
    [jumpWithinReview, scrollFileIntoDiffContainer],
  );
  const selectView = useCallback(
    (action: ReviewViewAction, place: ReviewPlace | null = null) => {
      if (!review) return;
      const chosen = selectReviewView(
        review,
        { view: shownView, anchor: shownAnchor, ...(rangeStart !== undefined && { rangeStart }) },
        action,
      );
      if (!chosen) return;
      setViewAnchor({ view: chosen.view, sha: chosen.anchor });
      setRangePick(
        chosen.rangeStart === undefined ? null : { view: chosen.view, sha: chosen.rangeStart },
      );
      if (!chosen.selection) return;
      setIsCommitDrawerOpen(false);
      showDiff(chosen.selection, place);
    },
    [review, shownView, shownAnchor, rangeStart, showDiff],
  );
  const closeCommitDrawer = useCallback(() => {
    selectView({ kind: 'cancel' });
    setIsCommitDrawerOpen(false);
  }, [selectView]);
  const openReviewAt = useCallback(
    (commit: string) => showDiff(selectionAtCommit(selectedRevision, commit)),
    [selectedRevision, showDiff],
  );
  const submitDirectEdit = useCallback(
    async (request: DirectEditRequest): Promise<DirectEditFailure | null> => {
      let response: Response;
      try {
        response = await fetch(getCommentApiUrl('/api/direct-edit'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        });
      } catch {
        return { message: 'difit 서버에 연결하지 못했습니다.' };
      }
      const payload = (await response.json().catch(() => ({}))) as Partial<
        Extract<DirectEditResponse, { error: string }>
      > &
        Partial<Extract<DirectEditResponse, { success: true }>>;
      if (!response.ok || !payload.success) {
        if (payload.reason === 'card-changed') setDirectEditCount((count) => count + 1);
        return {
          message: directEditFailureMessage(
            payload.reason,
            payload.error ?? `${response.status} ${response.statusText}`,
            payload.sha !== undefined,
          ),
          ...(payload.output ? { output: payload.output } : {}),
          ...(payload.reason ? { reason: payload.reason } : {}),
        };
      }
      if (typeof payload.version === 'number') {
        serverCommentVersionRef.current = payload.version;
      }
      skipNextCommentSyncRef.current = true;
      replaceThreads(payload.threads ?? []);
      mergeDecisions(payload.decisions ?? []);
      setDirectEditCount((count) => count + 1);
      return null;
    },
    [getCommentApiUrl, mergeDecisions, replaceThreads],
  );
  const loadCommitMessage = useCallback(
    async (sha: string): Promise<string | null> => {
      const url = getCommentApiUrl('/api/commit-message');
      try {
        const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}commit=${sha}`);
        if (!response.ok) return null;
        const { message } = (await response.json()) as Partial<CommitMessageResponse>;
        return typeof message === 'string' ? message : null;
      } catch {
        return null;
      }
    },
    [getCommentApiUrl],
  );
  const submitReword = useCallback(
    async (request: RewordRequest): Promise<DirectEditFailure | null> => {
      let response: Response;
      try {
        response = await fetch(getCommentApiUrl('/api/reword'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        });
      } catch {
        return { message: 'difit 서버에 연결하지 못했습니다.' };
      }
      const payload = (await response.json().catch(() => ({}))) as Partial<
        Extract<RewordResponse, { error: string }>
      > &
        Partial<Extract<RewordResponse, { success: true }>>;
      if (!response.ok || !payload.success) {
        return {
          message: rewordFailureMessage(
            payload.reason,
            payload.error ?? `${response.status} ${response.statusText}`,
          ),
          ...(payload.output ? { output: payload.output } : {}),
        };
      }
      if (typeof payload.version === 'number') {
        serverCommentVersionRef.current = payload.version;
      }
      skipNextCommentSyncRef.current = true;
      replaceThreads(payload.threads ?? []);
      mergeDecisions(payload.decisions ?? []);
      setDirectEditCount((count) => count + 1);
      return null;
    },
    [getCommentApiUrl, mergeDecisions, replaceThreads],
  );
  const reword = useMemo<RewordControls | undefined>(
    () =>
      diffData?.directEditAvailable && targetCommit
        ? { load: loadCommitMessage, save: submitReword }
        : undefined,
    [diffData?.directEditAvailable, targetCommit, loadCommitMessage, submitReword],
  );
  const directEdit = useMemo<DirectEditControls | null>(() => {
    if (!diffData?.directEditAvailable || !targetCommit) return null;
    if (!showsPartOfReview) return { commit: targetCommit, submit: submitDirectEdit };
    const view = {
      base: resolvedSelection.baseCommitish,
      target: resolvedSelection.targetCommitish,
    };
    return {
      commit: view.target,
      submit: (request) =>
        submitDirectEdit(request.fixupSha === undefined ? { ...request, view } : request),
    };
  }, [
    diffData?.directEditAvailable,
    targetCommit,
    showsPartOfReview,
    resolvedSelection,
    submitDirectEdit,
  ]);
  const [focusedFixupFile, setFocusedFixupFile] = useState<FixupFileRef | null>(null);
  const pickThreadRef = useRef<(threadId: string) => void>(() => {});
  const pickThread = useCallback((threadId: string) => pickThreadRef.current(threadId), []);
  const showFixupFileRef = useRef<(ref: FixupFileRef, restoring: boolean) => void>(() => {});
  const revealFixupFile = useCallback(
    (fixupSha: string, path: string) => {
      const place: ReviewPlace = { kind: 'fixup', fixupSha, path };
      if (showsPartOfReview) {
        selectView({ kind: 'all' }, place);
        return;
      }
      if (!fixupSpread.places.has(fixupFileKey(place))) return;
      jumpWithinReview(place);
      showFixupFileRef.current(place, false);
    },
    [showsPartOfReview, selectView, fixupSpread, jumpWithinReview],
  );
  const fixupOverlay = useMemo<FixupOverlayState>(
    () => ({
      enabled: showFixupOverlay,
      fixupsByThread,
      decisions,
      targetCommit,
      recordDecision,
      decideFixups: recordFixupDecisions,
      undoApproval,
      openReviewAt,
      showView: showDiff,
      directEdit,
      boxesByFile: fixupSpread.boxesByFile,
      fixupPlaces: fixupSpread.places,
      fixupReviewPaths,
      fixupTouchedFiles: fixupSpread.touchedReviewFiles,
      focusedFixupFile,
      revealFixupFile,
      pickThread,
    }),
    [
      showFixupOverlay,
      fixupsByThread,
      decisions,
      targetCommit,
      recordDecision,
      recordFixupDecisions,
      undoApproval,
      openReviewAt,
      showDiff,
      directEdit,
      fixupSpread,
      fixupReviewPaths,
      focusedFixupFile,
      revealFixupFile,
      pickThread,
    ],
  );

  // Clear comments and viewed files on initial load if requested via CLI flag
  const hasCleanedRef = useRef(false);
  useEffect(() => {
    if (diffData?.clearComments && !hasCleanedRef.current) {
      hasCleanedRef.current = true;
      pendingBootstrapAfterLocalResetRef.current = true;
      clearAllComments({ resetAppliedCommentImportIds: true });
      clearViewedFiles();
      console.log(
        '✅ All existing comments and viewed files cleared as requested via --clean flag',
      );
    }
  }, [diffData?.clearComments, clearAllComments, clearViewedFiles]);

  useEffect(() => {
    if (!commentsContextKey || !hasLoadedComments) {
      return;
    }

    if (bootstrappedCommentsKey === commentsContextKey) {
      return;
    }

    if (bootstrappingCommentsKeyRef.current === commentsContextKey) {
      return;
    }

    const shouldReplaceFromServer = pendingBootstrapAfterLocalResetRef.current;
    pendingBootstrapAfterLocalResetRef.current = false;

    bootstrappingCommentsKeyRef.current = commentsContextKey;
    let cancelled = false;

    const bootstrapComments = async () => {
      try {
        const { threads: serverThreads, decisions: serverDecisions } = await fetchServerComments();
        const nextThreads = shouldReplaceFromServer
          ? serverThreads
          : mergeCommentThreads(serverThreads, storedThreads).threads;
        const nextDecisions = mergeReviewDecisions(serverDecisions, decisionsRef.current);
        if (cancelled) {
          return;
        }

        skipNextCommentSyncRef.current = true;
        replaceThreads(nextThreads);

        if (
          !shouldReplaceFromServer &&
          (JSON.stringify(serverThreads) !== JSON.stringify(nextThreads) ||
            JSON.stringify(mergeReviewDecisions(serverDecisions, [])) !==
              JSON.stringify(nextDecisions))
        ) {
          await syncThreadsToServer(nextThreads, nextDecisions);
        }
      } catch (commentsError) {
        if (!cancelled) {
          console.error('Failed to bootstrap comments from server:', commentsError);
        }
      } finally {
        if (!cancelled) {
          setBootstrappedCommentsKey(commentsContextKey);
        }
        if (bootstrappingCommentsKeyRef.current === commentsContextKey) {
          bootstrappingCommentsKeyRef.current = null;
        }
      }
    };

    void bootstrapComments();

    return () => {
      cancelled = true;
      if (bootstrappingCommentsKeyRef.current === commentsContextKey) {
        bootstrappingCommentsKeyRef.current = null;
      }
    };
  }, [
    bootstrappedCommentsKey,
    commentsContextKey,
    fetchServerComments,
    hasLoadedComments,
    replaceThreads,
    storedThreads,
    syncThreadsToServer,
  ]);

  // Trigger sparkle animation when all files are viewed
  useEffect(() => {
    if (diffData) {
      // Reset the trigger flag when not all files are viewed
      if (viewedFiles.size < diffData.files.length) {
        setHasTriggeredSparkles(false);
      }
      // Show sparkles when all files are viewed and not already triggered
      else if (viewedFiles.size === diffData.files.length && !hasTriggeredSparkles) {
        setShowSparkles(true);
        setHasTriggeredSparkles(true);
        // Hide sparkles after animation completes
        setTimeout(() => {
          setShowSparkles(false);
        }, 1000);
      }
    }
  }, [viewedFiles.size, diffData, hasTriggeredSparkles]);

  // Send comments to server whenever they change and before page unload
  useEffect(() => {
    if (!hasBootstrappedComments) {
      return;
    }

    const data = JSON.stringify({
      threads: storedThreads,
      decisions,
      baseVersion: serverCommentVersionRef.current ?? undefined,
    });
    const commentsApiUrl = getCommentApiUrl('/api/comments');

    // Also handle page unload
    const sendCommentsBeforeUnload = () => {
      // Use sendBeacon for reliable delivery during page unload, including empty states.
      navigator.sendBeacon(commentsApiUrl, data);
    };

    window.addEventListener('beforeunload', sendCommentsBeforeUnload);

    if (skipNextCommentSyncRef.current) {
      skipNextCommentSyncRef.current = false;
      return () => {
        window.removeEventListener('beforeunload', sendCommentsBeforeUnload);
      };
    }

    syncThreadsToServer(storedThreads, decisions).catch((syncError) => {
      console.error('Failed to sync comments:', syncError);
    });

    return () => {
      window.removeEventListener('beforeunload', sendCommentsBeforeUnload);
    };
  }, [decisions, getCommentApiUrl, hasBootstrappedComments, storedThreads, syncThreadsToServer]);

  const bindNewThread = useCallback(
    async (
      file: string,
      line: LineNumber | undefined,
      side: DiffSide,
      extraLines?: readonly SidedLine[],
    ): Promise<ViewBinding | undefined> => {
      if (!review || !resolvedSelection || !isViewOfReview(resolvedSelection, review)) {
        return undefined;
      }
      const fixupTarget = await fetchFixupTarget(resolvedSelection, file, line, side, extraLines);
      return bindingForView(review, resolvedSelection, fixupTarget);
    },
    [review, resolvedSelection],
  );
  const handleAddComment = useCallback(
    async (
      file: string,
      line: LineNumber,
      body: string,
      codeContent?: string,
      side?: DiffSide,
      extra?: ExtraCommentLines,
    ): Promise<void> => {
      const binding = await bindNewThread(file, line, side || 'new', extra?.lines);
      addThreadRef.current(newThread(file, line, body, codeContent, side, binding, extra));
    },
    [bindNewThread],
  );
  const handleAddFileComment = useCallback(
    async (file: string, body: string, side: DiffSide): Promise<void> => {
      const binding = await bindNewThread(file, undefined, side);
      addThreadRef.current({ filePath: file, body, side, binding });
    },
    [bindNewThread],
  );
  const handleAddFixupOnlyComment = useCallback(
    (
      fixupSha: string,
      file: string,
      line: LineNumber,
      body: string,
      codeContent?: string,
      side?: DiffSide,
      extra?: ExtraCommentLines,
    ): Promise<void> => {
      const group = fixupOnlyRef.current.find(({ fixup }) => fixup.sha === fixupSha);
      const fixupTarget =
        group?.fixup.foldTargetSha ??
        (group?.threads ?? [])
          .map(({ id }) => threadsRef.current.find((thread) => thread.id === id)?.fixupTarget)
          .find((target) => target !== undefined) ??
        targetCommit;
      const binding = fixupTarget ? { fixupTarget, snapshotCommit: fixupSha } : undefined;
      addThreadRef.current(newThread(file, line, body, codeContent, side, binding, extra));
      return Promise.resolve();
    },
    [targetCommit],
  );

  const showCopyAllNotice = (notice: CopyAllNotice) => {
    setCopyAllNotice(notice);
    setTimeout(() => setCopyAllNotice(null), 2000);
  };

  const handleCopyAllComments = async () => {
    if (!fixupsLoaded) return;
    if (openThreads.length === 0) {
      showCopyAllNotice('empty');
      return;
    }
    try {
      const prompt = generateAllCommentsPrompt(
        {
          requestedBaseCommitish: diffData?.requestedBaseCommitish,
          requestedTargetCommitish: diffData?.requestedTargetCommitish,
          baseMode: normalizeBaseMode(diffData?.requestedBaseMode),
          resolvedBaseCommitish: diffData?.baseCommitish,
          resolvedTargetCommitish: diffData?.targetCommitish,
        },
        openThreads,
      );
      await copyTextToClipboard(prompt);
      showCopyAllNotice('copied');
    } catch (error) {
      console.error('Failed to copy all comments prompt:', error);
    }
  };

  const handleReplyToThread = useCallback(
    (threadId: string, body: string, answer?: ChoiceAnswer): Promise<void> => {
      replyToThread({ threadId, body, ...(answer ? { answer } : {}) });
      return Promise.resolve();
    },
    [replyToThread],
  );

  const pickComment = (thread: CommentThread) => {
    if (!diffData) return;
    setPickedThreadId(thread.id);
    const place: ReviewPlace = { kind: 'thread', threadId: thread.id };
    const placedHere =
      !hiddenThreadIds.has(thread.id) &&
      !thread.isOutdated &&
      diffData.files.some(({ path }) => path === thread.file);
    if (!placedHere && showsPartOfReview && review) {
      showDiff(thread.madeView ?? review.requested, place);
      return;
    }

    jumpWithinReview(place);
    jumpToThread(thread, collapsedFiles.has(thread.file), false);
  };
  pickThreadRef.current = (threadId) => {
    const thread = normalizedThreads.find(({ id }) => id === threadId);
    if (thread) pickComment(thread);
  };
  const jumpToThread = (thread: CommentThread, afterRender: boolean, restoring: boolean) => {
    if (!diffData) return;
    const placed = fixupSpread.outsidePlacements.get(thread.id);
    if (placed) {
      showFixupFile({ fixupSha: placed.fixupSha, path: thread.file }, restoring);
      return;
    }
    if (restoring && collapsedFiles.has(thread.file)) {
      scrollFileIntoDiffContainer(thread.file);
      return;
    }
    setCollapsedFiles((prev) => {
      if (!prev.has(thread.file)) return prev;
      const next = new Set(prev);
      next.delete(thread.file);
      return next;
    });
    if (thread.line === undefined) {
      if (diffData.files.some(({ path }) => path === thread.file)) {
        scrollFileIntoDiffContainer(
          thread.file,
          `comment-thread-${thread.id}`,
          `file-comment-${thread.id}`,
        );
      }
      return;
    }
    const moveCursor = () => {
      const position = findCommentPosition(thread, navigableFilesRef.current);
      setCursorPosition(position);
      scrollFileIntoDiffContainer(
        thread.file,
        `comment-thread-${thread.id}`,
        position ? getElementId(position, diffMode) : undefined,
      );
    };
    if (afterRender) requestAnimationFrame(moveCursor);
    else moveCursor();
  };
  const showFixupFile = (ref: FixupFileRef, restoring: boolean) => {
    const place = fixupSpread.places.get(fixupFileKey(ref));
    if (!place) return;
    setFocusedFixupFile(ref);
    if (place.kind === 'card') {
      const thread = normalizedThreads.find(({ id }) => id === place.threadId);
      if (!thread) return;
      setPickedThreadId(thread.id);
      jumpToThread(thread, collapsedFiles.has(thread.file), restoring);
      return;
    }
    if (place.kind === 'box' && collapsedFiles.has(place.reviewPath)) {
      if (restoring) {
        scrollFileIntoDiffContainer(place.reviewPath);
        return;
      }
      setCollapsedFiles((prev) => {
        const next = new Set(prev);
        next.delete(place.reviewPath);
        return next;
      });
    }
    scrollFileIntoDiffContainer(
      place.kind === 'box' ? place.reviewPath : ref.path,
      fixupFileElementId(ref.fixupSha, ref.path),
    );
  };
  showFixupFileRef.current = showFixupFile;

  const showPlace = (place: ReviewPlace, restoring: boolean, afterRender: boolean) => {
    if (place.kind === 'thread') {
      const thread = normalizedThreads.find(({ id }) => id === place.threadId);
      if (!thread) return;
      setPickedThreadId(thread.id);
      jumpToThread(thread, afterRender || collapsedFiles.has(thread.file), restoring);
      return;
    }
    if (place.kind === 'fixup') {
      showFixupFile(place, restoring);
      return;
    }
    if (place.kind === 'file' || collapsedFiles.has(place.file)) {
      scrollFileIntoDiffContainer(place.file);
      return;
    }
    const moveTo = () => {
      const position = findLinePlacePosition(place, navigableFilesRef.current);
      if (!position) {
        scrollFileIntoDiffContainer(place.file);
        return;
      }
      if (place.cursor) setCursorPosition(position);
      scrollFileIntoDiffContainer(place.file, getElementId(position, diffMode));
    };
    if (afterRender) requestAnimationFrame(moveTo);
    else moveTo();
  };
  restoreEntryRef.current = ({ selection, place }) => {
    if (!diffSelectionsEqual(selection, selectedRevisionRef.current)) {
      void handleRevisionChange(selection);
      pendingPlaceRef.current = place && { place, restoring: true };
      return;
    }
    if (place) showPlace(place, true, false);
  };
  const showPlaceRef = useRef(showPlace);
  showPlaceRef.current = showPlace;
  useEffect(() => {
    const pending = pendingPlaceRef.current;
    if (!pending || loading || !diffData) return;
    // A new view folds its viewed files once they load; jumping before that would be folded again.
    if (!collapsedInitializedRef.current && !hasLoadedInitialViewedFiles) return;
    const { place } = pending;
    if (place.kind === 'thread' && (!hasLoadedComments || hiddenThreadIds.has(place.threadId))) {
      return;
    }
    if (
      place.kind === 'fixup' &&
      (showsPartOfReview || !fixupSpread.places.has(fixupFileKey(place)))
    ) {
      return;
    }
    pendingPlaceRef.current = null;
    showPlaceRef.current(place, pending.restoring, true);
  }, [
    loading,
    diffData,
    hasLoadedComments,
    hasLoadedInitialViewedFiles,
    normalizedThreads,
    hiddenThreadIds,
    showsPartOfReview,
    fixupSpread,
  ]);

  const handleOpenInEditor = useCallback(
    async (filePath: string, lineNumber: number) => {
      try {
        const response = await fetch('/api/open-in-editor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filePath,
            line: lineNumber,
            editor: settings.editor,
          }),
        });

        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => null);
          let message = response.statusText;
          if (
            payload &&
            typeof payload === 'object' &&
            'error' in payload &&
            typeof (payload as { error?: unknown }).error === 'string'
          ) {
            message = (payload as { error: string }).error;
          }
          console.error('Failed to open file in editor:', message);
        }
      } catch (error) {
        console.error('Failed to open file in editor:', error);
      }
    },
    [settings.editor],
  );

  const handleGlobalClick = (e: React.MouseEvent) => {
    // Clear cursor position
    setCursorPosition(null);

    // Check if clicking on a comment button
    const target = e.target as HTMLElement;
    if (
      (commentsPanelRef.current?.hasFocus() && !target.closest('#comments-panel')) ||
      (fileListRef.current?.hasFocus() && !target.closest('#file-tree-panel'))
    ) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
    const isCommentButton = target.closest('[data-comment-button="true"]');
    const isOpenInEditorButton = target.closest('[data-open-in-editor-button="true"]');
    const isShiftRangeClick = e.shiftKey && target.closest('[data-diff-line-row="true"]');
    const pickingInFile =
      (e.ctrlKey || e.metaKey || target.closest('[data-adds-lines="true"]')) &&
      target.closest('[data-line-number-cell]')
        ? target.closest('[data-file-path]')
        : null;

    // Close empty comment forms (unless clicking on a comment button)
    if (!isCommentButton && !isOpenInEditorButton && !isShiftRangeClick) {
      closeEmptyCommentForms(e, pickingInFile);
    }
  };

  // A form in `pickingInFile` stays open: the click picks lines for it.
  const closeEmptyCommentForms = (e: React.MouseEvent, pickingInFile: Element | null) => {
    const emptyForms = document.querySelectorAll('form[data-empty="true"]');
    emptyForms.forEach((form) => {
      // Don't close if clicking inside the form itself
      if (!form.contains(e.target as Node) && !pickingInFile?.contains(form)) {
        const cancelButton = form.querySelector<HTMLButtonElement>('[data-comment-cancel="true"]');
        cancelButton?.click();
      }
    });
  };

  const commentsPanelBody = (
    <CommentsPanel
      ref={commentsPanelRef}
      threads={normalizedThreads}
      statusById={commentPanelStatusById}
      resolvedThreadIds={resolvedThreadIds}
      filter={commentsPanelFilter}
      onFilterChange={setCommentsPanelFilter}
      pickedThreadId={pickedThread?.id ?? null}
      onPick={(thread) => {
        pickComment(thread);
        if (isMobile) setIsCommentsDrawerOpen(false);
      }}
      onResolveThread={resolveThread}
      {...(isMobile && { onEscape: () => setIsCommentsDrawerOpen(false) })}
      onClose={() => setCommentsPanelShown(false)}
      inDrawer={isMobile}
    />
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-github-bg-primary">
        <div className="text-github-text-secondary text-base">Loading diff...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-github-bg-primary text-center gap-2">
        <h2 className="text-github-danger text-2xl mb-2">Error</h2>
        <p className="text-github-text-secondary text-base">{error}</p>
      </div>
    );
  }

  if (!diffData) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-github-bg-primary text-center gap-2">
        <h2 className="text-github-danger text-2xl mb-2">No data</h2>
        <p className="text-github-text-secondary text-base">No diff data available</p>
      </div>
    );
  }

  const canOpenInEditor =
    diffData.openInEditorAvailable !== false &&
    settings.editor.id !== 'none' &&
    settings.editor.command.trim() !== '' &&
    settings.editor.argsTemplate.trim() !== '';

  return (
    <WordHighlightProvider>
      <div
        className="h-screen flex flex-col"
        data-fixup-review={targetCommit ? '' : undefined}
        onClickCapture={handleGlobalClick}
      >
        <header
          className={`bg-github-bg-secondary border-b border-github-border flex ${
            isMobile ? 'flex-col' : 'flex-row items-center'
          }`}
        >
          <div
            ref={headerFileListAreaRef}
            className={`flex items-center justify-between w-full ${
              isMobile ? 'px-3 py-2 gap-3' : 'px-4 py-3 gap-4 w-auto'
            }`}
            style={{
              width: isMobile
                ? '100%'
                : isFileTreeOpen
                  ? `var(--file-list-width, ${sidebarWidth}px)`
                  : 'auto',
              minWidth: isMobile ? '0px' : isFileTreeOpen ? `${SIDEBAR_MIN_WIDTH}px` : 'auto',
              maxWidth: isMobile ? 'none' : isFileTreeOpen ? `${SIDEBAR_MAX_WIDTH}px` : 'none',
            }}
          >
            <h1>
              <Logo
                style={{
                  height: '18px',
                  color: 'var(--color-github-text-secondary)',
                }}
              />
            </h1>
            <div className="flex items-center gap-1">
              {isMobile && hasCommitList && (
                <button
                  type="button"
                  onClick={() =>
                    isCommitDrawerOpen ? closeCommitDrawer() : setIsCommitDrawerOpen(true)
                  }
                  className="flex items-center gap-1.5 min-w-0 p-2 text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary rounded transition-colors"
                  title="리뷰 범위의 커밋"
                  aria-expanded={isCommitDrawerOpen}
                  aria-controls="commit-drawer"
                  aria-label="커밋 목록"
                >
                  <GitCommitHorizontal size={18} className="shrink-0" />
                  <span className="min-w-0 max-w-40 truncate text-xs">
                    <ShownCommits commits={review.commits} shown={shownView} />
                  </span>
                </button>
              )}
              {isMobile && (
                <button
                  type="button"
                  onClick={() => setIsCommentsDrawerOpen(!isCommentsDrawerOpen)}
                  className="flex items-center gap-1 p-2 text-xs text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary rounded transition-colors"
                  title="코멘트 패널"
                  aria-expanded={isCommentsDrawerOpen}
                  aria-controls="comments-panel"
                  aria-label="Toggle comments panel"
                >
                  <MessageSquare size={18} />
                  {threads.length}
                </button>
              )}
              <button
                onClick={() =>
                  isMobile
                    ? setIsFileDrawerOpen(!isFileDrawerOpen)
                    : setIsFileTreeOpen(!isFileTreeOpen)
                }
                className="p-2 text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary rounded transition-colors"
                title={isFileTreeShown ? 'Collapse file tree' : 'Expand file tree'}
                aria-expanded={isFileTreeShown}
                aria-controls="file-tree-panel"
                aria-label="Toggle file tree panel"
              >
                {isFileTreeShown ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
              </button>
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="p-2 text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary rounded transition-colors"
                title="Settings"
              >
                <Settings size={18} />
              </button>
            </div>
          </div>
          {!isMobile && (
            <div
              className={`border-r border-github-border ${!isDragging ? '!transition-all !duration-300 !ease-in-out' : ''}`}
              style={{
                width: isFileTreeOpen ? '4px' : '0px',
                height: 'calc(100% - 16px)',
                margin: '8px 0',
                transform: 'translateX(-2px)',
              }}
            />
          )}
          <div
            className={`flex-1 flex flex-wrap items-center justify-between ${
              isMobile ? 'px-3 pb-2 gap-3' : 'px-4 py-3 gap-4'
            }`}
          >
            <div className={`flex flex-wrap items-center ${isMobile ? 'gap-2' : 'gap-3'}`}>
              {!isMobile && (
                <div className="flex bg-github-bg-tertiary border border-github-border rounded-md p-1">
                  <button
                    onClick={() => handleDiffModeChange('split')}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-all duration-200 flex items-center gap-1.5 cursor-pointer ${
                      diffMode === 'split'
                        ? 'bg-github-bg-primary text-github-text-primary shadow-sm'
                        : 'text-github-text-secondary hover:text-github-text-primary'
                    }`}
                  >
                    <Columns size={14} />
                    Split
                  </button>
                  <button
                    onClick={() => handleDiffModeChange('unified')}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-all duration-200 flex items-center gap-1.5 cursor-pointer ${
                      diffMode === 'unified'
                        ? 'bg-github-bg-primary text-github-text-primary shadow-sm'
                        : 'text-github-text-secondary hover:text-github-text-primary'
                    }`}
                  >
                    <AlignLeft size={14} />
                    Unified
                  </button>
                </div>
              )}
              <Checkbox
                checked={ignoreWhitespace}
                onChange={setIgnoreWhitespace}
                label="Ignore Whitespace"
                title={ignoreWhitespace ? 'Show whitespace changes' : 'Ignore whitespace changes'}
              />
              {diffData?.targetCommitish !== 'stdin' && (
                <Checkbox
                  checked={foldCommentChanges}
                  onChange={setFoldCommentChanges}
                  label="주석 변경 접기"
                  title={
                    foldCommentChanges
                      ? '주석이나 공백만 바뀐 곳도 펼쳐 보기'
                      : '코드는 그대로이고 주석이나 공백만 바뀐 곳을 한 줄로 접기'
                  }
                />
              )}
              {resolvedThreadIds.size > 0 && (
                <Checkbox
                  checked={showResolvedThreads}
                  onChange={setShowResolvedThreads}
                  label="해결된 지적 보기"
                  title={
                    showResolvedThreads
                      ? '해결된 지적을 diff에서 감추기'
                      : '해결된 지적도 접어서 보이기'
                  }
                />
              )}
              {fixupsByThread.size > 0 && (
                <Checkbox
                  checked={showFixupOverlay}
                  onChange={setShowFixupOverlay}
                  label="수정을 겹쳐 보기"
                  title={
                    showFixupOverlay
                      ? '원래 diff만 보기'
                      : '지적에 대한 수정을 코드 줄 아래에 겹쳐 보기'
                  }
                />
              )}
              <NewerTargetButton
                newerTarget={newerTarget}
                onReopen={openReviewAt}
                compact={isMobile}
              />
              {/* File Watch Reload Button */}
              <ReloadButton
                shouldReload={shouldReload}
                isReloading={watchState.isReloading}
                onReload={reload}
                changeType={watchState.lastChangeType}
                compact={isMobile}
              />
            </div>
            <div
              className={`flex flex-wrap items-center text-sm text-github-text-secondary ${
                isMobile ? 'gap-3' : 'gap-4'
              }`}
            >
              {!isMobile && threads.length > 0 && (
                <CommentsDropdown
                  commentsCount={threads.length}
                  openCount={fixupsLoaded ? openThreads.length : null}
                  copyAllNotice={copyAllNotice}
                  onCopyAll={handleCopyAllComments}
                  onDeleteAll={clearAllComments}
                  onViewAll={openCommentsPanelWithKeys}
                />
              )}
              {!isMobile && (
                <button
                  type="button"
                  onClick={() => setIsCommentsPanelOpen(!isCommentsPanelOpen)}
                  className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors ${
                    isCommentsPanelOpen
                      ? 'border-blue-500 bg-blue-500/15 text-github-text-primary'
                      : 'border-github-border bg-github-bg-tertiary text-github-text-primary hover:bg-github-bg-primary'
                  }`}
                  title={isCommentsPanelOpen ? 'Hide comments panel' : 'Show comments panel'}
                  aria-expanded={isCommentsPanelOpen}
                  aria-controls="comments-panel"
                  aria-label="Toggle comments panel"
                >
                  {isCommentsPanelOpen ? <PanelRightClose size={14} /> : <PanelRight size={14} />}
                  코멘트 {threads.length}
                  <span className="font-mono text-[10px] text-github-text-muted">Shift+L</span>
                </button>
              )}
              <div className="flex flex-col gap-1 items-center">
                <div className="text-xs relative">
                  {viewedFiles.size === diffData.files.length
                    ? 'All diffs difit-ed!'
                    : `${viewedFiles.size} / ${diffData.files.length} files viewed`}
                  <SparkleAnimation isActive={showSparkles} />
                </div>
                <div
                  className="relative h-2 bg-github-bg-tertiary rounded-full overflow-hidden"
                  style={{
                    width: '90px',
                    border: '1px solid var(--color-github-border)',
                  }}
                >
                  <div
                    className={`absolute top-0 right-0 h-full transition-all duration-300 ease-out ${(() => {
                      const remainingPercent =
                        ((diffData.files.length - viewedFiles.size) / diffData.files.length) * 100;
                      if (remainingPercent > 50) return 'bg-github-accent'; // green
                      if (remainingPercent > 20) {
                        return 'bg-github-warning fixup-review:bg-github-text-muted'; // yellow
                      }
                      return 'bg-github-danger'; // red
                    })()}`}
                    style={{
                      width: `${((diffData.files.length - viewedFiles.size) / diffData.files.length) * 100}%`,
                    }}
                  />
                </div>
              </div>
              {revisionOptions ? (
                <DiffQuickMenu
                  options={revisionOptions}
                  selection={selectedRevision}
                  resolvedBaseRevision={resolvedBaseRevision}
                  resolvedTargetRevision={resolvedTargetRevision}
                  onSelectDiff={(selection) => void handleRevisionChange(selection)}
                  onOpenAdvanced={() => setIsRevisionModalOpen(true)}
                  compact={!isDesktop}
                />
              ) : (
                <span className="text-xs">
                  Reviewing:{' '}
                  <code className="bg-github-bg-tertiary px-1.5 py-0.5 rounded text-xs text-github-text-primary">
                    {diffData.commit.includes('...') ? (
                      <>
                        <span className="text-github-text-secondary font-medium">
                          {diffData.commit.split('...')[0]}...
                        </span>
                        <span className="font-medium">{diffData.commit.split('...')[1]}</span>
                      </>
                    ) : (
                      diffData.commit
                    )}
                  </code>
                </span>
              )}
            </div>
          </div>
        </header>
        {isMobile && (
          <FileChips
            files={diffData.files}
            comments={drawnThreads}
            resolvedThreadIds={resolvedThreadIds}
            reviewedFiles={viewedFiles}
            selectedFileIndex={cursor?.fileIndex ?? null}
            scrollVisibleFileIndex={scrollVisibleFileIndex}
            pickedCommentFilePath={pickedThread?.file ?? null}
            onScrollToFile={jumpToFile}
          />
        )}
        {revisionOptions && (
          <RevisionDetailModal
            key={isRevisionModalOpen ? getDiffSelectionKey(selectedRevision) : 'closed'}
            isOpen={isRevisionModalOpen}
            onClose={() => setIsRevisionModalOpen(false)}
            options={revisionOptions}
            selection={selectedRevision}
            resolvedBaseRevision={resolvedBaseRevision}
            resolvedTargetRevision={resolvedTargetRevision}
            onApply={(selection) => void handleRevisionChange(selection)}
          />
        )}

        {isMobile && isFileDrawerOpen && (
          <button
            type="button"
            aria-label="Close file tree"
            className="fixed inset-0 bg-black/40 z-30"
            onClick={() => setIsFileDrawerOpen(false)}
          />
        )}

        {isMobile && hasCommitList && (
          <>
            {isCommitDrawerOpen && (
              <button
                type="button"
                aria-label="커밋 목록 닫기"
                className="fixed inset-0 bg-black/40 z-30"
                onClick={closeCommitDrawer}
              />
            )}
            <aside
              id="commit-drawer"
              inert={!isCommitDrawerOpen}
              className="fixed inset-y-0 right-0 z-40 w-[min(85vw,360px)] flex flex-col bg-github-bg-secondary border-l border-github-border transition-transform duration-300 ease-out"
              style={{ transform: isCommitDrawerOpen ? 'translateX(0)' : 'translateX(100%)' }}
            >
              <CommitList
                review={review}
                shown={shownView}
                onSelect={selectView}
                rangeStart={rangeStart}
                inDrawer
                openCounts={openCountsByCommit}
                amendedMessages={amendedMessages}
                reword={reword}
              />
            </aside>
          </>
        )}

        {isMobile && (
          <>
            {isCommentsDrawerOpen && (
              <button
                type="button"
                aria-label="코멘트 서랍 닫기"
                className="fixed inset-0 bg-black/40 z-30"
                onClick={() => setIsCommentsDrawerOpen(false)}
              />
            )}
            <aside
              id="comments-panel"
              aria-label="코멘트 패널"
              inert={!isCommentsDrawerOpen}
              className="fixed inset-y-0 right-0 z-40 w-[min(85vw,360px)] bg-github-bg-secondary border-l border-github-border transition-transform duration-300 ease-out"
              style={{ transform: isCommentsDrawerOpen ? 'translateX(0)' : 'translateX(100%)' }}
            >
              {commentsPanelBody}
            </aside>
          </>
        )}

        <div className="flex flex-1 overflow-hidden relative">
          <div
            ref={attachFileListBox}
            className={`relative overflow-hidden ${!isDragging ? '!transition-all !duration-300 !ease-in-out' : ''}`}
            style={{
              flex: isMobile ? '0 0 0px' : panelFlex('fileList', isFileTreeOpen, sidebarWidth),
              minWidth: !isMobile && isFileTreeOpen ? `${SIDEBAR_MIN_WIDTH}px` : '0px',
            }}
          >
            <aside
              id="file-tree-panel"
              inert={!isFileTreeShown}
              className={`bg-github-bg-secondary overflow-y-auto flex flex-col ${
                isMobile
                  ? 'fixed inset-y-0 right-0 z-40 w-[min(85vw,360px)] border-l border-github-border transition-transform duration-300 ease-out'
                  : 'relative border-r border-github-border'
              }`}
              style={{
                width: isMobile
                  ? 'min(85vw, 360px)'
                  : isFileTreeOpen
                    ? '100%'
                    : `${sidebarWidth}px`,
                minWidth: isMobile ? '0px' : `${SIDEBAR_MIN_WIDTH}px`,
                maxWidth: isMobile ? 'none' : `${SIDEBAR_MAX_WIDTH}px`,
                height: '100%',
                transform: isMobile
                  ? isFileDrawerOpen
                    ? 'translateX(0)'
                    : 'translateX(100%)'
                  : undefined,
              }}
            >
              <div className="flex-1 overflow-y-auto">
                <FileList
                  ref={fileListRef}
                  files={diffData.files}
                  onScrollToFile={jumpToFile}
                  onFileSelected={isMobile ? handleMobileFileSelected : undefined}
                  comments={drawnThreads}
                  resolvedThreadIds={resolvedThreadIds}
                  reviewedFiles={viewedFiles}
                  onToggleReviewed={toggleFileReviewed}
                  onToggleFolderReviewed={toggleFolderReviewed}
                  selectedFileIndex={cursor?.fileIndex ?? null}
                  scrollVisibleFileIndex={scrollVisibleFileIndex}
                  pickedCommentFilePath={pickedThread?.file ?? null}
                  {...(isMobile && { onEscape: () => setIsFileDrawerOpen(false) })}
                  fixupTouchedFiles={fixupSpread.touchedReviewFiles}
                  fixupOnly={fixupSpread.fixupOnly}
                  focusedFixupFile={focusedFixupFile}
                  onRevealFixupFile={revealFixupFile}
                />
              </div>
              {showsCommitList && (
                <CommitList
                  review={review}
                  shown={shownView}
                  onSelect={selectView}
                  rangeStart={rangeStart}
                  openCounts={openCountsByCommit}
                  amendedMessages={amendedMessages}
                  reword={reword}
                  height={commitListHeight}
                  onResize={handleCommitListResize}
                />
              )}
              {!isMobile && (
                <div className="p-4 border-t border-github-border flex justify-between items-center">
                  <button
                    onClick={() => setIsHelpOpen(true)}
                    className="flex items-center gap-1.5 text-github-text-secondary hover:text-github-text-primary transition-colors"
                    title="Keyboard shortcuts (Shift+?)"
                  >
                    <Keyboard size={16} />
                    <span className="text-sm">Shortcuts</span>
                  </button>
                  <a
                    href="https://github.com/yoshiko-pg/difit"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-github-text-secondary hover:text-github-text-primary transition-colors"
                    title="View on GitHub"
                  >
                    <span className="text-sm">Star on GitHub</span>
                    <GitHubIcon style={{ height: '18px', width: '18px' }} />
                  </a>
                </div>
              )}
            </aside>
          </div>

          {!isMobile && (
            <div
              className={`shrink-0 bg-github-border hover:bg-github-text-muted cursor-col-resize ${!isDragging ? '!transition-all !duration-300 !ease-in-out' : ''}`}
              style={{
                width: isFileTreeOpen ? '4px' : '0px',
              }}
              onMouseDown={startResize('fileList', setSidebarWidth, clampSidebarWidth, 1)}
              title="Drag to resize file list"
            />
          )}

          <PickedThreadProvider value={pickedThread?.id ?? null}>
            <main
              ref={diffScrollContainerRef}
              className={`flex-1 overflow-y-auto ${showMobileCommentsBar ? 'pb-16' : ''}`}
              style={
                isMobile
                  ? undefined
                  : { minWidth: `min(${DIFF_MIN_WIDTH}px, calc(100% - ${reservedPanelWidth}px))` }
              }
            >
              {diffData.files.map((file, fileIndex) => {
                const fileThreads = threadsByFile.get(file.path) ?? EMPTY_COMMENT_THREADS;
                const mergedChunks =
                  getMergedChunksForVersion(mergedChunksState, diffDataVersion, file.path) ??
                  EMPTY_MERGED_CHUNKS;
                const isRendered = renderedFilePaths.has(file.path);
                return (
                  <div
                    key={file.path}
                    id={getFileElementId(file.path)}
                    data-file-path={file.path}
                    data-rendered={isRendered ? 'true' : 'false'}
                    ref={(node) => registerLazyFileContainer(file.path, node)}
                    className="mb-6"
                    onMouseEnter={() => {
                      hoveredFileIndexRef.current = fileIndex;
                    }}
                    onMouseLeave={() => {
                      if (hoveredFileIndexRef.current === fileIndex) {
                        hoveredFileIndexRef.current = null;
                      }
                    }}
                  >
                    {isRendered ? (
                      <DiffViewer
                        file={file}
                        threads={fileThreads}
                        showAuthorBadges={showAuthorBadges}
                        diffMode={diffMode}
                        reviewedFiles={viewedFiles}
                        isChangedSinceViewed={changedSinceViewedFiles.has(file.path)}
                        onToggleReviewed={handleViewedButtonToggle}
                        collapsedFiles={collapsedFiles}
                        onToggleCollapsed={toggleFileCollapsed}
                        onToggleAllCollapsed={toggleAllFilesCollapsed}
                        onAddComment={takesComments ? handleAddComment : undefined}
                        onAddFileComment={takesComments ? handleAddFileComment : undefined}
                        onResolveThread={resolveThread}
                        onReplyToThread={handleReplyToThread}
                        onRemoveMessage={removeMessage}
                        onUpdateMessage={updateMessage}
                        onOpenInEditor={canOpenInEditor ? handleOpenInEditor : undefined}
                        syntaxTheme={settings.syntaxTheme}
                        baseCommitish={diffData.baseCommitish}
                        targetCommitish={diffData.targetCommitish}
                        cursor={cursor?.fileIndex === fileIndex ? cursor : null}
                        isFocused={cursor?.fileIndex === fileIndex}
                        fileIndex={fileIndex}
                        onLineClick={handleLineClick}
                        commentTrigger={
                          commentTrigger?.fileIndex === fileIndex ? commentTrigger : null
                        }
                        onCommentTriggerHandled={handleCommentTriggerHandled}
                        mergedChunks={mergedChunks}
                        openLines={openLines}
                        prefetchFileContent={prefetchFileContent}
                        isExpandLoading={isExpandLoading}
                        diffVersion={diffDataVersion}
                        fixupOverlay={fixupOverlay}
                        foldCommentChanges={foldCommentChanges}
                      />
                    ) : (
                      <div className="bg-github-bg-secondary border border-github-border rounded-md px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-xs uppercase tracking-wide text-github-text-muted">
                              Deferred Rendering
                            </div>
                            <FilePathText
                              path={file.path}
                              className="text-sm font-mono text-github-text-primary"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => ensureFileRendered(file.path)}
                            className="px-3 py-1.5 text-xs rounded border border-github-border text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary"
                          >
                            Load now
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <FixupOnlySections
                groups={fixupSpread.fixupOnly}
                threadsByFixupFile={threadsByFixupOnlyFile}
                firstFileIndex={diffData.files.length}
                fixupOverlay={fixupOverlay}
                diffMode={diffMode}
                showAuthorBadges={showAuthorBadges}
                syntaxTheme={settings.syntaxTheme}
                onAddComment={takesComments ? handleAddFixupOnlyComment : undefined}
                onResolveThread={resolveThread}
                onReplyToThread={handleReplyToThread}
                onRemoveMessage={removeMessage}
                onUpdateMessage={updateMessage}
                onOpenInEditor={canOpenInEditor ? handleOpenInEditor : undefined}
              />
            </main>
          </PickedThreadProvider>

          {!isMobile && (
            <div
              className={`shrink-0 bg-github-border hover:bg-github-text-muted cursor-col-resize ${!isDragging ? '!transition-all !duration-300 !ease-in-out' : ''}`}
              style={{ width: isCommentsPanelOpen ? '4px' : '0px' }}
              onMouseDown={startResize(
                'comments',
                setCommentsPanelWidth,
                clampCommentsPanelWidth,
                -1,
              )}
              title="Drag to resize comments panel"
            />
          )}

          {!isMobile && (
            <div
              ref={commentsPanelBoxRef}
              data-comments-panel-box
              className={`relative overflow-hidden ${!isDragging ? '!transition-all !duration-300 !ease-in-out' : ''}`}
              style={{
                flex: panelFlex('comments', isCommentsPanelOpen, commentsPanelWidth),
                minWidth: isCommentsPanelOpen ? `${COMMENTS_PANEL_MIN_WIDTH}px` : '0px',
              }}
            >
              {isCommentsPanelOpen && (
                <aside
                  id="comments-panel"
                  aria-label="코멘트 패널"
                  className="h-full w-full border-l border-github-border bg-github-bg-secondary"
                >
                  {commentsPanelBody}
                </aside>
              )}
            </div>
          )}
        </div>

        {showMobileCommentsBar && (
          <div className="fixed bottom-0 left-0 right-0 z-20 bg-github-bg-secondary border-t border-github-border px-4 py-2 flex justify-end">
            <CommentsDropdown
              commentsCount={threads.length}
              openCount={fixupsLoaded ? openThreads.length : null}
              copyAllNotice={copyAllNotice}
              onCopyAll={handleCopyAllComments}
              onDeleteAll={clearAllComments}
              onViewAll={openCommentsPanelWithKeys}
              direction="up"
              compact
            />
          </div>
        )}

        {isSettingsOpen && (
          <SettingsModal
            isOpen={isSettingsOpen}
            onClose={() => setIsSettingsOpen(false)}
            settings={settings}
            onSettingsChange={updateSettings}
          />
        )}

        <HelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />

        {symbolPeek.stack.map((request, depth) => (
          <SymbolPeekModal
            key={`${depth}:${request.ref}:${request.name}:${request.from ?? ''}`}
            request={request}
            hidden={depth !== symbolPeek.stack.length - 1}
            canGoBack={depth > 0}
            onBack={symbolPeek.back}
            onClose={symbolPeek.close}
            syntaxTheme={settings.syntaxTheme}
            indexUpdates={symbolPeek.indexUpdates}
          />
        ))}
        {symbolPeek.offer && (
          <SymbolPeekChip
            name={symbolPeek.offer.request.name}
            x={symbolPeek.offer.x}
            y={symbolPeek.offer.y}
            onOpen={() => symbolPeek.offer && symbolPeek.open(symbolPeek.offer.request)}
          />
        )}
      </div>
    </WordHighlightProvider>
  );
}

export default App;
