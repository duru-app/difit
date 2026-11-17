import type {
  BaseMode,
  Comment,
  CommentThread,
  DiffCommentMessage,
  DiffSide,
  LineNumber,
  ShownThread,
  SidedLine,
  ThreadReviewState,
} from '../types/diff';

import { commitLocationLabel, coversBothSides, sidedRangesLabel } from './commentPosition.js';
import { reviewStateLabel } from './reviewDecisions.js';
import { hasSuggestionBlock, parseSuggestionBlocks } from './suggestionUtils.js';

const spanInfo = (line: LineNumber) =>
  typeof line === 'number' ? `L${line}` : `L${line[0]}-L${line[1]}`;

function getLineInfo(
  line: LineNumber | undefined,
  side: DiffSide,
  extraLines: readonly SidedLine[] = [],
): string {
  if (line === undefined) return '';
  return `:${sidedRangesLabel([...extraLines, { side, line }], spanInfo)}`;
}

export interface CommentPromptDiffContext {
  requestedBaseCommitish?: string;
  requestedTargetCommitish?: string;
  baseMode?: BaseMode;
  resolvedBaseCommitish?: string;
  resolvedTargetCommitish?: string;
}

function formatCommentLocation(
  file: string,
  line: LineNumber | undefined,
  side?: DiffSide,
  reviewState?: ThreadReviewState,
  extraLines?: readonly SidedLine[],
): string {
  const filePath = file || '<unknown file>';
  const stateSuffix = reviewState ? ` [${reviewStateLabel(reviewState)}]` : '';
  const oldSuffix = side === 'old' && !coversBothSides(side, extraLines) ? ' (old)' : '';
  return `${filePath}${getLineInfo(line, side ?? 'new', extraLines)}${oldSuffix}${stateSuffix}`;
}

function isNonRangeCommitish(commitish: string): boolean {
  return (
    commitish === 'working' || commitish === 'staged' || commitish === '.' || commitish === 'stdin'
  );
}

function formatDiffContextHeader(context: CommentPromptDiffContext): string | null {
  const { requestedBaseCommitish, requestedTargetCommitish } = context;
  if (
    !requestedBaseCommitish ||
    !requestedTargetCommitish ||
    isNonRangeCommitish(requestedBaseCommitish) ||
    isNonRangeCommitish(requestedTargetCommitish)
  ) {
    return null;
  }

  const separator = context.baseMode === 'merge-base' ? '...' : '..';
  const requestedRange = `${requestedBaseCommitish}${separator}${requestedTargetCommitish}`;
  const { resolvedBaseCommitish, resolvedTargetCommitish } = context;
  const resolvedRange =
    resolvedBaseCommitish &&
    resolvedTargetCommitish &&
    (resolvedBaseCommitish !== requestedBaseCommitish ||
      resolvedTargetCommitish !== requestedTargetCommitish)
      ? ` (${resolvedBaseCommitish}${separator}${resolvedTargetCommitish})`
      : '';

  return `diff ${requestedRange}${resolvedRange}`;
}

export function formatCommentContent(body: string, codeContent?: string): string {
  if (hasSuggestionBlock(body)) {
    const suggestions = parseSuggestionBlocks(body);
    if (suggestions.length > 0) {
      let result = '';
      let lastIndex = 0;

      for (const suggestion of suggestions) {
        const textBefore = body.slice(lastIndex, suggestion.startIndex).trim();
        if (textBefore) {
          result += `${result ? '\n' : ''}${textBefore}`;
        }

        if (codeContent) {
          result += `${result ? '\n' : ''}ORIGINAL:\n\`\`\`\n${codeContent}\n\`\`\``;
        }
        result += `${result ? '\n' : ''}SUGGESTED:\n\`\`\`\n${suggestion.suggestedCode}\n\`\`\``;
        lastIndex = suggestion.endIndex;
      }

      const textAfter = body.slice(lastIndex).trim();
      if (textAfter) {
        result += `${result ? '\n' : ''}${textAfter}`;
      }

      return result;
    }
  }

  return body;
}

function formatChoices(message: DiffCommentMessage, messages: DiffCommentMessage[]): string[] {
  const lines = (message.choices ?? []).flatMap((choice) => {
    const head = `- ${choice.id}${choice.recommended ? ' (recommended)' : ''}: ${choice.name}`;
    const preview = choice.preview
      ? [
          `  ${choice.preview.label ? `preview (${choice.preview.label})` : 'preview'}:`,
          ...choice.preview.text.split('\n').map((line) => `    ${line}`),
        ]
      : [];
    return [choice.description ? `${head} — ${choice.description}` : head, ...preview];
  });
  if (lines.length > 0) lines.unshift('Choices:');
  const { answer } = message;
  if (answer) {
    const asked = messages.findIndex((candidate) => candidate.id === answer.messageId);
    lines.push(`Picked ${answer.choice}${asked > 0 ? ` from Reply ${asked}` : ''}`);
  }
  return lines;
}

function formatFixupLines({ fixupLines }: DiffCommentMessage): string[] {
  if (!fixupLines) return [];
  const { fixupSha, filePath, oldPath, ranges } = fixupLines;
  return ranges.flatMap(({ side, line, code }) => [
    `On fixup ${fixupSha.slice(0, 7)} ${side === 'old' ? (oldPath ?? filePath) : filePath} ${spanInfo(line)} (${side}):`,
    ...code.split('\n').map((codeLine) => `  ${codeLine}`),
  ]);
}

function normalizeLegacyComment(comment: Comment): CommentThread {
  return {
    id: comment.id,
    file: comment.file,
    line: comment.line,
    side: comment.side,
    createdAt: comment.timestamp,
    updatedAt: comment.timestamp,
    codeContent: comment.codeContent,
    messages: [
      {
        id: comment.id,
        body: comment.body,
        author: comment.author,
        createdAt: comment.timestamp,
        updatedAt: comment.timestamp,
      },
    ],
  };
}

export function formatCommentPrompt(
  file: string,
  line: LineNumber,
  body: string,
  codeContent?: string,
  side?: DiffSide,
): string {
  return `${formatCommentLocation(file, line, side)}\n${formatCommentContent(body, codeContent)}`;
}

export function formatAllCommentsPrompt(comments: Comment[]): string {
  if (comments.length === 0) return '';

  const prompts = comments.map((comment) =>
    formatCommentPrompt(
      comment.file,
      comment.line,
      comment.body,
      comment.codeContent,
      comment.side,
    ),
  );

  return prompts.join('\n=====\n');
}

const wasEdited = ({ createdAt, updatedAt }: DiffCommentMessage): boolean =>
  (Date.parse(updatedAt) || 0) > (Date.parse(createdAt) || 0);

interface PromptOptions {
  showEdits?: boolean;
  // Says so under the location when the thread's code is no longer where it was commented.
  showOutdated?: boolean;
}

export function formatCommentThreadPrompt(
  thread: ShownThread,
  reviewState?: ThreadReviewState,
  { showEdits = false, showOutdated = false }: PromptOptions = {},
): string {
  const onFile = 'file' in thread;
  const sections: string[] = [
    onFile
      ? formatCommentLocation(thread.file, thread.line, thread.side, reviewState, thread.extraLines)
      : `${commitLocationLabel(thread)}${reviewState ? ` [${reviewStateLabel(reviewState)}]` : ''}`,
  ];
  if (showOutdated && thread.isOutdated) {
    sections.push(
      thread.outdatedReason === 'ambiguous'
        ? '바뀐 줄: 지적을 단 코드가 지금 diff 의 여러 곳에 있다. 위 줄 번호는 지적을 단 때의 것이다.'
        : '바뀐 줄: 지적을 단 코드가 지금 diff 에 없다. 위 줄 번호는 지적을 단 때의 것이다.',
    );
  }
  if (onFile && thread.fixupCommit) {
    const { shortSha, subject } = thread.fixupCommit;
    sections.push(`고쳐 넣을 커밋: ${subject ? `${shortSha} ${subject}` : shortSha}`);
  }

  thread.messages.forEach((message, index) => {
    if (index > 0) {
      sections.push(`Reply ${index} (${message.author?.trim() || 'Unknown'})`);
    }
    if (showEdits && wasEdited(message)) sections.push(`고친 시각: ${message.updatedAt}`);
    sections.push(
      formatCommentContent(message.body, onFile ? thread.codeContent : undefined),
      ...formatFixupLines(message),
      ...formatChoices(message, thread.messages),
    );
  });

  return sections.filter(Boolean).join('\n');
}

export function formatAllCommentThreadsPrompt(
  threads: ShownThread[],
  context?: CommentPromptDiffContext,
  reviewStates?: ReadonlyMap<string, ThreadReviewState>,
  options?: PromptOptions,
): string {
  if (threads.length === 0) return '';

  const sections = threads.map((thread) =>
    formatCommentThreadPrompt(thread, reviewStates?.get(thread.id), options),
  );
  if (context) {
    const header = formatDiffContextHeader(context);
    if (header) {
      sections.unshift(header);
    }
  }

  return sections.join('\n=====\n');
}

export function formatCommentsOutput(
  input: Comment[] | ShownThread[],
  reviewStates?: ReadonlyMap<string, ThreadReviewState>,
  heading = '📝 Comments from review session:',
): string {
  const threads = input.map((item) => ('messages' in item ? item : normalizeLegacyComment(item)));
  const allPrompts = formatAllCommentThreadsPrompt(threads, undefined, reviewStates, {
    showEdits: true,
    showOutdated: true,
  });

  return [
    `\n${heading}`,
    '='.repeat(50),
    allPrompts,
    '='.repeat(50),
    `Total comments: ${threads.length}\n`,
  ].join('\n');
}
