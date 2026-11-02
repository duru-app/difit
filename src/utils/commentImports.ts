import {
  AGENT_AUTHOR,
  type ChoiceAnswer,
  type CommentImport,
  type CommitCommentPosition,
  type DiffCommentPosition,
  type DiffCommentThread,
  type DiffLineRange,
  type DiffCommentCodeSnapshot,
  type DiffSide,
  type ExtraLineRange,
  type DiffCommentMessage,
  type DiffSelection,
  type FixupLineRange,
  type FixupLines,
  type LineNumber,
  type ReplyChoice,
  type ReplyCommentImport,
  type ThreadCommentImport,
} from '../types/diff.js';
import {
  endOfLine,
  isOnCommit,
  rangesOfPosition,
  sideOfRange,
  startOfLine,
} from './commentPosition.js';
import { createId } from './createId.js';
import { createDiffSelection, isCommitHash, isSameCommit } from './diffSelection.js';

interface MergeCommentImportsResult {
  threads: DiffCommentThread[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function normalizeTimestamp(
  value: unknown,
  fieldName: 'createdAt' | 'updatedAt',
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0 || !isValidIsoTimestamp(value)) {
    throw new Error(`Invalid comment import field: ${fieldName}`);
  }
  return value;
}

function normalizeLineRange(value: unknown, fieldName = 'position.line'): DiffLineRange {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (!isRecord(value)) {
    throw new Error(`Invalid comment import field: ${fieldName}`);
  }

  const start = value.start;
  const end = value.end;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start <= 0 ||
    end <= 0 ||
    start > end
  ) {
    throw new Error(`Invalid comment import field: ${fieldName}`);
  }

  return { start, end };
}

function normalizeExtraRange(value: unknown, side: DiffSide): ExtraLineRange {
  const range = normalizeLineRange(value, 'position.extraRanges');
  if (!isRecord(value) || value.side === undefined || value.side === side) return range;
  if ((value.side !== 'old' && value.side !== 'new') || typeof range === 'number') {
    throw new Error('Invalid comment import field: position.extraRanges');
  }
  return { side: value.side, start: range.start, end: range.end };
}

const ascending = (ranges: readonly ExtraLineRange[]) =>
  ranges.every(
    (range, index) => index === 0 || endOfLine(ranges[index - 1] ?? range) < startOfLine(range),
  );

// On each side ascending and apart from each other, and on `side` all above `line`, as the screen
// stores them.
function normalizeExtraRanges(
  value: unknown,
  line: DiffLineRange,
  side: DiffSide,
): ExtraLineRange[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid comment import field: position.extraRanges');
  }
  const ranges = value.map((range) => normalizeExtraRange(range, side));
  const onSide = ranges.filter((range) => sideOfRange(range, side) === side);
  const onOtherSide = ranges.filter((range) => sideOfRange(range, side) !== side);
  if (!ascending([...onSide, line]) || !ascending(onOtherSide)) {
    throw new Error('Invalid comment import field: position.extraRanges');
  }
  return ranges.length > 0 ? ranges : undefined;
}

function normalizePosition(value: unknown): DiffCommentPosition {
  if (!isRecord(value)) {
    throw new Error('Invalid comment import field: position');
  }

  if (value.side !== 'old' && value.side !== 'new') {
    throw new Error('Invalid comment import field: position.side');
  }

  if (value.scope === undefined) {
    const line = normalizeLineRange(value.line);
    const extraRanges = normalizeExtraRanges(value.extraRanges, line, value.side);
    return { side: value.side, line, ...(extraRanges ? { extraRanges } : {}) };
  }
  if (value.scope !== 'file' || value.line !== undefined || value.extraRanges !== undefined) {
    throw new Error('Invalid comment import field: position.scope');
  }
  return { side: value.side, scope: 'file' };
}

function normalizeCommitPosition(value: unknown): CommitCommentPosition {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'scope')) {
    throw new Error('Invalid comment import field: position');
  }
  return { scope: 'commit' };
}

function normalizeCodeSnapshot(value: unknown): DiffCommentCodeSnapshot | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || typeof value.content !== 'string') {
    throw new Error('Invalid comment import field: codeSnapshot');
  }

  if (value.language !== undefined && typeof value.language !== 'string') {
    throw new Error('Invalid comment import field: codeSnapshot.language');
  }
  if (value.commit !== undefined && typeof value.commit !== 'string') {
    throw new Error('Invalid comment import field: codeSnapshot.commit');
  }
  const { extraContents } = value;
  if (
    extraContents !== undefined &&
    (!Array.isArray(extraContents) ||
      !extraContents.every((content): content is string => typeof content === 'string'))
  ) {
    throw new Error('Invalid comment import field: codeSnapshot.extraContents');
  }

  return {
    content: value.content,
    ...(extraContents === undefined ? {} : { extraContents }),
    language: value.language,
    commit: value.commit,
  };
}

function normalizeView(value: unknown): DiffSelection | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.baseCommitish !== 'string' ||
    value.baseCommitish.length === 0 ||
    typeof value.targetCommitish !== 'string' ||
    value.targetCommitish.length === 0 ||
    (value.baseMode !== undefined && value.baseMode !== 'direct' && value.baseMode !== 'merge-base')
  ) {
    throw new Error('Invalid comment import field: view');
  }
  return createDiffSelection(value.baseCommitish, value.targetCommitish, value.baseMode);
}

function normalizeFixupTarget(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !isCommitHash(value)) {
    throw new Error('Invalid comment import field: fixupTarget');
  }
  return value;
}

function cloneView(view: DiffSelection): DiffSelection {
  return createDiffSelection(view.baseCommitish, view.targetCommitish, view.baseMode);
}

function viewFields(source: { view?: DiffSelection; fixupTarget?: string }): {
  view?: DiffSelection;
  fixupTarget?: string;
} {
  return {
    ...(source.view === undefined ? {} : { view: cloneView(source.view) }),
    ...(source.fixupTarget === undefined ? {} : { fixupTarget: source.fixupTarget }),
  };
}

function normalizeOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid comment import field: ${fieldName}`);
  }
  return value;
}

function normalizeRequiredBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid comment import field: body');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('Invalid comment import field: body');
  }

  return trimmed;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizePreview(value: unknown): ReplyChoice['preview'] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Invalid comment import field: choices');
  }
  const { label, text } = value;
  if (typeof text !== 'string' || (label !== undefined && typeof label !== 'string')) {
    throw new Error('Invalid comment import field: choices');
  }
  return { ...(label === undefined ? {} : { label }), text };
}

function normalizeChoice(value: unknown): ReplyChoice {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.name) ||
    typeof value.description !== 'string' ||
    (value.recommended !== undefined && typeof value.recommended !== 'boolean')
  ) {
    throw new Error('Invalid comment import field: choices');
  }
  const preview = normalizePreview(value.preview);
  return {
    id: value.id.trim(),
    name: value.name.trim(),
    description: value.description.trim(),
    ...(preview === undefined ? {} : { preview }),
    ...(value.recommended ? { recommended: true } : {}),
  };
}

function normalizeChoices(value: unknown): ReplyChoice[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Invalid comment import field: choices');
  }
  const choices = value.map(normalizeChoice);
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) {
    throw new Error('Invalid comment import field: choices');
  }
  return choices;
}

function normalizeAnswer(value: unknown): ChoiceAnswer | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !isNonEmptyString(value.messageId) || !isNonEmptyString(value.choice)) {
    throw new Error('Invalid comment import field: answer');
  }
  return { messageId: value.messageId, choice: value.choice };
}

const isLineNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

function normalizeFixupLineRange(value: unknown): FixupLineRange {
  if (!isRecord(value) || (value.side !== 'old' && value.side !== 'new')) {
    throw new Error('Invalid comment import field: fixupLines');
  }
  const { line, code } = value;
  const isRange =
    Array.isArray(line) &&
    line.length === 2 &&
    isLineNumber(line[0]) &&
    isLineNumber(line[1]) &&
    line[0] <= line[1];
  if ((!isLineNumber(line) && !isRange) || typeof code !== 'string') {
    throw new Error('Invalid comment import field: fixupLines');
  }
  return { side: value.side, line: line as LineNumber, code };
}

function normalizeFixupLines(value: unknown): FixupLines | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.fixupSha) ||
    !isNonEmptyString(value.patchId) ||
    !isNonEmptyString(value.filePath) ||
    (value.oldPath !== undefined && !isNonEmptyString(value.oldPath)) ||
    !Array.isArray(value.ranges) ||
    value.ranges.length === 0
  ) {
    throw new Error('Invalid comment import field: fixupLines');
  }
  return {
    fixupSha: value.fixupSha,
    patchId: value.patchId,
    filePath: value.filePath,
    ...(value.oldPath === undefined ? {} : { oldPath: value.oldPath }),
    ranges: value.ranges.map(normalizeFixupLineRange),
  };
}

const cloneFixupLines = ({
  fixupSha,
  patchId,
  filePath,
  oldPath,
  ranges,
}: FixupLines): FixupLines => ({
  fixupSha,
  patchId,
  filePath,
  ...(oldPath === undefined ? {} : { oldPath }),
  ranges: ranges.map(({ side, line, code }) => ({
    side,
    line: Array.isArray(line) ? [line[0], line[1]] : line,
    code,
  })),
});

function cloneChoice(choice: ReplyChoice): ReplyChoice {
  return {
    id: choice.id,
    name: choice.name,
    description: choice.description,
    ...(choice.preview === undefined
      ? {}
      : {
          preview: {
            ...(choice.preview.label === undefined ? {} : { label: choice.preview.label }),
            text: choice.preview.text,
          },
        }),
    ...(choice.recommended ? { recommended: true } : {}),
  };
}

function normalizeFixPending(value: unknown): true | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  if (value !== true) {
    throw new Error('Invalid comment import field: fixPending');
  }
  return true;
}

type ReplyFields = Pick<DiffCommentMessage, 'choices' | 'answer' | 'fixupLines' | 'fixPending'>;

function replyFields(source: ReplyFields): ReplyFields {
  return {
    ...(source.choices === undefined ? {} : { choices: source.choices.map(cloneChoice) }),
    ...(source.answer === undefined
      ? {}
      : { answer: { messageId: source.answer.messageId, choice: source.answer.choice } }),
    ...(source.fixupLines === undefined ? {} : { fixupLines: cloneFixupLines(source.fixupLines) }),
    ...(source.fixPending ? { fixPending: true } : {}),
  };
}

function replyFieldsKey(message: ReplyFields): string {
  return JSON.stringify(replyFields(message));
}

function normalizeCommentImportEntry(value: unknown): CommentImport {
  if (!isRecord(value)) {
    throw new Error('Comment import must be an object');
  }

  if (value.type !== 'thread' && value.type !== 'reply') {
    throw new Error('Invalid comment import field: type');
  }

  const onCommit = isRecord(value.position) && value.position.scope === 'commit';
  if (
    onCommit
      ? value.filePath !== undefined
      : typeof value.filePath !== 'string' || value.filePath.trim().length === 0
  ) {
    throw new Error('Invalid comment import field: filePath');
  }

  const createdAt = normalizeTimestamp(value.createdAt, 'createdAt');
  const updatedAt = normalizeTimestamp(value.updatedAt, 'updatedAt');
  if (
    value.type === 'thread' &&
    (value.choices !== undefined ||
      value.answer !== undefined ||
      value.fixupLines !== undefined ||
      normalizeFixPending(value.fixPending) !== undefined)
  ) {
    throw new Error(
      'Invalid comment import field: choices, answer, fixupLines and fixPending belong on a reply',
    );
  }
  if (value.choices !== undefined && normalizeFixPending(value.fixPending) !== undefined) {
    throw new Error('Invalid comment import field: a reply takes choices or fixPending, not both');
  }

  const fixupTarget = normalizeFixupTarget(value.fixupTarget);
  const common = {
    type: value.type,
    id: normalizeOptionalString(value.id, 'id'),
    body: normalizeRequiredBody(value.body),
    author: normalizeOptionalString(value.author, 'author'),
    createdAt,
    updatedAt,
    ...replyFields({
      choices: normalizeChoices(value.choices),
      answer: normalizeAnswer(value.answer),
      fixupLines: normalizeFixupLines(value.fixupLines),
      fixPending: normalizeFixPending(value.fixPending),
    }),
  };

  if (onCommit) {
    if (fixupTarget === undefined) {
      throw new Error('Invalid comment import field: fixupTarget');
    }
    if (value.codeSnapshot !== undefined) {
      throw new Error('Invalid comment import field: codeSnapshot');
    }
    return {
      ...common,
      position: normalizeCommitPosition(value.position),
      ...viewFields({ view: normalizeView(value.view) }),
      fixupTarget,
    } as CommentImport;
  }

  return {
    ...common,
    filePath: value.filePath,
    position: normalizePosition(value.position),
    codeSnapshot: normalizeCodeSnapshot(value.codeSnapshot),
    ...viewFields({ view: normalizeView(value.view), fixupTarget }),
  } as CommentImport;
}

export function normalizeCommentImports(input: unknown): CommentImport[] {
  if (Array.isArray(input)) {
    return input.map((entry) => normalizeCommentImportEntry(entry));
  }

  return [normalizeCommentImportEntry(input)];
}

export function parseCommentImportValue(value: string): CommentImport[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid --comment JSON');
  }

  return normalizeCommentImports(parsed).map((entry) =>
    entry.author?.trim() ? entry : { ...entry, author: AGENT_AUTHOR },
  );
}

const rangeKey = (range: ExtraLineRange) => {
  if (typeof range === 'number') return String(range);
  return `${'side' in range ? `${range.side}@` : ''}${range.start}-${range.end}`;
};

function getPositionKey(position: DiffCommentPosition): string {
  if (!('line' in position)) {
    return `${position.side}:file`;
  }

  const ranges = [...rangesOfPosition(position)].sort(
    (a, b) =>
      Number(sideOfRange(a, position.side) !== position.side) -
        Number(sideOfRange(b, position.side) !== position.side) || startOfLine(a) - startOfLine(b),
  );
  return `${position.side}:${ranges.map(rangeKey).join(',')}`;
}

function positionsMatch(left: DiffCommentPosition, right: DiffCommentPosition): boolean {
  return getPositionKey(left) === getPositionKey(right);
}

type Place =
  | { filePath: string; position: DiffCommentPosition }
  | { position: CommitCommentPosition; fixupTarget: string };

function samePlace(left: Place, right: Place): boolean {
  if (isOnCommit(left) || isOnCommit(right)) {
    return (
      isOnCommit(left) && isOnCommit(right) && isSameCommit(left.fixupTarget, right.fixupTarget)
    );
  }
  return left.filePath === right.filePath && positionsMatch(left.position, right.position);
}

function placeLabel(place: Place): string {
  return isOnCommit(place)
    ? `the commit ${place.fixupTarget}`
    : `${place.filePath}:${getPositionKey(place.position)}`;
}

function normalizeAuthor(author: string | undefined): string {
  return author?.trim() || '';
}

function messageMatchesImport(
  message: DiffCommentMessage,
  commentImport: CommentImport,
  includeId = true,
): boolean {
  if (includeId && commentImport.id && message.id === commentImport.id) {
    return true;
  }

  if (normalizeAuthor(message.author) !== normalizeAuthor(commentImport.author)) {
    return false;
  }

  if (message.body !== commentImport.body) {
    return false;
  }

  if (commentImport.createdAt && message.createdAt !== commentImport.createdAt) {
    return false;
  }

  return (
    replyFieldsKey(message) === replyFieldsKey(commentImport.type === 'reply' ? commentImport : {})
  );
}

function rootThreadMatchesImport(
  thread: DiffCommentThread,
  commentImport: ThreadCommentImport,
): boolean {
  if (commentImport.id && thread.id === commentImport.id) {
    return true;
  }

  if (!samePlace(thread, commentImport)) {
    return false;
  }

  const rootMessage = thread.messages[0];
  if (!rootMessage) {
    return false;
  }

  return messageMatchesImport(rootMessage, commentImport, true);
}

function toThreadTimestamp(
  commentImport: CommentImport,
  now: string,
): { createdAt: string; updatedAt: string } {
  const createdAt = commentImport.createdAt ?? now;
  const updatedAt = commentImport.updatedAt ?? createdAt;
  return { createdAt, updatedAt };
}

function maxIsoTimestamp(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

function sortByNewestThread(left: DiffCommentThread, right: DiffCommentThread): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function createImportedThread(commentImport: ThreadCommentImport, now: string): DiffCommentThread {
  const { createdAt, updatedAt } = toThreadTimestamp(commentImport, now);
  const threadId = commentImport.id ?? createId();
  const common = {
    id: threadId,
    createdAt,
    updatedAt,
    messages: [
      {
        id: commentImport.id ?? threadId,
        body: commentImport.body,
        author: commentImport.author,
        createdAt,
        updatedAt,
      },
    ],
  };

  if (isOnCommit(commentImport)) {
    return {
      ...common,
      position: { scope: 'commit' },
      ...viewFields({ view: commentImport.view }),
      fixupTarget: commentImport.fixupTarget,
    };
  }
  return {
    ...common,
    filePath: commentImport.filePath,
    position: commentImport.position,
    codeSnapshot: commentImport.codeSnapshot,
    ...viewFields(commentImport),
  };
}

function createImportedReply(commentImport: ReplyCommentImport, now: string): DiffCommentMessage {
  const { createdAt, updatedAt } = toThreadTimestamp(commentImport, now);

  return {
    id: commentImport.id ?? createId(),
    body: commentImport.body,
    author: commentImport.author,
    createdAt,
    updatedAt,
    ...replyFields(commentImport),
  };
}

function cloneLineRange(line: DiffLineRange): DiffLineRange {
  if (typeof line === 'number') {
    return line;
  }

  return {
    start: line.start,
    end: line.end,
  };
}

function cloneExtraRange(range: ExtraLineRange): ExtraLineRange {
  if (typeof range === 'object' && 'side' in range) {
    return { side: range.side, start: range.start, end: range.end };
  }
  return cloneLineRange(range);
}

function clonePosition(position: DiffCommentPosition): DiffCommentPosition {
  if (!('line' in position)) {
    return { side: position.side, scope: 'file' };
  }

  return {
    side: position.side,
    line: cloneLineRange(position.line),
    ...(position.extraRanges ? { extraRanges: position.extraRanges.map(cloneExtraRange) } : {}),
  };
}

function cloneCodeSnapshot(
  snapshot: DiffCommentCodeSnapshot | undefined,
): DiffCommentCodeSnapshot | undefined {
  if (!snapshot) {
    return undefined;
  }

  return {
    content: snapshot.content,
    ...(snapshot.extraContents ? { extraContents: [...snapshot.extraContents] } : {}),
    language: snapshot.language,
    commit: snapshot.commit,
  };
}

function cloneMessage(message: DiffCommentMessage): DiffCommentMessage {
  return {
    id: message.id,
    body: message.body,
    author: message.author,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    ...replyFields(message),
  };
}

function cloneThread(thread: DiffCommentThread): DiffCommentThread {
  const common = {
    id: thread.id,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: thread.messages.map(cloneMessage),
  };
  if (isOnCommit(thread)) {
    return {
      ...common,
      position: { scope: 'commit' },
      ...viewFields({ view: thread.view }),
      fixupTarget: thread.fixupTarget,
    };
  }
  return {
    ...common,
    filePath: thread.filePath,
    position: clonePosition(thread.position),
    codeSnapshot: cloneCodeSnapshot(thread.codeSnapshot),
    ...viewFields(thread),
  };
}

function messagesMatch(left: DiffCommentMessage, right: DiffCommentMessage): boolean {
  if (left.id === right.id) {
    return true;
  }

  if (normalizeAuthor(left.author) !== normalizeAuthor(right.author)) {
    return false;
  }

  return (
    left.body === right.body &&
    left.createdAt === right.createdAt &&
    replyFieldsKey(left) === replyFieldsKey(right)
  );
}

function threadsMatch(left: DiffCommentThread, right: DiffCommentThread): boolean {
  if (left.id === right.id) {
    return true;
  }

  if (!samePlace(left, right)) {
    return false;
  }

  const leftRoot = left.messages[0];
  const rightRoot = right.messages[0];
  if (!leftRoot || !rightRoot) {
    return false;
  }

  return messagesMatch(leftRoot, rightRoot);
}

function sortReplies(left: DiffCommentMessage, right: DiffCommentMessage): number {
  const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }

  return left.id.localeCompare(right.id);
}

function pickNewerMessage(
  existingMessage: DiffCommentMessage,
  incomingMessage: DiffCommentMessage,
): DiffCommentMessage {
  if (incomingMessage.updatedAt.localeCompare(existingMessage.updatedAt) >= 0) {
    return cloneMessage(incomingMessage);
  }

  return cloneMessage(existingMessage);
}

function mergeThread(
  existingThread: DiffCommentThread,
  incomingThread: DiffCommentThread,
): DiffCommentThread {
  const mergedMessages = existingThread.messages.map(cloneMessage);

  for (const incomingMessage of incomingThread.messages) {
    const matchIndex = mergedMessages.findIndex((message) =>
      messagesMatch(message, incomingMessage),
    );
    if (matchIndex >= 0) {
      mergedMessages[matchIndex] = pickNewerMessage(mergedMessages[matchIndex], incomingMessage);
      continue;
    }

    mergedMessages.push(cloneMessage(incomingMessage));
  }

  const [rootMessage, ...replyMessages] = mergedMessages;
  const orderedMessages = rootMessage
    ? [rootMessage, ...replyMessages.sort(sortReplies)]
    : replyMessages.sort(sortReplies);
  const updatedAt = orderedMessages.reduce(
    (latest, message) => maxIsoTimestamp(latest, message.updatedAt),
    maxIsoTimestamp(existingThread.updatedAt, incomingThread.updatedAt),
  );

  const merged = {
    createdAt:
      existingThread.createdAt.localeCompare(incomingThread.createdAt) <= 0
        ? existingThread.createdAt
        : incomingThread.createdAt,
    updatedAt,
    messages: orderedMessages,
  };
  const view = existingThread.view ?? incomingThread.view;
  if (isOnCommit(existingThread)) {
    return { ...cloneThread(existingThread), ...merged, ...viewFields({ view }) };
  }
  return {
    ...cloneThread(existingThread),
    ...merged,
    codeSnapshot: cloneCodeSnapshot(
      (isOnCommit(incomingThread) ? undefined : incomingThread.codeSnapshot) ??
        existingThread.codeSnapshot,
    ),
    ...viewFields({ view, fixupTarget: existingThread.fixupTarget ?? incomingThread.fixupTarget }),
  };
}

export function mergeCommentThreads(
  existingThreads: DiffCommentThread[],
  incomingThreads: DiffCommentThread[],
): MergeCommentImportsResult {
  const threads = existingThreads.map(cloneThread);

  for (const incomingThread of incomingThreads) {
    const existingIndex = threads.findIndex((thread) => threadsMatch(thread, incomingThread));
    if (existingIndex < 0) {
      threads.push(cloneThread(incomingThread));
      continue;
    }

    threads[existingIndex] = mergeThread(threads[existingIndex], incomingThread);
  }

  return { threads, warnings: [] };
}

export function serializeCommentImports(commentImports: CommentImport[]): string {
  return JSON.stringify(
    commentImports.map((commentImport) => ({
      type: commentImport.type,
      id: commentImport.id,
      ...(isOnCommit(commentImport)
        ? { position: { scope: 'commit' } }
        : {
            filePath: commentImport.filePath,
            position: clonePosition(commentImport.position),
          }),
      body: commentImport.body,
      author: commentImport.author,
      createdAt: commentImport.createdAt,
      updatedAt: commentImport.updatedAt,
      codeSnapshot: isOnCommit(commentImport)
        ? undefined
        : cloneCodeSnapshot(commentImport.codeSnapshot),
      view: commentImport.view
        ? {
            baseCommitish: commentImport.view.baseCommitish,
            targetCommitish: commentImport.view.targetCommitish,
            baseMode: commentImport.view.baseMode,
          }
        : undefined,
      fixupTarget: commentImport.fixupTarget,
      ...(commentImport.type === 'reply' ? replyFields(commentImport) : {}),
    })),
  );
}

export function mergeCommentImports(
  existingThreads: DiffCommentThread[],
  commentImports: CommentImport[],
  takesReplies: (thread: DiffCommentThread) => boolean = () => true,
  isResolved: (thread: DiffCommentThread) => boolean = () => false,
): MergeCommentImportsResult {
  // Clone (don't shallow-copy) so appending a reply doesn't mutate the caller's
  // thread objects in place — otherwise the server can't detect the change and
  // skips the commentsChanged broadcast, leaving open browsers stale.
  const threads = existingThreads.map(cloneThread);
  const warnings: string[] = [];

  for (const commentImport of commentImports) {
    const now = new Date().toISOString();

    if (commentImport.type === 'thread') {
      const duplicate = threads.find((thread) => rootThreadMatchesImport(thread, commentImport));
      if (duplicate) {
        if (isResolved(duplicate)) {
          warnings.push(
            `Skipped thread import for ${placeLabel(commentImport)} because the same thread ${duplicate.id} is already resolved; nothing new was created.`,
          );
        }
        continue;
      }

      threads.push(createImportedThread(commentImport, now));
      continue;
    }

    const targetThreads = threads
      .filter((thread) => samePlace(thread, commentImport) && takesReplies(thread))
      .sort(sortByNewestThread);

    const targetThread = targetThreads.find((thread) => !isResolved(thread)) ?? targetThreads[0];
    if (!targetThread) {
      warnings.push(
        `Skipped reply import for ${placeLabel(commentImport)} because no matching thread was found.`,
      );
      continue;
    }

    const hasDuplicateReply = targetThread.messages.some((message) =>
      messageMatchesImport(message, commentImport, true),
    );
    if (hasDuplicateReply) {
      continue;
    }

    if (isResolved(targetThread)) {
      warnings.push(
        `Stored the reply for ${placeLabel(commentImport)} on thread ${targetThread.id}, which is resolved; no open thread matched.`,
      );
    }

    const importedReply = createImportedReply(commentImport, now);
    targetThread.messages = [...targetThread.messages, importedReply];
    targetThread.updatedAt = maxIsoTimestamp(targetThread.updatedAt, importedReply.updatedAt);
  }

  return { threads, warnings };
}
