import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { DiffCommentPosition, DiffSide } from '../types/diff.js';
import { endOfLine, sideOfRange, startOfLine } from '../utils/commentPosition.js';

import { literalPathspec, runGit } from './run-git.js';

export interface FixupTargetQuery {
  view: { base: string; target: string };
  filePath: string;
  // 1-based and inclusive, counted on the given side of the view; both left out for a comment on
  // the whole file.
  startLine?: number;
  endLine?: number;
  // More ranges of the same comment, counted like the one above on their own side, `side` when
  // left out.
  extraRanges?: ReadonlyArray<{ start: number; end: number; side?: DiffSide }>;
  side: DiffSide;
  // Oldest first, full SHAs; every commit in the view's range when left out.
  commits?: readonly string[];
}

export function linesOfComment(
  position: DiffCommentPosition,
): Pick<FixupTargetQuery, 'side' | 'startLine' | 'endLine' | 'extraRanges'> {
  if (!('line' in position)) return { side: position.side };
  return {
    side: position.side,
    startLine: startOfLine(position.line),
    endLine: endOfLine(position.line),
    extraRanges: (position.extraRanges ?? []).map((range) => ({
      start: startOfLine(range),
      end: endOfLine(range),
      side: sideOfRange(range, position.side),
    })),
  };
}

async function gitText(repoPath: string, args: string[]): Promise<string> {
  const run = await runGit(repoPath, args);
  if (run.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${run.output}`);
  }
  return run.stdout.toString('utf8').trim();
}

// The commit of the view that last changed the lines on the new side, the latest one when they came
// from several; the view's last commit for lines the view left as they were and when every line is
// on the old side. Lines a commit outside `commits` changed count for the commit they came from
// before it. For the whole file, on either side, the last of `commits` that changed the file, or the
// view's last commit.
export async function chooseFixupTarget(
  repoPath: string,
  { view, filePath, startLine, endLine, extraRanges = [], side, commits }: FixupTargetQuery,
): Promise<string> {
  const [base, target] = await Promise.all(
    [view.base, view.target].map((commitish) =>
      gitText(repoPath, ['rev-parse', '--verify', `${commitish}^{commit}`]),
    ),
  );
  const last = commits?.at(-1) ?? target;
  if (startLine === undefined || endLine === undefined) {
    const touched = (
      await gitText(repoPath, ['rev-list', `${base}..${target}`, '--', literalPathspec(filePath)])
    ).split('\n');
    if (!commits) return touched[0] || last;
    return [...commits].reverse().find((sha) => touched.includes(sha)) ?? last;
  }
  const newRanges = onNewSide(startLine, endLine, extraRanges, side);
  if (newRanges.length === 0) return last;
  const inRange = await revList(repoPath, `${base}..${target}`);
  const listed = commits ?? inRange;
  const authors = await blameAuthors(repoPath, {
    range: `${base}..${target}`,
    inRange,
    listed,
    ranges: newRanges,
    filePath,
  });
  return [...listed].reverse().find((sha) => authors.has(sha)) ?? last;
}

interface UncommittedViewQuery {
  // Full SHA; for a merge-base view, the merge base.
  base: string;
  newSide: 'working-tree' | 'index';
  filePath: string;
  // Counted as in FixupTargetQuery.
  startLine?: number;
  endLine?: number;
  extraRanges?: ReadonlyArray<{ start: number; end: number; side?: DiffSide }>;
  side: DiffSide;
  // Oldest first, full SHAs of base..HEAD; every commit in that range when left out.
  commits?: readonly string[];
}

// For a view whose new side is the working tree or the index, the commit of base..HEAD that last
// changed the lines on the new side, as chooseFixupTarget picks it; null when one of them is not
// committed, and where chooseFixupTarget would pick the view's last commit. For the whole file, the
// last commit that changed it, or null when it has an uncommitted change.
export async function chooseCommitOfUncommittedView(
  repoPath: string,
  {
    base,
    newSide,
    filePath,
    startLine,
    endLine,
    extraRanges = [],
    side,
    commits,
  }: UncommittedViewQuery,
): Promise<string | null> {
  const inRange = await revList(repoPath, `${base}..HEAD`);
  const listed = commits ?? inRange;
  if (startLine === undefined || endLine === undefined) {
    const unchanged = await runGit(repoPath, [
      'diff',
      '--quiet',
      ...(newSide === 'index' ? ['--cached'] : []),
      'HEAD',
      '--',
      literalPathspec(filePath),
    ]);
    if (unchanged.code !== 0) return null;
    const touched = await revList(repoPath, `${base}..HEAD`, filePath);
    return [...listed].reverse().find((sha) => touched.includes(sha)) ?? null;
  }
  const newRanges = onNewSide(startLine, endLine, extraRanges, side);
  if (newRanges.length === 0) return null;
  const inHead = await runGit(repoPath, ['cat-file', '-e', `HEAD:${filePath}`]);
  if (inHead.code !== 0) return null;
  const contents =
    newSide === 'index'
      ? { args: ['--contents', '-'], input: await gitBytes(repoPath, ['show', `:${filePath}`]) }
      : { args: ['--contents', join(repoPath, filePath)] };
  const authors = await blameAuthors(repoPath, {
    range: `${base}..HEAD`,
    inRange,
    listed,
    ranges: newRanges,
    filePath,
    contents,
  });
  if ([...authors].some((sha) => /^0+$/.test(sha))) return null;
  return [...listed].reverse().find((sha) => authors.has(sha)) ?? null;
}

type LineRange = { start: number; end: number; side?: DiffSide };

function onNewSide(
  startLine: number,
  endLine: number,
  extraRanges: readonly LineRange[],
  side: DiffSide,
): LineRange[] {
  return [...extraRanges, { start: startLine, end: endLine, side }].filter(
    (range) => (range.side ?? side) === 'new',
  );
}

async function revList(repoPath: string, range: string, filePath?: string): Promise<string[]> {
  const args = ['rev-list', '--reverse', range];
  if (filePath !== undefined) args.push('--', literalPathspec(filePath));
  return (await gitText(repoPath, args)).split('\n').filter(Boolean);
}

async function gitBytes(repoPath: string, args: string[]): Promise<Buffer> {
  const run = await runGit(repoPath, args);
  if (run.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${run.output}`);
  }
  return run.stdout;
}

// Commits of the range outside `listed` count for the commit each line came from before them.
async function blameAuthors(
  repoPath: string,
  {
    range,
    inRange,
    listed,
    ranges,
    filePath,
    contents,
  }: {
    range: string;
    inRange: readonly string[];
    listed: readonly string[];
    ranges: readonly LineRange[];
    filePath: string;
    contents?: { args: string[]; input?: Buffer };
  },
): Promise<Set<string>> {
  const given = new Set(listed);
  const passedOver = inRange.filter((sha) => !given.has(sha));
  const blame = await withIgnoredRevs(passedOver, async (ignoring) => {
    const args = [
      'blame',
      '--porcelain',
      '--no-ignore-revs-file',
      ...ignoring,
      ...(contents?.args ?? []),
      ...ranges.flatMap(({ start, end }) => ['-L', `${start},${end}`]),
      range,
      '--',
      filePath,
    ];
    const run = await runGit(repoPath, args, contents?.input ? { input: contents.input } : {});
    if (run.code !== 0) throw new Error(`git blame failed: ${run.output}`);
    return run.stdout.toString('utf8');
  });
  return new Set(
    blame.split('\n').flatMap((line) => /^([0-9a-f]{40,64}) \d+ \d+/.exec(line)?.[1] ?? []),
  );
}

async function withIgnoredRevs<T>(
  revs: readonly string[],
  work: (args: string[]) => Promise<T>,
): Promise<T> {
  if (revs.length === 0) return work([]);
  const dir = await fs.mkdtemp(join(tmpdir(), 'difit-fixup-target-'));
  try {
    const file = join(dir, 'ignore-revs');
    await fs.writeFile(file, `${revs.join('\n')}\n`);
    return await work(['--ignore-revs-file', file]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
