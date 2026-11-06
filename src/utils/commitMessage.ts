import { REVIEW_THREAD_TRAILER } from '../types/diff.js';

const THREAD_TRAILER_LINE = new RegExp(`^${REVIEW_THREAD_TRAILER}: `);
const TRAILER_LINE = /^[A-Za-z0-9-]+: \S/;

// As `git commit --cleanup=whitespace` leaves it: no trailing whitespace, no blank lines at either
// end, and no runs of blank lines.
function cleanCommitMessage(message: string): string {
  const lines = message
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd());
  return lines
    .filter((line, index) => line !== '' || lines[index - 1] !== '')
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

export function withoutThreadTrailers(message: string): string {
  return cleanCommitMessage(
    message
      .split('\n')
      .filter((line) => !THREAD_TRAILER_LINE.test(line))
      .join('\n'),
  );
}

export function threadIdsOf(message: string): string[] {
  return message
    .split('\n')
    .filter((line) => THREAD_TRAILER_LINE.test(line))
    .map((line) => line.replace(THREAD_TRAILER_LINE, '').trim());
}

export function withThreadTrailer(message: string, threadId: string): string {
  const trailer = `${REVIEW_THREAD_TRAILER}: ${threadId}`;
  const paragraphs = message.split('\n\n');
  const last = paragraphs.at(-1) ?? '';
  const endsWithTrailers =
    paragraphs.length > 1 && last.split('\n').every((line) => TRAILER_LINE.test(line));
  return `${message}${endsWithTrailers ? '\n' : '\n\n'}${trailer}`;
}
