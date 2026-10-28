import { useState, useEffect, useCallback, useRef } from 'react';

import {
  type BaseMode,
  type ChoiceAnswer,
  type CommentImport,
  type CommentThread,
  type DiffContextStorage,
  type DiffCommentThread,
  type DiffLineRange,
  type ExtraLineRange,
  type DiffSide,
  type LegacyDiffComment,
  type FixupRef,
  type ReviewDecision,
  type ReviewDecisionKind,
  REVIEWER_AUTHOR,
} from '../../types/diff';
import {
  type CommentPromptDiffContext,
  formatCommentThreadPrompt,
  formatAllCommentThreadsPrompt,
} from '../../utils/commentFormatting';
import { createId } from '../../utils/createId';
import { mergeCommentImports } from '../../utils/commentImports';
import { extraLinesOfPosition, lineOfPosition } from '../../utils/commentPosition';
import { isCommitTarget, type ViewBinding } from '../../utils/diffSelection';
import { mergeReviewDecisions } from '../../utils/reviewDecisions';
import { storageService } from '../services/StorageService';
import { getLanguageFromPath } from '../utils/diffUtils';

interface AddThreadParams {
  filePath: string;
  body: string;
  side: DiffSide;
  // Left out for a comment on the whole file.
  line?: DiffLineRange;
  // The comment's other ranges, in the order of a position's `extraRanges`.
  extraRanges?: ExtraLineRange[];
  codeSnapshot?: DiffCommentThread['codeSnapshot'];
  binding?: ViewBinding;
}

interface ReplyToThreadParams {
  threadId: string;
  body: string;
  answer?: ChoiceAnswer;
}

interface UseDiffCommentsReturn {
  hasLoadedComments: boolean;
  comments: LegacyDiffComment[];
  threads: DiffCommentThread[];
  decisions: ReviewDecision[];
  replaceThreads: (threads: DiffCommentThread[]) => void;
  mergeDecisions: (decisions: ReviewDecision[]) => void;
  recordDecision: (
    threadId: string,
    kind: ReviewDecisionKind,
    fixupSha: string,
    patchId?: string,
  ) => void;
  // Records one decision per fixup, all at the same instant.
  recordFixupDecisions: (
    threadId: string,
    kind: ReviewDecisionKind,
    fixups: readonly FixupRef[],
  ) => void;
  undoApproval: (threadId: string) => void;
  addComment: (params: AddThreadParams) => LegacyDiffComment;
  addThread: (params: AddThreadParams) => DiffCommentThread;
  removeComment: (commentId: string) => void;
  replyToThread: (params: ReplyToThreadParams) => void;
  removeThread: (threadId: string) => void;
  updateComment: (commentId: string, newBody: string) => void;
  removeMessage: (threadId: string, messageId: string) => void;
  updateMessage: (threadId: string, messageId: string, newBody: string) => void;
  clearAllComments: (options?: { resetAppliedCommentImportIds?: boolean }) => void;
  applyCommentImports: (imports: CommentImport[], importId: string) => string[];
  generatePrompt: (commentId: string) => string;
  generateAllCommentsPrompt: (
    context?: CommentPromptDiffContext,
    only?: DiffCommentThread[],
  ) => string;
}

function normalizeThread(thread: DiffCommentThread): CommentThread {
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
  };
}

function normalizeRootComment(thread: DiffCommentThread): LegacyDiffComment | null {
  const rootMessage = thread.messages[0];
  if (!rootMessage) return null;

  return {
    id: thread.id,
    filePath: thread.filePath,
    body: rootMessage.body,
    author: rootMessage.author,
    createdAt: rootMessage.createdAt,
    updatedAt: rootMessage.updatedAt,
    position: thread.position,
    codeSnapshot: thread.codeSnapshot,
  };
}

export function useDiffComments(
  baseCommitish?: string,
  targetCommitish?: string,
  currentCommitHash?: string,
  branchToHash?: Map<string, string>,
  repositoryId?: string,
  baseMode?: BaseMode,
): UseDiffCommentsReturn {
  const [threads, setThreads] = useState<DiffCommentThread[]>([]);
  const [decisions, setDecisions] = useState<ReviewDecision[]>([]);
  const reviewKey = [repositoryId, baseMode, baseCommitish, targetCommitish].join('|');
  // Decisions of the review currently loaded; callbacks of a review switched away from write nothing.
  const decisionsRef = useRef({ reviewKey, list: decisions });
  const [hasLoadedComments, setHasLoadedComments] = useState(false);

  const loadDiffContextData = useCallback(() => {
    if (!baseCommitish || !targetCommitish) {
      return null;
    }

    return storageService.getDiffContextData(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
  }, [baseCommitish, targetCommitish, currentCommitHash, branchToHash, repositoryId, baseMode]);

  const createEmptyDiffContext = useCallback((): DiffContextStorage | null => {
    if (!baseCommitish || !targetCommitish) {
      return null;
    }

    const now = new Date().toISOString();
    return {
      version: 2,
      baseCommitish,
      targetCommitish,
      baseMode,
      createdAt: now,
      lastModifiedAt: now,
      threads: [],
      viewedFiles: [],
      appliedCommentImportIds: [],
      decisions: [],
    };
  }, [baseCommitish, targetCommitish, baseMode]);

  useEffect(() => {
    if (!baseCommitish || !targetCommitish) {
      setThreads([]);
      decisionsRef.current = { reviewKey, list: [] };
      setDecisions([]);
      setHasLoadedComments(false);
      return;
    }

    const loadedData = loadDiffContextData();
    const loadedThreads =
      loadedData?.threads ||
      storageService.getCommentThreads(
        baseCommitish,
        targetCommitish,
        currentCommitHash,
        branchToHash,
        repositoryId,
        baseMode,
      );
    setThreads(loadedThreads);
    decisionsRef.current = { reviewKey, list: loadedData?.decisions ?? [] };
    setDecisions(decisionsRef.current.list);
    setHasLoadedComments(true);
  }, [
    baseCommitish,
    targetCommitish,
    currentCommitHash,
    branchToHash,
    repositoryId,
    baseMode,
    loadDiffContextData,
    reviewKey,
  ]);

  const saveThreads = useCallback(
    (newThreads: DiffCommentThread[]) => {
      if (!baseCommitish || !targetCommitish) return;

      storageService.saveCommentThreads(
        baseCommitish,
        targetCommitish,
        newThreads,
        currentCommitHash,
        branchToHash,
        repositoryId,
        baseMode,
      );
      setThreads(newThreads);
      setHasLoadedComments(true);
    },
    [baseCommitish, targetCommitish, currentCommitHash, branchToHash, repositoryId, baseMode],
  );

  const replaceThreads = useCallback(
    (newThreads: DiffCommentThread[]) => {
      saveThreads(newThreads);
    },
    [saveThreads],
  );

  const saveDecisions = useCallback(
    (newDecisions: ReviewDecision[]) => {
      if (!baseCommitish || !targetCommitish) return;
      if (decisionsRef.current.reviewKey !== reviewKey) return;

      const existingData = loadDiffContextData() || createEmptyDiffContext();
      if (!existingData) return;

      storageService.saveDiffContextData(
        baseCommitish,
        targetCommitish,
        { ...existingData, decisions: newDecisions },
        currentCommitHash,
        branchToHash,
        repositoryId,
        baseMode,
      );
      decisionsRef.current = { reviewKey, list: newDecisions };
      setDecisions(newDecisions);
    },
    [
      reviewKey,
      baseCommitish,
      targetCommitish,
      branchToHash,
      createEmptyDiffContext,
      currentCommitHash,
      loadDiffContextData,
      repositoryId,
      baseMode,
    ],
  );

  const mergeDecisions = useCallback(
    (incoming: ReviewDecision[]) => {
      const current = decisionsRef.current.list;
      const merged = mergeReviewDecisions(current, incoming);
      if (JSON.stringify(merged) === JSON.stringify(current)) return;
      saveDecisions(merged);
    },
    [saveDecisions],
  );

  const recordFixupDecisions = useCallback(
    (threadId: string, kind: ReviewDecisionKind, fixups: readonly FixupRef[]) => {
      const at = new Date().toISOString();
      saveDecisions(
        mergeReviewDecisions(
          decisionsRef.current.list,
          fixups.map(({ fixupSha, patchId }) => ({ threadId, kind, fixupSha, patchId, at })),
        ),
      );
    },
    [saveDecisions],
  );

  const recordDecision = useCallback(
    (threadId: string, kind: ReviewDecisionKind, fixupSha: string, patchId?: string) =>
      recordFixupDecisions(threadId, kind, [{ fixupSha, patchId }]),
    [recordFixupDecisions],
  );

  const undoApproval = useCallback(
    (threadId: string) => {
      const approvals = decisionsRef.current.list.filter(
        (decision) => decision.threadId === threadId && decision.kind === 'approved',
      );
      const approval = approvals[approvals.length - 1];
      if (!approval) return;
      recordDecision(threadId, 'unapproved', approval.fixupSha, approval.patchId);
    },
    [recordDecision],
  );

  const addThread = useCallback(
    (params: AddThreadParams): DiffCommentThread => {
      const now = new Date().toISOString();
      const threadId = createId();
      const { binding } = params;
      const commit =
        binding?.snapshotCommit ??
        (targetCommitish && isCommitTarget(targetCommitish) ? targetCommitish : undefined);
      const newThread: DiffCommentThread = {
        id: threadId,
        filePath: params.filePath,
        createdAt: now,
        updatedAt: now,
        position:
          params.line === undefined
            ? { side: params.side, scope: 'file' }
            : {
                side: params.side,
                line: params.line,
                ...(params.extraRanges?.length ? { extraRanges: params.extraRanges } : {}),
              },
        codeSnapshot: {
          ...(params.codeSnapshot ?? {
            content: '',
            language: getLanguageFromPath(params.filePath),
          }),
          commit,
        },
        messages: [
          {
            id: threadId,
            body: params.body,
            author: REVIEWER_AUTHOR,
            createdAt: now,
            updatedAt: now,
          },
        ],
        ...(binding?.view ? { view: binding.view } : {}),
        ...(binding ? { fixupTarget: binding.fixupTarget } : {}),
      };

      const newThreads = [...threads, newThread];
      saveThreads(newThreads);
      return newThread;
    },
    [saveThreads, threads, targetCommitish],
  );

  const addComment = useCallback(
    (params: AddThreadParams): LegacyDiffComment => {
      const thread = addThread(params);
      const rootComment = normalizeRootComment(thread);
      if (!rootComment) {
        throw new Error('Failed to create root comment');
      }
      return rootComment;
    },
    [addThread],
  );

  const replyToThread = useCallback(
    ({ threadId, body, answer }: ReplyToThreadParams) => {
      const now = new Date().toISOString();
      const newThreads = threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              updatedAt: now,
              messages: [
                ...thread.messages,
                {
                  id: createId(),
                  body,
                  author: REVIEWER_AUTHOR,
                  createdAt: now,
                  updatedAt: now,
                  ...(answer ? { answer } : {}),
                },
              ],
            }
          : thread,
      );
      saveThreads(newThreads);
    },
    [saveThreads, threads],
  );

  const removeThread = useCallback(
    (threadId: string) => {
      const newThreads = threads.filter((thread) => thread.id !== threadId);
      saveThreads(newThreads);
    },
    [saveThreads, threads],
  );

  const removeComment = useCallback(
    (commentId: string) => {
      removeThread(commentId);
    },
    [removeThread],
  );

  const removeMessage = useCallback(
    (threadId: string, messageId: string) => {
      const thread = threads.find((item) => item.id === threadId);
      if (!thread) return;

      const targetIndex = thread.messages.findIndex((message) => message.id === messageId);
      if (targetIndex < 0) {
        return;
      }

      if (targetIndex === 0) {
        removeThread(threadId);
        return;
      }

      const now = new Date().toISOString();
      const newThreads = threads.map((item) =>
        item.id === threadId
          ? {
              ...item,
              updatedAt: now,
              messages: item.messages.filter((message) => message.id !== messageId),
            }
          : item,
      );
      saveThreads(newThreads);
    },
    [removeThread, saveThreads, threads],
  );

  const updateMessage = useCallback(
    (threadId: string, messageId: string, newBody: string) => {
      const now = new Date().toISOString();
      const newThreads = threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              updatedAt: now,
              messages: thread.messages.map((message) =>
                message.id === messageId ? { ...message, body: newBody, updatedAt: now } : message,
              ),
            }
          : thread,
      );
      saveThreads(newThreads);
    },
    [saveThreads, threads],
  );

  const updateComment = useCallback(
    (commentId: string, newBody: string) => {
      updateMessage(commentId, commentId, newBody);
    },
    [updateMessage],
  );

  const clearAllComments = useCallback(() => {
    saveThreads([]);
    saveDecisions([]);
  }, [saveDecisions, saveThreads]);

  const clearAllCommentsWithOptions = useCallback(
    (options?: { resetAppliedCommentImportIds?: boolean }) => {
      if (!options?.resetAppliedCommentImportIds) {
        clearAllComments();
        return;
      }

      const existingData = loadDiffContextData() || createEmptyDiffContext();
      if (!existingData || !baseCommitish || !targetCommitish) {
        return;
      }

      const nextData: DiffContextStorage = {
        ...existingData,
        threads: [],
        appliedCommentImportIds: [],
        decisions: [],
      };

      storageService.saveDiffContextData(
        baseCommitish,
        targetCommitish,
        nextData,
        currentCommitHash,
        branchToHash,
        repositoryId,
        baseMode,
      );
      setThreads([]);
      decisionsRef.current = { reviewKey, list: [] };
      setDecisions([]);
    },
    [
      baseCommitish,
      targetCommitish,
      branchToHash,
      clearAllComments,
      createEmptyDiffContext,
      currentCommitHash,
      loadDiffContextData,
      repositoryId,
      reviewKey,
      baseMode,
    ],
  );

  const applyCommentImports = useCallback(
    (imports: CommentImport[], importId: string): string[] => {
      if (!baseCommitish || !targetCommitish || imports.length === 0 || importId.length === 0) {
        return [];
      }

      const existingData = loadDiffContextData() || createEmptyDiffContext();
      if (!existingData) {
        return [];
      }

      if (existingData.appliedCommentImportIds.includes(importId)) {
        setThreads(existingData.threads);
        return [];
      }

      const merged = mergeCommentImports(existingData.threads, imports);
      const nextData: DiffContextStorage = {
        ...existingData,
        threads: merged.threads,
        appliedCommentImportIds: [...existingData.appliedCommentImportIds, importId],
      };

      storageService.saveDiffContextData(
        baseCommitish,
        targetCommitish,
        nextData,
        currentCommitHash,
        branchToHash,
        repositoryId,
        baseMode,
      );
      setThreads(merged.threads);
      return merged.warnings;
    },
    [
      baseCommitish,
      targetCommitish,
      branchToHash,
      createEmptyDiffContext,
      currentCommitHash,
      loadDiffContextData,
      repositoryId,
      baseMode,
    ],
  );

  const generateThreadPrompt = useCallback(
    (threadId: string): string => {
      const thread = threads.find((item) => item.id === threadId);
      if (!thread) return '';

      return formatCommentThreadPrompt(normalizeThread(thread));
    },
    [threads],
  );

  const generatePrompt = useCallback(
    (commentId: string): string => {
      return generateThreadPrompt(commentId);
    },
    [generateThreadPrompt],
  );

  const generateAllCommentsPrompt = useCallback(
    (context?: CommentPromptDiffContext, only: DiffCommentThread[] = threads): string => {
      return formatAllCommentThreadsPrompt(only.map(normalizeThread), context);
    },
    [threads],
  );

  const comments = threads
    .map((thread) => normalizeRootComment(thread))
    .filter((comment): comment is LegacyDiffComment => comment !== null);

  return {
    hasLoadedComments,
    comments,
    threads,
    decisions,
    replaceThreads,
    mergeDecisions,
    recordDecision,
    recordFixupDecisions,
    undoApproval,
    addComment,
    addThread,
    removeComment,
    replyToThread,
    removeThread,
    updateComment,
    removeMessage,
    updateMessage,
    clearAllComments: clearAllCommentsWithOptions,
    applyCommentImports,
    generatePrompt,
    generateAllCommentsPrompt,
  };
}
