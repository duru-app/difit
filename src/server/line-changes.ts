import { runGit } from './run-git.js';

// Which lines changed between an older commit and a newer one, and where the rest moved.

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

interface FileChange {
  oldPath: string | null;
  newPath: string | null;
  hunks: Hunk[];
}

interface LineSpot {
  path: string;
  line: number;
}

interface ReplacedLines {
  path: string;
  // 1-based and inclusive, in the newer commit.
  first: number;
  last: number;
}

export interface LineChanges {
  // Null when the line was added or changed in the newer commit.
  toOlder(path: string, line: number): LineSpot | null;
  // Null when the line is gone from the newer commit.
  toNewer(path: string, line: number): LineSpot | ReplacedLines | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BINARY_JAVA = /^Binary files .*\.java"? (?:and|differ)/;

// Undefined for a path git quoted, which is not unquoted here.
function headerPath(header: string, prefix: string): string | null | undefined {
  // A path holding a space ends with a tab.
  const value = header.endsWith('\t') ? header.slice(0, -1) : header;
  if (value === '/dev/null') return null;
  return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

// Null when the diff names a path it had to quote or shows a Java file only as binary.
export function parseLineChanges(diff: string): LineChanges | null {
  const files: FileChange[] = [];
  let current: FileChange | null = null;
  let inHunks = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { oldPath: null, newPath: null, hunks: [] };
      files.push(current);
      inHunks = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@ ')) {
      inHunks = true;
      const match = HUNK_HEADER.exec(line);
      if (!match) return null;
      current.hunks.push({
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
      });
      continue;
    }
    if (inHunks) continue;
    if (BINARY_JAVA.test(line)) return null;
    let path: string | null | undefined;
    if (line.startsWith('rename from ')) path = headerPath(`a/${line.slice(12)}`, 'a/');
    else if (line.startsWith('rename to ')) path = headerPath(`b/${line.slice(10)}`, 'b/');
    else if (line.startsWith('--- ')) path = headerPath(line.slice(4), 'a/');
    else if (line.startsWith('+++ ')) path = headerPath(line.slice(4), 'b/');
    else continue;
    if (path === undefined || path?.startsWith('"')) return null;
    if (line.startsWith('rename from ') || line.startsWith('--- ')) current.oldPath = path;
    else current.newPath = path;
  }
  const byOld = new Map<string, FileChange>();
  const byNew = new Map<string, FileChange>();
  for (const file of files) {
    if (file.oldPath !== null) byOld.set(file.oldPath, file);
    if (file.newPath !== null) byNew.set(file.newPath, file);
  }

  return {
    toOlder(path, line) {
      const file = byNew.get(path);
      if (!file) return { path, line };
      if (file.oldPath === null) return null;
      let shift = 0;
      for (const hunk of file.hunks) {
        if (hunk.newCount > 0 && line >= hunk.newStart && line < hunk.newStart + hunk.newCount) {
          return null;
        }
        const before =
          hunk.newCount === 0 ? hunk.newStart < line : hunk.newStart + hunk.newCount <= line;
        if (!before) break;
        shift += hunk.oldCount - hunk.newCount;
      }
      return { path: file.oldPath, line: line + shift };
    },
    toNewer(path, line) {
      const file = byOld.get(path);
      if (!file) return { path, line };
      if (file.newPath === null) return null;
      let shift = 0;
      for (const hunk of file.hunks) {
        if (hunk.oldCount > 0 && line >= hunk.oldStart && line < hunk.oldStart + hunk.oldCount) {
          if (hunk.newCount === 0) return null;
          return {
            path: file.newPath,
            first: hunk.newStart,
            last: hunk.newStart + hunk.newCount - 1,
          };
        }
        const before =
          hunk.oldCount === 0 ? hunk.oldStart < line : hunk.oldStart + hunk.oldCount <= line;
        if (!before) break;
        shift += hunk.newCount - hunk.oldCount;
      }
      return { path: file.newPath, line: line + shift };
    },
  };
}

export function lineChangesBetween(
  repoPath: string,
  older: string,
  newer: string,
): Promise<LineChanges | null> {
  return lineChangesOfDiff(repoPath, [older, newer]);
}

export async function lineChangesOfDiff(
  repoPath: string,
  diffArgs: string[],
): Promise<LineChanges | null> {
  const run = await runGit(repoPath, [
    '-c',
    'core.quotePath=false',
    'diff',
    '-U0',
    '-M',
    '--no-ext-diff',
    '--no-color',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    ...diffArgs,
  ]);
  return run.code === 0 ? parseLineChanges(run.stdout.toString('utf8')) : null;
}
