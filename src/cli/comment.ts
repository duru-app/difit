import { Command, Option } from 'commander';

import { parseCommentImportValue } from '../utils/commentImports.js';
import {
  isThreadDeleted,
  isThreadResolved,
  latestResolutionMarkAt,
  normalizeReviewDecisions,
} from '../utils/reviewDecisions.js';

import { detectStdinSource, readStdin } from './utils.js';

interface CommentImportResponse {
  success?: boolean;
  importId?: string;
  count?: number;
  warnings?: string[];
}

function handleCommandError(error: unknown, port: number): never {
  if (error instanceof TypeError && error.message.includes('fetch failed')) {
    console.error(`Error: Cannot connect to difit server on port ${port}. Is the server running?`);
  } else {
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  process.exit(1);
}

function withoutDeletedThreads(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data;
  const { threads, decisions } = data as { threads?: unknown; decisions?: unknown };
  if (!Array.isArray(threads)) return data;
  const records = normalizeReviewDecisions(decisions);
  return {
    ...data,
    threads: threads.filter(
      (thread: { id?: unknown }) =>
        typeof thread?.id !== 'string' || !isThreadDeleted(thread.id, records),
    ),
  };
}

async function parseCommentAddInput(json?: string): Promise<string> {
  if (typeof json === 'string') {
    return json;
  }

  if (detectStdinSource() === 'tty') {
    throw new Error('Provide comment JSON as an argument or via stdin');
  }

  const stdin = await readStdin();
  if (!stdin.trim()) {
    throw new Error('No comment JSON received from stdin');
  }

  return stdin;
}

type WaitResult =
  | { kind: 'threads'; lines: string[] }
  | { kind: 'ended' }
  | { kind: 'unreachable' }
  | { kind: 'refused'; status: number };

// A server stopped and started again on the same port within this time keeps the same wait.
const RECONNECT_WINDOW_MS = 10_000;

export async function waitForAgentTurn(
  port: number,
  reconnectWindowMs = RECONNECT_WINDOW_MS,
): Promise<WaitResult> {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
  let announced = false;
  for (let until = Date.now() + reconnectWindowMs; ; ) {
    let response: Response;
    try {
      response = await fetch(`http://localhost:${port}/api/comments-wait`);
      if (response.status === 404) return { kind: 'refused', status: response.status };
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    } catch {
      if (Date.now() >= until) return { kind: 'unreachable' };
      await pause();
      continue;
    }
    if (!announced) {
      console.error(`Waiting for a review thread on port ${port}`);
      announced = true;
    }
    try {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let cut; (cut = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(cut + 2)) {
          const fields = new Map(
            buffer
              .slice(0, cut)
              .split('\n')
              .map((line) => [
                line.slice(0, line.indexOf(':')),
                line.slice(line.indexOf(':') + 1).trimStart(),
              ]),
          );
          if (fields.get('event') === 'end') return { kind: 'ended' };
          if (fields.get('event') === 'threads') {
            const threads = JSON.parse(fields.get('data') ?? '[]') as unknown[];
            return { kind: 'threads', lines: threads.map((thread) => JSON.stringify(thread)) };
          }
        }
      }
    } catch {}
    until = Date.now() + reconnectWindowMs;
    await pause();
  }
}

export function createCommentCommand(): Command {
  const comment = new Command('comment').description(
    'Add, retrieve, or resolve comments on a running difit server',
  );

  comment
    .command('add')
    .description('Add comments to a running difit server')
    .argument('[json]', 'comment import JSON (object or array)')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .action(async (json: string | undefined, opts: { port: number }) => {
      try {
        const input = await parseCommentAddInput(json);
        const imports = parseCommentImportValue(input);

        const response = await fetch(`http://localhost:${opts.port}/api/comment-imports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(imports),
        });

        if (!response.ok) {
          const errorBody = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          console.error(`Error: ${errorBody.error ?? 'Failed to add comments'}`);
          process.exit(1);
        }

        const result = (await response.json()) as CommentImportResponse;
        console.log(
          JSON.stringify({
            success: result.success ?? true,
            importId: result.importId,
            count: result.count ?? imports.length,
            warnings: result.warnings ?? [],
          }),
        );
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  comment
    .command('get')
    .description('Retrieve comments from a running difit server')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (opts: { port: number; format: string }) => {
      try {
        const endpoint = opts.format === 'json' ? '/api/comments-json' : '/api/comments-output';
        const response = await fetch(`http://localhost:${opts.port}${endpoint}`);

        if (!response.ok) {
          console.error('Error: Failed to retrieve comments');
          process.exit(1);
        }

        if (opts.format === 'json') {
          const data: unknown = await response.json();
          console.log(JSON.stringify(withoutDeletedThreads(data)));
        } else {
          const text = await response.text();
          if (text.trim()) {
            console.log(text);
          }
        }
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  comment
    .command('wait')
    .description(
      'Wait until a review thread is your turn, print each such thread as a JSON line, and exit',
    )
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .action(async (opts: { port: number }) => {
      const result = await waitForAgentTurn(opts.port);
      if (result.kind === 'unreachable') {
        console.error(
          `Error: Cannot connect to difit server on port ${opts.port}. Is the server running?`,
        );
        process.exit(1);
      }
      if (result.kind === 'refused') {
        console.error(
          `Error: difit server on port ${opts.port} answered HTTP ${result.status}; it may be a difit without comment wait.`,
        );
        process.exit(1);
      }
      if (result.kind === 'ended') console.error('Review ended');
      const output =
        result.kind === 'threads' ? result.lines.map((line) => `${line}\n`).join('') : '';
      process.stdout.write(output, () => process.exit(0));
    });

  comment
    .command('resolve')
    .alias('remove')
    .description('Resolve comment threads on a running difit server, keeping them recorded')
    .argument('<threadIds...>', 'thread IDs to resolve')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .action(async (requestedIds: string[], opts: { port: number }) => {
      try {
        const threadIds = [...new Set(requestedIds)];
        const baseUrl = `http://localhost:${opts.port}`;
        const failure = async (response: Response, fallback: string) => {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          return body.error ?? fallback;
        };

        const stateResponse = await fetch(`${baseUrl}/api/comments-json`);
        if (!stateResponse.ok) {
          const error = await failure(stateResponse, 'Failed to retrieve comments');
          console.log(
            JSON.stringify({
              success: false,
              resolved: [],
              notFound: [],
              errors: threadIds.map((threadId) => ({ threadId, error })),
            }),
          );
          process.exit(1);
          return;
        }
        const state = withoutDeletedThreads(await stateResponse.json()) as {
          threads?: unknown;
          decisions?: unknown;
        };
        const decisions = normalizeReviewDecisions(state.decisions);
        const existing = new Set(
          (Array.isArray(state.threads) ? (state.threads as Array<{ id?: unknown }>) : [])
            .map((thread) => thread.id)
            .filter((id): id is string => typeof id === 'string'),
        );

        const notFound = threadIds.filter((id) => !existing.has(id));
        const found = threadIds.filter((id) => existing.has(id));
        const pending = found.filter((id) => !isThreadResolved(id, decisions));

        let resolved = found;
        let errors: Array<{ threadId: string; error: string }> = [];
        if (pending.length > 0) {
          const now = Date.now();
          const response = await fetch(`${baseUrl}/api/decisions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              pending.map((threadId) => ({
                threadId,
                kind: 'resolved',
                fixupSha: '',
                at: new Date(
                  Math.max(now, latestResolutionMarkAt(threadId, decisions) + 1),
                ).toISOString(),
              })),
            ),
          });
          if (!response.ok) {
            const error = await failure(response, 'Failed to resolve thread');
            errors = pending.map((threadId) => ({ threadId, error }));
            resolved = found.filter((id) => !pending.includes(id));
          }
        }

        console.log(
          JSON.stringify({
            success: notFound.length === 0 && errors.length === 0,
            resolved,
            notFound,
            errors,
          }),
        );
        if (notFound.length > 0 || errors.length > 0) {
          process.exit(1);
        }
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  return comment;
}
