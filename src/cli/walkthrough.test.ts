import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stdin = vi.hoisted(() => ({ source: 'tty' as 'tty' | 'pipe', text: '' }));
vi.mock('./utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./utils.js')>()),
  detectStdinSource: () => stdin.source,
  readStdin: async () => stdin.text,
}));

import { createWalkthroughCommand } from './walkthrough.js';

const WALKTHROUGH =
  '{"cases":[{"steps":[{"file":"a.ts","line":2,"description":"여기서 바꾼다."}]}]}';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('difit walkthrough', () => {
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;
  let output: string[];
  let errors: string[];

  const run = (...args: string[]) =>
    createWalkthroughCommand().parseAsync(['node', 'difit', ...args]);

  beforeEach(() => {
    stdin.source = 'tty';
    stdin.text = '';
    mockFetch = vi.fn<typeof fetch>();
    globalThis.fetch = mockFetch;
    process.exit = vi.fn() as never;
    output = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  it('uploads the walkthrough given as an argument and prints the result with its warnings', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ success: true, threadId: 't1', messageId: 'm2', warnings: ['step 1: x'] }),
    );

    await run('add', 't1', WALKTHROUGH, '--port', '4966');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:4966/api/threads/t1/walkthrough',
      expect.objectContaining({ method: 'PUT', body: WALKTHROUGH }),
    );
    expect(output).toEqual([
      '{"success":true,"threadId":"t1","messageId":"m2","warnings":["step 1: x"]}',
    ]);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('reads the walkthrough from stdin when no argument is given', async () => {
    stdin.source = 'pipe';
    stdin.text = `${WALKTHROUGH}\n`;
    mockFetch.mockResolvedValue(
      jsonResponse({ success: true, threadId: 't1', messageId: 'm2', warnings: [] }),
    );

    await run('add', 't1', '--port', '4966');

    expect(JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body))).toEqual(JSON.parse(WALKTHROUGH));
  });

  it('refuses JSON it cannot parse before reaching the server', async () => {
    await run('add', 't1', '{cases', '--port', '4966');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(errors[0]).toMatch(/^Error: /);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('prints the error the server gives and exits 1', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Thread t1 has no agent reply yet' }, 409));

    await run('add', 't1', WALKTHROUGH, '--port', '4966');

    expect(errors).toEqual(['Error: Thread t1 has no agent reply yet']);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('reads back and removes the walkthrough of a thread', async () => {
    const stored = { threadId: 't1', messageId: 'm2', walkthrough: { commit: 'abc', cases: [] } };
    mockFetch.mockResolvedValueOnce(jsonResponse(stored));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, threadId: 't1', messageId: 'm2' }),
    );

    await run('get', 't1', '--port', '4966');
    await run('remove', 't1', '--port', '4966');

    expect(mockFetch.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
      ['http://localhost:4966/api/threads/t1/walkthrough', 'GET'],
      ['http://localhost:4966/api/threads/t1/walkthrough', 'DELETE'],
    ]);
    expect(output.map((line) => JSON.parse(line) as unknown)).toEqual([
      stored,
      { success: true, threadId: 't1', messageId: 'm2' },
    ]);
  });

  it('says so when the server is not running', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    await run('get', 't1', '--port', '4966');

    expect(errors).toEqual([
      'Error: Cannot connect to difit server on port 4966. Is the server running?',
    ]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
