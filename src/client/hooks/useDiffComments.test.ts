import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { DiffContextStorage } from '../../types/diff';
import { storageService } from '../services/StorageService';

import { useDiffComments } from './useDiffComments';

// Mock StorageService
let mockDiffContextData: DiffContextStorage | null = null;
vi.mock('../services/StorageService', () => ({
  storageService: {
    getCommentThreads: vi.fn(() => mockDiffContextData?.threads || []),
    saveCommentThreads: vi.fn(
      (baseCommitish: string, targetCommitish: string, threads: DiffContextStorage['threads']) => {
        const now = new Date().toISOString();
        mockDiffContextData = {
          version: 2,
          baseCommitish,
          targetCommitish,
          createdAt: mockDiffContextData?.createdAt ?? now,
          lastModifiedAt: now,
          threads,
          viewedFiles: mockDiffContextData?.viewedFiles ?? [],
          appliedCommentImportIds: mockDiffContextData?.appliedCommentImportIds ?? [],
          decisions: mockDiffContextData?.decisions ?? [],
        };
      },
    ),
    getComments: vi.fn(() => []),
    saveComments: vi.fn(),
    getDiffContextData: vi.fn(() => mockDiffContextData),
    saveDiffContextData: vi.fn(
      (baseCommitish: string, targetCommitish: string, data: DiffContextStorage) => {
        mockDiffContextData = {
          ...data,
          baseCommitish,
          targetCommitish,
        };
      },
    ),
  },
}));

// Mock diffUtils
vi.mock('../utils/diffUtils', () => ({
  getLanguageFromPath: vi.fn((path: string) => {
    if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
    if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
    return 'plaintext';
  }),
}));

describe('useDiffComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiffContextData = null;
  });

  describe('generatePrompt', () => {
    it('should format single line comment correctly', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      act(() => {
        result.current.addComment({
          filePath: 'src/client/components/CommentForm.tsx',
          body: 'コメント内容',
          side: 'new',
          line: 42,
        });
      });

      const comment = result.current.comments[0];
      expect(comment).toBeDefined();
      const prompt = result.current.generatePrompt(comment!.id);

      expect(prompt).toBe('src/client/components/CommentForm.tsx:L42\nコメント内容');
    });

    it('should format multi-line comment correctly', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      act(() => {
        result.current.addComment({
          filePath: 'src/client/components/CommentForm.tsx',
          body: '複数行',
          side: 'new',
          line: { start: 36, end: 39 },
        });
      });

      const comment = result.current.comments[0];
      expect(comment).toBeDefined();
      const prompt = result.current.generatePrompt(comment!.id);

      expect(prompt).toBe('src/client/components/CommentForm.tsx:L36-L39\n複数行');
    });

    it('should return empty string for non-existent comment', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      const prompt = result.current.generatePrompt('non-existent-id');
      expect(prompt).toBe('');
    });
  });

  describe('generateAllCommentsPrompt', () => {
    it('should return empty string when no comments', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      const prompt = result.current.generateAllCommentsPrompt();
      expect(prompt).toBe('');
    });

    it('should format multiple comments with separator', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      act(() => {
        result.current.addComment({
          filePath: 'src/client/components/CommentForm.tsx',
          body: '複数行',
          side: 'new',
          line: { start: 36, end: 39 },
        });
      });

      act(() => {
        result.current.addComment({
          filePath: 'src/client/components/CommentForm.tsx',
          body: 'コメント内容',
          side: 'new',
          line: 42,
        });
      });

      const prompt = result.current.generateAllCommentsPrompt({
        requestedBaseCommitish: 'main',
        requestedTargetCommitish: 'feature-branch',
        baseMode: 'merge-base',
        resolvedBaseCommitish: 'abc1234',
        resolvedTargetCommitish: 'def5678',
      });

      // Check if comments are in the correct order
      expect(result.current.comments).toHaveLength(2);
      expect(result.current.comments[0]?.position).toMatchObject({ line: { start: 36, end: 39 } });
      expect(result.current.comments[1]?.position).toMatchObject({ line: 42 });

      const expected = `diff main...feature-branch (abc1234...def5678)
=====
src/client/components/CommentForm.tsx:L36-L39
複数行
=====
src/client/components/CommentForm.tsx:L42
コメント内容`;

      expect(prompt).toBe(expected);
    });

    it('should handle comments from different files', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      act(() => {
        result.current.addComment({
          filePath: 'src/client/App.tsx',
          body: 'App comment',
          side: 'new',
          line: 10,
        });
      });

      act(() => {
        result.current.addComment({
          filePath: 'src/server/server.ts',
          body: 'Server comment',
          side: 'new',
          line: { start: 20, end: 25 },
        });
      });

      const prompt = result.current.generateAllCommentsPrompt();

      // Check if comments are in the correct order
      expect(result.current.comments).toHaveLength(2);
      expect(result.current.comments[0]?.filePath).toBe('src/client/App.tsx');
      expect(result.current.comments[1]?.filePath).toBe('src/server/server.ts');

      const expected = `src/client/App.tsx:L10
App comment
=====
src/server/server.ts:L20-L25
Server comment`;

      expect(prompt).toBe(expected);
    });

    it('should include ORIGINAL section for suggestion comments with code snapshot', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      act(() => {
        result.current.addComment({
          filePath: 'src/client/components/Button.tsx',
          body: `Please apply this:\n\`\`\`suggestion
const next = true;
\`\`\``,
          side: 'new',
          line: 12,
          codeSnapshot: {
            content: 'const prev = false;',
            language: 'typescript',
          },
        });
      });

      const prompt = result.current.generateAllCommentsPrompt();

      expect(prompt).toContain('src/client/components/Button.tsx:L12');
      expect(prompt).toContain('ORIGINAL:');
      expect(prompt).toContain('const prev = false;');
      expect(prompt).toContain('SUGGESTED:');
      expect(prompt).toContain('const next = true;');
    });
  });

  describe('review decisions', () => {
    it('keeps a decision recorded while an older merge callback was in flight', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));
      const staleMerge = result.current.mergeDecisions;

      act(() => {
        result.current.recordDecision('t1', 'approved', 'a'.repeat(40));
      });
      act(() => {
        staleMerge([]);
      });

      expect(result.current.decisions.map((decision) => decision.threadId)).toEqual(['t1']);
    });

    it('leaves storage and state alone when merged decisions change nothing', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));
      act(() => {
        result.current.recordDecision('t1', 'approved', 'a'.repeat(40));
      });
      const before = result.current.decisions;
      vi.mocked(storageService.saveDiffContextData).mockClear();

      act(() => {
        result.current.mergeDecisions(structuredClone(before));
      });

      expect(storageService.saveDiffContextData).not.toHaveBeenCalled();
      expect(result.current.decisions).toBe(before);
    });

    it('ignores a merge from a review the page has switched away from', () => {
      const { result, rerender } = renderHook(
        ({ target }) => useDiffComments('main', target, 'abc123'),
        { initialProps: { target: 'review-a' } },
      );
      const mergeForReviewA = result.current.mergeDecisions;

      rerender({ target: 'review-b' });
      act(() => {
        mergeForReviewA([
          {
            threadId: 't1',
            kind: 'approved',
            fixupSha: 'a'.repeat(40),
            at: '2026-01-01T00:00:00Z',
          },
        ]);
      });

      expect(result.current.decisions).toEqual([]);
    });

    it.each([undefined, { resetAppliedCommentImportIds: true }])(
      'drops the decisions along with the threads when all comments are cleared (%o)',
      (options) => {
        const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));
        act(() => {
          result.current.recordDecision('t1', 'rejected', 'a'.repeat(40));
        });

        act(() => {
          result.current.clearAllComments(options);
        });

        expect(result.current.decisions).toEqual([]);
        expect(mockDiffContextData?.decisions).toEqual([]);
      },
    );

    it('forgets the previous review’s decisions when there is no review to show', () => {
      const { result, rerender } = renderHook(
        ({ target }) => useDiffComments('main', target, 'abc123'),
        { initialProps: { target: 'review-a' as string | undefined } },
      );
      act(() => {
        result.current.recordDecision('t1', 'approved', 'a'.repeat(40));
      });

      rerender({ target: undefined });

      expect(result.current.decisions).toEqual([]);
    });

    it('records a decision on several fixups at one instant, so they count as one approval', () => {
      let tick = 0;
      const stamp = vi
        .spyOn(Date.prototype, 'toISOString')
        .mockImplementation(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toUTCString());
      try {
        const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

        act(() => {
          result.current.recordFixupDecisions('t1', 'approved', [
            { fixupSha: 'a'.repeat(40), patchId: 'change-a' },
            { fixupSha: 'b'.repeat(40) },
          ]);
        });

        const [first, second] = result.current.decisions;
        expect(first).toMatchObject({ fixupSha: 'a'.repeat(40), patchId: 'change-a' });
        expect(second?.fixupSha).toBe('b'.repeat(40));
        expect(second?.at).toBe(first?.at);
      } finally {
        stamp.mockRestore();
      }
    });

    it('records an undo instead of deleting the approval', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      act(() => {
        result.current.recordDecision('t1', 'approved', 'a'.repeat(40), 'change-1');
      });
      act(() => {
        result.current.undoApproval('t1');
      });

      expect(result.current.decisions.map((decision) => decision.kind)).toEqual([
        'approved',
        'unapproved',
      ]);
      expect(result.current.decisions[1]).toMatchObject({
        fixupSha: 'a'.repeat(40),
        patchId: 'change-1',
      });
    });
  });

  describe('comment CRUD operations', () => {
    it('should add comment with code snapshot', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      act(() => {
        result.current.addComment({
          filePath: 'src/utils/test.ts',
          body: 'Test comment',
          side: 'new',
          line: 15,
          codeSnapshot: {
            content: 'const x = 42;',
            language: 'typescript',
          },
        });
      });

      expect(result.current.comments).toHaveLength(1);
      const comment = result.current.comments[0];
      expect(comment).toBeDefined();
      expect(comment!.filePath).toBe('src/utils/test.ts');
      expect(comment!.body).toBe('Test comment');
      expect(comment!.author).toBe('User');
      expect(comment!.position).toEqual({ side: 'new', line: 15 });
      expect(comment!.codeSnapshot?.content).toBe('const x = 42;');
      expect(comment!.codeSnapshot?.language).toBe('typescript');
      expect(comment!.codeSnapshot?.commit).toBe('feature-branch');
    });

    it('records no commit on a thread made against the working tree', () => {
      const { result } = renderHook(() => useDiffComments('main', 'working', 'abc123'));

      act(() => {
        result.current.addThread({
          filePath: 'src/utils/test.ts',
          body: 'Test comment',
          side: 'new',
          line: 15,
        });
      });

      expect(result.current.threads[0]).toMatchObject({ codeSnapshot: { commit: undefined } });
    });

    it('binds a thread made on one commit to that commit and the view it was made on', () => {
      const commit = '1111111'.padEnd(40, '1');
      const view = { baseCommitish: '0000000'.padEnd(40, '0'), targetCommitish: commit };
      const { result } = renderHook(() => useDiffComments('def4567', 'abc1234'));

      act(() => {
        result.current.addThread({
          filePath: 'src/utils/test.ts',
          body: 'Pinned here',
          side: 'new',
          line: 3,
          codeSnapshot: { content: 'const x = 1;' },
          binding: { view, fixupTarget: commit, snapshotCommit: commit },
        });
      });
      act(() => {
        result.current.addThread({
          filePath: 'src/utils/test.ts',
          body: 'On the whole review',
          side: 'new',
          line: 3,
        });
      });

      const [bound, plain] = result.current.threads;
      expect(bound?.view).toEqual(view);
      expect(bound?.fixupTarget).toBe(commit);
      expect(bound).toMatchObject({ codeSnapshot: { commit, content: 'const x = 1;' } });
      expect(plain).not.toHaveProperty('view');
      expect(plain).not.toHaveProperty('fixupTarget');
      expect(plain).toMatchObject({ codeSnapshot: { commit: 'abc1234' } });
    });

    it('makes a thread on a whole commit without a file or a code snapshot', () => {
      const commit = '1111111'.padEnd(40, '1');
      const view = { baseCommitish: '0000000'.padEnd(40, '0'), targetCommitish: commit };
      const { result } = renderHook(() => useDiffComments('def4567', 'abc1234'));

      act(() => {
        result.current.addThread({
          scope: 'commit',
          body: 'Split this commit',
          binding: { view, fixupTarget: commit, snapshotCommit: commit },
        });
      });

      const [thread] = result.current.threads;
      expect(thread).toMatchObject({
        position: { scope: 'commit' },
        view,
        fixupTarget: commit,
        messages: [{ body: 'Split this commit' }],
      });
      expect(thread).not.toHaveProperty('filePath');
      expect(thread).not.toHaveProperty('codeSnapshot');
    });

    it('should remove comment by id', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      let commentId: string;
      act(() => {
        const comment = result.current.addComment({
          filePath: 'test.ts',
          body: 'To be removed',
          side: 'new',
          line: 1,
        });
        commentId = comment.id;
      });

      expect(result.current.comments).toHaveLength(1);

      act(() => {
        result.current.removeComment(commentId);
      });

      expect(result.current.comments).toHaveLength(0);
    });

    it('should update comment body', async () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      let commentId: string;
      act(() => {
        const comment = result.current.addComment({
          filePath: 'test.ts',
          body: 'Original comment',
          side: 'new',
          line: 1,
        });
        commentId = comment.id;
      });

      // Wait a bit to ensure updatedAt timestamp is different
      await new Promise((resolve) => setTimeout(resolve, 10));

      act(() => {
        result.current.updateComment(commentId, 'Updated comment');
      });

      expect(result.current.comments[0]?.body).toBe('Updated comment');
      expect(result.current.comments[0]?.updatedAt).not.toBe(result.current.comments[0]?.createdAt);
    });

    it('should clear all comments', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      act(() => {
        result.current.addComment({
          filePath: 'test1.ts',
          body: 'Comment 1',
          side: 'new',
          line: 1,
        });
      });

      act(() => {
        result.current.addComment({
          filePath: 'test2.ts',
          body: 'Comment 2',
          side: 'new',
          line: 2,
        });
      });

      expect(result.current.comments).toHaveLength(2);

      act(() => {
        result.current.clearAllComments();
      });

      expect(result.current.comments).toHaveLength(0);
    });

    it('applies imported thread comments once and skips reapplying the same import id', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      let warnings: string[] = [];
      act(() => {
        warnings = result.current.applyCommentImports(
          [
            {
              type: 'thread',
              id: 'imported-thread',
              filePath: 'test.ts',
              position: { side: 'new', line: 10 },
              body: 'Imported comment',
              author: 'AI',
            },
          ],
          'import-bundle-1',
        );
      });

      expect(warnings).toEqual([]);
      expect(result.current.threads).toHaveLength(1);
      expect(result.current.threads[0]?.messages[0]?.body).toBe('Imported comment');

      act(() => {
        result.current.applyCommentImports(
          [
            {
              type: 'thread',
              id: 'imported-thread',
              filePath: 'test.ts',
              position: { side: 'new', line: 10 },
              body: 'Imported comment',
              author: 'AI',
            },
          ],
          'import-bundle-1',
        );
      });

      expect(result.current.threads).toHaveLength(1);
      expect(mockDiffContextData?.appliedCommentImportIds).toEqual(['import-bundle-1']);
    });

    it('adds imported replies to the newest matching thread', async () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      let olderThreadId = '';
      let newerThreadId = '';

      act(() => {
        olderThreadId = result.current.addThread({
          filePath: 'test.ts',
          body: 'Older thread',
          side: 'new',
          line: 10,
        }).id;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      act(() => {
        newerThreadId = result.current.addThread({
          filePath: 'test.ts',
          body: 'Newer thread',
          side: 'new',
          line: 10,
        }).id;
      });

      act(() => {
        result.current.applyCommentImports(
          [
            {
              type: 'reply',
              filePath: 'test.ts',
              position: { side: 'new', line: 10 },
              body: 'Imported reply',
              author: 'AI',
            },
          ],
          'import-bundle-2',
        );
      });

      expect(
        result.current.threads.find((thread) => thread.id === olderThreadId)?.messages,
      ).toHaveLength(1);
      expect(
        result.current.threads.find((thread) => thread.id === newerThreadId)?.messages,
      ).toHaveLength(2);
    });

    it('warns when imported replies have no matching thread', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      let warnings: string[] = [];
      act(() => {
        warnings = result.current.applyCommentImports(
          [
            {
              type: 'reply',
              filePath: 'missing.ts',
              position: { side: 'new', line: 99 },
              body: 'Imported reply',
            },
          ],
          'import-bundle-3',
        );
      });

      expect(result.current.threads).toHaveLength(0);
      expect(warnings).toHaveLength(1);
    });

    it('clears applied import ids when requested', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      act(() => {
        result.current.applyCommentImports(
          [
            {
              type: 'thread',
              filePath: 'test.ts',
              position: { side: 'new', line: 10 },
              body: 'Imported comment',
            },
          ],
          'import-bundle-4',
        );
      });

      expect(mockDiffContextData?.appliedCommentImportIds).toEqual(['import-bundle-4']);

      act(() => {
        result.current.clearAllComments({ resetAppliedCommentImportIds: true });
      });

      expect(result.current.threads).toHaveLength(0);
      expect(mockDiffContextData?.appliedCommentImportIds).toEqual([]);
    });

    it('should not remove a thread when reply deletion targets a missing message id', () => {
      const { result } = renderHook(() => useDiffComments('main', 'feature-branch', 'abc123'));

      let threadId = '';
      act(() => {
        threadId = result.current.addThread({
          filePath: 'test.ts',
          body: 'Root comment',
          side: 'new',
          line: 1,
        }).id;
      });

      act(() => {
        result.current.replyToThread({
          threadId,
          body: 'Reply comment',
        });
      });

      expect(result.current.threads).toHaveLength(1);
      expect(result.current.threads[0]?.messages).toHaveLength(2);

      act(() => {
        result.current.removeMessage(threadId, 'missing-message-id');
      });

      expect(result.current.threads).toHaveLength(1);
      expect(result.current.threads[0]?.id).toBe(threadId);
      expect(result.current.threads[0]?.messages).toHaveLength(2);
      expect(result.current.threads[0]?.messages[1]?.body).toBe('Reply comment');
    });
  });
});
