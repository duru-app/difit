import { promises as fs } from 'fs';
import { join, resolve } from 'path';

import type { LeftBranch } from '../types/diff.js';

import { runGit } from './run-git.js';

export interface StackedBranches {
  moving: { name: string; tip: string }[];
  left: LeftBranch[];
  // Short names, HEAD's branch among them, whose upstream holds a commit the rewrite replaces.
  pushed: string[];
}

const BRANCH_PREFIX = 'refs/heads/';
const shortName = (ref: string) =>
  ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref;

async function gitLines(repoPath: string, args: string[]): Promise<string[]> {
  const run = await runGit(repoPath, args);
  if (run.code !== 0) throw new Error(`git ${args[0]} failed: ${run.output}`);
  return run.stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '');
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return (await fs.readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

// A worktree stopped in a rebase or a bisect shows as detached, and a rebase with --update-refs
// holds more branches than its own, so only these files tell which branches are in use.
async function branchesInOperation(repoPath: string): Promise<Set<string>> {
  const [common = ''] = await gitLines(repoPath, ['rev-parse', '--git-common-dir']);
  const commonDir = resolve(repoPath, common);
  const linked = await fs.readdir(join(commonDir, 'worktrees')).catch(() => [] as string[]);
  const gitDirs = [commonDir, ...linked.map((name) => join(commonDir, 'worktrees', name))];
  const names = await Promise.all(
    gitDirs.flatMap((gitDir) =>
      [
        join(gitDir, 'rebase-merge', 'head-name'),
        join(gitDir, 'rebase-apply', 'head-name'),
        join(gitDir, 'BISECT_START'),
      ].map(readIfPresent),
    ),
  );
  // `rebase --update-refs` lists each branch it will move as a ref line followed by two object ids.
  const updated = await Promise.all(
    gitDirs.map((gitDir) => readIfPresent(join(gitDir, 'rebase-merge', 'update-refs'))),
  );
  const updatedBranches = updated.flatMap((text) =>
    (text ?? '').split('\n').filter((line) => line.startsWith(BRANCH_PREFIX)),
  );
  return new Set([...names, ...updatedBranches].flatMap((name) => (name ? [shortName(name)] : [])));
}

export async function findStackedBranches(
  repoPath: string,
  {
    oldest,
    headBranch,
    defaultBranch,
  }: { oldest: string; headBranch: string | null; defaultBranch: string | null },
): Promise<StackedBranches> {
  const [heads, remotes, inOperation] = await Promise.all([
    gitLines(repoPath, [
      'for-each-ref',
      '--contains',
      oldest,
      '--format=%(refname)%00%(objectname)%00%(worktreepath)%00%(upstream)%00%(symref)',
      'refs/heads',
    ]),
    gitLines(repoPath, [
      'for-each-ref',
      '--contains',
      oldest,
      '--format=%(refname)',
      'refs/remotes',
    ]),
    branchesInOperation(repoPath),
  ]);
  const pushedUpstreams = new Set(remotes);
  const branches = heads.map((line) => {
    const [ref = '', tip = '', worktree = '', upstream = '', symref = ''] = line.split('\0');
    return { name: shortName(ref), tip, worktree, upstream, symref };
  });
  const aliases = new Map(
    branches.flatMap(({ name, symref }) =>
      symref.startsWith(BRANCH_PREFIX) ? [[name, shortName(symref)] as const] : [],
    ),
  );
  const resolveAlias = (name: string | null) => {
    let resolved = name;
    while (resolved !== null && aliases.has(resolved)) resolved = aliases.get(resolved) ?? null;
    return resolved;
  };
  const head = resolveAlias(headBranch);
  const defaultName = resolveAlias(defaultBranch);
  const result: StackedBranches = { moving: [], left: [], pushed: [] };
  for (const { name, tip, worktree, upstream, symref } of branches) {
    if (symref !== '') continue;
    const isHead = name === head;
    if (!isHead && name === defaultName) {
      result.left.push({ name, why: 'default' });
      continue;
    }
    if (!isHead && worktree !== '') {
      result.left.push({ name, why: 'worktree' });
      continue;
    }
    if (!isHead && inOperation.has(name)) {
      result.left.push({ name, why: 'operation' });
      continue;
    }
    if (pushedUpstreams.has(upstream)) result.pushed.push(name);
    if (!isHead) result.moving.push({ name, tip });
  }
  result.pushed.sort();
  return result;
}
