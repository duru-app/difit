import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiffLine } from '../../types/diff';

import {
  directEditFailureMessage,
  fetchLinesAt,
  hunkRange,
  newSideLineNumbers,
  rangeOfLine,
  rangeShown,
  rewordFailureMessage,
} from './directEdit';

const lines: DiffLine[] = [
  { type: 'normal', content: 'a', oldLineNumber: 1, newLineNumber: 1 },
  { type: 'delete', content: 'old b', oldLineNumber: 2 },
  { type: 'add', content: 'b', newLineNumber: 2 },
  { type: 'add', content: 'c', newLineNumber: 3 },
];

const serveBlob = (bytes: Uint8Array, ok = true) =>
  vi.mocked(global.fetch).mockResolvedValue({
    ok,
    arrayBuffer: async () => bytes.slice().buffer,
  } as Response);

describe('direct edit ranges', () => {
  it('keeps only the lines of the reviewed commit', () => {
    expect([...newSideLineNumbers(lines)]).toEqual([1, 2, 3]);
  });

  it('gives up on a range when a line in it is not shown', () => {
    const shown = newSideLineNumbers(lines);
    expect(rangeShown(shown, { start: 2, end: 3 })).toBe(true);
    expect(rangeShown(shown, { start: 3, end: 4 })).toBe(false);
  });

  it('spans a hunk only when its lines follow on without a gap', () => {
    expect(hunkRange(newSideLineNumbers(lines))).toEqual({ start: 1, end: 3 });
    expect(hunkRange(new Set([1, 5]))).toBeNull();
    expect(hunkRange(new Set())).toBeNull();
  });

  it('spans a hunk too long to spread into Math.min', () => {
    const numbers = new Set(Array.from({ length: 200_000 }, (_, i) => i + 1));
    expect(hunkRange(numbers)).toEqual({ start: 1, end: 200_000 });
  });

  it('reads a thread line as a range', () => {
    expect(rangeOfLine(4)).toEqual({ start: 4, end: 4 });
    expect(rangeOfLine([4, 6])).toEqual({ start: 4, end: 6 });
  });
});

describe('fetchLinesAt', () => {
  afterEach(() => {
    vi.mocked(global.fetch).mockReset();
  });

  it('reads the lines from the blob at the reviewed commit', async () => {
    serveBlob(new TextEncoder().encode('one\ntwo\nthree\n'));

    expect(await fetchLinesAt('src/a b.ts', 'abc1234', { start: 2, end: 3 })).toEqual([
      'two',
      'three',
    ]);
    expect(global.fetch).toHaveBeenCalledWith('/api/blob/src%2Fa%20b.ts?ref=abc1234');
  });

  it('keeps the BOM and drops only the CR of each CRLF ending', async () => {
    serveBlob(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('one\r\ntwo\r\r\n')]));

    expect(await fetchLinesAt('a.ts', 'abc1234', { start: 1, end: 2 })).toEqual(['﻿one', 'two\r']);
  });

  it('gives up past the end of the file or when the blob cannot be read', async () => {
    serveBlob(new TextEncoder().encode('one\n'));
    expect(await fetchLinesAt('a.ts', 'abc1234', { start: 1, end: 2 })).toBeNull();

    serveBlob(new Uint8Array(), false);
    expect(await fetchLinesAt('a.ts', 'abc1234', { start: 1, end: 1 })).toBeNull();
  });
});

describe('directEditFailureMessage', () => {
  it('says an earlier edit may still sit on HEAD when nothing changes or lines clash', () => {
    expect(directEditFailureMessage('no-change', '')).toContain('HEAD에 남아 있을 수 있습니다');
    expect(directEditFailureMessage('conflict', '')).toContain('HEAD에 남아 있을 수 있습니다');
  });

  it('falls back to the server error when no reason is given', () => {
    expect(directEditFailureMessage(undefined, 'boom')).toBe('boom');
  });

  it('says the edit was committed unapproved when the card changed during the commit', () => {
    expect(directEditFailureMessage('card-changed', '', true)).toContain('fixup 커밋으로 남았지만');
    expect(directEditFailureMessage('card-changed', '')).toContain('카드를 다시 확인한 뒤 고쳐');
  });
});

describe('rewordFailureMessage', () => {
  it('names the branches a warning is about, after the warnings that name none', () => {
    expect(
      rewordFailureMessage('needs-confirmation', '', ['default-branch', 'branch-elsewhere'], {
        'branch-elsewhere': ['work2', 'rebasing'],
      }),
    ).toBe(
      '기본 브랜치의 이력이 바뀝니다. 다른 작업 폴더에서 쓰는 브랜치 work2, rebasing는 옮기지 않습니다. 옛 커밋에 남습니다.',
    );
  });

  it('says the default branch stays on the old commits and parts from the current branch', () => {
    expect(
      rewordFailureMessage('needs-confirmation', '', ['default-branch-left'], {
        'default-branch-left': ['main'],
      }),
    ).toBe('기본 브랜치 main는 옮기지 않습니다. 옛 커밋에 남아 지금 브랜치와 갈라집니다.');
  });

  it('asks to save again when a branch moved during the save', () => {
    expect(rewordFailureMessage('branch-moved', 'Reword refused: branch-moved')).toBe(
      '저장하는 동안 브랜치가 바뀌어 이력을 바꾸지 않았습니다. 다시 저장해 주세요.',
    );
  });

  it('names the force push a pushed commit will need', () => {
    expect(rewordFailureMessage('needs-confirmation', '', ['pushed-commit'])).toBe(
      'push한 커밋이 바뀝니다. 다시 올리려면 force push가 필요합니다.',
    );
  });

  it('says every warning when more than one applies', () => {
    const message = rewordFailureMessage('needs-confirmation', '', [
      'default-branch',
      'pushed-commit',
    ]);
    expect(message).toContain('기본 브랜치');
    expect(message).toContain('force push');
  });

  it('says the agent is at work', () => {
    expect(rewordFailureMessage('agent-working', '')).toContain('에이전트가 작업 중입니다.');
  });
});
