import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { createServer, type Server } from 'http';
import { join, dirname, isAbsolute, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

import express, { type Express } from 'express';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { AUTOSQUASH_PREFIX, COMMIT_MESSAGE_PATH, REVIEWER_EDIT_AUTHOR } from '../types/diff.js';
import { type DiffMode, type WatchEvent } from '../types/watch.js';
import { amendedMessagesByCommit } from '../utils/amendedMessages.js';
import { formatCommentsOutput } from '../utils/commentFormatting.js';
import {
  extraLinesOfPosition,
  lineOfPosition,
  lineOfRange,
  positionOfLines,
} from '../utils/commentPosition.js';
import {
  mergeCommentImports,
  mergeCommentThreads,
  normalizeCommentImports,
  serializeCommentImports,
} from '../utils/commentImports.js';
import {
  buildEditorSpawnSpec,
  CUSTOM_EDITOR_ID,
  NONE_EDITOR_ID,
  resolveEditorOption,
} from '../utils/editorOptions.js';
import { withoutThreadTrailers } from '../utils/commitMessage.js';
import { createId } from '../utils/createId.js';
import { getFileExtension } from '../utils/fileUtils.js';
import { isSymbolName } from '../utils/symbolName.js';
import {
  deriveThreadReviewState,
  isAgentResponding,
  isAnswerableByEdit,
  isEditableOnCard,
  isOpenedByEdit,
  isThreadDeleted,
  isThreadResolved,
  mergeReviewDecisions,
  normalizeReviewDecisions,
  pendingFixupsFor,
  selectThreadsAwaitingAgent,
} from '../utils/reviewDecisions.js';

import { validateCommitish } from '../cli/utils.js';
import { sendToClaudeSession, sessionMessageFor } from './claude-session.js';
import { CLIENT_GONE_GRACE_MS, createClientPresence } from './client-presence.js';
import { commitDirectEdit, commitDirectReword, type EditedView } from './direct-edit.js';
import { chooseFixupTarget } from './fixup-target.js';
import { FileWatcherService } from './file-watcher.js';
import { GitDiffParser } from './git-diff.js';
import { findLibrarySource, sourceLocations } from './library-source.js';
import { type LineChanges, lineChangesBetween } from './line-changes.js';
import { acceptLiveSockets, isLiveSocketRequest } from './live-socket.js';
import { runGit } from './run-git.js';
import { ScipIndexBuilder, indexStateForClient, readBuildLog } from './scip-build.js';
import { type SymbolPosition, answerFromScipIndex, commitFiles, isJavaPath } from './scip-peek.js';
import { searchSymbol } from './symbol-search.js';
import { parseUserSettingsPatch, readUserConfig, updateUserClientSettings } from './user-config.js';

import {
  type BaseMode,
  type ChangeKindsResponse,
  type CommitMessageResponse,
  type CommentImport,
  type Comment,
  type CommentThread,
  type DiffCommentThread,
  type DiffLineRange,
  type DiffResponse,
  type DiffSelection,
  type DirectEditRejection,
  type DirectEditRequest,
  type DirectEditResponse,
  type FixupsResponse,
  type GeneratedStatusResponse,
  type ReviewDecision,
  type RevisionsResponse,
  type ReviewCommit,
  type ReviewScope,
  type RewordRejection,
  type RewordRequest,
  type RewordResponse,
  type LibrarySourceResponse,
  type SymbolIndexLogResponse,
  type SymbolSearchResponse,
  type ThreadAwaitingAgent,
  type ThreadFixup,
  type ThreadReviewState,
} from '@/types/diff.js';
import {
  bindingForView,
  commitsOfView,
  createDiffSelection,
  diffSelectionsEqual,
  fixupCommitOf,
  getDiffSelectionKey,
  isCommitHash,
  isCommitTarget,
  isSameCommit,
  isSameView,
  isViewOfReview,
} from '../utils/diffSelection.js';

interface ServerOptions {
  selection?: DiffSelection;
  stdinDiff?: string;
  preferredPort?: number;
  host?: string;
  openBrowser?: boolean;
  ignoreWhitespace?: boolean;
  clearComments?: boolean;
  commentImports?: CommentImport[];
  keepAlive?: boolean;
  diffMode?: DiffMode;
  repoPath?: string;
  contextLines?: number;
  followedRef?: string;
}

const GENERATED_STATUS_CACHE_TTL_MS = 60_000;
const DIRECT_EDIT_MESSAGE = '직접 고침';
const REWORD_MESSAGE = '메시지 직접 고침';
const LOOPBACK_ADDRESSES = new Set(['localhost', '127.0.0.1', '::1']);
// A Host header wraps an IPv6 address in brackets.
const LOOPBACK_HOST_HEADERS = new Set([...LOOPBACK_ADDRESSES, '[::1]']);
const MAX_DIFF_CACHE_ENTRIES = 8;
const INDEXED_ANCESTOR_DEPTH = 50;
const MAX_LINE_CHANGES = 16;
const MAX_SYMBOL_LENGTH = 4096;

function parseIntAtLeast(value: unknown, min: number): number | undefined {
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= min ? parsed : undefined;
}

function createDiffCacheKey(selection: DiffSelection, ignoreWhitespace: boolean) {
  return `${getDiffSelectionKey(selection)}\u0000${ignoreWhitespace ? '1' : '0'}`;
}

function getCachedDiffResponse(
  cache: Map<string, DiffResponse>,
  key: string,
): DiffResponse | undefined {
  const cached = cache.get(key);
  if (!cached) {
    return undefined;
  }

  // Refresh insertion order to keep the most recently used entry.
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function setCachedDiffResponse(cache: Map<string, DiffResponse>, key: string, value: DiffResponse) {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);

  while (cache.size > MAX_DIFF_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    cache.delete(oldestKey);
  }
}

interface CommentSessionState {
  threads: DiffCommentThread[];
  decisions: ReviewDecision[];
  version: number;
}

function createResolvedCommentSelection(
  responseDiffData: DiffResponse,
  fallbackSelection: DiffSelection,
  stdinDiff: boolean,
): DiffSelection {
  const baseCommitish =
    responseDiffData.baseCommitish ?? (stdinDiff ? 'stdin' : fallbackSelection.baseCommitish);
  const targetCommitish =
    responseDiffData.targetCommitish ?? (stdinDiff ? 'stdin' : fallbackSelection.targetCommitish);
  const baseMode = responseDiffData.requestedBaseMode ?? fallbackSelection.baseMode;

  return createDiffSelection(baseCommitish, targetCommitish, baseMode);
}

function createCommentSessionKey(selection: DiffSelection): string {
  return getDiffSelectionKey(selection);
}

export async function startServer(options: ServerOptions): Promise<{
  port: number;
  url: string;
  isEmpty?: boolean;
  server?: Server;
  settleDirectEdits?: () => Promise<unknown>;
  stopClientPresence?: () => boolean;
  endCommentWaits?: () => Promise<void>;
  stopSymbolIndex?: () => Promise<void>;
  // Settles once every index build that the opened reviews asked for has ended.
  settleSymbolIndex?: () => Promise<void>;
}> {
  const app = express();
  const repositoryPath = resolve(options.repoPath ?? process.cwd());
  const repositoryId = createHash('sha256').update(repositoryPath).digest('hex');
  const initialCommentImports = options.commentImports || [];
  const initialSelection = options.selection ?? createDiffSelection('', '');
  const commentImportId =
    initialCommentImports.length > 0
      ? createHash('sha256').update(serializeCommentImports(initialCommentImports)).digest('hex')
      : undefined;
  const parser = new GitDiffParser(repositoryPath);
  const fileWatcher = new FileWatcherService();
  const generatedStatusCache = new Map<
    string,
    { value: GeneratedStatusResponse; expiresAt: number }
  >();
  const diffDataCache = new Map<string, DiffResponse>();
  const changeKindsCache = new Map<string, ChangeKindsResponse>();
  const initialIgnoreWhitespace = options.ignoreWhitespace || false;
  const parseBaseMode = (value: unknown): BaseMode | undefined => {
    if (value === 'merge-base') {
      return 'merge-base';
    }

    return undefined;
  };

  // Editing writes commits, so it stays off whenever another machine could reach the server.
  const listensOnLoopbackOnly = !options.host || LOOPBACK_ADDRESSES.has(options.host);
  // A direct edit carries a whole hunk, which easily passes the default 100kb.
  const parseJson = express.json();
  const parseDirectEditJson = express.json({ limit: '64mb' });
  app.use((req, res, next) => {
    const directEdit =
      req.path === '/api/direct-edit' &&
      listensOnLoopbackOnly &&
      LOOPBACK_HOST_HEADERS.has(req.hostname);
    (directEdit ? parseDirectEditJson : parseJson)(req, res, next);
  });
  app.use(express.text()); // For sendBeacon text/plain requests

  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

  // Skip validation if using stdin diff
  if (!options.stdinDiff) {
    const isValidCommit = await parser.validateCommit(initialSelection.targetCommitish);
    if (!isValidCommit) {
      throw new Error(`Invalid or non-existent commit: ${initialSelection.targetCommitish}`);
    }
  }

  // Generate initial diff data for isEmpty check
  let initialDiffData: DiffResponse;
  if (options.stdinDiff) {
    // Parse stdin diff directly
    initialDiffData = parser.parseStdinDiff(options.stdinDiff);
  } else {
    initialDiffData = await parser.parseDiff(
      initialSelection,
      initialIgnoreWhitespace,
      options.contextLines,
    );
    setCachedDiffResponse(
      diffDataCache,
      createDiffCacheKey(initialSelection, initialIgnoreWhitespace),
      initialDiffData,
    );
  }

  // Function to invalidate cache when file changes are detected
  const invalidateCache = () => {
    diffDataCache.clear();
    generatedStatusCache.clear();
    changeKindsCache.clear();
    parser.clearResolvedCommitCache();
  };

  // Track current revisions for cache invalidation
  let currentSelection = initialSelection;
  let currentCommentSelection = createResolvedCommentSelection(
    initialDiffData,
    initialSelection,
    Boolean(options.stdinDiff),
  );
  // A target named by hash stays put while fixups pile up after it; HEAD or a branch moves with
  // them, so only such reviews carry review states.
  const pinnedCommentSessionKeys = new Set<string>();
  // Pinned reviews, newest last.
  const pinnedReviews: ReviewScope[] = [];
  // A part of the review being read stays on it even when a newer review also covers it.
  const findReviewOf = (view: DiffSelection) => {
    const newestFirst = [...pinnedReviews].reverse();
    const current = newestFirst.find((review) =>
      diffSelectionsEqual(review.selection, currentCommentSelection),
    );
    return (
      newestFirst.find((review) => diffSelectionsEqual(view, review.selection)) ??
      (current && isViewOfReview(view, current) ? current : undefined) ??
      newestFirst.find((review) => isViewOfReview(view, review))
    );
  };
  const reviewOf = async (
    requested: DiffSelection,
    resolved: DiffSelection,
  ): Promise<ReviewScope | undefined> => {
    if (options.stdinDiff) return undefined;
    const known = findReviewOf(resolved);
    if (known || !isCommitHash(requested.targetCommitish)) return known;
    let commits: ReviewScope['commits'] = [];
    try {
      commits = await parser.listReviewCommits(resolved);
    } catch (error) {
      console.error('Error listing review commits:', error);
    }
    const raced = findReviewOf(resolved);
    if (raced) return raced;
    const review = { selection: resolved, requested, commits };
    pinnedCommentSessionKeys.add(createCommentSessionKey(resolved));
    pinnedReviews.push(review);
    return review;
  };
  await reviewOf(initialSelection, currentCommentSelection);

  // A ref that rev-parse returns unchanged is a full hash and always names the same commit.
  const resolvedCommits = new Map<string, string>();
  const resolveCommit = async (ref: string): Promise<string | null> => {
    if (!isCommitTarget(ref) || !validateCommitish(ref)) return null;
    const known = resolvedCommits.get(ref);
    if (known) return known;
    const result = await runGit(repositoryPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ]);
    const commit = result.code === 0 ? result.stdout.toString('utf8').trim() : '';
    if (commit === '') return null;
    if (commit === ref) resolvedCommits.set(ref, commit);
    return commit;
  };
  const shownCommits = async (): Promise<string[]> => {
    const refs = [currentSelection, currentCommentSelection].flatMap((selection) => [
      selection.baseCommitish,
      selection.targetCommitish,
    ]);
    const commits = await Promise.all(refs.map((ref) => resolveCommit(ref)));
    return [...commits.filter((commit): commit is string => commit !== null), ...borrowedIndexes];
  };
  const isShownBase = async (commit: string): Promise<boolean> => {
    for (const selection of [currentSelection, currentCommentSelection]) {
      if (!isCommitTarget(selection.targetCommitish)) continue;
      if ((await resolveCommit(selection.baseCommitish)) === commit) return true;
    }
    return false;
  };
  const symbolIndex = options.stdinDiff
    ? undefined
    : new ScipIndexBuilder({ repoPath: repositoryPath, inUse: shownCommits });
  // Indexes of older commits that answer for commits of the shown view without one of their own.
  const borrowedIndexes = new Set<string>();
  const firstParents = new Map<string, Promise<string[]>>();
  const ancestorsOf = (commit: string): Promise<string[]> => {
    let known = firstParents.get(commit);
    if (!known) {
      known = runGit(repositoryPath, [
        'rev-list',
        '--first-parent',
        `--max-count=${INDEXED_ANCESTOR_DEPTH + 1}`,
        commit,
      ]).then((run) =>
        run.code === 0 ? run.stdout.toString('utf8').split('\n').filter(Boolean).slice(1) : [],
      );
      firstParents.set(commit, known);
    }
    return known;
  };
  // The nearest ancestor with an index, and an ancestor nearer still whose index is queued or
  // being built.
  const indexedAncestor = async (
    commit: string,
  ): Promise<{ ready: string | null; building: string | null }> => {
    let building: string | null = null;
    if (!symbolIndex) return { ready: null, building };
    for (const ancestor of await ancestorsOf(commit)) {
      const status = symbolIndex.state(ancestor).status;
      if (status === 'queued' || status === 'building') building ??= ancestor;
      else if (status === 'ready' || (await symbolIndex.useStored(ancestor))) {
        return { ready: ancestor, building };
      }
    }
    return { ready: null, building };
  };
  const fixupCommits = new Map<string, Promise<boolean>>();
  const isFixupCommit = (commit: string): Promise<boolean> => {
    let known = fixupCommits.get(commit);
    if (!known) {
      known = runGit(repositoryPath, ['log', '-1', '--format=%s', commit]).then(
        (run) => run.code === 0 && AUTOSQUASH_PREFIX.test(run.stdout.toString('utf8')),
      );
      fixupCommits.set(commit, known);
    }
    return known;
  };
  const borrowIndex = (ancestor: { ready: string | null; building: string | null }) => {
    for (const commit of [ancestor.ready, ancestor.building]) {
      if (commit) borrowedIndexes.add(commit);
    }
  };
  const borrowsIndex = async (commit: string): Promise<boolean> => {
    if (!(await isFixupCommit(commit))) return false;
    const ancestor = await indexedAncestor(commit);
    borrowIndex(ancestor);
    return ancestor.ready !== null || ancestor.building !== null;
  };
  const lineChanges = new Map<string, Promise<LineChanges | null>>();
  const lineChangesSince = (older: string, newer: string): Promise<LineChanges | null> => {
    const key = `${older}..${newer}`;
    let known = lineChanges.get(key);
    if (!known) {
      known = lineChangesBetween(repositoryPath, older, newer)
        .catch(() => null)
        .then((changes) => {
          if (!changes) lineChanges.delete(key);
          return changes;
        });
      lineChanges.set(key, known);
      for (const oldest of lineChanges.keys()) {
        if (lineChanges.size <= MAX_LINE_CHANGES) break;
        lineChanges.delete(oldest);
      }
    }
    return known;
  };
  const indexEvents = new Map<string, WatchEvent>();
  symbolIndex?.onChange((commit, state) => {
    const event: WatchEvent = {
      type: 'symbolIndexChanged',
      commit,
      state: indexStateForClient(state),
      timestamp: new Date().toISOString(),
    };
    indexEvents.set(commit, event);
    fileWatcher.broadcast(event);
  });
  const indexRequests = new Set<Promise<void>>();
  const indexReviewedCommit = (selection: DiffSelection) => {
    if (!symbolIndex) return;
    const pending: Promise<void> = (async () => {
      try {
        const commit = await resolveCommit(selection.targetCommitish);
        if (!commit) return;
        if (await isFixupCommit(commit)) {
          for (;;) {
            const ancestor = await indexedAncestor(commit);
            if (!diffSelectionsEqual(currentSelection, selection)) return;
            borrowIndex(ancestor);
            if (ancestor.ready) return;
            if (!ancestor.building) break;
            await symbolIndex.request(ancestor.building);
          }
        }
        await symbolIndex.request(commit);
      } catch (error) {
        console.error('Error starting the symbol index:', error);
      }
    })().finally(() => indexRequests.delete(pending));
    indexRequests.add(pending);
  };
  const settleSymbolIndex = async () => {
    while (indexRequests.size > 0) await Promise.all(indexRequests);
  };
  indexReviewedCommit(initialSelection);

  const canEditDirectly = (selection: DiffSelection) =>
    !options.stdinDiff &&
    listensOnLoopbackOnly &&
    pinnedCommentSessionKeys.has(createCommentSessionKey(selection));

  function parseRepositoryRelativePath(filepath: unknown):
    | { ok: true; path: string }
    | {
        ok: false;
        error: 'Invalid file path' | 'File path outside repository';
      } {
    if (typeof filepath !== 'string' || filepath.length === 0) {
      return { ok: false, error: 'Invalid file path' };
    }

    const normalizedFilepath = filepath.replace(/\\/g, '/');
    const hasParentTraversal = normalizedFilepath.split('/').some((segment) => segment === '..');
    if (isAbsolute(filepath) || normalizedFilepath.startsWith('/') || hasParentTraversal) {
      return { ok: false, error: 'File path outside repository' };
    }

    const resolvedPath = resolve(repositoryPath, normalizedFilepath);
    if (resolvedPath !== repositoryPath && !resolvedPath.startsWith(`${repositoryPath}${sep}`)) {
      return { ok: false, error: 'File path outside repository' };
    }

    return { ok: true, path: normalizedFilepath };
  }

  interface EditorRequest {
    readonly id: string | undefined;
    readonly command: string | undefined;
    readonly argsTemplate: string | undefined;
  }

  function parseEditorRequest(value: unknown): EditorRequest {
    if (!value || typeof value !== 'object') {
      return { id: undefined, command: undefined, argsTemplate: undefined };
    }
    const candidate = value as {
      id?: unknown;
      command?: unknown;
      argsTemplate?: unknown;
    };
    return {
      id: typeof candidate.id === 'string' ? candidate.id : undefined,
      command: typeof candidate.command === 'string' ? candidate.command : undefined,
      argsTemplate: typeof candidate.argsTemplate === 'string' ? candidate.argsTemplate : undefined,
    };
  }

  const commentSessions = new Map<string, CommentSessionState>();
  const initialCommentThreads = mergeCommentImports([], initialCommentImports).threads;
  if (initialCommentThreads.length > 0) {
    commentSessions.set(createCommentSessionKey(currentCommentSelection), {
      threads: initialCommentThreads,
      decisions: [],
      version: 1,
    });
  }

  function getCommentSelectionFromQuery(query: Record<string, unknown>): DiffSelection {
    const hasBase = typeof query.base === 'string';
    const hasTarget = typeof query.target === 'string';
    const hasBaseMode = typeof query.baseMode === 'string';

    if (!hasBase && !hasTarget && !hasBaseMode) {
      return currentCommentSelection;
    }

    const selection = createDiffSelection(
      hasBase ? (query.base as string) : currentCommentSelection.baseCommitish,
      hasTarget ? (query.target as string) : currentCommentSelection.targetCommitish,
      hasBaseMode
        ? parseBaseMode(query.baseMode)
        : hasBase || hasTarget
          ? undefined
          : currentCommentSelection.baseMode,
    );
    return findReviewOf(selection)?.selection ?? selection;
  }

  function getOrCreateCommentSession(selection: DiffSelection): CommentSessionState {
    const key = createCommentSessionKey(selection);
    const existing = commentSessions.get(key);
    if (existing) {
      return existing;
    }

    const nextSession: CommentSessionState = {
      threads: [],
      decisions: [],
      version: 0,
    };
    commentSessions.set(key, nextSession);
    return nextSession;
  }

  const selectionFromQuery = (query: express.Request['query']): DiffSelection => {
    const hasBase = typeof query.base === 'string';
    const hasTarget = typeof query.target === 'string';
    const hasBaseMode = typeof query.baseMode === 'string';
    return createDiffSelection(
      hasBase ? (query.base as string) : currentSelection.baseCommitish,
      hasTarget ? (query.target as string) : currentSelection.targetCommitish,
      hasBaseMode
        ? parseBaseMode(query.baseMode)
        : hasBase || hasTarget
          ? undefined
          : currentSelection.baseMode,
    );
  };

  app.get('/api/diff', async (req, res) => {
    const ignoreWhitespace = req.query.ignoreWhitespace === 'true';
    const requestedSelection = selectionFromQuery(req.query);
    const shouldIncludeCommentImports =
      initialCommentImports.length > 0 &&
      (Boolean(options.stdinDiff) || diffSelectionsEqual(requestedSelection, initialSelection));

    let responseDiffData = initialDiffData;
    if (!options.stdinDiff) {
      const cacheKey = createDiffCacheKey(requestedSelection, ignoreWhitespace);
      const cached = getCachedDiffResponse(diffDataCache, cacheKey);
      if (cached) {
        responseDiffData = cached;
      } else {
        try {
          responseDiffData = await parser.parseDiff(
            requestedSelection,
            ignoreWhitespace,
            options.contextLines,
          );
        } catch (error) {
          console.error('Error fetching diff:', error);
          res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to fetch diff',
          });
          return;
        }
        setCachedDiffResponse(diffDataCache, cacheKey, responseDiffData);
        generatedStatusCache.clear();
        changeKindsCache.clear();
      }
    }

    if (!diffSelectionsEqual(currentSelection, requestedSelection)) borrowedIndexes.clear();
    currentSelection = requestedSelection;

    const viewSelection = createResolvedCommentSelection(
      responseDiffData,
      requestedSelection,
      Boolean(options.stdinDiff),
    );
    const review = await reviewOf(requestedSelection, viewSelection);
    currentCommentSelection = review?.selection ?? viewSelection;
    indexReviewedCommit(requestedSelection);

    const baseCommitish =
      responseDiffData.baseCommitish ?? (options.stdinDiff ? 'stdin' : undefined);
    const targetCommitish =
      responseDiffData.targetCommitish ?? (options.stdinDiff ? 'stdin' : undefined);
    const requestedBaseCommitish =
      responseDiffData.requestedBaseCommitish ??
      (requestedSelection.baseCommitish || (options.stdinDiff ? 'stdin' : undefined));
    const requestedTargetCommitish =
      responseDiffData.requestedTargetCommitish ??
      (requestedSelection.targetCommitish || (options.stdinDiff ? 'stdin' : undefined));
    const requestedBaseMode = responseDiffData.requestedBaseMode ?? requestedSelection.baseMode;

    res.json({
      ...responseDiffData,
      ignoreWhitespace,
      openInEditorAvailable: !options.stdinDiff,
      directEditAvailable: canEditDirectly(currentCommentSelection),
      symbolSearchAvailable: !options.stdinDiff,
      baseCommitish,
      targetCommitish,
      requestedBaseCommitish,
      requestedTargetCommitish,
      requestedBaseMode,
      clearComments: options.clearComments,
      repositoryId,
      commentImports: shouldIncludeCommentImports ? initialCommentImports : undefined,
      commentImportId: shouldIncludeCommentImports ? commentImportId : undefined,
      review,
    });
  });

  // Takes the same query as /api/diff.
  app.get(/^\/api\/change-kinds\/(.*)$/, async (req, res) => {
    if (options.stdinDiff) {
      res.status(400).json({ error: 'Change kinds are not available for stdin diff' });
      return;
    }

    const filepathResult = parseRepositoryRelativePath(req.params[0]);
    if (!filepathResult.ok) {
      res.status(400).json({ error: filepathResult.error });
      return;
    }
    const ignoreWhitespace = req.query.ignoreWhitespace === 'true';
    const selection = selectionFromQuery(req.query);
    const diffCacheKey = createDiffCacheKey(selection, ignoreWhitespace);
    const cacheKey = `${diffCacheKey}\u0000${filepathResult.path}`;
    const cached = changeKindsCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    try {
      let diff = getCachedDiffResponse(diffDataCache, diffCacheKey);
      if (!diff) {
        diff = await parser.parseDiff(selection, ignoreWhitespace, options.contextLines);
        setCachedDiffResponse(diffDataCache, diffCacheKey, diff);
      }
      const file = diff.files.find((candidate) => candidate.path === filepathResult.path);
      if (!file) {
        res.status(404).json({ error: 'File is not in the diff' });
        return;
      }

      const classified = await parser.classifyDiffFile(selection, file);
      const response: ChangeKindsResponse = {
        path: file.path,
        chunks: classified.chunks.map(({ header, changeKind }) => ({ header, changeKind })),
      };
      changeKindsCache.set(cacheKey, response);
      res.json(response);
    } catch (error) {
      console.error('Error classifying changes:', error);
      res.status(500).json({ error: 'Failed to classify changes' });
    }
  });

  app.get(/^\/api\/generated-status\/(.*)$/, async (req, res) => {
    if (options.stdinDiff) {
      res.status(400).json({ error: 'Generated status is not available for stdin diff' });
      return;
    }

    try {
      const filepathResult = parseRepositoryRelativePath(req.params[0]);
      if (!filepathResult.ok) {
        res.status(400).json({ error: filepathResult.error });
        return;
      }
      const normalizedFilepath = filepathResult.path;

      const ref = (req.query.ref as string) || currentSelection.targetCommitish || 'HEAD';
      const cacheKey = `${ref}:${normalizedFilepath}`;
      const now = Date.now();
      const cached = generatedStatusCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        res.json(cached.value);
        return;
      }

      const status = await parser.getGeneratedStatus(normalizedFilepath, ref);
      const response: GeneratedStatusResponse = {
        path: normalizedFilepath,
        ref,
        ...status,
      };
      generatedStatusCache.set(cacheKey, {
        value: response,
        expiresAt: now + GENERATED_STATUS_CACHE_TTL_MS,
      });

      res.json(response);
    } catch (error) {
      console.error('Error fetching generated status:', error);
      res.status(500).json({ error: 'Failed to get generated status' });
    }
  });

  app.get('/api/symbol', async (req, res) => {
    if (options.stdinDiff) {
      res.status(404).json({ error: 'Symbol search is not available for stdin diff' });
      return;
    }

    const { name, ref, from } = req.query;
    if (typeof name !== 'string' || !isSymbolName(name)) {
      res.status(400).json({ error: 'Invalid symbol name' });
      return;
    }
    if (typeof ref !== 'string' || !validateCommitish(ref)) {
      res.status(400).json({ error: 'Invalid ref' });
      return;
    }
    const fromPath = typeof from === 'string' ? parseRepositoryRelativePath(from) : undefined;
    const path = fromPath?.ok ? fromPath.path : undefined;
    const line = parseIntAtLeast(req.query.line, 1);
    const column = parseIntAtLeast(req.query.column, 0);
    const at: SymbolPosition | undefined =
      path !== undefined && line !== undefined && column !== undefined
        ? { path, line, column }
        : undefined;
    const disconnected = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) disconnected.abort();
    });

    try {
      const clickedJava = path !== undefined && isJavaPath(path);
      const commit = symbolIndex && clickedJava ? await resolveCommit(ref) : null;
      if (commit && at && symbolIndex) {
        if ((await isShownBase(commit)) && !(await borrowsIndex(commit))) {
          await symbolIndex.start(commit, { urgent: true });
        } else if (!(await symbolIndex.useStored(commit))) {
          symbolIndex.hurry(commit);
        }
      }
      let askedIndex = false;
      const fromIndex = async () => {
        if (!commit || !at) return null;
        try {
          const index = await symbolIndex?.getIndex(commit);
          if (!index) return null;
          askedIndex = true;
          return await answerFromScipIndex(
            index,
            name,
            ref,
            at,
            commitFiles(repositoryPath, commit, disconnected.signal),
          );
        } catch (error) {
          if (!disconnected.signal.aborted) console.error('Error reading the symbol index:', error);
          return null;
        }
      };

      const fromAncestor = async () => {
        const status = commit ? symbolIndex?.state(commit).status : undefined;
        if (!commit || !at || !symbolIndex) return null;
        if (status === 'ready' || status === 'queued' || status === 'building') return null;
        try {
          const ancestor = await indexedAncestor(commit);
          borrowIndex(ancestor);
          if (ancestor.building) symbolIndex.hurry(ancestor.building);
          const [index, changes] = ancestor.ready
            ? await Promise.all([
                symbolIndex.getIndex(ancestor.ready),
                lineChangesSince(ancestor.ready, commit),
              ])
            : [null, null];
          const answer =
            index && changes
              ? await answerFromScipIndex(
                  index,
                  name,
                  ref,
                  at,
                  commitFiles(repositoryPath, commit, disconnected.signal),
                  changes,
                )
              : null;
          if (answer) return { answer };
          return ancestor.building ? { waitingFor: ancestor.building } : null;
        } catch (error) {
          if (!disconnected.signal.aborted) console.error('Error reading the symbol index:', error);
          return null;
        }
      };

      const indexed = await fromIndex();
      if (indexed) {
        res.json(indexed);
        return;
      }
      const borrowed = await fromAncestor();
      if (borrowed?.answer) {
        res.json(borrowed.answer);
        return;
      }
      const response: SymbolSearchResponse = await searchSymbol(
        repositoryPath,
        name,
        ref,
        path,
        disconnected.signal,
      );
      const state = commit ? symbolIndex?.state(commit) : undefined;
      // The index may have finished while the name search ran.
      const late = !askedIndex && state?.status === 'ready' ? await fromIndex() : null;
      if (late) {
        res.json(late);
        return;
      }
      const shown = borrowed?.waitingFor ?? commit;
      if (shown && at && symbolIndex) {
        response.index = { commit: shown, ...indexStateForClient(symbolIndex.state(shown)) };
      } else if (symbolIndex && at) {
        const unindexed = clickedJava ? 'not-commit' : 'not-java';
        const checked = isCommitTarget(ref)
          ? await resolveCommit(ref)
          : await resolveCommit('HEAD');
        if (checked && (await symbolIndex.indexable(checked)) === 'indexable') {
          response.unindexed = unindexed;
        }
      }
      res.json(response);
    } catch (error) {
      if (disconnected.signal.aborted) return;
      console.error('Error searching symbol:', error);
      res.status(404).json({ error: 'Could not search this revision' });
    }
  });

  app.get('/api/library-source', async (req, res) => {
    const { symbol } = req.query;
    if (typeof symbol !== 'string' || symbol.length === 0 || symbol.length > MAX_SYMBOL_LENGTH) {
      res.status(400).json({ error: 'Invalid symbol' });
      return;
    }
    try {
      const body: LibrarySourceResponse = await findLibrarySource(symbol, sourceLocations());
      res.json(body);
    } catch (error) {
      console.error('Error reading library source:', error);
      res.status(500).json({ error: 'Failed to read library source' });
    }
  });

  app.get('/api/symbol-index/:commit/log', async (req, res) => {
    const state = symbolIndex?.state(req.params.commit);
    if (state?.status !== 'failed' || !state.logPath) {
      res.status(404).json({ error: 'No build log for this commit' });
      return;
    }
    try {
      const body: SymbolIndexLogResponse = {
        path: state.logPath,
        text: await readBuildLog(state.logPath),
      };
      res.json(body);
    } catch {
      res.status(404).json({ error: 'No build log for this commit' });
    }
  });

  // Get available revisions for revision selector
  app.get('/api/revisions', async (_req, res) => {
    if (options.stdinDiff) {
      res.status(400).json({ error: 'Revision selection not available for stdin diff' });
      return;
    }

    try {
      const { branches, commits, originDefaultBranch, resolvedBase, resolvedTarget } =
        await parser.getRevisionOptions(
          currentSelection.baseCommitish,
          currentSelection.targetCommitish,
        );

      const response: RevisionsResponse = {
        specialOptions: [
          { value: '.', label: 'All Uncommitted Changes' },
          { value: 'staged', label: 'Staging Area' },
          { value: 'working', label: 'Working Directory' },
        ],
        branches,
        commits,
        originDefaultBranch,
        resolvedBase,
        resolvedTarget,
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching revisions:', error);
      res.status(500).json({ error: 'Failed to fetch revisions' });
    }
  });

  app.get(/^\/api\/line-count\/(.*)$/, async (req, res) => {
    try {
      if (options.stdinDiff) {
        res.status(404).json({ error: 'Line count not available for stdin diff' });
        return;
      }

      const filepathResult = parseRepositoryRelativePath(req.params[0]);
      if (!filepathResult.ok) {
        res.status(400).json({ error: filepathResult.error });
        return;
      }
      const filepath = filepathResult.path;
      const oldRef = req.query.oldRef as string | undefined;
      const oldPathResult = req.query.oldPath
        ? parseRepositoryRelativePath(req.query.oldPath)
        : { ok: true as const, path: filepath };
      if (!oldPathResult.ok) {
        res.status(400).json({ error: oldPathResult.error });
        return;
      }
      const newRef = req.query.newRef as string | undefined;
      const oldPath = oldPathResult.path;

      const result: { oldLineCount?: number; newLineCount?: number } = {};

      if (oldRef) {
        try {
          result.oldLineCount = await parser.getLineCount(oldPath, oldRef);
        } catch {
          result.oldLineCount = 0;
        }
      }
      if (newRef) {
        try {
          result.newLineCount = await parser.getLineCount(filepath, newRef);
        } catch {
          result.newLineCount = 0;
        }
      }

      res.json(result);
    } catch (error) {
      console.error('Error fetching line count:', error);
      res.status(500).json({ error: 'Failed to get line count' });
    }
  });

  app.get(/^\/api\/blob\/(.*)$/, async (req, res) => {
    try {
      // If using stdin diff, blob content is not available
      if (options.stdinDiff) {
        res.status(404).json({ error: 'Blob content not available for stdin diff' });
        return;
      }

      const filepathResult = parseRepositoryRelativePath(req.params[0]);
      if (!filepathResult.ok) {
        res.status(400).json({ error: filepathResult.error });
        return;
      }
      const filepath = filepathResult.path;
      const ref = (req.query.ref as string) || 'HEAD';

      const blob = await parser.getBlobContent(filepath, ref);

      // Determine content type based on file extension
      const ext = getFileExtension(filepath);
      const contentTypes: { [key: string]: string } = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        bmp: 'image/bmp',
        svg: 'image/svg+xml',
        webp: 'image/webp',
        ico: 'image/x-icon',
        tiff: 'image/tiff',
        tif: 'image/tiff',
        avif: 'image/avif',
        heic: 'image/heic',
        heif: 'image/heif',
      };

      const contentType = contentTypes[ext || ''] || 'application/octet-stream';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(blob);
    } catch (error) {
      console.error('Error fetching blob:', error);
      res.status(404).json({ error: 'File not found' });
    }
  });

  app.get('/api/fixup-target', async (req, res) => {
    const { base, target, path, start, end, side, scope, range } = req.query;
    const wholeFile = scope === 'file';
    const startLine = Number(start);
    const endLine = Number(end);
    const extraRanges = parseLineRanges(range);
    const filepathResult = parseRepositoryRelativePath(path);
    const view =
      typeof base === 'string' && typeof target === 'string'
        ? createDiffSelection(base, target)
        : undefined;
    const linesValid = wholeFile
      ? start === undefined && end === undefined && range === undefined
      : scope === undefined &&
        extraRanges !== null &&
        Number.isInteger(startLine) &&
        Number.isInteger(endLine) &&
        startLine >= 1 &&
        startLine <= endLine;
    if (!view || !filepathResult.ok || !linesValid || (side !== 'old' && side !== 'new')) {
      res.status(400).json({ error: 'Invalid fixup target request' });
      return;
    }
    const review = options.stdinDiff ? undefined : findReviewOf(view);
    if (!review) {
      res.status(404).json({ error: 'No review shows this view' });
      return;
    }
    const commits = commitsOfView(view, review).map((commit) => commit.sha);
    try {
      const fixupTarget = await chooseFixupTarget(repositoryPath, {
        view: { base: view.baseCommitish, target: view.targetCommitish },
        filePath: filepathResult.path,
        ...(wholeFile ? {} : { startLine, endLine, extraRanges: extraRanges ?? [] }),
        side,
        ...(commits.length > 0 ? { commits } : {}),
      });
      res.json({ fixupTarget });
    } catch (error) {
      console.error('Error choosing fixup target:', error);
      res.status(500).json({ error: 'Failed to choose fixup target' });
    }
  });

  // `range=12-12&range=40-41`; null when any of them is not a range of lines.
  function parseLineRanges(value: unknown): Array<{ start: number; end: number }> | null {
    if (value === undefined) return [];
    const values = Array.isArray(value) ? value : [value];
    const ranges = values.map((text) => {
      const match = typeof text === 'string' ? /^(\d+)-(\d+)$/.exec(text) : null;
      const start = Number(match?.[1]);
      const end = Number(match?.[2]);
      return match && start >= 1 && start <= end ? { start, end } : null;
    });
    return ranges.every((range) => range !== null) ? ranges : null;
  }

  function normalizeLineValue(line: unknown): DiffLineRange {
    if (Array.isArray(line) && line.length === 2) {
      const start = line[0] as unknown;
      const end = line[1] as unknown;
      if (
        typeof start === 'number' &&
        typeof end === 'number' &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start > 0 &&
        end > 0 &&
        start <= end
      ) {
        return { start, end };
      }
    }

    if (typeof line === 'number' && Number.isInteger(line) && line > 0) {
      return line;
    }

    return 1;
  }

  function normalizeComment(comment: Comment): DiffCommentThread {
    const now = new Date().toISOString();
    const timestamp = typeof comment.timestamp === 'string' ? comment.timestamp : now;
    const threadId =
      typeof comment.id === 'string' && comment.id.length > 0
        ? comment.id
        : createHash('sha256').update(JSON.stringify(comment)).digest('hex').slice(0, 12);
    const filePath =
      typeof comment.file === 'string' && comment.file.length > 0 ? comment.file : '<unknown file>';

    return {
      id: threadId,
      filePath,
      createdAt: timestamp,
      updatedAt: timestamp,
      position: {
        side: comment.side ?? 'new',
        line: normalizeLineValue(comment.line),
      },
      codeSnapshot:
        typeof comment.codeContent === 'string'
          ? {
              content: comment.codeContent,
            }
          : undefined,
      messages: [
        {
          id: threadId,
          body: comment.body,
          author: comment.author,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };
  }

  function toCommentThread(
    thread: DiffCommentThread,
    commits: readonly ReviewCommit[] = [],
  ): CommentThread {
    const line = lineOfPosition(thread.position);
    const extraLines = extraLinesOfPosition(thread.position);
    return {
      id: thread.id,
      file: thread.filePath,
      ...(line === undefined ? {} : { line }),
      ...(extraLines ? { extraLines } : {}),
      side: thread.position.side,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      codeContent: thread.codeSnapshot?.content,
      messages: thread.messages,
      ...(thread.fixupTarget === undefined
        ? {}
        : { fixupCommit: fixupCommitOf(thread.fixupTarget, commits) }),
    };
  }

  function normalizeThreadPayload(thread: CommentThread | DiffCommentThread): DiffCommentThread {
    if ('filePath' in thread && 'position' in thread) {
      return thread;
    }

    const threadId =
      typeof thread.id === 'string' && thread.id.length > 0
        ? thread.id
        : createHash('sha256').update(JSON.stringify(thread)).digest('hex').slice(0, 12);
    const now = new Date().toISOString();
    const messages =
      Array.isArray(thread.messages) && thread.messages.length > 0
        ? thread.messages.map((message, index) => ({
            id:
              typeof message.id === 'string' && message.id.length > 0
                ? message.id
                : `${threadId}:${index}`,
            body: message.body,
            author: message.author,
            createdAt: message.createdAt || thread.createdAt || now,
            updatedAt: message.updatedAt || message.createdAt || thread.updatedAt || now,
          }))
        : [
            {
              id: threadId,
              body: '',
              createdAt: thread.createdAt || now,
              updatedAt: thread.updatedAt || thread.createdAt || now,
            },
          ];
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];

    return {
      id: threadId,
      filePath:
        typeof thread.file === 'string' && thread.file.length > 0 ? thread.file : '<unknown file>',
      createdAt: thread.createdAt || firstMessage?.createdAt || now,
      updatedAt: thread.updatedAt || lastMessage?.updatedAt || thread.createdAt || now,
      position:
        thread.line === undefined
          ? { side: thread.side ?? 'new', scope: 'file' }
          : positionOfLines(thread.side ?? 'new', [
              lineOfRange(normalizeLineValue(thread.line)),
              ...(Array.isArray(thread.extraLines) ? thread.extraLines : []).map((line) =>
                lineOfRange(normalizeLineValue(line)),
              ),
            ]),
      codeSnapshot:
        typeof thread.codeContent === 'string'
          ? {
              content: thread.codeContent,
            }
          : undefined,
      messages,
    };
  }

  function parseCommentsPayload(body: unknown): DiffCommentThread[] {
    const payload =
      typeof body === 'string'
        ? (JSON.parse(body) as {
            comments?: Comment[];
            threads?: Array<CommentThread | DiffCommentThread>;
          })
        : (body as {
            comments?: Comment[];
            threads?: Array<CommentThread | DiffCommentThread>;
          });

    if (Array.isArray(payload.threads)) {
      return payload.threads.map(normalizeThreadPayload);
    }

    if (Array.isArray(payload.comments)) {
      return payload.comments.map(normalizeComment);
    }

    return [];
  }

  // Absent when an older client or the CLI pushes threads alone; the session copy is kept then.
  function parseDecisionsPayload(body: unknown): ReviewDecision[] | undefined {
    const payload: unknown = typeof body === 'string' ? JSON.parse(body) : body;
    if (!payload || typeof payload !== 'object' || !('decisions' in payload)) return undefined;
    return normalizeReviewDecisions((payload as { decisions?: unknown }).decisions);
  }

  // Version the client based its push on (omitted by older clients).
  function parseBaseVersion(payload: unknown): number | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const value = (payload as { baseVersion?: unknown }).baseVersion;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
  }

  function parseCommentImportsPayload(body: unknown): CommentImport[] {
    if (typeof body === 'string') {
      return normalizeCommentImports(JSON.parse(body));
    }

    return normalizeCommentImports(body);
  }

  function updateCommentSession(
    selection: DiffSelection,
    nextThreads: DiffCommentThread[],
    nextDecisions: ReviewDecision[] = getOrCreateCommentSession(selection).decisions,
  ): boolean {
    const session = getOrCreateCommentSession(selection);
    const previous = JSON.stringify([session.threads, session.decisions]);
    const next = JSON.stringify([nextThreads, nextDecisions]);
    session.threads = nextThreads;
    session.decisions = nextDecisions;

    if (previous === next) {
      return false;
    }

    session.version += 1;
    fileWatcher.broadcast({
      type: 'commentsChanged',
      version: session.version,
      timestamp: new Date().toISOString(),
    });
    for (const wait of commentWaits) void wait.check();
    return true;
  }

  async function fixupsByThreadFor(
    selection: DiffSelection,
  ): Promise<Map<string, ThreadFixup[]> | undefined> {
    if (options.stdinDiff || !pinnedCommentSessionKeys.has(createCommentSessionKey(selection))) {
      return undefined;
    }
    const fixups = await parser.listThreadFixups(selection);
    const byThread = new Map<string, ThreadFixup[]>();
    for (const fixup of fixups) {
      for (const threadId of fixup.threadIds) {
        byThread.set(threadId, [...(byThread.get(threadId) ?? []), fixup]);
      }
    }
    return byThread;
  }

  async function threadsAwaitingAgentFor(selection: DiffSelection): Promise<{
    waiting: ThreadAwaitingAgent[];
    fixupsByThread?: Map<string, ThreadFixup[]>;
  }> {
    try {
      const fixupsByThread = await fixupsByThreadFor(selection);
      const session = getOrCreateCommentSession(selection);
      return {
        waiting: selectThreadsAwaitingAgent(session.threads, fixupsByThread, session.decisions),
        ...(fixupsByThread ? { fixupsByThread } : {}),
      };
    } catch (error) {
      console.error('Error listing fixups:', error);
      return { waiting: [] };
    }
  }

  // A thread passed again within the same turn keeps its first handover.
  function recordHandover(
    selection: DiffSelection,
    waiting: ThreadAwaitingAgent[],
    fixupsByThread: Map<string, ThreadFixup[]> | undefined,
  ) {
    const session = getOrCreateCommentSession(selection);
    const at = new Date().toISOString();
    const handovers = waiting.flatMap(({ threadId }): ReviewDecision[] => {
      const thread = session.threads.find((candidate) => candidate.id === threadId);
      if (!thread || isAgentResponding(thread, fixupsByThread, session.decisions)) return [];
      return [{ threadId, kind: 'handed', fixupSha: '', at }];
    });
    if (handovers.length === 0) return;
    updateCommentSession(
      selection,
      session.threads,
      mergeReviewDecisions(session.decisions, handovers),
    );
  }

  interface CommentWait {
    check: () => Promise<void>;
    finish: (event: string) => Promise<void>;
  }
  const commentWaits = new Set<CommentWait>();
  let commentWaitsEnded = false;
  const REVIEW_ENDED_EVENT = 'event: end\ndata: review ended\n\n';

  async function endCommentWaits(): Promise<void> {
    commentWaitsEnded = true;
    await Promise.all([...commentWaits].map((wait) => wait.finish(REVIEW_ENDED_EVENT)));
  }

  // Only what the reviewer saves from the page is told: threads the agent itself added or copied
  // over, and fixups the reviewer committed by editing, need no answer.
  let sessionMessages: Promise<void> = Promise.resolve();
  function tellClaudeSession(
    selection: DiffSelection,
    before: Pick<CommentSessionState, 'threads' | 'decisions'>,
  ) {
    if (!process.env.CLAUDE_CODE_MESSAGING_SOCKET) return;
    const session = getOrCreateCommentSession(selection);
    const after = { threads: session.threads, decisions: session.decisions };
    sessionMessages = sessionMessages.then(async () => {
      let fixupsByThread: Map<string, ThreadFixup[]> | undefined;
      try {
        fixupsByThread = await fixupsByThreadFor(selection);
      } catch (error) {
        console.error('Error listing fixups:', error);
        return;
      }
      const turnKey = (threads: DiffCommentThread[], waiting: ThreadAwaitingAgent): string => {
        const lastMessageId = threads.find((t) => t.id === waiting.threadId)?.messages.at(-1)?.id;
        return JSON.stringify([
          waiting.threadId,
          waiting.state,
          lastMessageId,
          waiting.rejectedFixupShas,
        ]);
      };
      const known = new Set(
        selectThreadsAwaitingAgent(before.threads, fixupsByThread, before.decisions).map(
          (waiting) => turnKey(before.threads, waiting),
        ),
      );
      const fresh = selectThreadsAwaitingAgent(
        after.threads,
        fixupsByThread,
        after.decisions,
      ).filter((waiting) => !known.has(turnKey(after.threads, waiting)));
      if (fresh.length > 0 && (await sendToClaudeSession(sessionMessageFor(port, fresh)))) {
        recordHandover(selection, fresh, fixupsByThread);
      }
    });
  }

  app.post('/api/comments', (req, res) => {
    try {
      const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
      const body: unknown =
        typeof req.body === 'string' ? (JSON.parse(req.body) as unknown) : req.body;
      const nextThreads = parseCommentsPayload(body);
      const nextDecisions = parseDecisionsPayload(body);
      const baseVersion = parseBaseVersion(body);
      const session = getOrCreateCommentSession(selection);
      const before = { threads: session.threads, decisions: session.decisions };

      // Stale baseVersion means another writer (e.g. an agent) changed comments since the
      // client's last read, so merge rather than overwrite. A matching/absent version replaces.
      const isStale = typeof baseVersion === 'number' && baseVersion !== session.version;
      const resolvedThreads = isStale
        ? mergeCommentThreads(session.threads, nextThreads).threads
        : nextThreads;
      const resolvedDecisions =
        nextDecisions === undefined
          ? session.decisions
          : isStale
            ? mergeReviewDecisions(session.decisions, nextDecisions)
            : nextDecisions;

      if (updateCommentSession(selection, resolvedThreads, resolvedDecisions)) {
        tellClaudeSession(selection, before);
      }

      res.json({
        success: true,
        merged: isStale,
        version: session.version,
        threads: session.threads,
        decisions: session.decisions,
      });
    } catch (error) {
      console.error('Error parsing comments:', error);
      res.status(400).json({ error: 'Invalid comment data' });
    }
  });

  app.post('/api/comment-imports', (req, res) => {
    try {
      const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
      const session = getOrCreateCommentSession(selection);
      const commentImports = parseCommentImportsPayload(req.body);
      const importId = createHash('sha256')
        .update(serializeCommentImports(commentImports))
        .digest('hex');
      const merged = mergeCommentImports(
        session.threads,
        commentImports,
        (thread) => !isThreadDeleted(thread.id, session.decisions),
      );
      const changed = updateCommentSession(selection, merged.threads);

      res.json({
        success: true,
        changed,
        count: commentImports.length,
        importId,
        warnings: merged.warnings,
      });
    } catch (error) {
      console.error('Error parsing comment imports:', error);
      res.status(400).json({ error: 'Invalid comment import data' });
    }
  });

  app.delete('/api/comments/:threadId', (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(selection);
    const threadId = req.params.threadId;
    const nextThreads = session.threads.filter((thread) => thread.id !== threadId);

    if (nextThreads.length === session.threads.length) {
      res.status(404).json({ error: `Thread not found: ${threadId}` });
      return;
    }

    updateCommentSession(selection, nextThreads);

    res.json({
      success: true,
      threadId,
      version: session.version,
    });
  });

  app.get('/api/comments-json', (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(selection);
    res.json({
      version: session.version,
      threads: session.threads,
      decisions: session.decisions,
    });
  });

  app.post('/api/decisions', (req, res) => {
    try {
      const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
      const session = getOrCreateCommentSession(selection);
      const body: unknown = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const incoming = normalizeReviewDecisions(body);
      if (!Array.isArray(body) || incoming.length !== body.length) {
        res.status(400).json({ error: 'Expected an array of review decisions' });
        return;
      }
      const changed = updateCommentSession(
        selection,
        session.threads,
        mergeReviewDecisions(session.decisions, incoming),
      );
      res.json({ success: true, changed, count: incoming.length, version: session.version });
    } catch (error) {
      console.error('Error parsing decisions:', error);
      res.status(400).json({ error: 'Invalid decision data' });
    }
  });

  app.get('/api/fixups', async (req, res) => {
    if (options.stdinDiff) {
      res.json({ fixups: [] } satisfies FixupsResponse);
      return;
    }
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    const { followedRef } = options;
    try {
      const [fixups, newerTarget] = await Promise.all([
        parser.listFixupsForScreen(selection),
        followedRef
          ? parser.findNewerTarget(
              selection.targetCommitish,
              followedRef,
              initialSelection.targetCommitish,
            )
          : null,
      ]);
      res.json({ fixups, ...(newerTarget ? { newerTarget } : {}) } satisfies FixupsResponse);
    } catch (error) {
      console.error('Error listing fixups:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list fixups',
      });
    }
  });

  function parseDirectEditRequest(body: unknown): DirectEditRequest | null {
    if (!body || typeof body !== 'object') return null;
    const {
      filePath,
      startLine,
      endLine,
      original,
      replacement,
      threadId,
      view,
      fixupSha,
      approvedWith,
    } = body as Record<string, unknown>;
    const isLineNumber = (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value > 0;
    const isLines = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((line) => typeof line === 'string');
    if (
      typeof filePath !== 'string' ||
      !isLineNumber(startLine) ||
      !isLineNumber(endLine) ||
      startLine > endLine ||
      !isLines(original) ||
      original.length !== endLine - startLine + 1 ||
      !isLines(replacement) ||
      (threadId !== undefined && typeof threadId !== 'string')
    ) {
      return null;
    }
    if (fixupSha !== undefined) {
      if (
        typeof fixupSha !== 'string' ||
        threadId === undefined ||
        view !== undefined ||
        !isLines(approvedWith)
      ) {
        return null;
      }
      return {
        filePath,
        startLine,
        endLine,
        original,
        replacement,
        threadId,
        fixupSha,
        approvedWith,
      };
    }
    if (view === undefined) {
      return { filePath, startLine, endLine, original, replacement, threadId };
    }
    const { base, target } = (view ?? {}) as Record<string, unknown>;
    if (typeof base !== 'string' || typeof target !== 'string') return null;
    return {
      filePath,
      startLine,
      endLine,
      original,
      replacement,
      threadId,
      view: { base, target },
    };
  }

  const refuse = (
    reason: DirectEditRejection,
    output?: string,
  ): { status: number; body: DirectEditResponse } => ({
    status: 409,
    body: {
      error: `Direct edit refused: ${reason}`,
      reason,
      ...(output === undefined ? {} : { output }),
    },
  });

  async function applyDirectEdit(
    selection: DiffSelection,
    review: ReviewScope | undefined,
    view: DiffSelection,
    request: DirectEditRequest,
  ): Promise<{ status: number; body: DirectEditResponse }> {
    const commits =
      review && !isSameView(view, review.selection)
        ? commitsOfView(view, review).map((commit) => commit.sha)
        : [];
    const session = getOrCreateCommentSession(selection);
    const answered =
      request.threadId === undefined
        ? undefined
        : session.threads.find((thread) => thread.id === request.threadId);
    if (request.threadId !== undefined && !answered) {
      return { status: 404, body: { error: `Thread not found: ${request.threadId}` } };
    }
    if (answered && isOpenedByEdit(answered)) return refuse('thread-opened-by-edit');
    let editedView: EditedView = {
      base: view.baseCommitish,
      target: view.targetCommitish,
      ...(commits.length > 0 ? { commits } : {}),
    };
    let approvedWith: ThreadFixup[] = [];
    let cardFixups: ThreadFixup[] = [];
    const onCard = request.fixupSha !== undefined;
    // The card's fixup and those approved with it, while the thread still takes an edit on the card
    // and its fixups are the ones the reviewer saw.
    const standingCard = (
      thread: DiffCommentThread,
      fixups: ThreadFixup[],
      decisions: ReviewDecision[],
    ) => {
      const state = deriveThreadReviewState(thread.id, fixups, decisions, thread);
      const pending = pendingFixupsFor(thread.id, fixups, decisions);
      const seen = new Set(request.approvedWith);
      const unchanged =
        seen.size === pending.length && pending.every((fixup) => seen.has(fixup.sha));
      if (isThreadResolved(thread.id, decisions) || !isEditableOnCard(state) || !unchanged) {
        return undefined;
      }
      const card = pending.find((fixup) => fixup.sha === request.fixupSha);
      return card && { card, pending };
    };
    if (answered) {
      const fixups = (
        await (onCard ? parser.listFixupsForScreen(selection) : parser.listThreadFixups(selection))
      ).filter((fixup) => fixup.threadIds.includes(answered.id));
      if (!onCard) {
        const state = deriveThreadReviewState(answered.id, fixups, session.decisions, answered);
        if (isThreadResolved(answered.id, session.decisions) || !isAnswerableByEdit(state)) {
          return refuse('thread-has-fixup');
        }
      } else {
        const standing = standingCard(answered, fixups, session.decisions);
        if (!standing) return refuse('card-changed');
        const { card, pending } = standing;
        if (!card.foldTargetSha) return refuse('no-fold-target');
        const changed = new Set(
          card.files
            .filter((file) => file.path === request.filePath)
            .flatMap((file) => file.chunks.flatMap((chunk) => chunk.lines))
            .filter((line) => line.type === 'add')
            .map((line) => line.newLineNumber),
        );
        for (let line = request.startLine; line <= request.endLine; line++) {
          if (!changed.has(line)) return refuse('outside-fixup');
        }
        // Read at the card's fixup and folded where it folds; blame would send lines the fixup
        // added to the last commit of the review.
        editedView = {
          base: selection.baseCommitish,
          target: card.sha,
          commits: [card.foldTargetSha],
        };
        approvedWith = pending;
        cardFixups = fixups;
      }
    }

    const threadId = answered?.id ?? createId();
    const result = await commitDirectEdit(
      repositoryPath,
      { base: selection.baseCommitish, target: selection.targetCommitish },
      {
        filePath: request.filePath,
        startLine: request.startLine,
        endLine: request.endLine,
        original: request.original,
        replacement: request.replacement,
        threadId,
      },
      editedView,
    );
    if (!result.ok) return refuse(result.reason, result.output);
    const binding = review && bindingForView(review, view, result.fixupTarget);

    const patchId = (await parser.readThreadFixup(result.sha))?.patchId;
    // A judgment posted while the commit ran stands.
    const current = answered && session.threads.find((thread) => thread.id === answered.id);
    const cardChanged =
      onCard && (!current || !standingCard(current, cardFixups, session.decisions));
    const now = new Date().toISOString();
    const message = {
      id: answered ? createId() : threadId,
      body: DIRECT_EDIT_MESSAGE,
      author: REVIEWER_EDIT_AUTHOR,
      createdAt: now,
      updatedAt: now,
    };
    const nextThreads: DiffCommentThread[] = answered
      ? session.threads.map((thread) =>
          thread.id === threadId
            ? { ...thread, updatedAt: now, messages: [...thread.messages, message] }
            : thread,
        )
      : [
          ...session.threads,
          {
            id: threadId,
            filePath: request.filePath,
            createdAt: now,
            updatedAt: now,
            position: {
              side: 'new',
              line:
                request.startLine === request.endLine
                  ? request.startLine
                  : { start: request.startLine, end: request.endLine },
            },
            codeSnapshot: {
              content: request.original.join('\n'),
              commit: binding?.snapshotCommit ?? selection.targetCommitish,
            },
            messages: [message],
            ...(binding?.view ? { view: binding.view } : {}),
            ...(binding ? { fixupTarget: binding.fixupTarget } : {}),
          },
        ];
    updateCommentSession(
      selection,
      nextThreads,
      mergeReviewDecisions(
        session.decisions,
        (cardChanged ? [] : [...approvedWith, { sha: result.sha, patchId }]).map((fixup) => ({
          threadId,
          kind: 'approved' as const,
          fixupSha: fixup.sha,
          ...(fixup.patchId === undefined ? {} : { patchId: fixup.patchId }),
          at: now,
        })),
      ),
    );
    if (cardChanged) {
      const refused = refuse('card-changed');
      return { ...refused, body: { ...refused.body, sha: result.sha } };
    }
    return {
      status: 200,
      body: {
        success: true,
        sha: result.sha,
        threadId,
        version: session.version,
        threads: session.threads,
        decisions: session.decisions,
      },
    };
  }

  let directEditQueue: Promise<unknown> = Promise.resolve();

  app.post('/api/direct-edit', async (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    if (!canEditDirectly(selection)) {
      res.status(403).json({ error: 'Direct edit is not available for this review' });
      return;
    }
    // A page whose host name was rebound to this address still sends its own name as Host.
    if (!LOOPBACK_HOST_HEADERS.has(req.hostname)) {
      res.status(403).json({ error: 'Direct edit accepts requests to localhost only' });
      return;
    }
    // Only JSON needs a preflight, so a page on another site cannot post an edit.
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Expected application/json' });
      return;
    }
    const request = parseDirectEditRequest(req.body);
    const filepathResult = request ? parseRepositoryRelativePath(request.filePath) : null;
    const review = findReviewOf(selection);
    const view = request?.view
      ? createDiffSelection(request.view.base, request.view.target)
      : selection;
    if (
      !request ||
      !filepathResult?.ok ||
      (request.view && !(review && isViewOfReview(view, review)))
    ) {
      res.status(400).json({ error: 'Invalid direct edit request' });
      return;
    }

    const run = directEditQueue.then(() =>
      applyDirectEdit(selection, review, view, { ...request, filePath: filepathResult.path }),
    );
    directEditQueue = run.catch(() => undefined);
    try {
      const { status, body } = await run;
      res.status(status).json(body);
    } catch (error) {
      console.error('Error applying direct edit:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to apply direct edit',
      });
    }
  });

  const reviewCommitOf = (review: ReviewScope | undefined, commit: unknown) =>
    typeof commit === 'string' && commit.length > 0
      ? review?.commits.find(({ sha }) => isSameCommit(sha, commit))
      : undefined;

  async function messageAsReviewed(
    selection: DiffSelection,
    commit: ReviewCommit,
  ): Promise<string> {
    const { decisions } = getOrCreateCommentSession(selection);
    const fixups = await parser.listFixupsForScreen(selection);
    return (
      amendedMessagesByCommit(fixups, decisions).get(commit.sha) ??
      withoutThreadTrailers(await parser.readCommitMessage(commit.sha))
    );
  }

  app.get('/api/commit-message', async (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    const commit = reviewCommitOf(findReviewOf(selection), req.query.commit);
    if (!commit) {
      res.status(400).json({ error: 'Not a commit of this review' });
      return;
    }
    try {
      const body: CommitMessageResponse = { message: await messageAsReviewed(selection, commit) };
      res.json(body);
    } catch (error) {
      console.error('Error reading the commit message:', error);
      res.status(500).json({ error: 'Failed to read the commit message' });
    }
  });

  function parseRewordRequest(body: unknown): RewordRequest | null {
    if (!body || typeof body !== 'object') return null;
    const { commit, original, message } = body as Record<string, unknown>;
    if (typeof commit !== 'string' || typeof original !== 'string' || typeof message !== 'string') {
      return null;
    }
    return { commit, original, message };
  }

  const refuseReword = (
    reason: RewordRejection,
    output?: string,
  ): { status: number; body: RewordResponse } => ({
    status: 409,
    body: {
      error: `Reword refused: ${reason}`,
      reason,
      ...(output === undefined ? {} : { output }),
    },
  });

  async function applyReword(
    selection: DiffSelection,
    review: ReviewScope,
    commit: ReviewCommit,
    request: RewordRequest,
  ): Promise<{ status: number; body: RewordResponse }> {
    const current = await messageAsReviewed(selection, commit);
    if (withoutThreadTrailers(request.original) !== current) return refuseReword('stale-view');
    if (withoutThreadTrailers(request.message) === current) return refuseReword('no-change');

    const threadId = createId();
    const result = await commitDirectReword(repositoryPath, selection.targetCommitish, {
      commit: commit.sha,
      message: request.message,
      threadId,
    });
    if (!result.ok) return refuseReword(result.reason, result.output);
    const binding = bindingForView(
      review,
      createDiffSelection(commit.parentSha, commit.sha),
      commit.sha,
    );

    const session = getOrCreateCommentSession(selection);
    const patchId = (await parser.readThreadFixup(result.sha))?.patchId;
    const now = new Date().toISOString();
    updateCommentSession(
      selection,
      [
        ...session.threads,
        {
          id: threadId,
          filePath: COMMIT_MESSAGE_PATH,
          createdAt: now,
          updatedAt: now,
          position: { side: 'new', line: 1 },
          messages: [
            {
              id: threadId,
              body: REWORD_MESSAGE,
              author: REVIEWER_EDIT_AUTHOR,
              createdAt: now,
              updatedAt: now,
            },
          ],
          ...(binding?.view ? { view: binding.view } : {}),
          fixupTarget: commit.sha,
        },
      ],
      mergeReviewDecisions(session.decisions, [
        {
          threadId,
          kind: 'approved',
          fixupSha: result.sha,
          ...(patchId === undefined ? {} : { patchId }),
          at: now,
        },
      ]),
    );
    return {
      status: 200,
      body: {
        success: true,
        sha: result.sha,
        threadId,
        version: session.version,
        threads: session.threads,
        decisions: session.decisions,
      },
    };
  }

  app.post('/api/reword', async (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    if (!canEditDirectly(selection)) {
      res.status(403).json({ error: 'Rewording is not available for this review' });
      return;
    }
    if (!LOOPBACK_HOST_HEADERS.has(req.hostname)) {
      res.status(403).json({ error: 'Rewording accepts requests to localhost only' });
      return;
    }
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Expected application/json' });
      return;
    }
    const request = parseRewordRequest(req.body);
    const review = findReviewOf(selection);
    const commit = request ? reviewCommitOf(review, request.commit) : undefined;
    if (!request || !review || !commit) {
      res.status(400).json({ error: 'Invalid reword request' });
      return;
    }

    const run = directEditQueue.then(() => applyReword(selection, review, commit, request));
    directEditQueue = run.catch(() => undefined);
    try {
      const { status, body } = await run;
      res.status(status).json(body);
    } catch (error) {
      console.error('Error rewording a commit:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to reword the commit',
      });
    }
  });

  async function threadReviewStatesFor(
    selection: DiffSelection,
  ): Promise<Map<string, ThreadReviewState> | undefined> {
    try {
      const fixupsByThread = await fixupsByThreadFor(selection);
      if (!fixupsByThread) return undefined;
      const session = getOrCreateCommentSession(selection);
      return new Map(
        session.threads.map((thread) => [
          thread.id,
          deriveThreadReviewState(
            thread.id,
            fixupsByThread.get(thread.id) ?? [],
            session.decisions,
            thread,
          ),
        ]),
      );
    } catch (error) {
      console.error('Error listing fixups:', error);
      return undefined;
    }
  }

  async function renderCommentsOutput(selection: DiffSelection): Promise<string> {
    const session = getOrCreateCommentSession(selection);
    const threads = session.threads.filter(
      (thread) =>
        !isThreadResolved(thread.id, session.decisions) &&
        !isThreadDeleted(thread.id, session.decisions),
    );
    if (threads.length === 0) return '';
    const reviewStates = await threadReviewStatesFor(selection);
    const commits = findReviewOf(selection)?.commits;
    return formatCommentsOutput(
      threads.map((thread) => toCommentThread(thread, commits)),
      reviewStates,
    );
  }

  app.get('/api/comments-output', async (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    res.type('text/plain');
    res.send(await renderCommentsOutput(selection));
  });

  app.get('/api/user-settings', async (_req, res) => {
    const config = await readUserConfig();
    res.json(config);
  });

  app.put('/api/user-settings', async (req, res) => {
    let patch: Record<string, unknown> | null;
    try {
      const body: unknown = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      patch = parseUserSettingsPatch(body);
    } catch {
      patch = null;
    }

    if (!patch) {
      res.status(400).json({ error: 'Invalid user settings payload' });
      return;
    }

    try {
      const config = await updateUserClientSettings(patch);
      res.json(config);
    } catch (error) {
      console.error('Error saving user settings:', error);
      res.status(500).json({ error: 'Failed to save user settings' });
    }
  });

  app.post('/api/open-in-editor', async (req, res) => {
    if (options.stdinDiff) {
      res.status(400).json({ error: 'Open in editor is not available for stdin diff' });
      return;
    }

    const { filePath, line, editor } = (req.body ?? {}) as {
      filePath?: unknown;
      line?: unknown;
      editor?: unknown;
    };

    if (typeof filePath !== 'string') {
      res.status(400).json({ error: 'Invalid request payload' });
      return;
    }

    const filepathResult = parseRepositoryRelativePath(filePath);
    if (!filepathResult.ok) {
      res.status(400).json({ error: filepathResult.error });
      return;
    }
    const resolvedPath = resolve(repositoryPath, filepathResult.path);

    const editorRequest = parseEditorRequest(editor);
    const editorId =
      editorRequest.id ?? process.env.DIFIT_EDITOR ?? process.env.EDITOR ?? undefined;

    if (editorId?.toLowerCase() === NONE_EDITOR_ID) {
      res.status(400).json({ error: 'Open in editor is disabled' });
      return;
    }

    // The browser always sends command + argsTemplate in the body, so we use
    // those directly. We only fall back to the preset table when neither is
    // provided (for example, when DIFIT_EDITOR is set and there's no body).
    let command: string;
    let argsTemplate: string;
    if (editorRequest.command !== undefined || editorRequest.argsTemplate !== undefined) {
      command = (editorRequest.command ?? '').trim();
      argsTemplate = (editorRequest.argsTemplate ?? '').trim();
    } else {
      const preset = resolveEditorOption(editorId);
      command = preset.command;
      argsTemplate = preset.argsTemplate;
    }

    if (!command || !argsTemplate) {
      const isCustom = editorId?.toLowerCase() === CUSTOM_EDITOR_ID;
      res.status(400).json({
        error: isCustom
          ? 'Custom editor is not configured. Set a command and arguments in Settings > System.'
          : 'Open in editor is not configured',
      });
      return;
    }

    const lineNumber = (() => {
      const parsed = Number.parseInt(String(line ?? ''), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    })();

    const spawnSpec = buildEditorSpawnSpec({
      command,
      argsTemplate,
      filePath: resolvedPath,
      lineNumber,
    });

    if (!spawnSpec) {
      res.status(500).json({ error: 'Invalid editor configuration' });
      return;
    }

    const launched = await new Promise<boolean>((resolvePromise) => {
      const child = spawn(spawnSpec.command, [...spawnSpec.args], {
        stdio: 'ignore',
        detached: true,
      });
      child.once('error', (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== 'ENOENT') {
          console.error('Failed to launch editor CLI:', error);
        }
        resolvePromise(false);
      });
      child.once('spawn', () => {
        child.unref();
        resolvePromise(true);
      });
    });

    if (!launched) {
      res.status(500).json({
        error: `Failed to launch editor: command "${spawnSpec.command}" is not available on PATH`,
      });
      return;
    }

    res.json({ success: true });
  });

  // Function to output comments when server shuts down
  async function outputFinalComments() {
    const output = await renderCommentsOutput(currentCommentSelection);
    if (output) {
      console.log(output);
    }
  }

  app.get('/api/comments-wait', (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (commentWaitsEnded) {
      res.end(REVIEW_ENDED_EVENT);
      return;
    }
    res.write(': waiting\n\n');
    // fetch gives up on a body that stays silent for five minutes.
    const ping = setInterval(() => res.write(': ping\n\n'), 30_000);
    const wait: CommentWait = {
      check: async () => {
        const { waiting, fixupsByThread } = await threadsAwaitingAgentFor(selection);
        if (waiting.length > 0 && commentWaits.has(wait)) {
          await wait.finish(`event: threads\ndata: ${JSON.stringify(waiting)}\n\n`);
          recordHandover(selection, waiting, fixupsByThread);
        }
      },
      finish: (event) => {
        if (!commentWaits.delete(wait)) return Promise.resolve();
        clearInterval(ping);
        return new Promise((resolve) => res.end(event, () => resolve()));
      },
    };
    commentWaits.add(wait);
    req.on('close', () => {
      commentWaits.delete(wait);
      clearInterval(ping);
    });
    void wait.check();
  });

  const clientPresence = createClientPresence(() => {
    void (async () => {
      console.log('All tabs closed, shutting down server...');
      await fileWatcher.stop();
      await symbolIndex?.stop();
      await directEditQueue;
      await endCommentWaits();
      await outputFinalComments();
      process.exit(0);
    })();
  }, CLIENT_GONE_GRACE_MS);

  // Always runs in production mode when distributed as a CLI tool
  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV !== 'development';

  if (isProduction) {
    // Find client files relative to the CLI executable location
    const distPath = join(__dirname, '..', 'client');
    app.use(express.static(distPath));
  } else {
    app.get('/', (_req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>difit - Dev Mode</title>
          </head>
          <body>
            <div id="root"></div>
            <script>
              console.log('difit development mode');
              console.log('Diff data available at /api/diff');
            </script>
          </body>
        </html>
      `);
    });
  }

  const { port, url, server } = await startServerWithFallback(
    app,
    options.preferredPort || 4966,
    options.host || 'localhost',
  );
  server.on('close', () => clientPresence.stop());
  acceptLiveSockets(server, (socket) => {
    fileWatcher.addClient(socket, [...indexEvents.values()]);
    const leave = options.keepAlive ? undefined : clientPresence.join();
    socket.on('close', () => {
      fileWatcher.removeClient(socket);
      if (leave) {
        leave();
      } else {
        console.log('Client disconnected, but server is staying alive (--keep-alive)');
        console.log('Press Ctrl+C to stop the server');
      }
    });
  });

  // Security warning for non-localhost binding
  if (options.host && !LOOPBACK_ADDRESSES.has(options.host)) {
    console.warn('\n⚠️  WARNING: Server is accessible from external network!');
    console.warn(`   Binding to: ${options.host}:${port}`);
    console.warn('   Make sure this is intended and your network is secure.\n');
  }

  // Start file watcher
  if (options.diffMode) {
    try {
      await fileWatcher.start(options.diffMode, repositoryPath, 300, invalidateCache);
    } catch (error) {
      console.warn('⚠️  File watcher failed to start:', error);
      console.warn('   Continuing without file watching...');
    }
  }

  // Check if diff is empty and skip browser opening
  if (initialDiffData.isEmpty) {
    // Don't open browser if no differences found
  } else if (options.openBrowser) {
    try {
      await open(url);
    } catch {
      console.warn('Failed to open browser automatically');
    }
  }

  return {
    port,
    url,
    isEmpty: initialDiffData.isEmpty || false,
    server,
    settleDirectEdits: () => directEditQueue,
    stopClientPresence: () => clientPresence.stop(),
    endCommentWaits,
    stopSymbolIndex: async () => {
      await symbolIndex?.stop();
    },
    settleSymbolIndex,
  };
}

async function startServerWithFallback(
  app: Express,
  preferredPort: number,
  host: string,
): Promise<{ port: number; url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer({ shouldUpgradeCallback: isLiveSocketRequest }, app);
    let settled = false;
    const onListen = (err?: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      const displayHost = host === '0.0.0.0' ? 'localhost' : host;
      const url = `http://${displayHost}:${preferredPort}`;
      if (!err) {
        resolve({ port: preferredPort, url, server });
        return;
      }

      // Handling errors when failed to launch a server
      switch (err.code) {
        // Try another port until it succeeds
        case 'EADDRINUSE': {
          console.log(`Port ${preferredPort} is busy, trying ${preferredPort + 1}...`);
          return startServerWithFallback(app, preferredPort + 1, host)
            .then(({ port, url, server }) => {
              resolve({ port, url, server });
            })
            .catch(reject);
        }
        // Unexpected error
        default: {
          reject(new Error(`Failed to launch a server: ${err.message}`));
        }
      }
    };
    server.once('error', onListen);
    server.listen(preferredPort, host, onListen);
  });
}
