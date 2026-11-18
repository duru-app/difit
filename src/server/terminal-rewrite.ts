import { AUTOSQUASH_PREFIX, REVIEW_THREAD_TRAILER, type RewrittenShas } from '../types/diff.js';

import { hasOperationInProgress } from './direct-edit.js';
import { runGit } from './run-git.js';

export interface LineCommit {
  sha: string;
  // Author name, email, epoch seconds and zone: what a rebase carries over to the new commit.
  author: string;
  subject: string;
  // A fixup or a commit with a thread trailer, which the review does not list.
  isFixup: boolean;
}

export interface TerminalRewrite {
  rewritten: RewrittenShas;
  // Full SHA of the commit the review now ends at.
  target: string;
  // The review's commits that nothing on the new line stands for.
  left: string[];
}

function pairOnce<T>(
  olds: readonly LineCommit[],
  news: readonly LineCommit[],
  key: (commit: LineCommit) => T | undefined,
  pairs: Map<string, string>,
) {
  const once = (commits: readonly LineCommit[]) => {
    const counts = new Map<T, number>();
    for (const commit of commits) {
      const value = key(commit);
      if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return new Map(
      commits.flatMap((commit) => {
        const value = key(commit);
        return value !== undefined && counts.get(value) === 1 ? [[value, commit] as const] : [];
      }),
    );
  };
  const newByKey = once(news.filter(({ sha }) => ![...pairs.values()].includes(sha)));
  for (const [value, old] of once(olds.filter(({ sha }) => !pairs.has(sha)))) {
    const partner = newByKey.get(value);
    if (partner) pairs.set(old.sha, partner.sha);
  }
}

// The commits sharing an author and author date with a commit on the other side, when more than one
// does on either side; only these need a patch id to tell them apart.
export function tiedCommits(before: readonly LineCommit[], after: readonly LineCommit[]): string[] {
  const kept = new Set(after.map(({ sha }) => sha));
  const olds = before.filter(({ sha }) => !kept.has(sha));
  const held = new Set(before.map(({ sha }) => sha));
  const news = after.filter(({ sha }) => !held.has(sha));
  const count = (commits: readonly LineCommit[], author: string) =>
    commits.filter((commit) => commit.author === author).length;
  return [...olds, ...news]
    .filter(({ author }) => {
      const [onOld, onNew] = [count(olds, author), count(news, author)];
      return onOld > 0 && onNew > 0 && (onOld > 1 || onNew > 1);
    })
    .map(({ sha }) => sha);
}

// A commit keeps its SHA, or else stands for the one commit of the old line with the same author
// and author date, which a rebase keeps through reordering, rewording and conflicts resolved by
// hand. Where several share them, an equal patch id and then an equal subject decide; what is still
// tied stays without a partner.
export function pairRewrittenCommits(
  before: readonly LineCommit[],
  after: readonly LineCommit[],
  patchIds: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const pairs = new Map<string, string>();
  const kept = new Set(after.map(({ sha }) => sha));
  for (const { sha } of before) if (kept.has(sha)) pairs.set(sha, sha);
  const authors = new Set(before.map(({ author }) => author));
  for (const author of authors) {
    const olds = before.filter((commit) => commit.author === author && !pairs.has(commit.sha));
    const news = after.filter(
      (commit) => commit.author === author && ![...pairs.values()].includes(commit.sha),
    );
    pairOnce(olds, news, () => author, pairs);
    pairOnce(olds, news, ({ sha }) => patchIds.get(sha), pairs);
    pairOnce(olds, news, ({ subject }) => subject, pairs);
  }
  return pairs;
}

const LINE_FORMAT = `--format=%x1e%H%x00%an <%ae> %ad%x00%s%x00%(trailers:key=${REVIEW_THREAD_TRAILER},valueonly)`;

async function readLine(repoPath: string, range: string): Promise<LineCommit[] | null> {
  const run = await runGit(repoPath, [
    'log',
    '--first-parent',
    '--reverse',
    '--no-show-signature',
    '--date=raw',
    LINE_FORMAT,
    range,
    '--',
  ]);
  if (run.code !== 0) return null;
  return run.stdout
    .toString('utf8')
    .split('\x1e')
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = '', author = '', subject = '', trailers = ''] = record.split('\0');
      return {
        sha,
        author,
        subject,
        isFixup: AUTOSQUASH_PREFIX.test(subject) || trailers.trim().length > 0,
      };
    });
}

async function readPatchIds(
  repoPath: string,
  shas: readonly string[],
): Promise<Map<string, string>> {
  if (shas.length === 0) return new Map();
  const log = await runGit(repoPath, [
    'log',
    '--no-walk=unsorted',
    '--no-show-signature',
    '-p',
    '--no-color',
    '--no-ext-diff',
    '--format=commit %H',
    ...shas,
    '--',
  ]);
  if (log.code !== 0) return new Map();
  const ids = await runGit(repoPath, ['patch-id', '--stable'], { input: log.stdout });
  return new Map(
    ids.stdout
      .toString('utf8')
      .split('\n')
      .flatMap((line) => {
        const [patchId, sha] = line.trim().split(' ');
        return patchId && sha ? [[sha, patchId] as const] : [];
      }),
  );
}

const isAncestor = async (repoPath: string, ancestor: string, of: string) =>
  (await runGit(repoPath, ['merge-base', '--is-ancestor', ancestor, of])).code === 0;

// A commit held by another branch that holds nothing the rebase made came from where the line now
// starts, as when it was rebased onto a newer main.
async function cameFromElsewhere(
  repoPath: string,
  commit: string,
  branchRef: string,
  rebuilt: string,
): Promise<boolean> {
  const run = await runGit(repoPath, [
    'for-each-ref',
    '--contains',
    commit,
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
  ]);
  const refs = run.stdout
    .toString('utf8')
    .split('\n')
    .filter((ref) => ref.length > 0 && ref !== branchRef);
  for (const ref of refs) {
    if (!(await isAncestor(repoPath, rebuilt, ref))) return true;
  }
  return false;
}

const REFLOG_DEPTH = 20;

// The newest tip the branch's reflog shows holding the review: where it stood before the rewrite.
// ORIG_HEAD will not do, since a `git reset` that splits a commit during the rebase moves it.
async function tipBeforeRewrite(
  repoPath: string,
  branchRef: string,
  target: string,
): Promise<string | null> {
  const run = await runGit(repoPath, [
    'log',
    '--walk-reflogs',
    `--max-count=${REFLOG_DEPTH}`,
    '--format=%H',
    branchRef,
    '--',
  ]);
  if (run.code !== 0) return null;
  for (const tip of run.stdout.toString('utf8').split('\n')) {
    if (tip.length > 0 && (await isAncestor(repoPath, target, tip))) return tip;
  }
  return null;
}

// What became of a review's commits after the history of HEAD was rewritten outside difit. Null
// while there is nothing to follow: the review still stands on HEAD, a rebase is still going, HEAD
// left the branch the review was on, the line now starts elsewhere, or a commit from above the
// review now stands inside it.
export async function findTerminalRewrite(
  repoPath: string,
  review: { target: string; commits: readonly { sha: string; parentSha: string }[] },
): Promise<TerminalRewrite | null> {
  const base = review.commits[0]?.parentSha;
  if (base === undefined || (await isAncestor(repoPath, review.target, 'HEAD'))) return null;
  if (await hasOperationInProgress(repoPath)) return null;
  const branch = await runGit(repoPath, ['symbolic-ref', '-q', 'HEAD']);
  if (branch.code !== 0 || !(await isAncestor(repoPath, base, 'HEAD'))) return null;
  const branchRef = branch.stdout.toString('utf8').trim();
  const oldTip = await tipBeforeRewrite(repoPath, branchRef, review.target);
  if (oldTip === null) return null;

  const [before, after] = await Promise.all([
    readLine(repoPath, `${base}..${oldTip}`),
    readLine(repoPath, `${base}..HEAD`),
  ]);
  if (!before || !after) return null;
  const pairs = pairRewrittenCommits(
    before,
    after,
    await readPatchIds(repoPath, tiedCommits(before, after)),
  );

  const targetAt = before.findIndex(({ sha }) => sha === review.target);
  if (targetAt === -1) return null;
  const placeOf = ({ sha }: LineCommit) => {
    const partner = pairs.get(sha);
    return partner === undefined ? -1 : after.findIndex((commit) => commit.sha === partner);
  };
  const inside = before.slice(0, targetAt + 1).map(placeOf);
  const above = before
    .slice(targetAt + 1)
    .map(placeOf)
    .filter((place) => place !== -1);
  const lastInside = Math.max(...inside);
  const firstAbove = Math.min(after.length, ...above);
  if (lastInside === -1 || firstAbove < lastInside) return null;
  let topAt = lastInside;
  for (let at = lastInside + 1; at < firstAbove; at += 1) {
    if (after[at]?.isFixup === false) topAt = at;
  }
  const target = after[topAt]?.sha ?? '';

  const rewritten: RewrittenShas = Object.fromEntries(
    [...pairs].filter(([old, sha]) => old !== sha),
  );
  const rebuilt = after.find(({ sha }) => Object.values(rewritten).includes(sha));
  if (!rebuilt) return null;
  const partners = new Set(pairs.values());
  for (const commit of after.slice(0, firstAbove)) {
    if (partners.has(commit.sha) || commit.isFixup) continue;
    if (await cameFromElsewhere(repoPath, commit.sha, branchRef, rebuilt.sha)) return null;
  }
  return {
    rewritten,
    target,
    left: review.commits.flatMap(({ sha }) => (pairs.has(sha) ? [] : [sha])),
  };
}
