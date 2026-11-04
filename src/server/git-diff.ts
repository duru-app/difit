import { createHash } from 'crypto';
import { simpleGit, type SimpleGit } from 'simple-git';
import { isAbsolute, resolve, sep } from 'path';

import {
  validateCommitish,
  validateDiffArguments,
  shortHash,
  createCommitRangeString,
} from '../cli/utils.js';
import {
  type DiffChunk,
  type DiffFile,
  type DiffLine,
  type DiffResponse,
  type DiffSelection,
  type MessageAmendment,
  type NewerTarget,
  type PlainFileChange,
  type ReviewCommit,
  type ThreadFixup,
  AUTOSQUASH_PREFIX,
  REVIEW_THREAD_TRAILER,
} from '../types/diff.js';
import { withoutThreadTrailers } from '../utils/commitMessage.js';
import {
  getMergeBaseTargetRef,
  isCommitTarget,
  normalizeBaseMode,
} from '../utils/diffSelection.js';

import { classifyChunks, isClassifiablePath } from './change-kind.js';
import { autosquashGroups, type TodoCommit } from './autosquash.js';
import { runGit } from './run-git.js';
import { isGeneratedFile } from './generated-file-check.js';

// Hashes every diff line with its surrounding context but not the line numbers, so a rebase keeps
// the id unless it also changes those context lines. The context tells apart the same line added in
// two places. A fixup with no changed text lines (empty or binary-only) keeps its own sha.
function patchIdOf(sha: string, files: ThreadFixup['files']): string {
  const hash = createHash('sha1');
  let changedLines = 0;
  for (const file of files) {
    hash.update(`${file.path}\n`);
    for (const chunk of file.chunks) {
      for (const line of chunk.lines) {
        if (line.type === 'add' || line.type === 'delete') changedLines += 1;
        hash.update(`${line.type}:${line.content}\n`);
      }
    }
  }
  return changedLines > 0 ? hash.digest('hex') : sha;
}

const FIXUP_LOG_FORMAT = `--format=%x00%H%x00%P%x00%aI%x00%s%x00%(trailers:key=${REVIEW_THREAD_TRAILER},valueonly,separator=%x2C)%x00`;
// Every line of a patch starts with a diff marker or keyword, so a NUL at the start of a line can
// only open one of our headers, even when a file diffed as text holds NUL bytes. Lines are split on
// \n alone: the `m` flag would also start a line after \r, U+2028 or U+2029 inside file content.
const FIXUP_LOG_HEADER =
  /(?<=^|\n)\0([0-9a-f]+)\0([0-9a-f ]*)\0([^\0]*)\0([^\0]*)\0([^\0]*)\0(?=\n|$)/g;

type ClassifiableFile = Pick<DiffFile, 'path' | 'oldPath' | 'status' | 'chunks' | 'isGenerated'>;

interface FixupLogEntry {
  sha: string;
  parents: string[];
  firstParent: string | undefined;
  isMerge: boolean;
  authoredAt: string;
  subject: string;
  threadIds: string[];
  diff: string;
}

function parseFixupLog(raw: string): FixupLogEntry[] {
  const headers = [...raw.matchAll(FIXUP_LOG_HEADER)];
  return headers.map((header, index) => {
    const [, sha, parents, authoredAt, subject, trailerValues] = header;
    return {
      sha,
      parents: parents.split(' ').filter((parent) => parent.length > 0),
      firstParent: parents.split(' ')[0] || undefined,
      isMerge: parents.includes(' '),
      authoredAt,
      subject,
      threadIds: trailerValues
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
      diff: raw.slice(header.index + header[0].length, headers[index + 1]?.index ?? raw.length),
    };
  });
}

function withoutFirstParagraph(message: string): string {
  const paragraphEnd = message.search(/\n[ \t]*\n/);
  return paragraphEnd < 0 ? '' : message.slice(paragraphEnd).replace(/^\s*\n/, '');
}

export class GitDiffParser {
  private git: SimpleGit;
  private repoPath: string;
  private readonly resolvedCommitCache = new Map<string, { value: string; expiresAt: number }>();
  private static readonly RESOLVED_COMMIT_CACHE_TTL_MS = 5_000;
  private static readonly GENERATED_HEADER_SCAN_BYTES = 4 * 1024;
  private static readonly GITATTRIBUTES_CHECK_CHUNK_SIZE = 200;
  private static readonly CHANGE_KIND_BUDGET_MS = 2_000;
  private static readonly MERGED_COMMITS_LIMIT = 20;
  private readonly classifiedFixupFiles = new Map<string, ThreadFixup['files']>();
  // Keyed by `<since>:<fixup sha>`.
  private readonly plainChanges = new Map<string, PlainFileChange[]>();

  constructor(repoPath = process.cwd()) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
  }

  private normalizeRepositoryRelativePath(filepath: string): string {
    if (filepath.length === 0) {
      throw new Error('Invalid file path');
    }

    const normalizedFilepath = filepath.replace(/\\/g, '/');
    const hasParentTraversal = normalizedFilepath.split('/').some((segment) => segment === '..');
    if (isAbsolute(filepath) || normalizedFilepath.startsWith('/') || hasParentTraversal) {
      throw new Error('File path outside repository');
    }

    const repositoryPath = resolve(this.repoPath);
    const resolvedPath = resolve(repositoryPath, normalizedFilepath);
    if (resolvedPath !== repositoryPath && !resolvedPath.startsWith(`${repositoryPath}${sep}`)) {
      throw new Error('File path outside repository');
    }

    return normalizedFilepath;
  }

  private async resolveBaseCommitish(selection: DiffSelection): Promise<string> {
    if (normalizeBaseMode(selection.baseMode) !== 'merge-base') {
      return selection.baseCommitish;
    }

    const targetRef = getMergeBaseTargetRef(selection.targetCommitish);
    const mergeBase = await this.git.raw(['merge-base', targetRef, selection.baseCommitish]);
    return mergeBase.trim();
  }

  async parseDiff(
    selection: DiffSelection,
    ignoreWhitespace = false,
    contextLines?: number,
  ): Promise<DiffResponse> {
    const { targetCommitish, baseCommitish } = selection;
    const requestedBaseMode =
      normalizeBaseMode(selection.baseMode) === 'merge-base' ? 'merge-base' : undefined;

    try {
      // Validate arguments
      const validation = validateDiffArguments(targetCommitish, baseCommitish);
      if (!validation.valid) {
        throw new Error(validation.error);
      }

      const effectiveBaseCommitish = await this.resolveBaseCommitish(selection);
      let resolvedCommit: string;
      let diffArgs: string[];
      let resolvedBaseCommitish = effectiveBaseCommitish;
      let resolvedTargetCommitish = targetCommitish;
      let attributesRef = targetCommitish;

      // Handle target special chars (base is always a regular commit)
      if (targetCommitish === 'working') {
        // Show unstaged changes (working vs staged)
        resolvedCommit = 'Working Directory (unstaged changes)';
        diffArgs = [];
      } else if (targetCommitish === 'staged') {
        // Show staged changes against base commit
        const baseHash = await this.git.revparse([effectiveBaseCommitish]);
        resolvedCommit = `${shortHash(baseHash)} vs Staging Area (staged changes)`;
        resolvedBaseCommitish = shortHash(baseHash);
        diffArgs = ['--cached', effectiveBaseCommitish];
      } else if (targetCommitish === '.') {
        // Show all uncommitted changes against base commit
        const baseHash = await this.git.revparse([effectiveBaseCommitish]);
        resolvedCommit = `${shortHash(baseHash)} vs Working Directory (all uncommitted changes)`;
        resolvedBaseCommitish = shortHash(baseHash);
        diffArgs = [effectiveBaseCommitish];
      } else {
        // Both are regular commits: standard commit-to-commit comparison
        const targetHash = await this.git.revparse([targetCommitish]);
        const baseHash = await this.git.revparse([effectiveBaseCommitish]);
        resolvedCommit = createCommitRangeString(shortHash(baseHash), shortHash(targetHash));
        resolvedBaseCommitish = shortHash(baseHash);
        resolvedTargetCommitish = shortHash(targetHash);
        attributesRef = targetHash;
        diffArgs = [baseHash, targetHash];
      }

      if (ignoreWhitespace) {
        diffArgs.push('-w');
      }

      if (contextLines !== undefined) {
        diffArgs.push(`-U${contextLines}`);
      }

      // Ignore external diff-tools to unify output.
      // https://github.com/yoshiko-pg/difit/issues/19
      diffArgs.push('--no-ext-diff', '--color=never');

      // Single git invocation for better startup latency on large repositories.
      const diffRaw = await this.git.diff(diffArgs);
      const files = await this.markGitattributesGeneratedFiles(
        this.parseUnifiedDiff(diffRaw),
        attributesRef,
      );

      return {
        commit: resolvedCommit,
        files,
        isEmpty: files.length === 0,
        baseCommitish: resolvedBaseCommitish,
        targetCommitish: resolvedTargetCommitish,
        requestedBaseCommitish: baseCommitish,
        requestedTargetCommitish: targetCommitish,
        requestedBaseMode,
      };
    } catch (error) {
      throw new Error(
        `Failed to parse diff for ${targetCommitish} vs ${baseCommitish}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  private parseUnifiedDiff(diffText: string): DiffFile[] {
    const files: DiffFile[] = [];
    const fileBlocks = diffText.split(/^diff --git /m).slice(1);

    if (fileBlocks.length > 0) {
      for (const fileBlock of fileBlocks) {
        const block = `diff --git ${fileBlock}`;
        const file = this.parseFileBlock(block);
        if (file) {
          files.push(file);
        }
      }

      return files;
    }

    for (const fileBlock of this.splitPlainUnifiedDiff(diffText)) {
      const file = this.parseFileBlock(fileBlock, 'plain');
      if (file) {
        files.push(file);
      }
    }

    return files;
  }

  private splitPlainUnifiedDiff(diffText: string): string[] {
    const lines = diffText.split(/\r?\n/);
    const blocks: string[] = [];
    let blockStart: number | null = null;
    let remainingOldLines = 0;
    let remainingNewLines = 0;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];

      if (blockStart !== null && line.startsWith('@@')) {
        const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (match) {
          remainingOldLines = parseInt(match[2] ?? '1');
          remainingNewLines = parseInt(match[4] ?? '1');
        }
        continue;
      }

      if (blockStart !== null && (remainingOldLines > 0 || remainingNewLines > 0)) {
        if (line.startsWith('\\')) {
          continue;
        }
        if (line.startsWith('+')) {
          remainingNewLines--;
        } else if (line.startsWith('-')) {
          remainingOldLines--;
        } else if (line.startsWith(' ')) {
          remainingOldLines--;
          remainingNewLines--;
        }
        continue;
      }

      if (line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) {
        if (blockStart !== null) {
          blocks.push(lines.slice(blockStart, index).join('\n'));
        }
        blockStart = index;
      }
    }

    if (blockStart !== null) {
      blocks.push(lines.slice(blockStart).join('\n'));
    }

    return blocks;
  }

  private getGitattributesSourceArgs(ref: string): string[] {
    if (ref === 'working' || ref === '.') {
      return [];
    }

    if (ref === 'staged') {
      return ['--cached'];
    }

    return ['--source', ref];
  }

  private parseGitattributesGeneratedOutput(output: string): Set<string> {
    const generatedPaths = new Set<string>();
    const fields = output.split('\0');

    for (let i = 0; i + 2 < fields.length; i += 3) {
      const [path, attribute, value] = fields.slice(i, i + 3);
      if (attribute === 'linguist-generated' && value === 'true') {
        generatedPaths.add(path);
      }
    }

    return generatedPaths;
  }

  private async getGitattributesGeneratedPaths(
    filepaths: string[],
    ref: string,
  ): Promise<Set<string>> {
    if (filepaths.length === 0) {
      return new Set();
    }

    const generatedPaths = new Set<string>();

    try {
      for (let i = 0; i < filepaths.length; i += GitDiffParser.GITATTRIBUTES_CHECK_CHUNK_SIZE) {
        const chunk = filepaths.slice(i, i + GitDiffParser.GITATTRIBUTES_CHECK_CHUNK_SIZE);
        const output = await this.git.raw([
          'check-attr',
          '-z',
          ...this.getGitattributesSourceArgs(ref),
          'linguist-generated',
          '--',
          ...chunk,
        ]);

        if (typeof output !== 'string') {
          continue;
        }

        for (const path of this.parseGitattributesGeneratedOutput(output)) {
          generatedPaths.add(path);
        }
      }

      return generatedPaths;
    } catch {
      return new Set();
    }
  }

  private async markGitattributesGeneratedFiles(
    files: DiffFile[],
    ref: string,
  ): Promise<DiffFile[]> {
    const candidates = files.filter((file) => !file.isGenerated).map((file) => file.path);
    const generatedPaths = await this.getGitattributesGeneratedPaths(candidates, ref);

    if (generatedPaths.size === 0) {
      return files;
    }

    return files.map((file) =>
      generatedPaths.has(file.path) ? { ...file, isGenerated: true } : file,
    );
  }

  private decodeGitPath(
    rawPath: string | undefined,
    stripGitPrefix: boolean = true,
  ): string | undefined {
    if (typeof rawPath !== 'string') {
      return undefined;
    }

    const tabIndex = rawPath.indexOf('\t');
    const pathWithoutTimestamp = tabIndex === -1 ? rawPath : rawPath.slice(0, tabIndex);
    const trimmed =
      pathWithoutTimestamp.startsWith('"') && pathWithoutTimestamp.endsWith('"')
        ? pathWithoutTimestamp.slice(1, -1)
        : pathWithoutTimestamp;

    const gitPrefixes = ['a/', 'b/', 'c/', 'i/', 'w/'];
    let withoutPrefix = trimmed;
    if (stripGitPrefix) {
      for (const prefix of gitPrefixes) {
        if (withoutPrefix.startsWith(prefix)) {
          withoutPrefix = withoutPrefix.slice(prefix.length);
          break;
        }
      }
    }

    if (withoutPrefix === '/dev/null') {
      return undefined;
    }

    const bytes: number[] = [];
    for (let i = 0; i < withoutPrefix.length; i++) {
      const char = withoutPrefix[i];

      if (char === '\\' && i + 1 < withoutPrefix.length) {
        const next = withoutPrefix[i + 1];

        if (/[0-7]/.test(next)) {
          let octal = next;
          let read = 1;

          while (read < 3 && i + 1 + read < withoutPrefix.length) {
            const candidate = withoutPrefix[i + 1 + read];
            if (!/[0-7]/.test(candidate)) {
              break;
            }
            octal += candidate;
            read++;
          }

          bytes.push(parseInt(octal, 8));
          i += read; // Skip consumed digits
          continue;
        }

        switch (next) {
          case 't':
            bytes.push(0x09);
            break;
          case 'n':
            bytes.push(0x0a);
            break;
          case 'r':
            bytes.push(0x0d);
            break;
          case 'b':
            bytes.push(0x08);
            break;
          case 'f':
            bytes.push(0x0c);
            break;
          case 'v':
            bytes.push(0x0b);
            break;
          case 'a':
            bytes.push(0x07);
            break;
          case '\\':
            bytes.push(0x5c);
            break;
          case '"':
            bytes.push(0x22);
            break;
          case ' ':
            bytes.push(0x20);
            break;
          default:
            bytes.push(...Buffer.from(next, 'utf8'));
            break;
        }
        i++; // Skip the escaped character
        continue;
      }

      bytes.push(...Buffer.from(char, 'utf8'));
    }

    return Buffer.from(bytes).toString('utf8');
  }

  private extractPathFromLine(
    line: string | undefined,
    prefix: string,
    stripGitPrefix: boolean = true,
  ): string | undefined {
    if (!line?.startsWith(prefix)) {
      return undefined;
    }

    return this.decodeGitPath(line.slice(prefix.length), stripGitPrefix);
  }

  private parseDiffHeaderPaths(
    headerLine: string,
  ): { oldPath: string | undefined; newPath: string | undefined } | null {
    if (!headerLine.startsWith('diff --git ')) {
      return null;
    }

    const raw = headerLine.slice('diff --git '.length);
    const segments: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < raw.length; i++) {
      const char = raw[i];
      const prevChar = i > 0 ? raw[i - 1] : null;

      if (char === '"' && prevChar !== '\\') {
        inQuotes = !inQuotes;
        current += char;
        continue;
      }

      if (char === ' ' && !inQuotes && prevChar !== '\\') {
        if (current) {
          segments.push(current);
          current = '';
        }
        continue;
      }

      current += char;
    }

    if (current) {
      segments.push(current);
    }

    if (segments.length !== 2) {
      return null;
    }

    const [rawOldPath, rawNewPath] = segments;
    return {
      oldPath: this.decodeGitPath(rawOldPath),
      newPath: this.decodeGitPath(rawNewPath),
    };
  }

  private parseFileBlock(block: string, format: 'git' | 'plain' | null = 'git'): DiffFile | null {
    const lines = block.split('\n');
    const headerLine = lines[0];
    const headerPaths = this.parseDiffHeaderPaths(headerLine);

    const minusLine = lines.find((line) => line.startsWith('--- '));
    const plusLine = lines.find((line) => line.startsWith('+++ '));
    const renameFromLine = lines.find((line) => line.startsWith('rename from '));
    const renameToLine = lines.find((line) => line.startsWith('rename to '));

    const stripGitPrefix = format !== 'plain';
    const plusPath = this.extractPathFromLine(plusLine, '+++ ', stripGitPrefix);
    const minusPath = this.extractPathFromLine(minusLine, '--- ', stripGitPrefix);
    const renameFromPath = this.extractPathFromLine(renameFromLine, 'rename from ');
    const renameToPath = this.extractPathFromLine(renameToLine, 'rename to ');
    const parsedNewPath = renameToPath ?? plusPath ?? headerPaths?.newPath;
    const parsedOldPath = renameFromPath ?? minusPath ?? headerPaths?.oldPath;
    const newPath = parsedNewPath ?? parsedOldPath;
    const oldPath = parsedOldPath ?? newPath;

    if (!newPath) {
      return null;
    }

    const path = newPath;

    let status: DiffFile['status'] = 'modified';

    // Check for new file mode (added files)
    const newFileMode = lines.find((line) => line.startsWith('new file mode'));
    const deletedFileMode = lines.find((line) => line.startsWith('deleted file mode'));

    // Check for /dev/null which indicates added or deleted files
    if (newFileMode || minusLine?.includes('/dev/null')) {
      status = 'added';
    } else if (deletedFileMode || plusLine?.includes('/dev/null')) {
      status = 'deleted';
    } else if (format !== 'plain' && oldPath !== newPath) {
      status = 'renamed';
    }

    // Common properties for all files
    const baseFile = {
      path,
      oldPath: status === 'renamed' && oldPath !== newPath ? oldPath : undefined,
      status,
    };

    // Parse chunks
    const chunks = this.parseChunks(lines);

    const { additions, deletions } = this.countLinesFromChunks(chunks);
    return {
      ...baseFile,
      additions,
      deletions,
      chunks,
      isGenerated: isGeneratedFile(path).isGenerated,
    };
  }

  private countLinesFromChunks(chunks: DiffChunk[]): {
    additions: number;
    deletions: number;
  } {
    let additions = 0;
    let deletions = 0;
    for (const chunk of chunks) {
      for (const line of chunk.lines) {
        if (line.type === 'add') additions++;
        else if (line.type === 'delete') deletions++;
      }
    }
    return { additions, deletions };
  }

  private parseChunks(lines: string[]): DiffChunk[] {
    const chunks: DiffChunk[] = [];
    let currentChunk: DiffChunk | null = null;
    let oldLineNum = 0;
    let newLineNum = 0;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        if (currentChunk) {
          chunks.push(currentChunk);
        }

        const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
        if (match) {
          const oldStart = parseInt(match[1]);
          const oldLines = parseInt(match[2] || '1');
          const newStart = parseInt(match[3]);
          const newLines = parseInt(match[4] || '1');

          oldLineNum = oldStart;
          newLineNum = newStart;

          currentChunk = {
            header: line,
            oldStart,
            oldLines,
            newStart,
            newLines,
            lines: [],
          };
        }
      } else if (
        currentChunk &&
        (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))
      ) {
        const type = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'delete' : 'normal';

        const diffLine: DiffLine = {
          type,
          content: line.slice(1),
          oldLineNumber: type !== 'add' ? oldLineNum : undefined,
          newLineNumber: type !== 'delete' ? newLineNum : undefined,
        };

        currentChunk.lines.push(diffLine);

        if (type !== 'add') oldLineNum++;
        if (type !== 'delete') newLineNum++;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  async validateCommit(commitish: string): Promise<boolean> {
    try {
      if (commitish === '.' || commitish === 'working' || commitish === 'staged') {
        // For working directory or staging area, just check if we're in a git repo
        await this.git.status();
        return true;
      }
      await this.git.show([commitish, '--name-only']);
      return true;
    } catch {
      return false;
    }
  }

  async listThreadFixups(selection: DiffSelection): Promise<ThreadFixup[]> {
    return (await this.readThreadFixups(selection)).fixups;
  }

  async listFixupsForScreen(selection: DiffSelection): Promise<ThreadFixup[]> {
    const { targetHash, fixups } = await this.readThreadFixups(selection);
    const [classified, plainChangesBySha, { foldTargetBySha, amendedMessageBySha }, baseMatches] =
      await Promise.all([
        this.classifyFixups(fixups),
        this.readPlainChanges(targetHash, fixups),
        this.readFolding(selection, targetHash, fixups),
        this.readBaseMatches(selection, fixups),
      ]);
    return classified.map((fixup) => {
      const plainChangesBefore = plainChangesBySha.get(fixup.sha);
      const foldTargetSha = foldTargetBySha.get(fixup.sha);
      const amendedMessage = amendedMessageBySha.get(fixup.sha);
      const files = fixup.files.some(({ path }) => baseMatches.has(`${fixup.sha}:${path}`))
        ? fixup.files.map((file) =>
            baseMatches.has(`${fixup.sha}:${file.path}`)
              ? { ...file, matchesReviewBase: true as const }
              : file,
          )
        : fixup.files;
      if (!plainChangesBefore && !foldTargetSha && files === fixup.files) return fixup;
      return {
        ...fixup,
        files,
        ...(plainChangesBefore ? { plainChangesBefore } : {}),
        ...(foldTargetSha ? { foldTargetSha } : {}),
        ...(amendedMessage ? { amendedMessage } : {}),
      };
    });
  }

  // Keys `<fixup sha>:<path>` of the fixup files whose object at the fixup is the one at the review
  // base under the same path, or that the fixup deletes where the base has none.
  private async readBaseMatches(
    selection: DiffSelection,
    fixups: ThreadFixup[],
  ): Promise<Set<string>> {
    const matches = new Set<string>();
    const asked = fixups.flatMap(({ sha, files }) =>
      files
        .filter(({ path }) => !path.includes('\n'))
        .map(({ path, status }) => ({ key: `${sha}:${path}`, sha, path, status })),
    );
    if (asked.length === 0) return matches;
    try {
      const base = await this.resolveBaseCommitish(selection);
      const run = await runGit(this.repoPath, ['cat-file', '--batch-check=%(objectname)'], {
        input: Buffer.from(
          asked.map(({ sha, path }) => `${sha}:${path}\n${base}:${path}\n`).join(''),
        ),
      });
      if (run.code !== 0) throw new Error(`git cat-file failed: ${run.output}`);
      const answers = run.stdout.toString('utf8').split('\n');
      const absent = (answer: string) => answer.endsWith(' missing');
      for (const [index, { key, status }] of asked.entries()) {
        const atFixup = answers[index * 2];
        const atBase = answers[index * 2 + 1];
        if (atFixup === undefined || atBase === undefined) break;
        const bothAbsent = status === 'deleted' && absent(atFixup) && absent(atBase);
        if (atFixup === atBase || bothAbsent) matches.add(key);
      }
    } catch (error) {
      console.error('Error comparing fixup files with the review base:', error);
    }
    return matches;
  }

  // Follows each fixup the way autosquash does, through fixups of fixups, to a reviewed commit.
  private async readFolding(
    selection: DiffSelection,
    targetHash: string,
    fixups: ThreadFixup[],
  ): Promise<{
    foldTargetBySha: Map<string, string>;
    amendedMessageBySha: Map<string, MessageAmendment>;
  }> {
    const foldTargetBySha = new Map<string, string>();
    let amendedMessageBySha = new Map<string, MessageAmendment>();
    if (fixups.length === 0) return { foldTargetBySha, amendedMessageBySha };
    try {
      const base = await this.resolveBaseCommitish(selection);
      const [log, reviewedList] = await Promise.all([
        this.git.raw([
          'log',
          '--reverse',
          '--no-merges',
          '--no-show-signature',
          FIXUP_LOG_FORMAT,
          `${base}..HEAD`,
          '--',
        ]),
        this.git.raw(['rev-list', '--first-parent', `${base}..${targetHash}`, '--']),
      ]);
      const reviewed = new Set(reviewedList.split('\n').filter((sha) => sha.length > 0));
      const threadShas = new Set(fixups.map(({ sha }) => sha));
      const reviewedGroups = autosquashGroups(parseFixupLog(log)).filter(
        ([root]) => root !== undefined && reviewed.has(root.sha),
      );
      for (const [root, ...folded] of reviewedGroups) {
        for (const commit of folded) {
          if (root && threadShas.has(commit.sha)) foldTargetBySha.set(commit.sha, root.sha);
        }
      }
      amendedMessageBySha = await this.readAmendedMessages(reviewedGroups, threadShas);
    } catch (error) {
      console.error('Error finding the commits fixups fold into:', error);
    }
    return { foldTargetBySha, amendedMessageBySha };
  }

  // Replays the messages of each group in autosquash order: an amend! commit replaces the message
  // with its own past the first paragraph, less the thread trailers taken out after folding. Left
  // out from a squash! on, which git merges by hand.
  private async readAmendedMessages(
    groups: TodoCommit[][],
    threadShas: ReadonlySet<string>,
  ): Promise<Map<string, MessageAmendment>> {
    const bySha = new Map<string, MessageAmendment>();
    const amending = groups.filter((group) =>
      group.some(({ sha, subject }) => threadShas.has(sha) && subject.startsWith('amend! ')),
    );
    if (amending.length === 0) return bySha;
    try {
      const read = amending.flatMap(([root, ...folded]) => [
        ...(root ? [root.sha] : []),
        ...folded.filter(({ subject }) => subject.startsWith('amend! ')).map(({ sha }) => sha),
      ]);
      const fields = (
        await this.git.raw([
          'log',
          '--no-walk=unsorted',
          '--no-show-signature',
          '--format=%x00%H%x00%B',
          ...read,
          '--',
        ])
      ).split('\0');
      const messageOf = new Map<string, string>();
      for (let at = 1; at + 1 < fields.length; at += 2) {
        messageOf.set(fields[at] ?? '', (fields[at + 1] ?? '').trimEnd());
      }
      for (const [root, ...folded] of amending) {
        let message = root && messageOf.get(root.sha);
        for (const commit of folded) {
          if (message === undefined || commit.subject.startsWith('squash! ')) break;
          if (!commit.subject.startsWith('amend! ')) continue;
          const after = withoutThreadTrailers(
            withoutFirstParagraph(messageOf.get(commit.sha) ?? ''),
          );
          if (after.length === 0) break;
          if (threadShas.has(commit.sha)) bySha.set(commit.sha, { before: message, after });
          message = after;
        }
      }
    } catch (error) {
      console.error('Error reading the messages of amend! commits:', error);
    }
    return bySha;
  }

  private async readThreadFixups(
    selection: DiffSelection,
  ): Promise<{ targetHash: string; fixups: ThreadFixup[] }> {
    const { targetCommitish } = selection;
    if (!isCommitTarget(targetCommitish) || !validateCommitish(targetCommitish)) {
      return { targetHash: '', fixups: [] };
    }

    const targetHash = (
      await this.git.revparse(['--verify', `${targetCommitish}^{commit}`])
    ).trim();
    const headHash = (await this.git.revparse(['HEAD'])).trim();
    if (targetHash === headHash) {
      return { targetHash, fixups: [] };
    }

    const entries = parseFixupLog(
      await this.git.raw([
        'log',
        '--reverse',
        '--no-show-signature',
        // Trailer keys are matched without regard to case, so the grep must match the same way.
        '--regexp-ignore-case',
        `--grep=^${REVIEW_THREAD_TRAILER}: `,
        '-p',
        '-M',
        '--no-ext-diff',
        '--color=never',
        FIXUP_LOG_FORMAT,
        `${targetHash}..HEAD`,
      ]),
    ).filter((entry) => entry.threadIds.length > 0);

    // `log -p` prints no diff for a merge, and `-m` on its own skips a parent whose diff is empty, so
    // merges are read again against their first parent only. The config keeps `-m` to that parent on
    // git versions where it follows log.diffMerges.
    const merges = entries.filter((entry) => entry.isMerge);
    if (merges.length > 0) {
      const mergeDiffs = new Map(
        parseFixupLog(
          await this.git.raw([
            '-c',
            'log.diffMerges=first-parent',
            'log',
            '--no-walk=unsorted',
            '--no-show-signature',
            '-p',
            '-M',
            '-m',
            '--first-parent',
            '--no-ext-diff',
            '--color=never',
            FIXUP_LOG_FORMAT,
            ...merges.map((entry) => entry.sha),
          ]),
        ).map((entry) => [entry.sha, entry.diff]),
      );
      for (const entry of merges) {
        entry.diff = mergeDiffs.get(entry.sha) ?? '';
      }
    }

    return { targetHash, fixups: entries.map((entry) => this.toThreadFixup(entry)) };
  }

  // Oldest first along the first parent, so a merge stands as one commit against its first parent.
  async listReviewCommits(selection: DiffSelection): Promise<ReviewCommit[]> {
    const { targetCommitish } = selection;
    if (!isCommitTarget(targetCommitish) || !validateCommitish(targetCommitish)) {
      return [];
    }

    const base = await this.resolveBaseCommitish(selection);
    const range = `${base}..${targetCommitish}`;
    const log = await this.git.raw([
      'log',
      '--reverse',
      '--first-parent',
      '--no-show-signature',
      FIXUP_LOG_FORMAT,
      range,
      '--',
    ]);
    const mainline = parseFixupLog(log);
    const mergedOf = mainline.some((entry) => entry.isMerge)
      ? await this.listMergedCommits(mainline, range)
      : new Map<string, Pick<ReviewCommit, 'merged' | 'mergedOmitted'>>();
    return mainline.flatMap(({ sha, firstParent, subject, threadIds, isMerge }) =>
      firstParent && threadIds.length === 0 && !AUTOSQUASH_PREFIX.test(subject)
        ? [
            {
              sha,
              shortSha: shortHash(sha),
              parentSha: firstParent,
              subject,
              ...mergedOf.get(sha),
              ...(isMerge ? { isMerge: true as const } : {}),
            },
          ]
        : [],
    );
  }

  // A commit that two merges bring in belongs to the older one, which brought it in first.
  private async listMergedCommits(
    mainline: readonly FixupLogEntry[],
    range: string,
  ): Promise<Map<string, Pick<ReviewCommit, 'merged' | 'mergedOmitted'>>> {
    const all = parseFixupLog(
      await this.git.raw([
        'log',
        '--reverse',
        '--topo-order',
        '--no-show-signature',
        FIXUP_LOG_FORMAT,
        range,
        '--',
      ]),
    );
    const bySha = new Map(all.map((entry) => [entry.sha, entry]));
    const order = new Map(all.map((entry, index) => [entry.sha, index]));
    const claimed = new Set(mainline.map((entry) => entry.sha));
    const mergedOf = new Map<string, Pick<ReviewCommit, 'merged' | 'mergedOmitted'>>();
    for (const merge of mainline) {
      const found: FixupLogEntry[] = [];
      const pending = merge.parents.slice(1);
      for (let sha = pending.pop(); sha !== undefined; sha = pending.pop()) {
        const entry = bySha.get(sha);
        if (!entry || claimed.has(sha)) continue;
        claimed.add(sha);
        found.push(entry);
        pending.push(...entry.parents);
      }
      if (found.length === 0) continue;
      found.sort((a, b) => (order.get(a.sha) ?? 0) - (order.get(b.sha) ?? 0));
      const kept = found.slice(-GitDiffParser.MERGED_COMMITS_LIMIT);
      mergedOf.set(merge.sha, {
        merged: kept.map(({ sha, subject }) => ({ sha, shortSha: shortHash(sha), subject })),
        ...(found.length > kept.length ? { mergedOmitted: found.length - kept.length } : {}),
      });
    }
    return mergedOf;
  }

  // Counts the commits on `ref` that neither the target nor `since` holds, leaving out fixups;
  // `commit` is the newest of them.
  async findNewerTarget(
    targetCommitish: string,
    ref: string,
    since: string,
  ): Promise<NewerTarget | null> {
    if (!isCommitTarget(targetCommitish) || !validateCommitish(targetCommitish)) {
      return null;
    }

    let log: string;
    try {
      log = await this.git.raw([
        'log',
        '--no-show-signature',
        FIXUP_LOG_FORMAT,
        ref,
        `^${targetCommitish}`,
        `^${since}`,
        '--',
      ]);
    } catch (error) {
      console.error('Error looking for newer commits:', error);
      return null;
    }
    const others = parseFixupLog(log).filter(
      (entry) => entry.threadIds.length === 0 && !AUTOSQUASH_PREFIX.test(entry.subject),
    );
    const [newest] = others;
    return newest
      ? {
          ref: ref.replace(/^refs\/(?:heads|remotes|tags)\//, ''),
          commit: newest.sha,
          commitCount: others.length,
        }
      : null;
  }

  async readCommitMessage(sha: string): Promise<string> {
    return (
      await this.git.raw([
        'log',
        '-1',
        '--no-show-signature',
        '--encoding=UTF-8',
        '--format=%B',
        sha,
        '--',
      ])
    ).trimEnd();
  }

  // A commit that is not a merge, read the way listThreadFixups reads it.
  async readThreadFixup(sha: string): Promise<ThreadFixup | null> {
    const [entry] = parseFixupLog(
      await this.git.raw([
        'log',
        '-1',
        '--no-show-signature',
        '-p',
        '-M',
        '--no-ext-diff',
        '--color=never',
        FIXUP_LOG_FORMAT,
        sha,
      ]),
    );
    return entry ? this.toThreadFixup(entry) : null;
  }

  private toThreadFixup({ sha, authoredAt, subject, threadIds, diff }: FixupLogEntry): ThreadFixup {
    const files = this.parseUnifiedDiff(diff).map(
      ({ path, oldPath, status, chunks, isGenerated }) => ({
        path,
        oldPath,
        status,
        chunks,
        isGenerated,
      }),
    );
    return {
      sha,
      shortSha: shortHash(sha),
      patchId: patchIdOf(sha, files),
      authoredAt,
      subject,
      threadIds,
      files,
    };
  }

  async classifyFixups(fixups: ThreadFixup[]): Promise<ThreadFixup[]> {
    const unclassified = fixups.filter((fixup) => !this.classifiedFixupFiles.has(fixup.sha));
    const marked = await this.markChangeKinds(
      unclassified.map((fixup) => ({
        files: fixup.files,
        oldRef: `${fixup.sha}^`,
        newRef: fixup.sha,
      })),
      { judgeGenerated: true },
    );
    const markedBySha = new Map<string, ThreadFixup['files']>();
    for (const [index, fixup] of unclassified.entries()) {
      const result = marked[index];
      if (!result) continue;
      markedBySha.set(fixup.sha, result.files);
      if (result.settled) this.classifiedFixupFiles.set(fixup.sha, result.files);
    }
    return fixups.map((fixup) => {
      const files = this.classifiedFixupFiles.get(fixup.sha) ?? markedBySha.get(fixup.sha);
      return files ? { ...fixup, files } : fixup;
    });
  }

  // Fixups in log order after the target hash; a fixup whose span could not be read has no entry.
  private async readPlainChanges(
    targetHash: string,
    fixups: ThreadFixup[],
  ): Promise<Map<string, PlainFileChange[]>> {
    const bySha = new Map<string, PlainFileChange[]>();
    await Promise.all(
      fixups.map(async (fixup, index) => {
        const since = fixups[index - 1]?.sha ?? targetHash;
        const key = `${since}:${fixup.sha}`;
        let changes = this.plainChanges.get(key);
        if (!changes) {
          try {
            changes = this.parseUnifiedDiff(
              await this.git.raw([
                'diff',
                '-M',
                '-U0',
                '--no-ext-diff',
                '--color=never',
                since,
                `${fixup.sha}^`,
                '--',
              ]),
            )
              .filter((file) => file.status !== 'deleted')
              .map(({ path, oldPath, chunks }) => ({
                path,
                ...(oldPath ? { oldPath } : {}),
                shifts: chunks.map(({ oldStart, oldLines, newStart, newLines }) => ({
                  oldStart,
                  oldLines,
                  newStart,
                  newLines,
                })),
              }));
          } catch (error) {
            console.error('Error reading the commits before a fixup:', error);
            return;
          }
          this.plainChanges.set(key, changes);
        }
        bySha.set(fixup.sha, changes);
      }),
    );
    return bySha;
  }

  // Old side first. 'staged', 'working' and '.' stand for the index and the working tree.
  private async sideRefsOf(selection: DiffSelection): Promise<[string, string]> {
    const { targetCommitish } = selection;
    if (targetCommitish === 'working') return ['staged', 'working'];
    const baseHash = (await this.git.revparse([await this.resolveBaseCommitish(selection)])).trim();
    if (targetCommitish === 'staged' || targetCommitish === '.') return [baseHash, targetCommitish];
    return [baseHash, (await this.git.revparse([targetCommitish])).trim()];
  }

  async classifyDiffFile<File extends ClassifiableFile>(
    selection: DiffSelection,
    file: File,
  ): Promise<File> {
    const [oldRef, newRef] = await this.sideRefsOf(selection);
    const [marked] = await this.markChangeKinds([{ files: [file], oldRef, newRef }]);
    return marked?.files[0] ?? file;
  }

  // Reads every file a ref holds with one git process; null where that side has no such file.
  private async readTexts(
    requests: Array<{ path: string; ref: string }>,
  ): Promise<Array<string | null>> {
    const texts: Array<string | null> = requests.map(() => null);
    const fromGit: Array<{ index: number; spec: string }> = [];
    for (const [index, { path, ref }] of requests.entries()) {
      if (ref === 'working' || ref === '.') {
        texts[index] = await this.getBlobContent(path, ref).then(
          (content) => content.toString('utf8'),
          () => null,
        );
        continue;
      }
      const normalized = this.normalizeRepositoryRelativePath(path);
      // One request per line, so a path holding a newline cannot be asked for.
      if (!normalized.includes('\n')) {
        fromGit.push({ index, spec: `${ref === 'staged' ? '' : ref}:${normalized}` });
      }
    }
    if (fromGit.length === 0) return texts;

    const run = await runGit(this.repoPath, ['cat-file', '--batch'], {
      input: Buffer.from(fromGit.map(({ spec }) => `${spec}\n`).join('')),
    });
    if (run.code !== 0) throw new Error(`git cat-file failed: ${run.output}`);
    let offset = 0;
    for (const { index } of fromGit) {
      const headerEnd = run.stdout.indexOf(0x0a, offset);
      if (headerEnd < 0) break;
      const [, type, size] = run.stdout.subarray(offset, headerEnd).toString('utf8').split(' ');
      const length = Number(size);
      if (!Number.isInteger(length)) {
        offset = headerEnd + 1;
        continue;
      }
      if (type === 'blob') {
        texts[index] = run.stdout.subarray(headerEnd + 1, headerEnd + 1 + length).toString('utf8');
      }
      offset = headerEnd + 1 + length + 1;
    }
    return texts;
  }

  // Reads every group's files with one git process; the groups share one time budget. A group is
  // unsettled when reading failed or the budget ran out before any of its files was started on.
  private async markChangeKinds<File extends ClassifiableFile>(
    groups: Array<{ files: File[]; oldRef: string; newRef: string }>,
    { judgeGenerated = false }: { judgeGenerated?: boolean } = {},
  ): Promise<Array<{ files: File[]; settled: boolean }>> {
    const candidates = groups.flatMap(({ files, oldRef, newRef }, group) =>
      files
        .filter(
          (file) =>
            (file.status === 'modified' || file.status === 'renamed') &&
            file.chunks.length > 0 &&
            (judgeGenerated || !file.isGenerated) &&
            isClassifiablePath(file.path),
        )
        .map((file) => ({ group, file, oldRef, newRef })),
    );
    const settled = groups.map(() => true);
    const started = groups.map(() => false);
    const classified = new Map<File, File>();
    const results = () =>
      groups.map(({ files }, group) => ({
        files: files.map((file) => classified.get(file) ?? file),
        settled: settled[group] ?? false,
      }));
    if (candidates.length === 0) return results();

    let texts: Array<string | null>;
    try {
      texts = await this.readTexts(
        candidates.flatMap(({ file, oldRef, newRef }) => [
          { path: file.oldPath ?? file.path, ref: oldRef },
          { path: file.path, ref: newRef },
        ]),
      );
    } catch (error) {
      console.warn('Could not read files to classify their changes:', error);
      return groups.map(({ files }) => ({ files, settled: false }));
    }

    const deadline = Date.now() + GitDiffParser.CHANGE_KIND_BUDGET_MS;
    let judged = 0;
    for (const [index, { group, file }] of candidates.entries()) {
      const oldText = texts[index * 2];
      const newText = texts[index * 2 + 1];
      if (oldText == null || newText == null) continue;
      if (judged > 0 && Date.now() > deadline) {
        if (!started[group]) settled[group] = false;
        continue;
      }
      started[group] = true;
      judged += 1;
      try {
        const kinds = await classifyChunks(file.path, oldText, newText, file.chunks);
        if (kinds) {
          classified.set(file, {
            ...file,
            chunks: file.chunks.map((chunk, chunkIndex) => ({
              ...chunk,
              changeKind: kinds[chunkIndex],
            })),
          });
        }
      } catch (error) {
        console.warn(`Could not classify changes in ${file.path}:`, error);
      }
    }
    return results();
  }

  parseStdinDiff(diffContent: string): DiffResponse {
    const files = this.parseUnifiedDiff(diffContent);

    return {
      commit: 'stdin diff',
      files,
      isEmpty: files.length === 0,
    };
  }

  async getBlobContent(filepath: string, ref: string): Promise<Buffer> {
    try {
      // For working directory, read directly from filesystem
      if (ref === 'working' || ref === '.') {
        const fs = await import('fs');
        if (filepath.length === 0) {
          throw new Error('Invalid file path');
        }

        const repositoryPath = fs.realpathSync(resolve(this.repoPath));
        const repositoryRoot = `${repositoryPath}${sep}`;
        const absolutePath = fs.realpathSync(resolve(repositoryRoot, filepath.replace(/\\/g, '/')));

        if (!absolutePath.startsWith(repositoryRoot)) {
          throw new Error('File path outside repository');
        }

        return fs.readFileSync(absolutePath);
      }

      const normalizedFilepath = this.normalizeRepositoryRelativePath(filepath);

      // For git refs, we need to use child_process to execute git cat-file
      // to properly handle binary data
      const { execFileSync } = await import('child_process');

      // Handle staged files
      if (ref === 'staged') {
        // For staged files, use git show :filepath
        // Using execFileSync to prevent command injection
        const buffer = execFileSync('git', ['show', `:${normalizedFilepath}`], {
          maxBuffer: 10 * 1024 * 1024, // 10MB limit
        });
        return buffer;
      }

      // First, get the blob hash for the file at the given ref
      // Using execFileSync to prevent command injection
      const blobHash = execFileSync('git', ['rev-parse', `${ref}:${normalizedFilepath}`], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      }).trim();

      // Then use git cat-file to get the raw binary content
      // Increase maxBuffer to handle large files (default is 1024*1024 = 1MB)
      const buffer = execFileSync('git', ['cat-file', 'blob', blobHash], {
        maxBuffer: 10 * 1024 * 1024, // 10MB limit
      });

      return buffer;
    } catch (error) {
      // Check if it's a buffer size error
      if (
        error instanceof Error &&
        (error.message.includes('ENOBUFS') || error.message.includes('maxBuffer'))
      ) {
        throw new Error(`Image file ${filepath} is too large to display (over 10MB limit)`);
      }

      if (
        error instanceof Error &&
        (error.message === 'Invalid file path' || error.message === 'File path outside repository')
      ) {
        throw error;
      }

      throw new Error(
        `Failed to get blob content for ${filepath} at ${ref}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async getLineCount(filepath: string, ref: string): Promise<number> {
    const buffer = await this.getBlobContent(filepath, ref);
    let count = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0x0a) count++; // newline byte
    }
    // If file doesn't end with newline, the last line still counts
    if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
      count++;
    }
    return count;
  }

  private extractHeaderLines(buffer: Buffer, maxLines = 20): string[] {
    const headerSlice = buffer.subarray(0, GitDiffParser.GENERATED_HEADER_SCAN_BYTES);
    return headerSlice.toString('utf8').split('\n').slice(0, maxLines);
  }

  async getGeneratedStatus(
    filepath: string,
    ref: string,
  ): Promise<{ isGenerated: boolean; source: 'path' | 'content' }> {
    const pathResult = isGeneratedFile(filepath);
    if (pathResult.isGenerated) {
      return { isGenerated: true, source: 'path' };
    }

    const gitattributesResult = await this.getGitattributesGeneratedPaths([filepath], ref);
    if (gitattributesResult.has(filepath)) {
      return { isGenerated: true, source: 'path' };
    }

    try {
      const buffer = await this.getBlobContent(filepath, ref);
      const lines = this.extractHeaderLines(buffer);
      const result = isGeneratedFile(filepath, () => lines);
      return { isGenerated: result.isGenerated, source: 'content' };
    } catch {
      return { isGenerated: false, source: 'path' };
    }
  }

  async resolveCommitish(commitish: string): Promise<string> {
    const now = Date.now();
    const cached = this.resolvedCommitCache.get(commitish);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const hash = await this.git.revparse([commitish]);
    const value = hash.substring(0, 7);

    this.resolvedCommitCache.set(commitish, {
      value,
      expiresAt: now + GitDiffParser.RESOLVED_COMMIT_CACHE_TTL_MS,
    });

    return value;
  }

  clearResolvedCommitCache(): void {
    this.resolvedCommitCache.clear();
  }

  async getDefaultBranch(): Promise<string | null> {
    try {
      // Try to get the default branch from origin/HEAD
      const result = await this.git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      // Result will be like "refs/remotes/origin/main\n"
      const match = result.trim().match(/refs\/remotes\/origin\/(.+)/);
      if (match) {
        return match[1];
      }
    } catch {
      // If origin/HEAD is not set, fall back to common default branches
      const commonDefaults = ['main', 'master'];
      const branchResult = await this.git.branchLocal();
      const branchNames = Object.keys(branchResult.branches);

      for (const defaultName of commonDefaults) {
        if (branchNames.includes(defaultName)) {
          return defaultName;
        }
      }
    }
    return null;
  }

  async getOriginDefaultBranch(): Promise<string | null> {
    try {
      const result = await this.git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      const match = result.trim().match(/refs\/remotes\/origin\/(.+)/);
      if (match) {
        return `origin/${match[1]}`;
      }
    } catch {
      const commonDefaults = ['main', 'master'];

      for (const defaultName of commonDefaults) {
        try {
          // No --quiet as simple-git success depends on stderr and that resolves wrong remotes
          await this.git.raw(['show-ref', '--verify', `refs/remotes/origin/${defaultName}`]);
          return `origin/${defaultName}`;
        } catch {
          // Ignore missing refs and continue checking common defaults.
        }
      }
    }

    return null;
  }

  async getRevisionOptions(
    currentBase?: string,
    currentTarget?: string,
  ): Promise<{
    branches: Array<{ name: string; current: boolean }>;
    commits: Array<{ hash: string; shortHash: string; message: string }>;
    originDefaultBranch?: string;
    resolvedBase?: string;
    resolvedTarget?: string;
  }> {
    const [branchResult, logResult, defaultBranch, originDefaultBranch] = await Promise.all([
      this.git.branchLocal(),
      this.git.log({ maxCount: 20 }),
      this.getDefaultBranch(),
      this.getOriginDefaultBranch(),
    ]);

    const branches = Object.entries(branchResult.branches).map(([name, data]) => ({
      name,
      current: data.current,
    }));

    // Sort branches: default branch first, then current branch, then alphabetically
    branches.sort((a, b) => {
      if (defaultBranch) {
        if (a.name === defaultBranch) return -1;
        if (b.name === defaultBranch) return 1;
      }
      if (a.current && !b.current) return -1;
      if (!a.current && b.current) return 1;
      return a.name.localeCompare(b.name);
    });

    const commits = logResult.all.map((commit) => ({
      hash: commit.hash,
      shortHash: commit.hash.substring(0, 7),
      message: commit.message,
    }));

    // Resolve HEAD and HEAD^ to actual commit hashes if they're being used
    let resolvedBase: string | undefined;
    let resolvedTarget: string | undefined;

    if (currentBase && !['working', 'staged', '.'].includes(currentBase)) {
      try {
        resolvedBase = await this.resolveCommitish(currentBase);
      } catch {
        // If resolution fails, leave undefined
      }
    }

    if (currentTarget && !['working', 'staged', '.'].includes(currentTarget)) {
      try {
        resolvedTarget = await this.resolveCommitish(currentTarget);
      } catch {
        // If resolution fails, leave undefined
      }
    }

    return {
      branches,
      commits,
      originDefaultBranch: originDefaultBranch ?? undefined,
      resolvedBase,
      resolvedTarget,
    };
  }
}
