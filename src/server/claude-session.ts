import { createConnection } from 'node:net';

import type { ThreadAwaitingAgent } from '../types/diff.js';

export function sessionMessageFor(port: number, threads: ThreadAwaitingAgent[]): string {
  const named = threads
    .map((thread) => (thread.label ? `${thread.threadId} [${thread.label}]` : thread.threadId))
    .join(', ');
  return [
    `difit review: your turn on ${named}; read with difit comment get --port ${port} --format json`,
    ...threads.map((thread) => JSON.stringify(thread)),
  ].join('\n');
}

export function claudeSessionListening(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const socketPath = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!socketPath) return Promise.resolve(false);
  return new Promise((resolve) => {
    const connection = createConnection(socketPath, () => {
      connection.end();
      resolve(true);
    });
    connection.on('error', () => resolve(false));
  });
}

// Resolves to whether the message reached the session's socket.
export function sendToClaudeSession(
  content: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const socketPath = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!socketPath) return Promise.resolve(false);
  return new Promise((resolve) => {
    let failed = false;
    const connection = createConnection(socketPath, () => {
      const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
      if (token) connection.write(`${JSON.stringify({ type: 'auth', token })}\n`);
      connection.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
    });
    connection.on('close', () => resolve(!failed));
    connection.on('error', (error) => {
      failed = true;
      console.error(
        `Could not send the review update to the Claude Code session: ${error.message}`,
      );
      resolve(false);
    });
  });
}
