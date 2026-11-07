import { existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import type { LeftBranch, RewrittenShas } from '../types/diff.js';
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
): Promise<Pick<RewriteState, 'branch' | 'targetInHead' | 'operationInProgress'>> {
  const [branch, onHead, operationInProgress] = await Promise.all([
    runGit(repoPath, ['symbolic-ref', '-q', '--short', 'HEAD']),
    runGit(repoPath, ['merge-base', '--is-ancestor', target, 'HEAD']),
    hasOperationInProgress(repoPath),
  ]);
  return {
    branch: branch.code === 0 ? branch.stdout.toString('utf8').trim() : null,
    targetInHead: onHead.code === 0,
    operationInProgress,
  };
}

const shellQuoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// git's todo with a stop after each commit still to replay, and those commits in the order the stops
// come; a commit already replayed is not picked again but reset to where it landed.
async function plannedTodo(
  dir: string,
  generated: string,
  landedAt: ReadonlyMap<string, string>,
): Promise<{ todo: string; commits: string[] }> {
  const lines = generated.split('\n');
  const abbreviated = lines.flatMap((line) => {
    const [, sha] = /^(?:pick|merge -C) ([0-9a-f]+)/.exec(line) ?? [];
    return sha === undefined ? [] : [sha];
  });
  const full = (await gitText(dir, ['rev-parse', ...abbreviated])).split('\n');
  const todo: string[] = [];
  const commits: string[] = [];
  let next = 0;
  for (const line of lines) {
    if (!/^(?:pick|merge -C) /.test(line)) {
      todo.push(line);
      continue;
    }
    const commit = full[next++] ?? '';
    const landed = landedAt.get(commit);
    if (landed === undefined) {
      todo.push(line, 'break');
      commits.push(commit);
      continue;
    }
    if (todo.at(-1)?.startsWith('reset ')) todo.pop();
    todo.push(`reset ${landed}`);
  }
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

async function listCommits(repoPath: string, range: string): Promise<TodoCommit[]> {
  return (
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
}

const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
    const replay = new Replay(repoPath, worktree, dir, config, `${oldest}^`);
    const replayed = await replay.run(
      messagePlanner(await listCommits(repoPath, range), request.messages),
    );
    if (!replayed.ok) return replayed;
    for (const { name, tip } of byLength) {
      if (replay.landedAt.has(tip)) continue;
      const moved =
        (await replay.checkout(tip)) ??
        (await replay.run(
          messagePlanner(await listCommits(repoPath, `${request.base}..${tip}`), request.messages),
        ));
      if (!moved.ok) return { ...moved, output: `Moving branch ${name}: ${moved.output ?? ''}` };
    }

    const newHead = replay.landedAt.get(head) ?? head;
    const moves = stack.moving.flatMap(({ name, tip }) => {
      const landed = replay.landedAt.get(tip);
      return landed === undefined || landed === tip ? [] : [{ name, tip, landed }];
    });
    // Only messages change, so every tip keeps its files.
    for (const { name, tip, landed } of [{ name: 'HEAD', tip: head, landed: newHead }, ...moves]) {
      const [oldTree, newTree] = await Promise.all(
        [tip, landed].map((commit) => gitText(worktree, ['rev-parse', `${commit}^{tree}`])),
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
        branches: { moved: moves.map(({ name }) => name), left: stack.left },
      };
    }
    return { ok: false, reason: await whatMoved(repoPath, head, moves), output: written.output };
  } finally {
    const removed = await runGit(repoPath, ['worktree', 'remove', '--force', worktree]);
    await fs.rm(dir, { recursive: true, force: true });
    if (removed.code !== 0) await runGit(repoPath, ['worktree', 'prune']);
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
  // Unchanged commits included, unlike rewritten.
  readonly landedAt = new Map<string, string>();
  readonly rewritten: Record<string, string> = {};

  constructor(
    private readonly repoPath: string,
    private readonly worktree: string,
    private readonly dir: string,
    private readonly config: string[],
    private readonly upstream: string,
  ) {}

  async checkout(tip: string): Promise<Failure | null> {
    const run = await runGit(this.worktree, [
      ...this.config,
      'checkout',
      '--quiet',
      '--detach',
      tip,
    ]);
    return run.code === 0 ? null : { ok: false, reason: 'commit-failed', output: run.output };
  }

  async run(plan: ReturnType<typeof messagePlanner>): Promise<{ ok: true } | Failure> {
    const { worktree, config } = this;
    const generatedPath = join(this.dir, 'generated-todo');
    const todoPath = join(this.dir, 'todo');
    await fs.rm(generatedPath, { force: true });
    const rebase = (args: string[], sequenceEditor: string) =>
      runGit(worktree, [...config, 'rebase', ...args], {
        env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: sequenceEditor },
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
    const { todo, commits } = await plannedTodo(worktree, generated, this.landedAt);
    await fs.writeFile(todoPath, todo);
    const current = await readMessages(this.repoPath, commits);

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
    for (const commit of commits) {
      const message = current.get(commit) ?? '';
      const planned = plan(commit, message, this.rewritten);
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
        if (amended.code !== 0) {
          return { ok: false, reason: 'commit-failed', output: amended.output };
        }
      }
      const landed = await gitText(worktree, ['rev-parse', 'HEAD']);
      this.landedAt.set(commit, landed);
      if (landed !== commit) this.rewritten[commit] = landed;
      run = await rebase(['--continue'], 'true');
      if (run.code !== 0) return stuck(run.output);
    }
    return { ok: true };
  }
}
