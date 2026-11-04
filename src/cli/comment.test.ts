import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { CommentImport } from '../types/diff.js';

import { createCommentCommand, waitForAgentTurn } from './comment.js';

describe('createCommentCommand', () => {
  const command = createCommentCommand();

  it('creates a command named "comment"', () => {
    expect(command.name()).toBe('comment');
  });

  it('has "add", "get", and "resolve" subcommands', () => {
    const subcommandNames = command.commands.map((c) => c.name());
    expect(subcommandNames).toContain('add');
    expect(subcommandNames).toContain('get');
    expect(subcommandNames).toContain('resolve');
    expect(subcommandNames).toContain('wait');
  });

  describe('add subcommand', () => {
    const addCommand = command.commands.find((c) => c.name() === 'add')!;

    it('requires --port option', () => {
      const portOption = addCommand.options.find((o) => o.long === '--port');
      expect(portOption).toBeDefined();
      expect(portOption?.mandatory).toBe(true);
    });

    it('accepts optional json argument', () => {
      const args = addCommand.registeredArguments;
      expect(args).toHaveLength(1);
      expect(args[0].name()).toBe('json');
      expect(args[0].required).toBe(false);
    });
  });

  describe('get subcommand', () => {
    const getCommand = command.commands.find((c) => c.name() === 'get')!;

    it('requires --port option', () => {
      const portOption = getCommand.options.find((o) => o.long === '--port');
      expect(portOption).toBeDefined();
      expect(portOption?.mandatory).toBe(true);
    });

    it('has --format option with choices', () => {
      const formatOption = getCommand.options.find((o) => o.long === '--format');
      expect(formatOption).toBeDefined();
      expect(formatOption?.defaultValue).toBe('text');
      expect(formatOption?.argChoices).toEqual(['text', 'json']);
    });
  });

  describe('resolve subcommand', () => {
    const resolveCommand = command.commands.find((c) => c.name() === 'resolve')!;

    it('has "remove" alias', () => {
      expect(resolveCommand.aliases()).toContain('remove');
    });

    it('requires --port option', () => {
      const portOption = resolveCommand.options.find((o) => o.long === '--port');
      expect(portOption).toBeDefined();
      expect(portOption?.mandatory).toBe(true);
    });

    it('accepts variadic threadIds argument', () => {
      const args = resolveCommand.registeredArguments;
      expect(args).toHaveLength(1);
      expect(args[0].name()).toBe('threadIds');
      expect(args[0].required).toBe(true);
      expect(args[0].variadic).toBe(true);
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}

describe('comment subcommand integration', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;
  let originalProcessExit: typeof process.exit;
  let consoleOutput: string[];
  let consoleErrors: string[];

  beforeEach(() => {
    mockFetch = vi.fn<typeof fetch>();
    globalThis.fetch = mockFetch;

    originalProcessExit = process.exit;
    process.exit = vi.fn() as any;

    consoleOutput = [];
    consoleErrors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.join(' '));
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exit = originalProcessExit;
    vi.restoreAllMocks();
  });

  describe('add', () => {
    it('sends comment imports to the server', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ success: true, importId: 'abc123', count: 1 }));

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'add',
        '--port',
        '4966',
        '{"type":"thread","filePath":"test.ts","position":{"side":"new","line":1},"body":"Test"}',
      ]);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4966/api/comment-imports',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(consoleOutput[0]).toContain('"success":true');
    });

    it('sends the agent author for comments without one', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ success: true, importId: 'abc123', count: 1 }));

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'add',
        '--port',
        '4966',
        '{"type":"thread","filePath":"test.ts","position":{"side":"new","line":1},"body":"Test"}',
      ]);

      const sent = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body)) as CommentImport[];
      expect(sent.map((entry) => entry.author)).toEqual(['Agent']);
    });

    it('sends the author a comment names', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ success: true, importId: 'abc123', count: 1 }));

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'add',
        '--port',
        '4966',
        '{"type":"thread","filePath":"test.ts","position":{"side":"new","line":1},"body":"Test","author":"Codex"}',
      ]);

      const sent = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body)) as CommentImport[];
      expect(sent.map((entry) => entry.author)).toEqual(['Codex']);
    });

    it('validates JSON before sending', async () => {
      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'add', '--port', '4966', 'not-valid-json']);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(consoleErrors[0]).toContain('Error:');
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles server error response', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: 'Bad request' }, 400));

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'add',
        '--port',
        '4966',
        '{"type":"thread","filePath":"test.ts","position":{"side":"new","line":1},"body":"Test"}',
      ]);

      expect(consoleErrors[0]).toContain('Bad request');
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles connection error', async () => {
      const fetchError = new TypeError('fetch failed');
      mockFetch.mockRejectedValue(fetchError);

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'add',
        '--port',
        '9999',
        '{"type":"thread","filePath":"test.ts","position":{"side":"new","line":1},"body":"Test"}',
      ]);

      expect(consoleErrors[0]).toContain('Cannot connect');
      expect(consoleErrors[0]).toContain('9999');
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('get', () => {
    it('fetches comments in text format by default', async () => {
      mockFetch.mockResolvedValue(textResponse('Comments output text'));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'get', '--port', '4966']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/comments-output');
      expect(consoleOutput[0]).toBe('Comments output text');
    });

    it('fetches comments in json format', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ threads: [{ id: '1' }] }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'get', '--port', '4966', '--format', 'json']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/comments-json');
      expect(consoleOutput[0]).toContain('"threads"');
    });

    it('leaves deleted threads out of the json output', async () => {
      const deletion = { threadId: 'gone', kind: 'deleted', fixupSha: '', at: '2026-01-01' };
      mockFetch.mockResolvedValue(
        jsonResponse({ threads: [{ id: 'kept' }, { id: 'gone' }], decisions: [deletion] }),
      );

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'get', '--port', '4966', '--format', 'json']);

      expect(JSON.parse(consoleOutput[0]!)).toEqual({
        threads: [{ id: 'kept' }],
        decisions: [deletion],
      });
    });

    it('handles connection error', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'get', '--port', '9999']);

      expect(consoleErrors[0]).toContain('Cannot connect');
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles empty text output silently', async () => {
      mockFetch.mockResolvedValue(textResponse('  '));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'get', '--port', '4966']);

      expect(consoleOutput).toHaveLength(0);
    });
  });

  describe('wait', () => {
    const THREAD = { threadId: 'c1', state: 'awaiting-fix', label: '답변 대기' };

    function streamResponse(...events: string[]): Response {
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const event of events) controller.enqueue(new TextEncoder().encode(event));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }

    it('returns each thread of the first threads event as a JSON line', async () => {
      mockFetch.mockResolvedValue(
        streamResponse(
          ': waiting\n\n: ping\n\n',
          `event: threads\ndata: ${JSON.stringify([THREAD, { threadId: 'c2' }])}\n\n`,
        ),
      );

      expect(await waitForAgentTurn(4966)).toEqual({
        kind: 'threads',
        lines: [JSON.stringify(THREAD), '{"threadId":"c2"}'],
      });
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/comments-wait');
    });

    it('reports the end of the review', async () => {
      mockFetch.mockResolvedValue(streamResponse('event: end\ndata: review ended\n\n'));

      expect(await waitForAgentTurn(4966)).toEqual({ kind: 'ended' });
    });

    it('connects again when the stream drops without an end', async () => {
      mockFetch
        .mockResolvedValueOnce(streamResponse(': waiting\n\n'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(
          streamResponse(`event: threads\ndata: ${JSON.stringify([THREAD])}\n\n`),
        );

      expect(await waitForAgentTurn(4966)).toEqual({
        kind: 'threads',
        lines: [JSON.stringify(THREAD)],
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('reports a server that answers without the wait endpoint at once', async () => {
      mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));

      expect(await waitForAgentTurn(4966)).toEqual({ kind: 'refused', status: 404 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('connects again after a server error answer', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
        .mockResolvedValueOnce(
          streamResponse(`event: threads\ndata: ${JSON.stringify([THREAD])}\n\n`),
        );

      expect(await waitForAgentTurn(4966)).toEqual({
        kind: 'threads',
        lines: [JSON.stringify(THREAD)],
      });
    });

    it('gives up once the server stays unreachable past the window', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      expect(await waitForAgentTurn(4966, 300)).toEqual({ kind: 'unreachable' });
    });

    it('prints the threads on standard output and exits with 0', async () => {
      mockFetch.mockResolvedValue(
        streamResponse(`event: threads\ndata: ${JSON.stringify([THREAD])}\n\n`),
      );
      const written: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string, done?: () => void) => {
        written.push(chunk);
        done?.();
        return true;
      }) as typeof process.stdout.write);

      await createCommentCommand().parseAsync(['node', 'difit', 'wait', '--port', '4966']);

      expect(written.join('')).toBe(`${JSON.stringify(THREAD)}\n`);
      expect(process.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('resolve', () => {
    const thread = (id: string) => ({ id, messages: [] });
    const decision = (threadId: string, kind: string, at: string) => ({
      threadId,
      kind,
      fixupSha: '',
      at,
    });
    const state = (ids: string[], decisions: unknown[] = []) =>
      jsonResponse({ version: 1, threads: ids.map(thread), decisions });
    const decisionPosts = () => mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST');

    it('records resolved decisions without deleting the threads', async () => {
      mockFetch
        .mockResolvedValueOnce(state(['abc123', 'def456']))
        .mockResolvedValueOnce(jsonResponse({ success: true, changed: true }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123', 'def456']);

      expect(mockFetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
      expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:4966/api/comments-json');
      const posts = decisionPosts();
      expect(posts).toHaveLength(1);
      expect(posts[0]![0]).toBe('http://localhost:4966/api/decisions');
      const body = JSON.parse(posts[0]![1]!.body as string) as Array<Record<string, string>>;
      expect(body.map((d) => [d.threadId, d.kind, d.fixupSha])).toEqual([
        ['abc123', 'resolved', ''],
        ['def456', 'resolved', ''],
      ]);
      expect(Number.isNaN(Date.parse(body[0]!.at!))).toBe(false);
      expect(consoleOutput[0]).toBe(
        JSON.stringify({
          success: true,
          resolved: ['abc123', 'def456'],
          notFound: [],
          errors: [],
        }),
      );
      expect(process.exit).not.toHaveBeenCalled();
    });

    it('records each thread once when an ID is repeated', async () => {
      mockFetch
        .mockResolvedValueOnce(state(['abc123']))
        .mockResolvedValueOnce(jsonResponse({ success: true }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123', 'abc123']);

      const body = JSON.parse(decisionPosts()[0]![1]!.body as string) as unknown[];
      expect(body).toHaveLength(1);
      expect(consoleOutput[0]).toContain('"resolved":["abc123"]');
    });

    it('works via the remove alias', async () => {
      mockFetch
        .mockResolvedValueOnce(state(['abc123']))
        .mockResolvedValueOnce(jsonResponse({ success: true }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'remove', '--port', '4966', 'abc123']);

      expect(decisionPosts()).toHaveLength(1);
      expect(consoleOutput[0]).toContain('"success":true');
    });

    it('does not write again for an already resolved thread', async () => {
      mockFetch.mockResolvedValueOnce(
        state(['abc123'], [decision('abc123', 'resolved', '2026-01-01T00:00:00Z')]),
      );

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123']);

      expect(decisionPosts()).toHaveLength(0);
      expect(consoleOutput[0]).toBe(
        JSON.stringify({ success: true, resolved: ['abc123'], notFound: [], errors: [] }),
      );
      expect(process.exit).not.toHaveBeenCalled();
    });

    it('records a new resolution for a thread the reviewer reopened', async () => {
      mockFetch
        .mockResolvedValueOnce(
          state(
            ['abc123'],
            [
              decision('abc123', 'resolved', '2026-01-01T00:00:00Z'),
              decision('abc123', 'unresolved', '2026-01-01T00:01:00Z'),
            ],
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ success: true }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123']);

      expect(decisionPosts()).toHaveLength(1);
      expect(consoleOutput[0]).toContain('"resolved":["abc123"]');
    });

    it('stamps the resolution after a reopening made on a clock ahead of this one', async () => {
      const ahead = new Date(Date.now() + 3_600_000).toISOString();
      mockFetch
        .mockResolvedValueOnce(
          state(
            ['abc123'],
            [
              decision('abc123', 'resolved', '2026-01-01T00:00:00Z'),
              decision('abc123', 'unresolved', ahead),
            ],
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ success: true }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123']);

      const body = JSON.parse(decisionPosts()[0]![1]!.body as string) as Array<{ at: string }>;
      expect(Date.parse(body[0]!.at)).toBeGreaterThan(Date.parse(ahead));
    });

    it('reports unknown and deleted thread IDs and exits with an error', async () => {
      mockFetch
        .mockResolvedValueOnce(
          state(['abc123', 'gone'], [decision('gone', 'deleted', '2026-01-01T00:00:00Z')]),
        )
        .mockResolvedValueOnce(jsonResponse({ success: true }));

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'resolve',
        '--port',
        '4966',
        'abc123',
        'missing',
        'gone',
      ]);

      const body = JSON.parse(decisionPosts()[0]![1]!.body as string) as Array<{
        threadId: string;
      }>;
      expect(body.map((d) => d.threadId)).toEqual(['abc123']);
      expect(consoleOutput[0]).toBe(
        JSON.stringify({
          success: false,
          resolved: ['abc123'],
          notFound: ['missing', 'gone'],
          errors: [],
        }),
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('reports every thread to be recorded as an error when the write fails', async () => {
      mockFetch
        .mockResolvedValueOnce(state(['abc123', 'def456']))
        .mockResolvedValueOnce(jsonResponse({ error: 'Internal error' }, 500));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123', 'def456']);

      expect(consoleOutput[0]).toBe(
        JSON.stringify({
          success: false,
          resolved: [],
          notFound: [],
          errors: [
            { threadId: 'abc123', error: 'Internal error' },
            { threadId: 'def456', error: 'Internal error' },
          ],
        }),
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('reports a failed thread lookup as an error for every thread', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123']);

      expect(decisionPosts()).toHaveLength(0);
      expect(consoleOutput[0]).toContain('"errors":[{"threadId":"abc123"');
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles connection error', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '9999', 'abc123']);

      expect(consoleErrors[0]).toContain('Cannot connect');
      expect(consoleErrors[0]).toContain('9999');
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });
});
