import type { SymbolIndexState } from './watch';

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  chunks: DiffChunk[];
  isGenerated?: boolean;
}

// What a chunk's changed lines alter, read from a parse of both whole files.
export type ChunkChangeKind = 'comment' | 'whitespace' | 'code' | 'unknown';

export interface DiffChunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  // Absent when the file was not classified.
  changeKind?: ChunkChangeKind;
}

export interface DiffLine {
  type: 'add' | 'delete' | 'normal' | 'hunk' | 'remove' | 'context' | 'header';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export type DiffViewMode = 'split' | 'unified';
export type DiffSide = 'old' | 'new';
export type DiffLineRange = number | { start: number; end: number };
// The object form names its side when it is not the position's `side`.
export type ExtraLineRange = DiffLineRange | { side: DiffSide; start: number; end: number };

export type DiffCommentPosition =
  | {
      side: DiffSide;
      // The range that ended lowest in the view the comment was written in.
      line: DiffLineRange;
      // The comment's other ranges, ascending on each side, those on `side` above `line`; the
      // screen writes those on `side` first. Optional so a record stays version 2 and an older
      // difit still reads it, as a comment on `line` alone.
      extraRanges?: ExtraLineRange[];
    }
  // On the whole file rather than on any of its lines; `old` for a file the diff deletes.
  | { side: DiffSide; scope: 'file' };

// On the commit the thread's `fixupTarget` names, as a whole; such a thread has no file.
export interface CommitCommentPosition {
  scope: 'commit';
}

export interface DiffCommentCodeSnapshot {
  content: string;
  // The code of each of the position's `extraRanges`, in the same order.
  extraContents?: string[];
  language?: string;
  // The target commit the content was read from; absent when the target was not a commit.
  commit?: string;
}

export type BaseMode = 'direct' | 'merge-base';

export interface DiffSelection {
  baseCommitish: string;
  targetCommitish: string;
  baseMode?: BaseMode;
}

export interface MergedCommit {
  sha: string;
  shortSha: string;
  subject: string;
}

export interface ReviewCommit {
  sha: string;
  shortSha: string;
  parentSha: string;
  subject: string;
  // On a merge, the commits of the review it brings in that no earlier commit of the list holds,
  // oldest first; the oldest beyond a limit are only counted in `mergedOmitted`.
  merged?: MergedCommit[];
  mergedOmitted?: number;
  // Set on a merge even when it brings in nothing `merged` would list.
  isMerge?: true;
}

export interface ReviewScope {
  selection: DiffSelection;
  requested: DiffSelection;
  commits: ReviewCommit[];
}

// Shas are the full ones of the review's commits.
export type ReviewView =
  | { kind: 'all' }
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; startSha: string; endSha: string };

export type ReviewViewAction =
  | { kind: 'click'; sha: string }
  | { kind: 'shift-click'; sha: string }
  | { kind: 'drop'; fromSha: string; toSha: string }
  | { kind: 'long-press'; sha: string }
  | { kind: 'cancel' }
  | { kind: 'previous' }
  | { kind: 'next' }
  | { kind: 'all' };

export interface DiffResponse {
  commit: string;
  files: DiffFile[];
  ignoreWhitespace?: boolean;
  isEmpty?: boolean;
  openInEditorAvailable?: boolean;
  directEditAvailable?: boolean;
  symbolSearchAvailable?: boolean;
  baseCommitish?: string;
  targetCommitish?: string;
  requestedBaseCommitish?: string;
  requestedTargetCommitish?: string;
  requestedBaseMode?: BaseMode;
  // New for every server started with --clean; a browser clears once for each value.
  cleanRunId?: string;
  repositoryId?: string;
  commentImports?: CommentImport[];
  commentImportId?: string;
  // The review this diff is a view of; comments and decisions belong to it.
  review?: ReviewScope;
  rewritten?: RewrittenShas;
}

export interface ChangeKindsResponse {
  path: string;
  // In the order of the file's chunks in the diff the same query returns.
  chunks: Array<Pick<DiffChunk, 'header' | 'changeKind'>>;
}

export interface GeneratedStatusResponse {
  path: string;
  ref: string;
  isGenerated: boolean;
  source: 'path' | 'content';
}

export interface SymbolMatch {
  path: string;
  line: number;
  // Cut short when the source line is very long.
  text: string;
  // Set on a use of the clicked field that goes through a method Lombok generated from it: a
  // getter call, or a call of a @Builder method. `interface` marks a caller that calls the
  // interface method the method implements.
  via?: 'getter' | 'builder' | 'interface';
  // From the index: the SCIP symbol of the method the use on this line sits in, which
  // /api/symbol-callers takes.
  caller?: string;
  // `name` where the index may no longer be right, so the line was found by name.
  source?: 'name';
}

export interface SymbolSearchResponse {
  name: string;
  ref: string;
  // Lines that look like they declare the name, most likely first.
  definitions: SymbolMatch[];
  references: SymbolMatch[];
  truncated: boolean;
  // `index` when the commit's SCIP index answered: the declarations and uses of the symbol at
  // the clicked spot. `name` when every line holding the name was searched.
  source: 'index' | 'name';
  // The declaration lives only in this library, outside the repository, e.g.
  // `java.util.Optional#orElse()`.
  library?: string;
  // The SCIP symbol of that declaration, which /api/library-source takes.
  librarySymbol?: string;
  // How the index of the clicked commit, or of the ancestor whose index it waits for, stands
  // when name search answered a click in a Java file; /api/live announces each later change as
  // a `symbolIndexChanged` event.
  index?: SymbolIndexState & { commit: string };
  // Of an answer from an index: the full sha of the commit whose index answered, an ancestor's
  // when the clicked commit borrowed it.
  indexCommit?: string;
  // Of an answer from an index stored before implementations and callers were kept.
  indexWithoutRelations?: true;
  // Why a click that name search answered did not use an index, sent only when the commit (or
  // HEAD, for a review of uncommitted changes) could be indexed.
  unindexed?: 'not-java' | 'not-commit';
  // From the index: declarations of the types that extend or implement the clicked one, or of
  // the methods that override it.
  implementations?: SymbolMatch[];
}

export interface SymbolCallersResponse {
  callers: SymbolMatch[];
  truncated: boolean;
}

// GET /api/symbol-index/:commit/log
export interface SymbolIndexLogResponse {
  path: string;
  // What is kept of the build log, without terminal color codes.
  text: string;
}

// Where the source of a library declaration was read from: the src.zip of an installed JDK,
// whose major version may differ from the `indexed` one the code was compiled against, or a
// -sources.jar in the Gradle or Maven cache.
export type LibrarySourceOrigin =
  | { kind: 'jdk'; installed: string | null; indexed: string }
  | { kind: 'gradle' | 'maven'; jar: string };

// Why no source was shown: no installed JDK has a src.zip (`sourcePackage` is the system
// package that would install a missing one), no cache holds a -sources.jar of the artifact,
// the archive found does not hold the file, or the symbol names no JDK or Maven artifact.
export type LibrarySourceMissing =
  | { kind: 'jdk'; indexed: string; sourcePackage?: string }
  | { kind: 'jar'; artifact: string }
  | { kind: 'file'; archive: string; path: string }
  | { kind: 'unknown' };

// GET /api/library-source?symbol=
export type LibrarySourceResponse =
  | { found: true; path: string; line: number; text: string; origin: LibrarySourceOrigin }
  | { found: false; missing: LibrarySourceMissing };

export interface SkillSummary {
  name: string;
  description: string;
  source: 'repository' | 'user' | 'plugin' | 'built-in';
}

export type LineNumber = number | [number, number];

export interface Comment {
  id: string;
  file: string;
  line: LineNumber;
  body: string;
  timestamp: string;
  author?: string;
  codeContent?: string; // The actual code content for this line
  side?: DiffSide; // Which side the comment is on
}

export interface LineSelection {
  side: DiffSide;
  lineNumber: number;
}

export interface SidedLine {
  side: DiffSide;
  line: LineNumber;
}

// The ranges a new comment takes besides the one its card sits under, with the code of each.
export interface ExtraCommentLines {
  lines: SidedLine[];
  contents: (string | undefined)[];
}

export interface LegacyDiffComment {
  id: string;
  filePath: string;
  body: string;
  author?: string;
  createdAt: string; // ISO 8601 format
  updatedAt: string; // ISO 8601 format

  position: DiffCommentPosition;

  codeSnapshot?: DiffCommentCodeSnapshot;
}

export interface ReplyChoice {
  id: string;
  name: string;
  description: string;
  preview?: { label?: string; text: string };
  recommended?: boolean;
}

// The reviewer's pick among the choices an earlier message of the thread offered.
export interface ChoiceAnswer {
  messageId: string;
  choice: string;
}

// An old range is numbered in the fixup's parent, a new one in the fixup commit.
export interface FixupLineRange extends SidedLine {
  code: string;
}

export interface FixupLines {
  fixupSha: string;
  patchId: string;
  filePath: string;
  // The file in the fixup's parent when the fixup renamed it.
  oldPath?: string;
  ranges: FixupLineRange[];
}

export interface DiffCommentMessage {
  id: string;
  body: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  choices?: ReplyChoice[];
  answer?: ChoiceAnswer;
  fixupLines?: FixupLines;
  fixPending?: true;
}

export type ReviewerReplyFields = Pick<DiffCommentMessage, 'answer' | 'fixupLines'>;

interface DiffCommentThreadBase {
  id: string;
  createdAt: string; // ISO 8601 format
  updatedAt: string; // ISO 8601 format

  messages: DiffCommentMessage[];

  // Optional so a record stays version 2 and an older difit still reads it. A thread without
  // them was made on the whole review and is fixed up into the review target.
  view?: DiffSelection;
  fixupTarget?: string;
}

export interface FileCommentThread extends DiffCommentThreadBase {
  filePath: string;
  position: DiffCommentPosition;
  codeSnapshot?: DiffCommentCodeSnapshot;
}

export interface CommitCommentThread extends DiffCommentThreadBase {
  position: CommitCommentPosition;
  fixupTarget: string;
}

export type DiffCommentThread = FileCommentThread | CommitCommentThread;

interface CommentImportCommon {
  id?: string;
  body: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  view?: DiffSelection;
}

interface FileCommentImportPlace {
  filePath: string;
  position: DiffCommentPosition;
  codeSnapshot?: DiffCommentCodeSnapshot;
  fixupTarget?: string;
}

interface CommitCommentImportPlace {
  position: CommitCommentPosition;
  fixupTarget: string;
}

type CommentImportPlace = FileCommentImportPlace | CommitCommentImportPlace;

export type ThreadCommentImport = CommentImportCommon & CommentImportPlace & { type: 'thread' };

export type ReplyCommentImport = CommentImportCommon &
  CommentImportPlace & {
    type: 'reply';
    threadId?: string;
    choices?: ReplyChoice[];
    answer?: ChoiceAnswer;
    fixupLines?: FixupLines;
    fixPending?: true;
  };

export type CommentImport = ThreadCommentImport | ReplyCommentImport;

export interface ViewedFileRecord {
  filePath: string;
  viewedAt: string; // ISO 8601 format
  diffContentHash: string; // SHA-256 hash
}

export interface ViewedHashIndexEntry {
  filePath: string;
  diffContentHash: string;
  hashVersion: 1;
  viewedAt: string; // ISO 8601 format
}

export interface ViewedHashRemoval {
  filePath: string;
  diffContentHash: string;
  removedAt: string; // ISO 8601 format
}

export interface ViewedHashIndex {
  version: 1;
  lastModifiedAt: string; // ISO 8601 format
  entries: ViewedHashIndexEntry[];
  removed?: ViewedHashRemoval[];
}

export interface SharedViewedRecord extends ViewedHashIndex {
  removed: ViewedHashRemoval[];
}

export interface LegacyDiffContextStorage {
  version: 1; // Schema version
  baseCommitish: string;
  targetCommitish: string;
  createdAt: string; // ISO 8601 format
  lastModifiedAt: string; // ISO 8601 format

  comments: LegacyDiffComment[];
  viewedFiles: ViewedFileRecord[];
}

export interface DiffContextStorage {
  version: 2; // Schema version
  baseCommitish: string;
  targetCommitish: string;
  baseMode?: BaseMode;
  createdAt: string; // ISO 8601 format
  lastModifiedAt: string; // ISO 8601 format

  threads: DiffCommentThread[];
  viewedFiles: ViewedFileRecord[];
  appliedCommentImportIds: string[];
  // Optional so a record stays version 2 and an older difit still reads it.
  decisions?: ReviewDecision[];
}

export type ReviewDecisionKind =
  | 'rejected'
  | 'approved'
  | 'unapproved'
  | 'folded'
  | 'resolved'
  | 'unresolved'
  // The server passed the thread to the agent through comment wait or a session message.
  | 'handed'
  // The reviewer deleted the thread; it stays stored but hidden.
  | 'deleted';

// Threads carry no resolved state; a thread's screen state is derived from these
// records plus the fixup commits found by trailer.
export interface ReviewDecision {
  threadId: string;
  kind: ReviewDecisionKind;
  // Empty for a resolution, a reopening, a handover or a deletion, which judge no fixup.
  fixupSha: string;
  // Identifies the fixup's changes across rebases that rewrite fixupSha.
  patchId?: string;
  targetSha?: string;
  at: string; // ISO 8601 format
}

export type FixupRef = Pick<ReviewDecision, 'fixupSha' | 'patchId'>;

export type ThreadReviewState =
  | 'awaiting-fix'
  // No fixup yet, and the agent replied to the reviewer: the reviewer's turn.
  | 'answered'
  // Like answered, with choices in the agent's reply for the reviewer to pick from.
  | 'choosing'
  // Still the agent's to finish, not the reviewer's turn.
  | 'fix-pending'
  | 'awaiting-approval'
  | 'approved'
  | 'folded'
  | 'rejected'
  // A thread the reviewer opened by editing, whose edit was then rejected; nobody fixes it again.
  | 'withdrawn'
  | 'deleted';

// A commit carrying a `Review-Thread: <threadId>` trailer is the agent's answer to that thread.
export const REVIEW_THREAD_TRAILER = 'Review-Thread';

export const AUTOSQUASH_PREFIX = /^(?:fixup|squash|amend)! /;

export const REVIEWER_EDIT_AUTHOR = 'reviewer-edit';

// Author the page writes on everything the reviewer types; any other author is the agent's.
export const REVIEWER_AUTHOR = 'User';

export const AGENT_AUTHOR = 'Agent';

interface ThreadAwaitingAgentBase {
  threadId: string;
  // Absent on reviews without fixup states, where any reviewer word left unanswered counts.
  state?: Extract<
    ThreadReviewState,
    'awaiting-fix' | 'awaiting-approval' | 'approved' | 'rejected' | 'withdrawn' | 'deleted'
  >;
  label?: string;
  // Rejected, or answering a deleted thread.
  rejectedFixupShas?: string[];
  rejectedFixupSha?: string;
  message: string;
  // Present when the latest message picks one of the choices the agent offered.
  answer?: ChoiceAnswer;
  // Present when the latest message was written on lines of a fixup card.
  fixupLines?: FixupLines;
  fixupTarget?: string;
}

export type ThreadAwaitingAgent = ThreadAwaitingAgentBase &
  ({ filePath: string; position: DiffCommentPosition } | { position: CommitCommentPosition });

export interface ThreadFixup {
  sha: string;
  shortSha: string;
  // Same for two commits that make the same changes next to the same unchanged lines in the same
  // files, wherever the line numbers fall.
  patchId: string;
  // The author date, which rebases keep; ISO 8601 format.
  authoredAt: string;
  subject: string;
  threadIds: string[];
  files: Array<
    Pick<DiffFile, 'path' | 'oldPath' | 'status' | 'chunks' | 'isGenerated'> & {
      // True when the file at the fixup is the same as at the review base, both absent included.
      matchesReviewBase?: true;
    }
  >;
  // What the commits answering no thread changed since the fixup before this one, or since the
  // review target for the first; left out when it was not read.
  plainChangesBefore?: PlainFileChange[];
  foldTargetSha?: string;
  // On an amend! commit: the message the commits folded before it leave on its target, and the one
  // it leaves there.
  amendedMessage?: MessageAmendment;
}

export interface MessageAmendment {
  before: string;
  after: string;
}

export interface PlainFileChange {
  // On the parent of the fixup.
  path: string;
  oldPath?: string;
  shifts: Array<Pick<DiffChunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>>;
}

export interface DirectEditRequest {
  filePath: string;
  // 1-based and inclusive, on the new side of the reviewed diff.
  startLine: number;
  endLine: number;
  original: string[];
  replacement: string[];
  threadId?: string;
  // The commit or run of commits the lines were edited in; the whole review when left out.
  view?: { base: string; target: string };
  // The fixup on the thread's card whose version of the file the lines were edited in, in place
  // of a view.
  fixupSha?: string;
  // With fixupSha: the fixups on the thread's cards as the reviewer saw them, approved with the edit.
  approvedWith?: string[];
}

export type DirectEditRejection =
  | 'stale-view'
  | 'target-not-in-head'
  | 'detached-head'
  | 'not-a-file'
  | 'binary'
  | 'not-utf8'
  | 'missing-at-head'
  | 'dirty-file'
  | 'operation-in-progress'
  | 'conflict'
  | 'fold-conflict'
  | 'no-change'
  | 'head-moved'
  | 'commit-failed'
  | 'thread-has-fixup'
  | 'thread-opened-by-edit'
  | 'no-fold-target'
  | 'outside-fixup'
  | 'card-changed';

export type DirectEditResponse =
  | {
      success: true;
      sha: string;
      threadId: string;
      version: number;
      threads: DiffCommentThread[];
      decisions: ReviewDecision[];
    }
  | {
      error: string;
      reason?: DirectEditRejection;
      output?: string;
      // With card-changed: the fixup committed before the card changed, which nothing approved.
      sha?: string;
    };

export interface RewordRequest {
  commit: string;
  // The message the reviewer started from; a mismatch means the view is out of date.
  original: string;
  message: string;
  acknowledged?: RewriteWarning[];
}

export type RewriteWarning = 'default-branch' | 'pushed-commit';

export type RewordRejection =
  | 'stale-view'
  | 'target-not-in-head'
  | 'detached-head'
  | 'operation-in-progress'
  | 'merge-commit'
  | 'agent-working'
  | 'empty-message'
  | 'no-change'
  | 'needs-confirmation'
  | 'conflict'
  | 'head-moved'
  | 'commit-failed';

// Keyed by the old full SHA; only commits the rewrite actually replaced.
export type RewrittenShas = Readonly<Record<string, string>>;

export type RewordResponse =
  | {
      success: true;
      rewritten: RewrittenShas;
      version: number;
      threads: DiffCommentThread[];
      decisions: ReviewDecision[];
    }
  | { error: string; reason?: RewordRejection; output?: string; warnings?: RewriteWarning[] };

// The message a commit of the review shows: the one its pending amend! commits leave, or its own.
export interface CommitMessageResponse {
  message: string;
}

// Where the ref the review was opened by now points, once commits other than fixups follow the target.
export interface NewerTarget {
  ref: string;
  commit: string;
  // Counts only the commits that are not fixups.
  commitCount: number;
}

export interface FixupsResponse {
  // Commits between the reviewed target and HEAD that carry the trailer, oldest first.
  fixups: ThreadFixup[];
  newerTarget?: NewerTarget;
}

// The saved snapshot is gone from the file, or occurs in more than one place.
export type AnchorStaleReason = 'missing' | 'ambiguous';

interface ShownThreadBase {
  id: string;
  createdAt: string;
  updatedAt: string;
  isOutdated?: boolean;
  outdatedReason?: AnchorStaleReason;
  messages: DiffCommentMessage[];
  fixupCommit?: { shortSha: string; subject?: string };
  // Set only when it is a view of this review other than the one shown.
  madeView?: DiffSelection;
}

export interface CommentThread extends ShownThreadBase {
  file: string;
  // Where the thread is drawn now, relocated by snapshot content; may differ from the stored position.
  // Absent on a thread about the whole file.
  line?: LineNumber;
  // The thread's other ranges, placed like `line`, in the order of the position's `extraRanges`.
  extraLines?: SidedLine[];
  side?: DiffSide;
  codeContent?: string;
  anchorCommit?: string;
}

export interface CommitThreadView extends ShownThreadBase {
  commit: string;
}

export type ShownThread = CommentThread | CommitThreadView;

// Revision selector types
interface RevisionOption {
  value: string;
  label: string;
}

interface BranchInfo {
  name: string;
  current: boolean;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
}

export interface RevisionsResponse {
  specialOptions: RevisionOption[];
  branches: BranchInfo[];
  commits: CommitInfo[];
  originDefaultBranch?: string;
  resolvedBase?: string;
  resolvedTarget?: string;
}

// Expanded lines types for showing more context in diffs
export interface ExpandedLinesState {
  [filePath: string]: FileExpandedState;
}

export interface FileExpandedState {
  oldContent?: string[];
  newContent?: string[];
  expandedRanges: ExpandedRange[];
  oldTotalLines?: number;
  newTotalLines?: number;
}

// Old-side line numbers, both ends included; `end` may be Infinity for "to the end of the file".
export interface ExpandedRange {
  start: number;
  end: number;
}

export interface ExpandedLine extends DiffLine {
  isExpanded?: boolean;
  // Its file's content could not be read, so `content` is blank.
  contentUnread?: boolean;
}
