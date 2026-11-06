import { existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';

import { AUTOSQUASH_PREFIX, type LeftBranch, type RewrittenShas } from '../types/diff.js';
import { threadIdsOf, withThreadTrailer } from '../utils/commitMessage.js';

import { autosquashGroups, squashTarget, type TodoCommit } from './autosquash.js';
import { hasOperationInProgress } from './direct-edit.js';
import type { RewriteState } from './rewrite-check.js';
import { type GitOptions, runGit } from './run-git.js';
import { findStackedBranches } from './stacked-branches.js';

export interface HistoryRewrite {
  // Where the reviewed range starts; autosquash targets are read from here on.
  base: string;
  // Whole new messages by full SHA, cleaned up as they should stand.
  messages: ReadonlyMap<string, string>;
  // Stays where it is even when it holds a replaced commit.
  defaultBranch: string | null;
  // The commits the review lists, oldest first, in the order they should stand.
  order?: readonly string[];
}

export type HistoryRewriteResult =
  | {
      ok: true;
      head: string;
      rewritten: RewrittenShas;
      branches: { moved: string[]; left: LeftBranch[] };
    }
  | {
      ok: false;
      reason: 'conflict' | 'head-moved' | 'branch-moved' | 'commit-failed';
      output?: string;
      commit?: { sha: string; subject: string };
    };

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
  defaultBranch: string | null,
): Promise<
  Pick<
    RewriteState,
    'branch' | 'targetInHead' | 'operationInProgress' | 'leftBranches' | 'rewritesPushedCommit'
  >
> {
  const [headBranch, onHead, onUpstream, operationInProgress] = await Promise.all([
    runGit(repoPath, ['symbolic-ref', '-q', '--short', 'HEAD']),
    runGit(repoPath, ['merge-base', '--is-ancestor', target, 'HEAD']),
    // Git fails this the same way when the branch has no upstream, which counts as not pushed.
    runGit(repoPath, ['merge-base', '--is-ancestor', oldestReplaced, '@{upstream}']),
    hasOperationInProgress(repoPath),
  ]);
  const branch = headBranch.code === 0 ? headBranch.stdout.toString('utf8').trim() : null;
  const { left } = await findStackedBranches(repoPath, {
    oldest: oldestReplaced,
    headBranch: branch,
    defaultBranch,
  });
  return {
    branch,
    targetInHead: onHead.code === 0,
    rewritesPushedCommit: onUpstream.code === 0,
    operationInProgress,
    leftBranches: left,
  };
}

const shellQuoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// The whole first-parent line in its new order, or null when `order` names a commit off that line.
// A commit the review does not list goes with the listed commit before it. A fixup standing ahead of
// the commit before it in its autosquash group then goes right behind that commit. What stands above
// the last listed commit stays above the review.
function lineInOrder(
  line: readonly string[],
  order: readonly string[],
  groups: readonly TodoCommit[][],
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
  const settled = [...placed];
  for (const group of groups) {
    let previous: string | undefined;
    for (const { sha } of group) {
      if (!settled.includes(sha)) continue;
      if (previous !== undefined && settled.indexOf(sha) < settled.indexOf(previous)) {
        settled.splice(settled.indexOf(sha), 1);
        settled.splice(settled.indexOf(previous) + 1, 0, sha);
      }
      previous = sha;
    }
  }
  return [...line.slice(0, firstListed), ...settled, ...line.slice(lastListed + 1)];
}

const TARGET_SEARCH_DEPTH = 1000;

// The commit below the base each fixup folds into, as git picks it in the shortest autosquash
// rebase that reaches the nearest match of every fixup: the oldest exact subject, then the commit
// id, then the oldest subject that starts with the name.
async function targetsBelow(
  repoPath: string,
  base: string,
  fixups: TodoCommit[],
): Promise<Map<string, string>> {
  const log = await runGit(repoPath, [
    'log',
    '--topo-order',
    '--no-merges',
    '--no-show-signature',
    '--encoding=UTF-8',
    `--max-count=${TARGET_SEARCH_DEPTH}`,
    '--format=%H%x00%s',
    base,
    '--',
  ]);
  if (log.code !== 0) return new Map();
  const below = log.stdout
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', subject = ''] = line.split('\0');
      return { sha, subject };
    });
  const reach = Math.max(
    -1,
    ...fixups.map((fixup) =>
      below.findIndex((commit) => squashTarget([commit, fixup], 1) !== undefined),
    ),
  );
  const reached = below.slice(0, reach + 1).reverse();
  return new Map(
    fixups.flatMap((fixup) => {
      const target = squashTarget([...reached, fixup], reached.length);
      return target ? [[fixup.sha, target.sha] as const] : [];
    }),
  );
}

// The autosquash groups, with the fixups that fold into one commit below the base joined into one
// group.
async function orderingGroups(
  repoPath: string,
  base: string,
  listed: TodoCommit[],
): Promise<TodoCommit[][]> {
  const groups = autosquashGroups(listed);
  const unplaced = groups.flatMap(([root]) =>
    root && AUTOSQUASH_PREFIX.test(root.subject) ? [root] : [],
  );
  if (unplaced.length === 0) return groups;
  const targetOf = await targetsBelow(repoPath, base, unplaced);
  const position = new Map(listed.map(({ sha }, at) => [sha, at]));
  const byTarget = new Map<string, TodoCommit[]>();
  const joined: TodoCommit[][] = [];
  for (const group of groups) {
    const [root] = group;
    if (!root || !AUTOSQUASH_PREFIX.test(root.subject)) {
      joined.push(group);
      continue;
    }
    const target = targetOf.get(root.sha) ?? root.subject.replace(AUTOSQUASH_PREFIXES, '');
    const same = byTarget.get(target);
    if (same) {
      same.push(...group);
      same.sort((a, b) => (position.get(a.sha) ?? 0) - (position.get(b.sha) ?? 0));
    } else {
      const fresh = [...group];
      byTarget.set(target, fresh);
      joined.push(fresh);
    }
  }
  return joined;
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

// After a new order, where a branch grown from a commit of HEAD's history starts again.
interface Restart {
  // By replaced commit, the commit that holds the same files now.
  sameFiles: ReadonlyMap<string, string>;
  // The replaced commits of HEAD's history; one with no commit holding its files restarts on `tip`.
  onHead: ReadonlySet<string>;
  tip: string;
}

// git's todo with a stop after each commit still to replay, and those commits in the order the stops
// come; a commit already replayed is not picked again but reset to where it landed. `restarted`
// tells that the commits start again on other files than they grew from.
async function plannedTodo(
  dir: string,
  generated: string,
  landedAt: ReadonlyMap<string, string>,
  { order, restart }: { order?: readonly string[] | undefined; restart?: Restart | undefined },
  signal: AbortSignal,
): Promise<{ todo: string; commits: string[]; restarted: boolean } | null> {
  const generatedLines = generated.split('\n');
  const named = generatedLines.flatMap((line) => {
    const [, sha] = TODO_COMMIT.exec(line) ?? [];
    return sha === undefined ? [] : [{ line, sha }];
  });
  const full = (
    await gitText(dir, ['rev-parse', ...named.map(({ sha }) => sha)], { signal })
  ).split('\n');
  const shaOfLine = new Map(named.map(({ line }, index) => [line, full[index] ?? '']));
  const lines = order ? todoInOrder(generatedLines, shaOfLine, order) : generatedLines;
  if (lines === null) return null;
  const todo: { line: string; onOtherFiles?: boolean }[] = [];
  const commits: string[] = [];
  for (const line of lines) {
    const commit = shaOfLine.get(line);
    if (commit === undefined) {
      todo.push({ line });
      continue;
    }
    const landed = landedAt.get(commit);
    if (landed === undefined) {
      todo.push({ line }, { line: 'break' });
      commits.push(commit);
      continue;
    }
    if (todo.at(-1)?.line.startsWith('reset ')) todo.pop();
    const sameFiles = restart?.sameFiles.get(commit);
    const onOtherFiles =
      restart !== undefined && sameFiles === undefined && restart.onHead.has(commit);
    todo.push({
      line: `reset ${sameFiles ?? (onOtherFiles ? restart.tip : landed)}`,
      onOtherFiles,
    });
  }
  return {
    todo: todo.map(({ line }) => line).join('\n'),
    commits,
    restarted: todo.some(({ onOtherFiles }) => onOtherFiles),
  };
}

// By replaced commit, the commit holding the same files once the line stands in its new order. A
// commit of the line is looked for at its old place in the line, any other where it landed.
async function sameFilesAfter(
  worktree: string,
  line: readonly string[],
  lineWanted: readonly string[],
  landedAt: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const placeOf = new Map(line.map((commit, at) => [commit, at]));
  const pairs = [...landedAt.keys()].flatMap((commit) => {
    const at = placeOf.get(commit);
    const now = landedAt.get(at === undefined ? commit : (lineWanted[at] ?? commit));
    return now === undefined ? [] : [[commit, now] as const];
  });
  if (pairs.length === 0) return new Map();
  const trees = (
    await gitText(worktree, ['rev-parse', ...pairs.flat().map((commit) => `${commit}^{tree}`)], {
      signal,
    })
  ).split('\n');
  return new Map(pairs.filter((_, index) => trees[2 * index] === trees[2 * index + 1]));
}

async function readMessages(
  repoPath: string,
  commits: string[],
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const log = await runGit(
    repoPath,
    [
      'log',
      '--no-walk=unsorted',
      '--no-show-signature',
      '--encoding=UTF-8',
      '--format=%x00%H%x00%B',
      ...commits,
      '--',
    ],
    { signal },
  );
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

async function listCommits(
  repoPath: string,
  range: string,
  signal: AbortSignal,
): Promise<TodoCommit[]> {
  return (
    await gitText(
      repoPath,
      [
        'log',
        '--reverse',
        '--no-merges',
        '--no-show-signature',
        '--encoding=UTF-8',
        '--format=%H%x00%s',
        range,
        '--',
      ],
      { signal },
    )
  )
    .split('\n')
    .map((line) => {
      const [sha = '', subject = ''] = line.split('\0');
      return { sha, subject };
    });
}

const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REWRITE_DIR_PREFIX = 'difit-history-rewrite-';
const OWNER_FILE = 'owner';
const INTERRUPTING_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

async function removeRewriteDir(repoPath: string, dir: string): Promise<void> {
  const removed = await runGit(repoPath, ['worktree', 'remove', '--force', join(dir, 'worktree')]);
  await fs.rm(dir, { recursive: true, force: true });
  if (removed.code !== 0) await runGit(repoPath, ['worktree', 'prune']);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function removeAbandonedRewrites(repoPath: string): Promise<void> {
  const listed = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
  if (listed.code !== 0) return;
  const dirs = listed.stdout
    .toString('utf8')
    .split('\n')
    .flatMap((line) => (line.startsWith('worktree ') ? [line.slice('worktree '.length)] : []))
    .filter((path) => basename(path) === 'worktree')
    .map(dirname)
    .filter((dir) => basename(dir).startsWith(REWRITE_DIR_PREFIX));
  for (const dir of dirs) {
    const owner = Number(await fs.readFile(join(dir, OWNER_FILE), 'utf8').catch(() => ''));
    if (!Number.isInteger(owner) || owner <= 0 || isRunning(owner)) continue;
    await removeRewriteDir(repoPath, dir);
  }
}

export async function rewriteHistory(
  repoPath: string,
  request: HistoryRewrite,
): Promise<HistoryRewriteResult> {
  const head = await gitText(repoPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const range = `${request.base}..${head}`;
  const interrupted = new AbortController();
  const { signal } = interrupted;
  const listed = await listCommits(repoPath, range, signal);
  const line = (await gitText(repoPath, ['rev-list', '--first-parent', '--reverse', range])).split(
    '\n',
  );
  const lineWanted = request.order
    ? lineInOrder(line, request.order, await orderingGroups(repoPath, request.base, listed))
    : null;
  if (request.order && lineWanted === null) {
    return { ok: false, reason: 'commit-failed', output: 'A commit left the line of the review.' };
  }
  const firstMoved = lineWanted?.findIndex((commit, index) => commit !== line[index]) ?? -1;
  const oldest = (await gitText(repoPath, ['rev-list', '--topo-order', '--reverse', range]))
    .split('\n')
    .find((commit) => request.messages.has(commit) || commit === line[firstMoved]);
  if (oldest === undefined) return { ok: false, reason: 'commit-failed' };
  const headBranch = await runGit(repoPath, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const stack = await findStackedBranches(repoPath, {
    oldest,
    headBranch: headBranch.code === 0 ? headBranch.stdout.toString('utf8').trim() : null,
    defaultBranch: request.defaultBranch,
  });
  const byLength = await Promise.all(
    stack.moving.map(async (branch) => ({
      ...branch,
      length: Number(await gitText(repoPath, ['rev-list', '--count', `${oldest}^..${branch.tip}`])),
    })),
  );
  byLength.sort((a, b) => b.length - a.length);

  const dir = await fs.mkdtemp(join(tmpdir(), REWRITE_DIR_PREFIX));
  let received: NodeJS.Signals | undefined;
  const interrupt = (name: NodeJS.Signals) => {
    received ??= name;
    interrupted.abort();
  };
  for (const name of INTERRUPTING_SIGNALS) process.on(name, interrupt);
  const hooks = join(dir, 'no-hooks');
  const worktree = join(dir, 'worktree');
  const config = rewriteConfig(hooks);
  try {
    await fs.writeFile(join(dir, OWNER_FILE), `${process.pid}\n`);
    await fs.mkdir(hooks);
    const added = await runGit(
      repoPath,
      [...config, 'worktree', 'add', '--quiet', '--detach', worktree, head],
      { signal },
    );
    if (added.code !== 0) return { ok: false, reason: 'commit-failed', output: added.output };
    const replay = new Replay(repoPath, worktree, dir, config, `${oldest}^`, signal);
    const replayed = await replay.run(messagePlanner(listed, request.messages), {
      order: lineWanted?.slice(firstMoved),
    });
    if (!replayed.ok) return replayed;
    const newHead = await gitText(worktree, ['rev-parse', 'HEAD'], { signal });
    const restart = lineWanted && {
      sameFiles: await sameFilesAfter(worktree, line, lineWanted, replay.landedAt, signal),
      onHead: new Set(replay.landedAt.keys()),
      tip: newHead,
    };
    for (const { name, tip } of byLength) {
      if (replay.landedAt.has(tip)) continue;
      const moved =
        (await replay.checkout(tip)) ??
        (await replay.run(
          messagePlanner(
            await listCommits(repoPath, `${request.base}..${tip}`, signal),
            request.messages,
          ),
          { restart: restart ?? undefined },
        ));
      if (!moved.ok) return { ...moved, output: `Moving branch ${name}: ${moved.output ?? ''}` };
    }

    const left = [...stack.left];
    const moves = stack.moving.flatMap(({ name, tip }) => {
      const landed = restart?.onHead.has(tip)
        ? restart.sameFiles.get(tip)
        : replay.landedAt.get(tip);
      if (landed === undefined && restart) left.push({ name, why: 'order-changed' });
      return landed === undefined || landed === tip ? [] : [{ name, tip, landed }];
    });
    // Messages and the order change, not files: every tip keeps its files, but for a branch that
    // started again on the new tip.
    for (const { name, tip, landed } of [{ name: 'HEAD', tip: head, landed: newHead }, ...moves]) {
      if (replay.restarted.has(tip)) continue;
      const [oldTree, newTree] = await Promise.all(
        [tip, landed].map((commit) =>
          gitText(worktree, ['rev-parse', `${commit}^{tree}`], { signal }),
        ),
      );
      if (oldTree !== newTree) {
        return {
          ok: false,
          reason: 'conflict',
          output: `${name === 'HEAD' ? '' : `Moving branch ${name}: `}The rewritten history ends in tree ${newTree}, not ${oldTree}: a merge held changes that rebuilding it dropped.`,
        };
      }
    }

    const updates = [
      `update HEAD ${newHead} ${head}`,
      ...moves.map(({ name, tip, landed }) => `update refs/heads/${name} ${landed} ${tip}`),
    ];
    // An empty new value would delete the branch.
    if (
      !updates.every((line) =>
        line
          .split(' ')
          .slice(2)
          .every((sha) => OBJECT_NAME.test(sha)),
      )
    ) {
      return { ok: false, reason: 'commit-failed', output: updates.join('\n') };
    }
    signal.throwIfAborted();
    const written = await runGit(
      repoPath,
      ['-c', `core.hooksPath=${hooks}`, 'update-ref', '-m', 'difit: rewrite history', '--stdin'],
      { input: Buffer.from(['start', ...updates, 'prepare', 'commit', ''].join('\n'), 'utf8') },
    );
    if (written.code === 0) {
      return {
        ok: true,
        head: newHead,
        rewritten: replay.rewritten,
        branches: { moved: moves.map(({ name }) => name), left },
      };
    }
    return { ok: false, reason: await whatMoved(repoPath, head, moves), output: written.output };
  } finally {
    await removeRewriteDir(repoPath, dir);
    for (const name of INTERRUPTING_SIGNALS) process.off(name, interrupt);
    if (received && process.listenerCount(received) === 0) process.kill(process.pid, received);
  }
}

async function whatMoved(
  repoPath: string,
  head: string,
  moves: { name: string; tip: string }[],
): Promise<'head-moved' | 'branch-moved' | 'commit-failed'> {
  const headNow = await gitText(repoPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (headNow !== head) return 'head-moved';
  const tipsNow = await Promise.all(
    moves.map(({ name }) => runGit(repoPath, ['rev-parse', '--verify', `refs/heads/${name}`])),
  );
  const branchMoved = tipsNow.some(
    (run, index) => run.code !== 0 || run.stdout.toString('utf8').trim() !== moves[index]?.tip,
  );
  return branchMoved ? 'branch-moved' : 'commit-failed';
}

// The rebases run in a worktree of their own, so the reviewer's files, index and branches stay put
// until the one ref transaction at the end, and giving up leaves nothing to undo.
class Replay {
  // Old SHA to where it landed for every commit replayed so far, unchanged ones included.
  readonly landedAt = new Map<string, string>();
  readonly rewritten: Record<string, string> = {};
  // The replayed commits that started again on other files than they grew from.
  readonly restarted = new Set<string>();

  constructor(
    private readonly repoPath: string,
    private readonly worktree: string,
    private readonly dir: string,
    private readonly config: string[],
    private readonly upstream: string,
    private readonly signal: AbortSignal,
  ) {}

  async checkout(tip: string): Promise<Failure | null> {
    const { worktree, config, signal } = this;
    const run = await runGit(worktree, [...config, 'checkout', '--quiet', '--detach', tip], {
      signal,
    });
    return run.code === 0 ? null : { ok: false, reason: 'commit-failed', output: run.output };
  }

  async run(
    plan: ReturnType<typeof messagePlanner>,
    placing: Parameters<typeof plannedTodo>[3] = {},
  ): Promise<{ ok: true } | Failure> {
    const { worktree, config, signal } = this;
    const generatedPath = join(this.dir, 'generated-todo');
    const todoPath = join(this.dir, 'todo');
    await fs.rm(generatedPath, { force: true });
    const rebase = (args: string[], sequenceEditor: string) =>
      runGit(worktree, [...config, 'rebase', ...args], {
        env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: sequenceEditor },
        signal,
      });
    const start = [
      '--interactive',
      '--rebase-merges',
      '--no-autostash',
      '--no-gpg-sign',
      this.upstream,
    ];

    // Git adds the todo's path as the editor's last argument; failing here ends this first rebase.
    const listing = await rebase(
      start,
      `f() { cp "$1" ${shellQuoted(generatedPath)}; return 1; }; f`,
    );
    const generated = await fs.readFile(generatedPath, 'utf8').catch(() => null);
    if (generated === null) return { ok: false, reason: 'commit-failed', output: listing.output };
    const planned = await plannedTodo(worktree, generated, this.landedAt, placing, signal);
    if (planned === null) {
      return {
        ok: false,
        reason: 'conflict',
        output: 'A commit that a side branch grows from would move past another such commit.',
      };
    }
    const { todo, commits } = planned;
    if (planned.restarted) for (const commit of commits) this.restarted.add(commit);
    await fs.writeFile(todoPath, todo);
    const current = await readMessages(this.repoPath, commits, signal);

    // Every commit in the todo is followed by a break, so a failed run stopped at the next commit.
    const stuck = async (output: string, next: number): Promise<Failure> => {
      const state = await gitText(worktree, ['rev-parse', '--git-path', 'rebase-merge'], {
        signal,
      });
      if (!existsSync(resolve(worktree, state))) {
        return { ok: false, reason: 'commit-failed', output };
      }
      const sha = commits[next];
      const subject = current.get(sha ?? '')?.split('\n')[0] ?? '';
      return {
        ok: false,
        reason: 'conflict',
        output,
        ...(sha ? { commit: { sha, subject } } : {}),
      };
    };

    let run = await rebase(start, `cp ${shellQuoted(todoPath)}`);
    if (run.code !== 0) return stuck(run.output, 0);
    for (const [at, commit] of commits.entries()) {
      const message = current.get(commit) ?? '';
      const wanted = plan(commit, message, this.rewritten);
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
          { input: Buffer.from(`${wanted}\n`, 'utf8'), signal },
        );
        if (amended.code !== 0) {
          return { ok: false, reason: 'commit-failed', output: amended.output };
        }
      }
      const landed = await gitText(worktree, ['rev-parse', 'HEAD'], { signal });
      this.landedAt.set(commit, landed);
      if (landed !== commit) this.rewritten[commit] = landed;
      run = await rebase(['--continue'], 'true');
      if (run.code !== 0) return stuck(run.output, at + 1);
    }
    return { ok: true };
  }
}
