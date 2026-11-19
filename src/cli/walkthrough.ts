import { Command } from 'commander';

import { handleCommandError, readJsonInput } from './comment.js';

async function callWalkthrough(
  port: number,
  threadId: string,
  init: { method: 'GET' | 'PUT' | 'DELETE'; body?: string },
): Promise<void> {
  const response = await fetch(
    `http://localhost:${port}/api/threads/${encodeURIComponent(threadId)}/walkthrough`,
    init.method === 'GET'
      ? undefined
      : {
          method: init.method,
          headers: { 'Content-Type': 'application/json' },
          ...(init.body === undefined ? {} : { body: init.body }),
        },
  );
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    console.error(`Error: ${result.error ?? `difit server answered HTTP ${response.status}`}`);
    process.exit(1);
    return;
  }
  console.log(JSON.stringify(result));
}

export function createWalkthroughCommand(): Command {
  const walkthrough = new Command('walkthrough').description(
    "Attach a code walkthrough to the agent's reply on a review thread of a running difit server",
  );

  walkthrough
    .command('add')
    .description(
      "Attach a walkthrough to the thread's latest agent reply, replacing the one it has; prints warnings for steps on missing files or lines",
    )
    .argument('<threadId>', 'thread the reply belongs to')
    .argument(
      '[json]',
      'walkthrough JSON: {"cases":[{"title"?,"setup"?,"steps":[{file,line,endLine?,description,callPath?:["path:line"],variables?:{name:"value"},stateChanges?:{name:"value"},error?:true}]}]}',
    )
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .action(async (threadId: string, json: string | undefined, opts: { port: number }) => {
      try {
        const input = await readJsonInput('walkthrough', json);
        JSON.parse(input);
        await callWalkthrough(opts.port, threadId, { method: 'PUT', body: input.trim() });
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  walkthrough
    .command('get')
    .description('Print the walkthrough on the thread as JSON')
    .argument('<threadId>', 'thread the walkthrough belongs to')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .action(async (threadId: string, opts: { port: number }) => {
      try {
        await callWalkthrough(opts.port, threadId, { method: 'GET' });
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  walkthrough
    .command('remove')
    .description('Remove the walkthrough from the thread')
    .argument('<threadId>', 'thread the walkthrough belongs to')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .action(async (threadId: string, opts: { port: number }) => {
      try {
        await callWalkthrough(opts.port, threadId, { method: 'DELETE' });
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  return walkthrough;
}
