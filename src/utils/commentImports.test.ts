import { describe, expect, it, vi } from 'vitest';

import type {
  CommentImport,
  DiffCommentPosition,
  DiffCommentThread,
  ThreadCommentImport,
} from '../types/diff';

import {
  mergeCommentImports,
  mergeCommentThreads,
  normalizeCommentImports,
  parseCommentImportValue,
  serializeCommentImports,
} from './commentImports';

function createThread({
  id,
  filePath = 'src/example.ts',
  side = 'new',
  line = 10,
  body,
  updatedAt = '2024-01-01T00:00:00.000Z',
}: {
  id: string;
  filePath?: string;
  side?: 'old' | 'new';
  line?: number;
  body: string;
  updatedAt?: string;
}): DiffCommentThread {
  return {
    id,
    filePath,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt,
    position: {
      side,
      line,
    },
    messages: [
      {
        id,
        body,
        author: 'User',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt,
      },
    ],
  };
}

const PIN_SHA = '1111111111111111111111111111111111111111';
const BASE_SHA = '0000000000000000000000000000000000000000';
const PIN_VIEW = { baseCommitish: BASE_SHA, targetCommitish: PIN_SHA };

function createBoundThread(args: Parameters<typeof createThread>[0]): DiffCommentThread {
  return { ...createThread(args), view: PIN_VIEW, fixupTarget: PIN_SHA };
}

describe('commentImports', () => {
  describe('parseCommentImportValue', () => {
    it('parses a single thread import', () => {
      const imports = parseCommentImportValue(
        JSON.stringify({
          type: 'thread',
          filePath: 'src/example.ts',
          position: { side: 'new', line: 10 },
          body: 'Review comment',
        }),
      );

      expect(imports).toEqual([
        {
          type: 'thread',
          filePath: 'src/example.ts',
          position: { side: 'new', line: 10 },
          body: 'Review comment',
          id: undefined,
          author: 'Agent',
          createdAt: undefined,
          updatedAt: undefined,
          codeSnapshot: undefined,
        },
      ]);
    });

    it('parses an array of imports', () => {
      const imports = parseCommentImportValue(
        JSON.stringify([
          {
            type: 'thread',
            filePath: 'src/example.ts',
            position: { side: 'new', line: 10 },
            body: 'Root',
          },
          {
            type: 'reply',
            filePath: 'src/example.ts',
            position: { side: 'new', line: 10 },
            body: 'Reply',
          },
        ]),
      );

      expect(imports).toHaveLength(2);
      expect(imports[0]?.type).toBe('thread');
      expect(imports[1]?.type).toBe('reply');
    });

    it('gives the agent author to threads and replies sent without one', () => {
      const imports = parseCommentImportValue(
        JSON.stringify([
          {
            type: 'thread',
            filePath: 'src/example.ts',
            position: { side: 'new', line: 10 },
            body: 'Root',
          },
          {
            type: 'reply',
            filePath: 'src/example.ts',
            position: { side: 'new', line: 10 },
            body: 'Reply',
            author: '   ',
          },
        ]),
      );

      expect(imports.map((entry) => entry.author)).toEqual(['Agent', 'Agent']);
    });

    it('keeps the author the import names', () => {
      const imports = parseCommentImportValue(
        JSON.stringify({
          type: 'thread',
          filePath: 'src/example.ts',
          position: { side: 'new', line: 10 },
          body: 'Review comment',
          author: 'claude',
        }),
      );

      expect(imports[0]?.author).toBe('claude');
    });

    it('keeps the commit a snapshot was taken from', () => {
      const imports = parseCommentImportValue(
        JSON.stringify({
          type: 'thread',
          filePath: 'src/example.ts',
          position: { side: 'new', line: 10 },
          body: 'Review comment',
          codeSnapshot: { content: 'const value = 1;', commit: '6e4f6d5' },
        }),
      );

      expect(imports[0]?.codeSnapshot).toEqual({
        content: 'const value = 1;',
        language: undefined,
        commit: '6e4f6d5',
      });
      expect(mergeCommentImports([], imports).threads[0]?.codeSnapshot?.commit).toBe('6e4f6d5');
    });

    it('rejects malformed json', () => {
      expect(() => parseCommentImportValue('{')).toThrow('Invalid --comment JSON');
    });

    it('rejects invalid import shape', () => {
      expect(() =>
        parseCommentImportValue(
          JSON.stringify({
            type: 'thread',
            filePath: '',
            position: { side: 'new', line: 0 },
            body: '',
          }),
        ),
      ).toThrow('Invalid comment import field: filePath');
    });
  });

  describe('serializeCommentImports', () => {
    it('creates a stable payload string for hashing', () => {
      const commentImports: CommentImport[] = [
        {
          type: 'thread',
          id: 'thread-1',
          filePath: 'src/example.ts',
          position: { side: 'new', line: { start: 10, end: 12 } },
          body: 'Root',
          author: 'AI',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          codeSnapshot: { content: 'const value = 1;' },
        },
      ];

      expect(serializeCommentImports(commentImports)).toBe(
        JSON.stringify([
          {
            type: 'thread',
            id: 'thread-1',
            filePath: 'src/example.ts',
            position: { side: 'new', line: { start: 10, end: 12 } },
            body: 'Root',
            author: 'AI',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
            codeSnapshot: { content: 'const value = 1;', language: undefined, commit: undefined },
          },
        ]),
      );
    });
  });

  describe('mergeCommentImports', () => {
    it('adds a new thread import', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-02-01T00:00:00.000Z'));

      const result = mergeCommentImports(
        [],
        [
          {
            type: 'thread',
            filePath: 'src/example.ts',
            position: { side: 'new', line: 10 },
            body: 'Imported thread',
          },
        ],
      );

      expect(result.warnings).toEqual([]);
      expect(result.threads).toHaveLength(1);
      expect(result.threads[0]?.messages[0]?.body).toBe('Imported thread');

      vi.useRealTimers();
    });

    it('skips a duplicate thread import with the same root message', () => {
      const existing = [createThread({ id: 'thread-1', body: 'Imported thread' })];

      const result = mergeCommentImports(existing, [
        {
          type: 'thread',
          filePath: 'src/example.ts',
          position: { side: 'new', line: 10 },
          body: 'Imported thread',
          author: 'User',
        },
      ]);

      expect(result.threads).toHaveLength(1);
    });

    it('adds a reply to the newest matching thread', () => {
      const olderThread = createThread({
        id: 'thread-1',
        body: 'Root 1',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      const newerThread = createThread({
        id: 'thread-2',
        body: 'Root 2',
        updatedAt: '2024-01-02T00:00:00.000Z',
      });

      const result = mergeCommentImports(
        [olderThread, newerThread],
        [
          {
            type: 'reply',
            filePath: 'src/example.ts',
            position: { side: 'new', line: 10 },
            body: 'Imported reply',
            author: 'AI',
          },
        ],
      );

      expect(result.threads[0]?.messages).toHaveLength(1);
      expect(result.threads[1]?.messages).toHaveLength(2);
      expect(result.threads[1]?.messages[1]?.body).toBe('Imported reply');
    });

    it('skips a duplicate reply import', () => {
      const existing = createThread({ id: 'thread-1', body: 'Root' });
      existing.messages.push({
        id: 'reply-1',
        body: 'Imported reply',
        author: 'AI',
        createdAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      });

      const result = mergeCommentImports(
        [existing],
        [
          {
            type: 'reply',
            id: 'reply-1',
            filePath: 'src/example.ts',
            position: { side: 'new', line: 10 },
            body: 'Imported reply',
            author: 'AI',
          },
        ],
      );

      expect(result.threads[0]?.messages).toHaveLength(2);
    });

    it('warns and skips reply import when no matching thread exists', () => {
      const result = mergeCommentImports(
        [],
        [
          {
            type: 'reply',
            filePath: 'src/example.ts',
            position: { side: 'new', line: 10 },
            body: 'Imported reply',
          },
        ],
      );

      expect(result.threads).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Skipped reply import');
    });

    it('leaves a stored message without an author as it is', () => {
      const stored = createThread({ id: 'stored', body: 'Old agent remark' });
      const existing = [
        {
          ...stored,
          messages: stored.messages.map(({ author: _author, ...message }) => message),
        },
      ];

      const result = mergeCommentImports(
        existing,
        parseCommentImportValue(
          JSON.stringify({
            type: 'thread',
            filePath: 'src/example.ts',
            position: { side: 'new', line: 20 },
            body: 'New agent remark',
          }),
        ),
      );

      expect(result.threads.map((thread) => thread.messages[0]?.author)).toEqual([
        undefined,
        'Agent',
      ]);
    });
  });

  describe('normalizeCommentImports', () => {
    it('leaves a missing author empty', () => {
      const imports = normalizeCommentImports({
        type: 'thread',
        filePath: 'src/example.ts',
        position: { side: 'new', line: 10 },
        body: 'Review comment',
      });

      expect(imports[0]?.author).toBeUndefined();
    });
  });
  describe('the view a thread was made on and its fixup target', () => {
    it('keeps them through a merge whether the thread is in the existing set, the incoming one or both', () => {
      const onlyExisting = createBoundThread({ id: 'a', body: 'a', line: 1 });
      const onlyIncoming = createBoundThread({ id: 'b', body: 'b', line: 2 });
      const inBoth = createBoundThread({ id: 'c', body: 'c', line: 3 });
      const incomingCopy = { ...createThread({ id: 'c', body: 'c', line: 3 }) };

      const { threads } = mergeCommentThreads([onlyExisting, inBoth], [onlyIncoming, incomingCopy]);

      for (const thread of threads) {
        expect(thread.view).toEqual(PIN_VIEW);
        expect(thread.fixupTarget).toBe(PIN_SHA);
      }
      expect(threads).toHaveLength(3);
    });

    it('takes them from the incoming copy when only that copy has them', () => {
      const existing = createThread({ id: 'c', body: 'c' });
      const incoming = createBoundThread({ id: 'c', body: 'c' });

      const [merged] = mergeCommentThreads([existing], [incoming]).threads;

      expect(merged?.view).toEqual(PIN_VIEW);
      expect(merged?.fixupTarget).toBe(PIN_SHA);
    });

    it('keeps them when an agent reply is added to the thread', () => {
      const thread = createBoundThread({ id: 'a', body: 'Fix this' });

      const { threads } = mergeCommentImports(
        [thread],
        [
          {
            type: 'reply',
            filePath: thread.filePath,
            position: thread.position,
            body: 'Done',
            author: 'Agent',
          },
        ],
      );

      expect(threads[0]?.messages).toHaveLength(2);
      expect(threads[0]?.view).toEqual(PIN_VIEW);
      expect(threads[0]?.fixupTarget).toBe(PIN_SHA);
    });

    it('adds no such keys to a thread that has none', () => {
      const thread = createThread({ id: 'a', body: 'a' });

      const [merged] = mergeCommentThreads([thread], [thread]).threads;
      const [replied] = mergeCommentImports(
        [thread],
        [{ type: 'reply', filePath: thread.filePath, position: thread.position, body: 'x' }],
      ).threads;

      expect(merged).not.toHaveProperty('view');
      expect(merged).not.toHaveProperty('fixupTarget');
      expect(replied).not.toHaveProperty('view');
      expect(replied).not.toHaveProperty('fixupTarget');
    });

    it('carries them from a thread import into the new thread', () => {
      const imports = parseCommentImportValue(
        JSON.stringify({
          type: 'thread',
          id: 'moved',
          filePath: 'src/example.ts',
          position: { side: 'new', line: 10 },
          body: 'Review comment',
          view: PIN_VIEW,
          fixupTarget: PIN_SHA,
        }),
      );

      const [thread] = mergeCommentImports([], imports).threads;

      expect(thread?.view).toEqual(PIN_VIEW);
      expect(thread?.fixupTarget).toBe(PIN_SHA);
    });

    it('keeps the base mode of an imported view', () => {
      const view = { ...PIN_VIEW, baseMode: 'merge-base' };
      const [entry] = normalizeCommentImports({
        type: 'thread',
        filePath: 'src/example.ts',
        position: { side: 'new', line: 10 },
        body: 'Review comment',
        view,
      });

      expect(entry?.view).toEqual(view);
    });

    it('leaves the keys out of an import that has neither', () => {
      const [entry] = normalizeCommentImports({
        type: 'thread',
        filePath: 'src/example.ts',
        position: { side: 'new', line: 10 },
        body: 'Review comment',
      });
      const [thread] = mergeCommentImports([], entry ? [entry] : []).threads;

      expect(entry).not.toHaveProperty('view');
      expect(entry).not.toHaveProperty('fixupTarget');
      expect(thread).not.toHaveProperty('view');
      expect(thread).not.toHaveProperty('fixupTarget');
    });

    it('makes them part of the import id', () => {
      const entry = {
        type: 'thread' as const,
        filePath: 'src/example.ts',
        position: { side: 'new' as const, line: 10 },
        body: 'Review comment',
      };

      expect(
        serializeCommentImports([{ ...entry, fixupTarget: PIN_SHA, view: PIN_VIEW }]),
      ).not.toBe(serializeCommentImports([entry]));
    });

    it.each([
      ['a fixup target that is not a commit hash', { fixupTarget: 'main' }, 'fixupTarget'],
      ['a view that is not an object', { view: 'abc..def' }, 'view'],
      [
        'a view with an empty end',
        { view: { baseCommitish: BASE_SHA, targetCommitish: '' } },
        'view',
      ],
      [
        'a view with an unknown base mode',
        { view: { ...PIN_VIEW, baseMode: 'triple-dot' } },
        'view',
      ],
    ])('rejects %s', (_label, fields, fieldName) => {
      expect(() =>
        normalizeCommentImports({
          type: 'thread',
          filePath: 'src/example.ts',
          position: { side: 'new', line: 10 },
          body: 'Review comment',
          ...fields,
        }),
      ).toThrow(`Invalid comment import field: ${fieldName}`);
    });
  });

  describe('a comment on the whole file', () => {
    const FILE_POSITION = { side: 'new', scope: 'file' } as const;
    const fileThreadImport = {
      type: 'thread',
      id: 'file-thread',
      filePath: 'src/example.ts',
      position: FILE_POSITION,
      body: 'Split this class in two',
    } as const;

    it('reads a thread import that names no line', () => {
      expect(parseCommentImportValue(JSON.stringify(fileThreadImport))[0]?.position).toEqual(
        FILE_POSITION,
      );
    });

    it.each([
      ['a line next to the file scope', { side: 'new', scope: 'file', line: 3 }],
      ['an unknown scope', { side: 'new', scope: 'folder' }],
      ['neither a line nor a scope', { side: 'new' }],
    ])('rejects %s', (_label, position) => {
      expect(() => normalizeCommentImports({ ...fileThreadImport, position })).toThrow(
        /Invalid comment import field: position/,
      );
    });

    it('serializes the scope in place of the line', () => {
      expect(JSON.parse(serializeCommentImports([fileThreadImport]))[0].position).toEqual(
        FILE_POSITION,
      );
    });

    it('takes a reply on the file thread and keeps it apart from a thread on line 1', () => {
      const lineThread = createThread({ id: 'line-thread', line: 1, body: 'On line 1' });
      const { threads: withFileThread } = mergeCommentImports([lineThread], [fileThreadImport]);

      const { threads, warnings } = mergeCommentImports(withFileThread, [
        { ...fileThreadImport, type: 'reply', id: 'reply-1', body: 'Done' },
      ]);

      expect(warnings).toEqual([]);
      expect(threads.find(({ id }) => id === 'file-thread')).toMatchObject({
        position: FILE_POSITION,
        messages: [{ body: 'Split this class in two' }, { body: 'Done' }],
      });
      expect(threads.find(({ id }) => id === 'line-thread')?.messages).toHaveLength(1);
    });

    it('keeps the scope through a merge of thread lists', () => {
      const {
        threads: [fileThread],
      } = mergeCommentImports([], [fileThreadImport]);

      expect(mergeCommentThreads([fileThread!], [fileThread!]).threads).toEqual([fileThread]);
    });
  });

  describe('choices on a reply and the pick that answers them', () => {
    const choices = [
      { id: 'A', name: '최상위 불리언', description: '가장 단순합니다.' },
      {
        id: 'B',
        name: 'review.overlay.enabled 묶음',
        description: '다른 리뷰 설정과 같은 자리입니다.',
        preview: { label: '~/.difit/config.json', text: '{\n  "review": {}\n}' },
        recommended: true,
      },
    ];
    const askReply = {
      type: 'reply',
      filePath: 'src/example.ts',
      position: { side: 'new', line: 10 },
      body: '하나를 골라 주세요.',
      createdAt: '2024-02-01T00:00:00.000Z',
      choices,
    };

    const askedThread = (): DiffCommentThread =>
      mergeCommentImports(
        [createThread({ id: 'thread-1', body: '설정이 있어야 하지 않나요?' })],
        parseCommentImportValue(JSON.stringify(askReply)),
      ).threads[0]!;

    const picked = (thread: DiffCommentThread): DiffCommentThread => ({
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: 'pick-1',
          body: '고름: B — review.overlay.enabled 묶음',
          author: 'User',
          createdAt: '2024-03-01T00:00:00.000Z',
          updatedAt: '2024-03-01T00:00:00.000Z',
          answer: { messageId: thread.messages[1]!.id, choice: 'B' },
        },
      ],
    });

    it('stores the choices on the agent reply', () => {
      const reply = askedThread().messages[1];

      expect(reply).toMatchObject({ author: 'Agent', body: '하나를 골라 주세요.', choices });
    });

    it('keeps the choices and the pick when the agent adds another comment', () => {
      const stored = picked(askedThread());

      const { threads } = mergeCommentImports(
        [stored],
        parseCommentImportValue(
          JSON.stringify({ ...askReply, body: 'B로 하겠습니다.', choices: undefined }),
        ),
      );

      expect(threads[0]!.messages[1]!.choices).toEqual(choices);
      expect(threads[0]!.messages[2]!.answer).toEqual(stored.messages[2]!.answer);
      expect(threads[0]!.messages[3]!.body).toBe('B로 하겠습니다.');
    });

    it('keeps the choices and the pick when a stale page push is merged', () => {
      const stored = picked(askedThread());

      const { threads } = mergeCommentThreads([stored], [stored]);

      expect(threads[0]!.messages).toEqual(stored.messages);
    });

    it('adds a second question with the same words but other choices', () => {
      const thread = askedThread();

      const { threads } = mergeCommentImports(
        [thread],
        parseCommentImportValue(JSON.stringify({ ...askReply, choices: [choices[0]] })),
      );

      expect(threads[0]!.messages).toHaveLength(3);
      expect(threads[0]!.messages[2]!.choices).toEqual([choices[0]]);
    });

    it('skips the same question sent twice', () => {
      const thread = askedThread();

      const { threads } = mergeCommentImports(
        [thread],
        parseCommentImportValue(JSON.stringify(askReply)),
      );

      expect(threads[0]!.messages).toHaveLength(2);
    });

    it('carries the choices and the pick into the import id', () => {
      const [ask] = parseCommentImportValue(JSON.stringify(askReply));
      const plain = serializeCommentImports(
        parseCommentImportValue(JSON.stringify({ ...askReply, choices: undefined })),
      );

      expect(JSON.parse(serializeCommentImports([ask!]))[0].choices).toEqual(choices);
      expect(plain).not.toContain('choices');
    });

    it.each([
      ['an empty list', { choices: [] }],
      ['a choice without a name', { choices: [{ id: 'A', description: '' }] }],
      ['two choices with one id', { choices: [choices[0], choices[0]] }],
      ['a preview without text', { choices: [{ ...choices[0], preview: { label: 'x' } }] }],
      ['a pick without the message it answers', { answer: { choice: 'A' } }],
    ])('rejects %s', (_name, fields) => {
      expect(() => normalizeCommentImports({ ...askReply, choices: undefined, ...fields })).toThrow(
        /Invalid comment import field/,
      );
    });

    it('takes choices only on a reply', () => {
      expect(() => normalizeCommentImports({ ...askReply, type: 'thread' })).toThrow(
        'choices and answer belong on a reply',
      );
    });
  });

  describe('a comment on several ranges', () => {
    const POSITION: DiffCommentPosition = {
      side: 'new',
      line: { start: 77, end: 80 },
      extraRanges: [12, { start: 40, end: 41 }],
    };
    const multiImport: ThreadCommentImport = {
      type: 'thread',
      id: 'multi',
      filePath: 'src/example.ts',
      position: POSITION,
      body: 'Use a placeholder instead of joining strings',
      codeSnapshot: { content: 'a\nb\nc\nd', extraContents: ['x', 'y\nz'], commit: PIN_SHA },
    };

    it('keeps the other ranges and their code', () => {
      const [parsed] = parseCommentImportValue(JSON.stringify(multiImport));

      expect(parsed?.position).toEqual(POSITION);
      expect(parsed?.codeSnapshot?.extraContents).toEqual(['x', 'y\nz']);
    });

    it('reads an import with only a line as before', () => {
      const [parsed] = parseCommentImportValue(
        JSON.stringify({
          ...multiImport,
          position: { side: 'new', line: 7 },
          codeSnapshot: undefined,
        }),
      );

      expect(parsed?.position).toEqual({ side: 'new', line: 7 });
    });

    it.each([
      ['a range below the line', { ...POSITION, extraRanges: [90] }],
      ['ranges out of order', { ...POSITION, extraRanges: [40, 12] }],
      ['ranges that overlap', { ...POSITION, extraRanges: [{ start: 10, end: 12 }, 12] }],
      ['a range touching the line', { ...POSITION, extraRanges: [{ start: 70, end: 77 }] }],
      ['something other than a list', { ...POSITION, extraRanges: 12 }],
      ['a range on the whole file', { side: 'new', scope: 'file', extraRanges: [12] }],
    ])('rejects %s', (_label, position) => {
      expect(() => normalizeCommentImports({ ...multiImport, position })).toThrow(
        /Invalid comment import field: position/,
      );
    });

    it('survives the copy to a new server that the skill makes with jq', () => {
      const {
        threads: [made],
      } = mergeCommentImports([], [multiImport]);
      const thread: DiffCommentThread = {
        ...made!,
        messages: [
          ...made!.messages,
          {
            id: 'r1',
            body: 'Which name?',
            author: 'Agent',
            createdAt: '2024-01-02T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            choices: [
              { id: 'A', name: 'placeholder', description: 'Keep one template.' },
              { id: 'B', name: 'format', description: 'Use a formatter.' },
            ],
          },
          {
            id: 'r2',
            body: '고름: A — placeholder',
            author: 'User',
            createdAt: '2024-01-03T00:00:00.000Z',
            updatedAt: '2024-01-03T00:00:00.000Z',
            answer: { messageId: 'r1', choice: 'A' },
          },
        ],
      };
      const stored = JSON.parse(JSON.stringify({ threads: [thread] })) as {
        threads: DiffCommentThread[];
      };
      const copied = stored.threads.flatMap((t) => [
        {
          type: 'thread',
          id: t.id,
          filePath: t.filePath,
          position: t.position,
          body: t.messages[0]!.body,
          author: t.messages[0]!.author,
          createdAt: t.messages[0]!.createdAt,
          codeSnapshot: t.codeSnapshot,
          view: t.view,
          fixupTarget: t.fixupTarget,
        },
        ...t.messages.slice(1).map((message) => ({
          type: 'reply',
          id: message.id,
          filePath: t.filePath,
          position: t.position,
          body: message.body,
          author: message.author,
          createdAt: message.createdAt,
          choices: message.choices,
          answer: message.answer,
        })),
      ]);

      const { threads, warnings } = mergeCommentImports(
        [],
        parseCommentImportValue(JSON.stringify(copied)),
      );

      expect(warnings).toEqual([]);
      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({
        id: 'multi',
        position: POSITION,
        codeSnapshot: { extraContents: ['x', 'y\nz'] },
        messages: [
          { body: multiImport.body },
          { id: 'r1', choices: thread.messages[1]!.choices },
          { id: 'r2', answer: { messageId: 'r1', choice: 'A' } },
        ],
      });
    });

    it('takes a reply only on the thread with the same ranges', () => {
      const lineOnly = createThread({ id: 'line-only', line: 77, body: 'On the last range alone' });
      const { threads: both } = mergeCommentImports(
        [{ ...lineOnly, position: { side: 'new', line: { start: 77, end: 80 } } }],
        [multiImport],
      );

      const { threads, warnings } = mergeCommentImports(both, [
        { ...multiImport, type: 'reply', id: 'reply-1', body: 'Done' },
      ]);

      expect(warnings).toEqual([]);
      expect(threads.find(({ id }) => id === 'multi')?.messages).toHaveLength(2);
      expect(threads.find(({ id }) => id === 'line-only')?.messages).toHaveLength(1);
    });

    it('keeps the ranges through a merge of thread lists', () => {
      const {
        threads: [multi],
      } = mergeCommentImports([], [multiImport]);

      expect(mergeCommentThreads([multi!], [multi!]).threads).toEqual([multi]);
    });
  });

  describe('a comment over deleted and kept lines', () => {
    const POSITION: DiffCommentPosition = {
      side: 'new',
      line: { start: 12, end: 13 },
      extraRanges: [3, { side: 'old', start: 12, end: 14 }, { side: 'old', start: 20, end: 20 }],
    };
    const mixedImport: ThreadCommentImport = {
      type: 'thread',
      id: 'mixed',
      filePath: 'src/example.ts',
      position: POSITION,
      body: 'Same fix on both sides',
      codeSnapshot: { content: 'a\nb', extraContents: ['c', 'x\ny\nz', 'w'], commit: PIN_SHA },
    };

    it('keeps the side of each range on the other side', () => {
      const [parsed] = parseCommentImportValue(JSON.stringify(mixedImport));

      expect(parsed?.position).toEqual(POSITION);
      expect(parsed?.codeSnapshot?.extraContents).toEqual(['c', 'x\ny\nz', 'w']);
    });

    it('reads a range that names the position side as a plain range', () => {
      const [parsed] = parseCommentImportValue(
        JSON.stringify({
          ...mixedImport,
          position: { ...POSITION, extraRanges: [{ side: 'new', start: 3, end: 4 }] },
        }),
      );

      expect(parsed?.position).toEqual({ ...POSITION, extraRanges: [{ start: 3, end: 4 }] });
    });

    it.each([
      [
        'ranges on the other side out of order',
        [
          { side: 'old', start: 20, end: 20 },
          { side: 'old', start: 12, end: 14 },
        ],
      ],
      [
        'ranges on the other side that overlap',
        [
          { side: 'old', start: 12, end: 14 },
          { side: 'old', start: 14, end: 15 },
        ],
      ],
      ['a range with an unknown side', [{ side: 'left', start: 1, end: 2 }]],
    ])('rejects %s', (_label, extraRanges) => {
      expect(() =>
        normalizeCommentImports({ ...mixedImport, position: { ...POSITION, extraRanges } }),
      ).toThrow(/Invalid comment import field: position.extraRanges/);
    });

    it('takes a reply only on the thread whose ranges sit on the same sides', () => {
      const oneSide = {
        ...mixedImport,
        id: 'one-side',
        position: { ...POSITION, extraRanges: [3, { start: 5, end: 7 }, 9] },
      };
      const { threads: both } = mergeCommentImports([], [mixedImport, oneSide]);

      const { threads, warnings } = mergeCommentImports(both, [
        { ...mixedImport, type: 'reply', id: 'reply-1', body: 'Done' },
      ]);

      expect(warnings).toEqual([]);
      expect(threads.find(({ id }) => id === 'mixed')?.messages).toHaveLength(2);
      expect(threads.find(({ id }) => id === 'one-side')?.messages).toHaveLength(1);
    });

    it('takes a reply whose ranges come in another order', () => {
      const { threads: made } = mergeCommentImports([], [mixedImport]);
      const topToBottom: DiffCommentPosition = {
        ...POSITION,
        extraRanges: [{ side: 'old', start: 12, end: 14 }, 3, { side: 'old', start: 20, end: 20 }],
      };

      const { threads, warnings } = mergeCommentImports(made, [
        { ...mixedImport, type: 'reply', id: 'reply-1', body: 'Done', position: topToBottom },
      ]);

      expect(warnings).toEqual([]);
      expect(threads[0]?.messages).toHaveLength(2);
    });

    it('keeps the sides through a merge of thread lists', () => {
      const {
        threads: [mixed],
      } = mergeCommentImports([], [mixedImport]);

      expect(mergeCommentThreads([mixed!], [mixed!]).threads).toEqual([mixed]);
      expect(mixed?.position).toEqual(POSITION);
    });
  });
});
