import { existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import type { RewrittenShas } from '../types/diff.js';
import { threadIdsOf, withThreadTrailer } from '../utils/commitMessage.js';

import { autosquashGroups, squashTarget, type TodoCommit } from './autosquash.js';
import { hasOperationInProgress } from './direct-edit.js';
import type { RewriteState } from './rewrite-check.js';
import { type GitOptions, runGit } from './run-git.js';

export interface HistoryRewrite {
  // Where the reviewed range starts; autosquash targets are read from here on.
  base: string;
  // Whole new messages by full SHA, cleaned up as they should stand.
  messages: ReadonlyMap<string, string>;
}

export type HistoryRewriteResult =
  | { ok: true; head: string; rewritten: RewrittenShas }
  | { ok: false; reason: 'conflict' | 'head-moved' | 'commit-failed'; output?: string };

type Failure = Extract<HistoryRewriteResult, { ok: false }>;

async function gitText(repoPath: string, args: string[], options?: GitOptions): Promise<string> {
  const run = await runGit(repoPath, args, options);
  if (run.code !== 0) throw new Error(`git ${args[0]} failed: ${run.output}`);
  return run.stdout.toString('utf8').trim();
}

export async function readRewriteState(
  repoPath: string,
  target: string,
  oldestReplaced: string,
): Promise<
  Pick<RewriteState, 'branch' | 'targetInHead' | 'operationInProgress' | 'rewritesPushedCommit'>
> {
  const [branch, onHead, onUpstream, operationInProgress] = await Promise.all([
    runGit(repoPath, ['symbolic-ref', '-q', '--short', 'HEAD']),
    runGit(repoPath, ['merge-base', '--is-ancestor', target, 'HEAD']),
    // Git fails this the same way when the branch has no upstream, which counts as not pushed.
    runGit(repoPath, ['merge-base', '--is-ancestor', oldestReplaced, '@{upstream}']),
    hasOperationInProgress(repoPath),
  ]);
  return {
    branch: branch.code === 0 ? branch.stdout.toString('utf8').trim() : null,
    targetInHead: onHead.code === 0,
    rewritesPushedCommit: onUpstream.code === 0,
    operationInProgress,
  };
}

const shellQuoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// git's todo with a stop after each commit, and the commits in the order the stops come.
async function plannedTodo(
  dir: string,
  generated: string,
): Promise<{ todo: string; commits: string[] }> {
  const lines = generated.split('\n');
  const abbreviated = lines.flatMap((line) => {
    const [, sha] = /^(?:pick|merge -C) ([0-9a-f]+)/.exec(line) ?? [];
    return sha === undefined ? [] : [sha];
  });
  const commits = (await gitText(dir, ['rev-parse', ...abbreviated])).split('\n');
  const todo = lines.flatMap((line) =>
    /^(?:pick|merge -C) /.test(line) ? [line, 'break'] : [line],
  );
  return { todo: todo.join('\n'), commits };
}

async function readMessages(repoPath: string, commits: string[]): Promise<Map<string, string>> {
  const log = await runGit(repoPath, [
    'log',
    '--no-walk=unsorted',
    '--no-show-signature',
    '--encoding=UTF-8',
    '--format=%x00%H%x00%B',
    ...commits,
    '--',
  ]);
  if (log.code !== 0) throw new Error(`git log failed: ${log.output}`);
  const fields = log.stdout.toString('utf8').split('\0');
  const messages = new Map<string, string>();
  for (let at = 1; at + 1 < fields.length; at += 2) {
    messages.set(fields[at] ?? '', (fields[at + 1] ?? '').trimEnd());
  }
  return messages;
}

const FULL_SHA = /\b[0-9a-f]{40}\b/g;
const AUTOSQUASH_PREFIXES = /^(?:(?:fixup|squash|amend)! )+/;

// The message each commit should end up with, once the commits before it have their new SHAs.
function messagePlanner(listed: TodoCommit[], messages: HistoryRewrite['messages']) {
  const targets = new Map(listed.map((commit, index) => [commit.sha, squashTarget(listed, index)]));
  const rootOf = new Map(
    autosquashGroups(listed).flatMap((group) => group.map(({ sha }) => [sha, group[0]?.sha])),
  );
  const subjectOf = new Map(listed.map(({ sha, subject }) => [sha, subject]));

  return (commit: string, current: string, rewritten: RewrittenShas): string => {
    const subject = subjectOf.get(commit) ?? '';
    const [firstParagraph = '', ...rest] = current.split('\n\n');
    const root = rootOf.get(commit);
    const saved = root === undefined ? undefined : messages.get(root);

    // An amend! left as it was would take the saved message back off when it folds.
    const body =
      subject.startsWith('amend! ') && saved !== undefined
        ? threadIdsOf(current).reduce((text, id) => withThreadTrailer(text, id), saved)
        : rest.join('\n\n');
    const target = targets.get(commit);
    const movedTarget = target && rewritten[target.sha];
    const prefixes = AUTOSQUASH_PREFIXES.exec(subject)?.[0] ?? '';
    const title = movedTarget ? `${prefixes}${movedTarget}` : firstParagraph;
    const message = messages.get(commit) ?? (body === '' ? title : `${title}\n\n${body}`);

    return message.replace(FULL_SHA, (sha) => rewritten[sha] ?? sha);
  };
}

// The empty hooks folder keeps the repository's hooks out, as with every commit difit makes.
const rewriteConfig = (hooks: string) => [
  '-c',
  `core.hooksPath=${hooks}`,
  '-c',
  'rebase.autoSquash=false',
  '-c',
  'rebase.updateRefs=false',
  '-c',
  'rebase.abbreviateCommands=false',
  '-c',
  'rebase.missingCommitsCheck=ignore',
  '-c',
  'rerere.enabled=false',
  '-c',
  'i18n.commitEncoding=UTF-8',
];

export async function rewriteHistory(
  repoPath: string,
  request: HistoryRewrite,
): Promise<HistoryRewriteResult> {
  const head = await gitText(repoPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const range = `${request.base}..${head}`;
  const oldest = (await gitText(repoPath, ['rev-list', '--topo-order', '--reverse', range]))
    .split('\n')
    .find((commit) => request.messages.has(commit));
  if (oldest === undefined) return { ok: false, reason: 'commit-failed' };
  const listed = (
    await gitText(repoPath, [
      'log',
      '--reverse',
      '--no-merges',
      '--no-show-signature',
      '--encoding=UTF-8',
      '--format=%H%x00%s',
      range,
      '--',
    ])
  )
    .split('\n')
    .map((line) => {
      const [sha = '', subject = ''] = line.split('\0');
      return { sha, subject };
    });
  const plan = messagePlanner(listed, request.messages);

  const dir = await fs.mkdtemp(join(tmpdir(), 'difit-history-rewrite-'));
  const hooks = join(dir, 'no-hooks');
  const worktree = join(dir, 'worktree');
  await fs.mkdir(hooks);
  const config = rewriteConfig(hooks);
  try {
    const added = await runGit(repoPath, [
      ...config,
      'worktree',
      'add',
      '--quiet',
      '--detach',
      worktree,
      head,
    ]);
    if (added.code !== 0) return { ok: false, reason: 'commit-failed', output: added.output };
    return await rewriteInWorktree(repoPath, worktree, dir, config, {
      head,
      upstream: `${oldest}^`,
      plan,
    });
  } finally {
    const removed = await runGit(repoPath, ['worktree', 'remove', '--force', worktree]);
    await fs.rm(dir, { recursive: true, force: true });
    if (removed.code !== 0) await runGit(repoPath, ['worktree', 'prune']);
  }
}

interface Replay {
  head: string;
  upstream: string;
  plan: ReturnType<typeof messagePlanner>;
}

// The rebase runs in a worktree of its own, so the reviewer's files, index and branch stay put until
// the one ref update at the end, and giving up leaves nothing to undo.
async function rewriteInWorktree(
  repoPath: string,
  worktree: string,
  dir: string,
  config: string[],
  { head, upstream, plan }: Replay,
): Promise<HistoryRewriteResult> {
  const generatedPath = join(dir, 'generated-todo');
  const todoPath = join(dir, 'todo');
  const rebase = (args: string[], sequenceEditor: string) =>
    runGit(worktree, [...config, 'rebase', ...args], {
      env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: sequenceEditor },
    });
  const start = ['--interactive', '--rebase-merges', '--no-autostash', '--no-gpg-sign', upstream];

  // Git adds the todo's path as the editor's last argument; failing here ends this first rebase.
  const listing = await rebase(
    start,
    `f() { cp "$1" ${shellQuoted(generatedPath)}; return 1; }; f`,
  );
  const generated = await fs.readFile(generatedPath, 'utf8').catch(() => null);
  if (generated === null) return { ok: false, reason: 'commit-failed', output: listing.output };
  const { todo, commits } = await plannedTodo(worktree, generated);
  await fs.writeFile(todoPath, todo);
  const current = await readMessages(repoPath, commits);

  const stuck = async (output: string): Promise<Failure> => {
    const state = await gitText(worktree, ['rev-parse', '--git-path', 'rebase-merge']);
    return {
      ok: false,
      reason: existsSync(resolve(worktree, state)) ? 'conflict' : 'commit-failed',
      output,
    };
  };

  let run = await rebase(start, `cp ${shellQuoted(todoPath)}`);
  if (run.code !== 0) return stuck(run.output);
  const rewritten: Record<string, string> = {};
  for (const commit of commits) {
    const message = current.get(commit) ?? '';
    const planned = plan(commit, message, rewritten);
    if (planned !== message) {
      const amended = await runGit(
        worktree,
        [
          ...config,
          'commit',
          '--quiet',
          '--amend',
          '--allow-empty',
          '--no-verify',
          '--no-gpg-sign',
          '--cleanup=verbatim',
          '--file=-',
        ],
        { input: Buffer.from(`${planned}\n`, 'utf8') },
      );
      if (amended.code !== 0) return { ok: false, reason: 'commit-failed', output: amended.output };
    }
    const landed = await gitText(worktree, ['rev-parse', 'HEAD']);
    if (landed !== commit) rewritten[commit] = landed;
    run = await rebase(['--continue'], 'true');
    if (run.code !== 0) return stuck(run.output);
  }

  const newHead = await gitText(worktree, ['rev-parse', 'HEAD']);
  const [oldTree, newTree] = await Promise.all(
    [head, newHead].map((commit) => gitText(worktree, ['rev-parse', `${commit}^{tree}`])),
  );
  if (oldTree !== newTree) {
    return {
      ok: false,
      reason: 'conflict',
      output: `The rewritten history ends in tree ${newTree ?? ''}, not ${oldTree ?? ''}: a merge held changes that rebuilding it dropped.`,
    };
  }

  const moved = await runGit(repoPath, [
    'update-ref',
    '-m',
    'difit: rewrite history',
    'HEAD',
    newHead,
    head,
  ]);
  if (moved.code === 0) return { ok: true, head: newHead, rewritten };
  const headNow = await gitText(repoPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
  return {
    ok: false,
    reason: headNow === head ? 'commit-failed' : 'head-moved',
    output: moved.output,
  };
}
