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
  // The commits the review lists, oldest first, in the order they should stand.
  order?: readonly string[];
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

// The whole first-parent line in its new order, or null when `order` names a commit off that line.
// A commit the review does not list goes with the listed commit before it, behind its squash target
// if that moved past it. What stands above the last listed commit stays above the review.
function lineInOrder(
  line: readonly string[],
  order: readonly string[],
  listed: TodoCommit[],
): string[] | null {
  if (order.some((commit) => !line.includes(commit))) return null;
  const isListed = new Set(order);
  const places = line.flatMap((commit, at) => (isListed.has(commit) ? [at] : []));
  const firstListed = places[0] ?? 0;
  const lastListed = places.at(-1) ?? -1;
  const following = new Map<string, string[]>();
  let current: string[] = [];
  for (const commit of line.slice(firstListed, lastListed + 1)) {
    if (isListed.has(commit)) following.set(commit, (current = []));
    else current.push(commit);
  }
  const placed = order.flatMap((commit) => [commit, ...(following.get(commit) ?? [])]);

  const targetOf = new Map(
    listed.flatMap((commit, index) => {
      const target = squashTarget(listed, index);
      return target ? [[commit.sha, target.sha] as const] : [];
    }),
  );
  const before = (commit: string, other: string) => placed.indexOf(commit) < placed.indexOf(other);
  const late = placed.filter((commit) => {
    const target = targetOf.get(commit);
    return target !== undefined && placed.includes(target) && before(commit, target);
  });
  const settled = placed.filter((commit) => !late.includes(commit));
  for (const commit of [...late].reverse()) {
    settled.splice(settled.indexOf(targetOf.get(commit) ?? '') + 1, 0, commit);
  }
  return [...line.slice(0, firstListed), ...settled, ...line.slice(lastListed + 1)];
}

// A commit a side branch grows from carries the label git put after it, and the lines of that branch
// stay behind the label; such commits keep their order among themselves, or this returns null.
function todoInOrder(
  lines: readonly string[],
  shaOfLine: ReadonlyMap<string, string>,
  order: readonly string[],
): string[] | null {
  const moving = new Set(order);
  const slots = lines.flatMap((line, at) => (moving.has(shaOfLine.get(line) ?? '') ? [at] : []));
  const slotOf = new Map(slots.map((at) => [shaOfLine.get(lines[at] ?? ''), at]));
  const anchors = slots.filter((at) => lines[at + 1]?.startsWith('label '));

  const placedAt = new Map<number, string[]>();
  let group: string[] = [];
  let anchorsSeen = 0;
  for (const commit of order) {
    const at = slotOf.get(commit);
    if (at === undefined) return null;
    group.push(lines[at] ?? '');
    if (anchors.includes(at)) {
      if (anchors[anchorsSeen] !== at) return null;
      placedAt.set(at, group);
      group = [];
      anchorsSeen += 1;
    }
  }
  if (group.length > 0) {
    const rest = slots.find((at) => at > (anchors.at(-1) ?? -1));
    if (rest === undefined) return null;
    placedAt.set(rest, group);
  }
  return lines.flatMap((line, at) => (slots.includes(at) ? (placedAt.get(at) ?? []) : [line]));
}

const TODO_COMMIT = /^(?:pick|merge -C) ([0-9a-f]+)/;

// git's todo with a stop after each commit, and the commits in the order the stops come.
async function plannedTodo(
  dir: string,
  generated: string,
  order: readonly string[] | undefined,
): Promise<{ todo: string; commits: string[] } | null> {
  const generatedLines = generated.split('\n');
  const named = generatedLines.flatMap((line) => {
    const [, sha] = TODO_COMMIT.exec(line) ?? [];
    return sha === undefined ? [] : [{ line, sha }];
  });
  const full = (await gitText(dir, ['rev-parse', ...named.map(({ sha }) => sha)])).split('\n');
  const shaOfLine = new Map(named.map(({ line }, index) => [line, full[index] ?? '']));
  const lines = order ? todoInOrder(generatedLines, shaOfLine, order) : generatedLines;
  if (lines === null) return null;
  const todo = lines.flatMap((line) => (TODO_COMMIT.test(line) ? [line, 'break'] : [line]));
  const commits = lines.flatMap((line) => {
    const commit = shaOfLine.get(line);
    return commit === undefined ? [] : [commit];
  });
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
  const line = (await gitText(repoPath, ['rev-list', '--first-parent', '--reverse', range])).split(
    '\n',
  );
  const lineWanted = request.order ? lineInOrder(line, request.order, listed) : null;
  if (request.order && lineWanted === null) {
    return { ok: false, reason: 'commit-failed', output: 'A commit left the line of the review.' };
  }
  const firstMoved = lineWanted?.findIndex((commit, index) => commit !== line[index]) ?? -1;
  const oldest = (await gitText(repoPath, ['rev-list', '--topo-order', '--reverse', range]))
    .split('\n')
    .find((commit) => request.messages.has(commit) || commit === line[firstMoved]);
  if (oldest === undefined) return { ok: false, reason: 'commit-failed' };
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
      ...(lineWanted ? { order: lineWanted.slice(firstMoved) } : {}),
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
  order?: readonly string[];
}

// The rebase runs in a worktree of its own, so the reviewer's files, index and branch stay put until
// the one ref update at the end, and giving up leaves nothing to undo.
async function rewriteInWorktree(
  repoPath: string,
  worktree: string,
  dir: string,
  config: string[],
  { head, upstream, plan, order }: Replay,
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
  const planned = await plannedTodo(worktree, generated, order);
  if (planned === null) {
    return {
      ok: false,
      reason: 'conflict',
      output: 'A commit that a side branch grows from would move past another such commit.',
    };
  }
  const { todo, commits } = planned;
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
    const wanted = plan(commit, message, rewritten);
    if (wanted !== message) {
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
        { input: Buffer.from(`${wanted}\n`, 'utf8') },
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
