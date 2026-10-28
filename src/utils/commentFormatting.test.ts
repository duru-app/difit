import { describe, it, expect } from 'vitest';

import type { Comment, CommentThread } from '../types/diff';

import {
  formatCommentPrompt,
  formatCommentThreadPrompt,
  formatAllCommentsPrompt,
  formatAllCommentThreadsPrompt,
  formatCommentsOutput,
} from './commentFormatting';

describe('commentFormatting', () => {
  describe('formatCommentPrompt', () => {
    it('should format single line number correctly', () => {
      const result = formatCommentPrompt('src/components/Button.tsx', 42, 'Fix accessibility');
      expect(result).toBe('src/components/Button.tsx:L42\nFix accessibility');
    });

    it('should format line range correctly', () => {
      const result = formatCommentPrompt(
        'src/utils/validation.ts',
        [100, 120],
        'Extract validation logic',
      );
      expect(result).toBe('src/utils/validation.ts:L100-L120\nExtract validation logic');
    });

    it('should handle multi-line comment body', () => {
      const body = 'This is a comment\nwith multiple lines\nof text';
      const result = formatCommentPrompt('src/index.ts', 10, body);
      expect(result).toBe('src/index.ts:L10\nThis is a comment\nwith multiple lines\nof text');
    });

    it('should handle file paths with special characters', () => {
      const result = formatCommentPrompt('src/components/@shared/Button.tsx', 15, 'Update styles');
      expect(result).toBe('src/components/@shared/Button.tsx:L15\nUpdate styles');
    });

    it('should handle empty string file path', () => {
      const result = formatCommentPrompt('', 10, 'Comment body');
      expect(result).toBe('<unknown file>:L10\nComment body');
    });

    it('should mark only the old diff side', () => {
      const result = formatCommentPrompt('src/removed.ts', 10, 'Why?', undefined, 'old');
      expect(result).toBe('src/removed.ts:L10 (old)\nWhy?');
      expect(formatCommentPrompt('src/added.ts', 11, 'New line', undefined, 'new')).toBe(
        'src/added.ts:L11\nNew line',
      );
      expect(formatCommentPrompt('src/legacy.ts', 12, 'Legacy comment')).toBe(
        'src/legacy.ts:L12\nLegacy comment',
      );
    });

    it('should format suggestion block with ORIGINAL/SUGGESTED structure', () => {
      const body = `\`\`\`suggestion
const newCode = 42;
\`\`\``;
      const result = formatCommentPrompt('src/file.ts', 10, body, 'const oldCode = 1;');
      expect(result).toContain('src/file.ts:L10');
      expect(result).toContain('ORIGINAL:');
      expect(result).toContain('const oldCode = 1;');
      expect(result).toContain('SUGGESTED:');
      expect(result).toContain('const newCode = 42;');
    });

    it('should format suggestion block with context text', () => {
      const body = `Please refactor this:\n\`\`\`suggestion
const better = true;
\`\`\``;
      const result = formatCommentPrompt('src/file.ts', 10, body, 'const old = false;');
      expect(result).toContain('Please refactor this:');
      expect(result).toContain('ORIGINAL:');
      expect(result).toContain('SUGGESTED:');
    });

    it('should format suggestion block without codeContent', () => {
      const body = `\`\`\`suggestion
const newCode = 42;
\`\`\``;
      const result = formatCommentPrompt('src/file.ts', 10, body);
      expect(result).toContain('src/file.ts:L10');
      expect(result).not.toContain('ORIGINAL:');
      expect(result).toContain('SUGGESTED:');
      expect(result).toContain('const newCode = 42;');
    });
  });

  describe('formatCommentThreadPrompt', () => {
    it('lists every range of a comment on several, in ascending order', () => {
      const at = '2024-01-01T00:00:00Z';
      const thread: CommentThread = {
        id: 'multi',
        file: 'order/OrderService.java',
        line: [77, 80],
        extraLines: [
          { side: 'new', line: 12 },
          { side: 'new', line: 40 },
        ],
        side: 'new',
        createdAt: at,
        updatedAt: at,
        messages: [{ id: 'm', body: 'Use a placeholder', createdAt: at, updatedAt: at }],
      };

      expect(formatCommentThreadPrompt(thread)).toBe(
        'order/OrderService.java:L12,L40,L77-L80\nUse a placeholder',
      );
      expect(
        formatCommentThreadPrompt({
          ...thread,
          side: 'old',
          extraLines: [{ side: 'old', line: [3, 4] }],
        }),
      ).toBe('order/OrderService.java:L3-L4,L77-L80 (old)\nUse a placeholder');
    });

    it('leads each side of a comment on deleted and kept lines with that side, old first', () => {
      const at = '2024-01-01T00:00:00Z';
      const thread: CommentThread = {
        id: 'mixed',
        file: 'src/a.ts',
        line: [12, 13],
        extraLines: [
          { side: 'new', line: 3 },
          { side: 'old', line: 20 },
          { side: 'old', line: [12, 14] },
        ],
        side: 'new',
        createdAt: at,
        updatedAt: at,
        messages: [{ id: 'm', body: 'Same fix', createdAt: at, updatedAt: at }],
      };

      expect(formatCommentThreadPrompt(thread)).toBe(
        'src/a.ts:old:L12-L14,L20,new:L3,L12-L13\nSame fix',
      );
      expect(
        formatCommentThreadPrompt({
          ...thread,
          side: 'old',
          line: [12, 14],
          extraLines: [{ side: 'new', line: [12, 13] }],
        }),
      ).toBe('src/a.ts:old:L12-L14,new:L12-L13\nSame fix');
    });
  });

  describe('formatAllCommentThreadsPrompt', () => {
    const timestamp = '2024-01-01T00:00:00Z';
    const threads: CommentThread[] = [
      {
        id: 'old-thread',
        file: 'docs/SUMMARY.md',
        line: 85,
        side: 'old',
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [
          {
            id: 'old-message',
            body: 'Explain why this was removed.',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      },
      {
        id: 'new-thread',
        file: 'docs/SUMMARY.md',
        line: [242, 244],
        side: 'new',
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [
          {
            id: 'new-message',
            body: 'Should this remain grouped?',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          {
            id: 'reply-message',
            body: 'Related entries are below.',
            author: 'Reviewer',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      },
    ];

    it('should format a merge-base range with resolved hashes', () => {
      const result = formatAllCommentThreadsPrompt(threads, {
        requestedBaseCommitish: 'main',
        requestedTargetCommitish: 'feature/docs-update',
        baseMode: 'merge-base',
        resolvedBaseCommitish: 'abcdef1',
        resolvedTargetCommitish: '1234567',
      });

      expect(result).toBe(`diff main...feature/docs-update (abcdef1...1234567)
=====
docs/SUMMARY.md:L85 (old)
Explain why this was removed.
=====
docs/SUMMARY.md:L242-L244
Should this remain grouped?
Reply 1 (Reviewer)
Related entries are below.`);
    });

    it('should use a direct range and omit identical resolved refs', () => {
      const result = formatAllCommentThreadsPrompt([threads[1]!], {
        requestedBaseCommitish: 'abcdef1',
        requestedTargetCommitish: '1234567',
        baseMode: 'direct',
        resolvedBaseCommitish: 'abcdef1',
        resolvedTargetCommitish: '1234567',
      });

      expect(result).toBe(`diff abcdef1..1234567
=====
docs/SUMMARY.md:L242-L244
Should this remain grouped?
Reply 1 (Reviewer)
Related entries are below.`);
    });

    it.each(['working', 'staged', '.', 'stdin'])(
      'should omit the header for non-range target %s',
      (target) => {
        const result = formatAllCommentThreadsPrompt([threads[0]!], {
          requestedBaseCommitish: 'HEAD',
          requestedTargetCommitish: target,
          baseMode: 'direct',
          resolvedBaseCommitish: 'abcdef1',
        });

        expect(result).toBe(`docs/SUMMARY.md:L85 (old)
Explain why this was removed.`);
      },
    );

    it('should omit an incomplete resolved range', () => {
      const result = formatAllCommentThreadsPrompt([threads[1]!], {
        requestedBaseCommitish: 'main',
        requestedTargetCommitish: 'feature/docs-update',
        baseMode: 'merge-base',
        resolvedBaseCommitish: 'abcdef1',
      });

      expect(result).toContain('diff main...feature/docs-update\n=====');
      expect(result).not.toContain('abcdef1');
    });

    it('should omit the header when the requested range is incomplete', () => {
      const result = formatAllCommentThreadsPrompt([threads[0]!], {
        requestedTargetCommitish: 'feature/docs-update',
        baseMode: 'merge-base',
        resolvedTargetCommitish: '1234567',
      });

      expect(result).toBe(`docs/SUMMARY.md:L85 (old)
Explain why this was removed.`);
    });

    it('should keep individual thread prompts free of the diff header', () => {
      const result = formatCommentThreadPrompt(threads[0]!);
      expect(result).toBe('docs/SUMMARY.md:L85 (old)\nExplain why this was removed.');
    });

    it('should append the review state to the location of each thread that has one', () => {
      const result = formatAllCommentThreadsPrompt(
        threads,
        undefined,
        new Map([
          ['old-thread', 'rejected'],
          ['new-thread', 'awaiting-approval'],
        ]),
      );

      expect(result).toBe(`docs/SUMMARY.md:L85 (old) [다시 수정 중]
Explain why this was removed.
=====
docs/SUMMARY.md:L242-L244 [승인 대기]
Should this remain grouped?
Reply 1 (Reviewer)
Related entries are below.`);
    });

    it('should leave the location bare when no review state is known for the thread', () => {
      const result = formatAllCommentThreadsPrompt(
        threads,
        undefined,
        new Map([['new-thread', 'folded']]),
      );

      expect(result).toContain('docs/SUMMARY.md:L85 (old)\nExplain');
      expect(result).toContain('docs/SUMMARY.md:L242-L244 [접힘]\n');
    });
  });

  describe('choices on a reply', () => {
    const at = '2024-01-01T00:00:00Z';
    const thread: CommentThread = {
      id: 't1',
      file: 'src/config.ts',
      line: 40,
      side: 'new',
      createdAt: at,
      updatedAt: at,
      messages: [
        {
          id: 'm1',
          body: '설정이 있어야 하지 않나요?',
          author: 'User',
          createdAt: at,
          updatedAt: at,
        },
        {
          id: 'm2',
          body: '하나를 골라 주세요.',
          author: 'Claude',
          createdAt: at,
          updatedAt: at,
          choices: [
            { id: 'A', name: '최상위 불리언', description: '가장 단순합니다.' },
            {
              id: 'B',
              name: '묶음',
              description: '',
              preview: { label: 'config.json', text: '{\n  "review": {}\n}' },
              recommended: true,
            },
          ],
        },
        {
          id: 'm3',
          body: '고름: B — 묶음',
          author: 'User',
          createdAt: at,
          updatedAt: at,
          answer: { messageId: 'm2', choice: 'B' },
        },
      ],
    };

    it('lists the choices under the reply and names the pick', () => {
      expect(formatCommentThreadPrompt(thread)).toBe(
        [
          'src/config.ts:L40',
          '설정이 있어야 하지 않나요?',
          'Reply 1 (Claude)',
          '하나를 골라 주세요.',
          'Choices:',
          '- A: 최상위 불리언 — 가장 단순합니다.',
          '- B (recommended): 묶음',
          '  preview (config.json):',
          '    {',
          '      "review": {}',
          '    }',
          'Reply 2 (User)',
          '고름: B — 묶음',
          'Picked B from Reply 1',
        ].join('\n'),
      );
    });
  });

  describe('formatAllCommentsPrompt', () => {
    it('should return empty string for empty comments array', () => {
      const result = formatAllCommentsPrompt([]);
      expect(result).toBe('');
    });

    it('should format single comment without separator', () => {
      const comments: Comment[] = [
        {
          id: '1',
          file: 'src/App.tsx',
          line: 10,
          body: 'Single comment',
          timestamp: '2024-01-01T00:00:00Z',
        },
      ];
      const result = formatAllCommentsPrompt(comments);
      expect(result).toBe('src/App.tsx:L10\nSingle comment');
    });

    it('should format multiple comments with separator', () => {
      const comments: Comment[] = [
        {
          id: '1',
          file: 'src/App.tsx',
          line: 10,
          body: 'First comment',
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          id: '2',
          file: 'src/utils/helper.ts',
          line: [20, 25],
          body: 'Second comment',
          timestamp: '2024-01-01T00:01:00Z',
        },
      ];
      const result = formatAllCommentsPrompt(comments);
      expect(result).toBe(
        'src/App.tsx:L10\nFirst comment\n=====\nsrc/utils/helper.ts:L20-L25\nSecond comment',
      );
    });

    it('should preserve comment order', () => {
      const comments: Comment[] = [
        {
          id: '3',
          file: 'third.ts',
          line: 30,
          body: 'Third',
          timestamp: '2024-01-01T00:02:00Z',
        },
        {
          id: '1',
          file: 'first.ts',
          line: 10,
          body: 'First',
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          id: '2',
          file: 'second.ts',
          line: 20,
          body: 'Second',
          timestamp: '2024-01-01T00:01:00Z',
        },
      ];
      const result = formatAllCommentsPrompt(comments);
      expect(result).toBe(
        'third.ts:L30\nThird\n=====\nfirst.ts:L10\nFirst\n=====\nsecond.ts:L20\nSecond',
      );
    });
  });

  describe('formatCommentsOutput', () => {
    it('should format empty comments with header and footer', () => {
      const result = formatCommentsOutput([]);
      const lines = result.split('\n');
      expect(lines[0]).toBe('');
      expect(lines[1]).toBe('📝 Comments from review session:');
      expect(lines[2]).toBe('='.repeat(50));
      expect(lines[3]).toBe('');
      expect(lines[4]).toBe('='.repeat(50));
      expect(lines[5]).toBe('Total comments: 0');
    });

    it('should format single comment with header and footer', () => {
      const comments: Comment[] = [
        {
          id: '1',
          file: 'src/App.tsx',
          line: 10,
          body: 'Fix this issue',
          timestamp: '2024-01-01T00:00:00Z',
        },
      ];
      const result = formatCommentsOutput(comments);
      expect(result).toContain('📝 Comments from review session:');
      expect(result).toContain('src/App.tsx:L10\nFix this issue');
      expect(result).toContain('Total comments: 1');
      expect(result).toContain('='.repeat(50));
    });

    it('should format multiple comments with separators', () => {
      const comments: Comment[] = [
        {
          id: '1',
          file: 'src/App.tsx',
          line: 10,
          body: 'First issue',
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          id: '2',
          file: 'src/utils/helper.ts',
          line: [20, 30],
          body: 'Second issue',
          timestamp: '2024-01-01T00:01:00Z',
        },
        {
          id: '3',
          file: 'src/components/Button.tsx',
          line: 42,
          body: 'Third issue',
          timestamp: '2024-01-01T00:02:00Z',
        },
      ];
      const result = formatCommentsOutput(comments);

      expect(result).toContain('📝 Comments from review session:');
      expect(result).toContain('src/App.tsx:L10\nFirst issue');
      expect(result).toContain('=====');
      expect(result).toContain('src/utils/helper.ts:L20-L30\nSecond issue');
      expect(result).toContain('src/components/Button.tsx:L42\nThird issue');
      expect(result).toContain('Total comments: 3');
    });

    it('should show each thread with its review state', () => {
      const comments: Comment[] = [
        { id: '1', file: 'src/App.tsx', line: 10, body: 'Open', timestamp: '2024-01-01T00:00:00Z' },
        { id: '2', file: 'src/App.tsx', line: 20, body: 'Done', timestamp: '2024-01-01T00:01:00Z' },
      ];
      const result = formatCommentsOutput(
        comments,
        new Map([
          ['1', 'awaiting-fix'],
          ['2', 'approved'],
        ]),
      );

      expect(result).toContain('src/App.tsx:L10 [수정 중]\nOpen');
      expect(result).toContain('src/App.tsx:L20 [승인됨]\nDone');
    });

    it('should name the commit to fix into only for a thread that has one', () => {
      const thread = (id: string, fixupCommit?: CommentThread['fixupCommit']): CommentThread => ({
        id,
        file: 'src/App.tsx',
        line: 10,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        messages: [
          {
            id,
            body: `Fix ${id}`,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        ...(fixupCommit ? { fixupCommit } : {}),
      });
      const result = formatCommentsOutput(
        [
          thread('named', { shortSha: '1111111', subject: 'first' }),
          thread('unlisted', { shortSha: '2222222' }),
          thread('old'),
        ],
        new Map([['named', 'awaiting-fix']]),
      );

      expect(result).toContain(
        'src/App.tsx:L10 [수정 중]\n고쳐 넣을 커밋: 1111111 first\nFix named',
      );
      expect(result).toContain('src/App.tsx:L10\n고쳐 넣을 커밋: 2222222\nFix unlisted');
      expect(result).toContain('src/App.tsx:L10\nFix old');
      expect(result.match(/고쳐 넣을 커밋/g)).toHaveLength(2);
    });

    it('should name only the file for a thread on the whole file, marking a deleted one', () => {
      const onFile = (id: string, side: 'old' | 'new'): CommentThread => ({
        id,
        file: 'src/App.tsx',
        side,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        messages: [
          {
            id,
            body: `Whole file ${id}`,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        fixupCommit: { shortSha: '1111111', subject: 'first' },
      });
      const result = formatCommentsOutput(
        [onFile('kept', 'new'), onFile('deleted', 'old')],
        new Map([['kept', 'awaiting-fix']]),
      );

      expect(result).toContain(
        '\nsrc/App.tsx [수정 중]\n고쳐 넣을 커밋: 1111111 first\nWhole file kept',
      );
      expect(result).toContain(
        '\nsrc/App.tsx (old)\n고쳐 넣을 커밋: 1111111 first\nWhole file deleted',
      );
    });

    it('should handle comments with multi-line bodies', () => {
      const comments: Comment[] = [
        {
          id: '1',
          file: 'src/complex.ts',
          line: [100, 200],
          body: 'This is a complex issue that\nspans multiple lines\nand needs attention',
          timestamp: '2024-01-01T00:00:00Z',
        },
      ];
      const result = formatCommentsOutput(comments);

      expect(result).toContain('src/complex.ts:L100-L200');
      expect(result).toContain(
        'This is a complex issue that\nspans multiple lines\nand needs attention',
      );
      expect(result).toContain('Total comments: 1');
    });
  });
});
