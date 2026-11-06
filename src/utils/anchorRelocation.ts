import type { AnchorStaleReason, DiffLineRange } from '../types/diff.js';

export interface ThreadAnchor {
  line: DiffLineRange;
  content: string;
}

export type AnchorRelocation =
  | { kind: 'located'; line: DiffLineRange }
  | { kind: 'stale'; reason: AnchorStaleReason };

const trimTrailingWhitespace = (line: string) => line.replace(/[ \t]+$/, '');

const splitContent = (content: string) =>
  content.replace(/\r\n/g, '\n').split('\n').map(trimTrailingWhitespace);

// Lines missing from `lines` (collapsed context) cannot contradict the anchor, so they pass.
export function noVisibleLineContradictsAnchor(
  anchor: ThreadAnchor,
  lines: ReadonlyMap<number, string>,
): boolean {
  const start = typeof anchor.line === 'number' ? anchor.line : anchor.line.start;
  return splitContent(anchor.content).every((content, offset) => {
    const current = lines.get(start + offset);
    return current === undefined || trimTrailingWhitespace(current) === content;
  });
}

// Moves only to an exact match that occurs exactly once; never fits by surrounding context. Only
// lines inside the range may be missing from `lines`; its first and last lines must match.
// At the anchor's own commit the stored line numbers are exact, so the stored position wins
// unless a visible line contradicts it.
export function relocateAnchor(
  anchor: ThreadAnchor,
  lines: ReadonlyMap<number, string>,
  atAnchorCommit = false,
): AnchorRelocation {
  if (atAnchorCommit && noVisibleLineContradictsAnchor(anchor, lines)) {
    return { kind: 'located', line: anchor.line };
  }

  const expected = splitContent(anchor.content);
  const matchesAt = (start: number) =>
    expected.every((content, offset) => {
      const current = lines.get(start + offset);
      if (current === undefined) return offset > 0 && offset < expected.length - 1;
      return trimTrailingWhitespace(current) === content;
    });

  const [start, ...others] = [...lines.keys()].filter(matchesAt);
  if (start === undefined) return { kind: 'stale', reason: 'missing' };
  if (others.length > 0) return { kind: 'stale', reason: 'ambiguous' };

  const line: DiffLineRange =
    typeof anchor.line === 'number' ? start : { start, end: start + expected.length - 1 };
  return { kind: 'located', line };
}
