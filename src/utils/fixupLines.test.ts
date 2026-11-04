import { describe, expect, it } from 'vitest';

import type { DiffCommentMessage, FixupLines } from '../types/diff';

import { currentFixupSha, withCurrentFixupShas } from './fixupLines';

const stored: FixupLines = {
  fixupSha: 'a'.repeat(40),
  patchId: 'patch-1',
  filePath: 'math.js',
  ranges: [{ side: 'new', line: 2, code: 'x' }],
};

const message = (fixupLines?: FixupLines): DiffCommentMessage => ({
  id: 'm',
  body: 'b',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...(fixupLines ? { fixupLines } : {}),
});

describe('currentFixupSha', () => {
  it('keeps the stored sha while the history still has it', () => {
    expect(
      currentFixupSha(stored, [
        { sha: 'b'.repeat(40), patchId: 'patch-1' },
        { sha: stored.fixupSha, patchId: 'patch-1' },
      ]),
    ).toBe(stored.fixupSha);
  });

  it('follows the patch id to the rebased commit', () => {
    expect(currentFixupSha(stored, [{ sha: 'b'.repeat(40), patchId: 'patch-1' }])).toBe(
      'b'.repeat(40),
    );
  });

  it('keeps the stored sha when nothing in the history matches', () => {
    expect(currentFixupSha(stored, [{ sha: 'b'.repeat(40), patchId: 'other' }])).toBe(
      stored.fixupSha,
    );
  });
});

describe('withCurrentFixupShas', () => {
  it('replaces the sha of replies on fixup lines and leaves the rest alone', () => {
    const thread = { messages: [message(), message(stored)] };
    const shown = withCurrentFixupShas(thread, [{ sha: 'b'.repeat(40), patchId: 'patch-1' }]);

    expect(shown.messages[0]).toBe(thread.messages[0]);
    expect(shown.messages[1]?.fixupLines?.fixupSha).toBe('b'.repeat(40));
    expect(thread.messages[1]?.fixupLines?.fixupSha).toBe(stored.fixupSha);
  });
});
