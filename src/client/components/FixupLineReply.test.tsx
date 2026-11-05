import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  CommentThread,
  DiffChunk as DiffChunkData,
  FixupLines,
  ThreadFixup,
} from '../../types/diff';
import {
  EMPTY_FIXUP_OVERLAY,
  FixupOverlayProvider,
  type FixupOverlayState,
} from '../contexts/FixupOverlayContext';
import { WordHighlightProvider } from '../contexts/WordHighlightContext';
import { boxesByAnchor, type FixupBox } from '../utils/fixupSpread';

import { CommentThreadCard } from './CommentThreadCard';
import { DiffChunk } from './DiffChunk';

const noop = () => {};
const asyncNoop = async () => {};

const chunk: DiffChunkData = {
  header: '@@ -10,3 +10,3 @@',
  oldStart: 10,
  oldLines: 3,
  newStart: 10,
  newLines: 3,
  lines: [
    {
      type: 'normal',
      content: 'const first = 1;',
      oldLineNumber: 10,
      newLineNumber: 10,
    },
    {
      type: 'normal',
      content: 'const second = 2;',
      oldLineNumber: 11,
      newLineNumber: 11,
    },
    { type: 'add', content: 'const third = 3;', newLineNumber: 12 },
  ],
};

const thread: CommentThread = {
  id: 't1',
  file: 'src/example.ts',
  line: 12,
  side: 'new',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  codeContent: 'const third = 3;',
  messages: [
    {
      id: 'm1',
      body: 'Rename this',
      author: 'User',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
};

const fixup: ThreadFixup = {
  sha: 'abc1234abc1234',
  shortSha: 'abc1234',
  patchId: 'patch-abc1234',
  authoredAt: '2026-01-01T00:00:00Z',
  subject: 'fixup! x',
  threadIds: ['t1'],
  files: [
    {
      path: 'src/example.ts',
      status: 'modified',
      chunks: [
        {
          header: '@@ -11,3 +11,3 @@',
          oldStart: 11,
          oldLines: 3,
          newStart: 11,
          newLines: 3,
          lines: [
            {
              type: 'normal',
              content: 'const second = 2;',
              oldLineNumber: 11,
              newLineNumber: 11,
            },
            { type: 'delete', content: 'const third = 3;', oldLineNumber: 12 },
            { type: 'add', content: 'const three = 3;', newLineNumber: 12 },
            {
              type: 'normal',
              content: 'const fourth = 4;',
              oldLineNumber: 13,
              newLineNumber: 13,
            },
          ],
        },
      ],
    },
  ],
};

const view = (
  overlay: Partial<FixupOverlayState>,
  { threads = [thread], filename = 'src/example.ts' } = {},
) => (
  <WordHighlightProvider>
    <FixupOverlayProvider
      value={{
        ...EMPTY_FIXUP_OVERLAY,
        targetCommit: 'b7c2e10',
        enabled: true,
        fixupsByThread: new Map([['t1', [fixup]]]),
        ...overlay,
      }}
    >
      <DiffChunk
        chunk={chunk}
        chunkIndex={0}
        threads={threads}
        mode="unified"
        onAddComment={asyncNoop}
        onResolveThread={noop}
        onReplyToThread={asyncNoop}
        onRemoveMessage={noop}
        onUpdateMessage={noop}
        filename={filename}
      />
    </FixupOverlayProvider>
  </WordHighlightProvider>
);

const numberCells = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('[data-line-number-cell]'),
];

const pressNumber = (cell: HTMLElement, init: MouseEventInit = {}) => {
  fireEvent.mouseDown(cell, { button: 0, ...init });
  fireEvent.mouseUp(document);
  fireEvent.click(cell, init);
};

const replyIn = async (container: HTMLElement, body: string) => {
  const textarea = await within(container).findByPlaceholderText('이 줄에 답글...');
  fireEvent.change(textarea, { target: { value: body } });
  fireEvent.click(within(container).getByRole('button', { name: /답글/ }));
};

describe('replying on lines of a fixup card', () => {
  it('opens a reply right below the picked line and saves it with the line on the thread', async () => {
    const replyToThread = vi.fn().mockResolvedValue(undefined);
    render(view({ replyToThread }));
    const card = screen.getByTestId('fixup-overlay-card');
    const added = numberCells(card)[2]!;

    pressNumber(added);

    const form = await within(card).findByRole('form', {
      name: /fixup 줄에 답글/,
    });
    const rows = [...card.querySelectorAll('tr')];
    expect(rows.indexOf(form.closest('tr')!)).toBe(rows.indexOf(added.closest('tr')!) + 1);
    expect(form).toHaveTextContent('abc1234 · example.ts · 수정 후 L12');

    await replyIn(form, '이 이름은 왜?');

    await waitFor(() =>
      expect(replyToThread).toHaveBeenCalledWith('t1', '이 이름은 왜?', {
        fixupLines: {
          fixupSha: 'abc1234abc1234',
          patchId: 'patch-abc1234',
          filePath: 'src/example.ts',
          ranges: [{ side: 'new', line: 12, code: 'const three = 3;' }],
        },
      }),
    );
    await waitFor(() => expect(within(card).queryByRole('form')).toBeNull());
  });

  it('takes a deleted line and an added line dragged over together, each on its side', async () => {
    const replyToThread = vi.fn().mockResolvedValue(undefined);
    render(view({ replyToThread }));
    const card = screen.getByTestId('fixup-overlay-card');
    const [, deleted, added] = numberCells(card);

    fireEvent.mouseDown(deleted!, { button: 0 });
    fireEvent.mouseEnter(added!.closest('tr')!);
    fireEvent.mouseUp(document);

    const form = await within(card).findByRole('form', {
      name: /fixup 줄에 답글/,
    });
    expect(form).toHaveTextContent('지운 줄 L12 · 수정 후 L12');
    await replyIn(form, '둘 다');

    await waitFor(() =>
      expect(replyToThread).toHaveBeenCalledWith(
        't1',
        '둘 다',
        expect.objectContaining({
          fixupLines: expect.objectContaining({
            ranges: [
              { side: 'old', line: 12, code: 'const third = 3;' },
              { side: 'new', line: 12, code: 'const three = 3;' },
            ],
          }),
        }),
      ),
    );
  });

  it('adds the lines dragged over with Ctrl held to the lines already picked', async () => {
    render(view({ replyToThread: vi.fn() }));
    const card = screen.getByTestId('fixup-overlay-card');
    const [first, , added, last] = numberCells(card);

    pressNumber(first!, { ctrlKey: true });
    await within(card).findByRole('form', { name: /fixup 줄에 답글/ });
    fireEvent.change(within(card).getByRole('textbox'), { target: { value: '이어서' } });

    fireEvent.mouseDown(added!, { button: 0, ctrlKey: true });
    fireEvent.mouseEnter(last!.closest('tr')!);
    expect(added!.closest('tr')).toHaveClass('comment-selected');
    expect(last!.closest('tr')).toHaveClass('comment-selected');
    fireEvent.mouseUp(document);

    await waitFor(() =>
      expect(within(card).getByRole('form')).toHaveTextContent('수정 후 L11-L13'),
    );
    expect(first!.closest('tr')).toHaveClass('comment-selected');
    expect(within(card).getByRole('textbox')).toHaveValue('이어서');
  });

  it('marks the lines under a drag before the button is released', () => {
    render(view({ replyToThread: vi.fn().mockResolvedValue(undefined) }));
    const card = screen.getByTestId('fixup-overlay-card');
    const [first, deleted, added, last] = numberCells(card);

    fireEvent.mouseDown(deleted!, { button: 0 });
    fireEvent.mouseEnter(added!.closest('tr')!);

    expect(deleted!.closest('tr')).toHaveClass('comment-selected');
    expect(added!.closest('tr')).toHaveClass('comment-selected');
    expect(first!.closest('tr')).not.toHaveClass('comment-selected');
    expect(last!.closest('tr')).not.toHaveClass('comment-selected');
    expect(within(card).queryByRole('form')).not.toBeInTheDocument();
  });

  it('grows the pick with Shift and closes it on a second press of the same line', async () => {
    render(view({ replyToThread: vi.fn() }));
    const card = screen.getByTestId('fixup-overlay-card');
    const [first, , added, last] = numberCells(card);

    pressNumber(added!);
    await within(card).findByRole('form', { name: /fixup 줄에 답글/ });
    fireEvent.change(within(card).getByRole('textbox'), {
      target: { value: '이 줄에 남길 말' },
    });
    pressNumber(last!, { shiftKey: true });

    await waitFor(() =>
      expect(within(card).getByRole('form')).toHaveTextContent('수정 후 L12-L13'),
    );
    expect(within(card).getByRole('textbox')).toHaveValue('이 줄에 남길 말');

    pressNumber(first!);
    await waitFor(() => expect(within(card).getByRole('form')).toHaveTextContent('수정 후 L11'));
    expect(within(card).getByRole('textbox')).toHaveValue('이 줄에 남길 말');
    pressNumber(first!);
    await waitFor(() => expect(within(card).queryByRole('form')).toBeNull());

    pressNumber(added!);
    await within(card).findByRole('form', { name: /fixup 줄에 답글/ });
    expect(within(card).getByRole('textbox')).toHaveValue('');
  });

  it('empties the reply after Escape closes the pick', async () => {
    render(view({ replyToThread: vi.fn() }));
    const card = screen.getByTestId('fixup-overlay-card');
    const [first, , added] = numberCells(card);

    pressNumber(added!);
    await within(card).findByRole('form', { name: /fixup 줄에 답글/ });
    const textbox = within(card).getByRole('textbox');
    fireEvent.change(textbox, { target: { value: '취소할 말' } });
    fireEvent.keyDown(textbox, { key: 'Escape' });
    await waitFor(() => expect(within(card).queryByRole('form')).toBeNull());

    pressNumber(first!);
    await within(card).findByRole('form', { name: /fixup 줄에 답글/ });
    expect(within(card).getByRole('textbox')).toHaveValue('');
  });

  it('adds one line at a time with the add button, for screens without Shift', async () => {
    render(view({ replyToThread: vi.fn() }));
    const card = screen.getByTestId('fixup-overlay-card');
    const [first, , , last] = numberCells(card);

    pressNumber(first!);
    const form = await within(card).findByRole('form', {
      name: /fixup 줄에 답글/,
    });
    fireEvent.click(within(form).getByRole('button', { name: '줄 더하기' }));
    pressNumber(last!);

    await waitFor(() =>
      expect(within(card).getByRole('form')).toHaveTextContent('수정 후 L11, L13'),
    );
  });

  it('opens the thread again when the reply lands on a resolved one', async () => {
    const replyToThread = vi.fn().mockResolvedValue(undefined);
    const recordDecision = vi.fn();
    render(
      view({
        replyToThread,
        recordDecision,
        decisions: [
          {
            threadId: 't1',
            kind: 'resolved',
            fixupSha: '',
            at: '2026-01-02T00:00:00Z',
          },
        ],
      }),
    );
    const card = screen.getByTestId('fixup-overlay-card');

    pressNumber(numberCells(card)[2]!);
    await replyIn(await within(card).findByRole('form'), '다시 봐 주세요');

    await waitFor(() => expect(recordDecision).toHaveBeenCalledWith('t1', 'unresolved', ''));
  });

  it('marks every line of the card for the way back from a reply', () => {
    render(view({ replyToThread: vi.fn() }));
    const card = screen.getByTestId('fixup-overlay-card');

    expect(card.querySelectorAll('tr[id]')).toHaveLength(4);
  });
});

describe('replying on lines of a fixup box in another file', () => {
  const answered = { id: 't1', file: 'src/example.ts', line: 12 };
  const second = {
    id: 't2',
    file: 'src/other.ts',
    line: [3, 5] as [number, number],
  };
  const box = (threads: FixupBox['threads']): FixupBox => {
    const file: FixupBox['file'] = {
      path: 'src/caller.ts',
      oldPath: 'src/call.ts',
      status: 'renamed',
      chunks: [
        {
          header: '@@ -11,1 +11,1 @@',
          oldStart: 11,
          oldLines: 1,
          newStart: 11,
          newLines: 1,
          lines: [
            { type: 'delete', content: 'const second = 2;', oldLineNumber: 11 },
            {
              type: 'add',
              content: 'const second = three - 1;',
              newLineNumber: 11,
            },
          ],
        },
      ],
    };
    return {
      fixup: { ...fixup, files: [file] },
      threads,
      file,
      chunk: file.chunks[0]!,
      chunkIndex: 0,
      anchor: 11,
    };
  };
  const renderBox = (boxed: FixupBox, overlay: Partial<FixupOverlayState>) =>
    render(
      view(
        {
          boxesByFile: new Map([['src/caller.ts', boxesByAnchor([boxed])]]),
          ...overlay,
        },
        { threads: [], filename: 'src/caller.ts' },
      ),
    );

  it('replies on the comment the box names, with the old path of a renamed file', async () => {
    const replyToThread = vi.fn().mockResolvedValue(undefined);
    renderBox(box([answered]), { replyToThread });
    const fileBox = screen.getByTestId('fixup-file-box');

    pressNumber(numberCells(fileBox)[0]!);
    const form = await within(fileBox).findByRole('form', {
      name: /fixup 줄에 답글/,
    });
    expect(within(form).queryByRole('combobox')).toBeNull();
    await replyIn(form, '이것도?');

    await waitFor(() =>
      expect(replyToThread).toHaveBeenCalledWith('t1', '이것도?', {
        fixupLines: {
          fixupSha: 'abc1234abc1234',
          patchId: 'patch-abc1234',
          filePath: 'src/caller.ts',
          oldPath: 'src/call.ts',
          ranges: [{ side: 'old', line: 11, code: 'const second = 2;' }],
        },
      }),
    );
  });

  it('lets the reviewer pick which comment takes the reply when the box names several', async () => {
    const replyToThread = vi.fn().mockResolvedValue(undefined);
    renderBox(box([answered, second]), { replyToThread });
    const fileBox = screen.getByTestId('fixup-file-box');

    pressNumber(numberCells(fileBox)[1]!);
    const form = await within(fileBox).findByRole('form', {
      name: /fixup 줄에 답글/,
    });
    const chooser = within(form).getByRole('combobox', {
      name: '답글을 달 지적',
    });
    expect(
      within(chooser)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['src/example.ts:12', 'src/other.ts:3-5']);
    fireEvent.change(chooser, { target: { value: 't2' } });
    await replyIn(form, '이쪽 지적에');

    await waitFor(() =>
      expect(replyToThread).toHaveBeenCalledWith('t2', '이쪽 지적에', expect.anything()),
    );
  });

  it('names a comment on a whole commit by its commit when the box names several', async () => {
    const onCommit = {
      id: 't3',
      commit: 'c'.repeat(40),
      fixupCommit: { shortSha: 'ccccccc', subject: 'split this' },
      isOutdated: false as const,
    };
    const replyToThread = vi.fn().mockResolvedValue(undefined);
    renderBox(box([answered, onCommit]), { replyToThread });
    const fileBox = screen.getByTestId('fixup-file-box');

    pressNumber(numberCells(fileBox)[1]!);
    const form = await within(fileBox).findByRole('form', {
      name: /fixup 줄에 답글/,
    });
    const chooser = within(form).getByRole('combobox', {
      name: '답글을 달 지적',
    });

    expect(
      within(chooser)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['src/example.ts:12', '커밋 ccccccc split this']);
  });
});

describe('the place a reply on fixup lines points at', () => {
  const fixupLines: FixupLines = {
    fixupSha: 'abc1234abc1234',
    patchId: 'patch-abc1234',
    filePath: 'src/example.ts',
    ranges: [
      { side: 'old', line: 12, code: 'const third = 3;' },
      {
        side: 'new',
        line: [12, 13],
        code: 'const three = 3;\nconst fourth = 4;',
      },
    ],
  };
  const replied: CommentThread = {
    ...thread,
    messages: [
      ...thread.messages,
      {
        id: 'm2',
        body: '이 줄은 왜?',
        author: 'User',
        createdAt: '2026-01-02T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        fixupLines,
      },
    ],
  };

  const reachable = new Set([`${fixup.sha}:src/example.ts`]);
  const renderReplied = (overlay: Partial<FixupOverlayState>) => {
    const revealFixupLines = vi.fn();
    render(
      <FixupOverlayProvider
        value={{
          ...EMPTY_FIXUP_OVERLAY,
          revealFixupLines,
          enabled: true,
          fixupsLoaded: true,
          reachableFixupFiles: reachable,
          ...overlay,
        }}
      >
        <CommentThreadCard
          thread={replied}
          onResolveThread={noop}
          onReplyToThread={asyncNoop}
          onRemoveMessage={noop}
          onUpdateMessage={noop}
        />
      </FixupOverlayProvider>,
    );
    return revealFixupLines;
  };
  const placeName = 'abc1234 · example.ts · 지운 줄 L12 · 수정 후 L12-L13';
  const byThread = new Map([['t1', [fixup]]]);
  const click = (name: string) => {
    const place = screen.getByRole('button', { name });
    act(() => fireEvent.click(place));
    return place;
  };

  it('shows above the reply and goes to those lines of the card', () => {
    const revealFixupLines = renderReplied({ fixupsByThread: byThread });

    const place = click(placeName);

    expect(place).toHaveAttribute('title', 'src/example.ts');
    expect(revealFixupLines).toHaveBeenCalledWith(fixupLines, 't1');
  });

  it('says why it cannot go when the fixups are not drawn over the diff', () => {
    const revealFixupLines = renderReplied({
      enabled: false,
      fixupsByThread: byThread,
    });

    const place = click(`${placeName}, 수정을 겹쳐 보기를 켜면 갈 수 있습니다`);

    expect(place).toHaveAttribute('aria-disabled', 'true');
    expect(place).toHaveAttribute(
      'title',
      'src/example.ts\n수정을 겹쳐 보기를 켜면 갈 수 있습니다',
    );
    expect(revealFixupLines).not.toHaveBeenCalled();
  });

  it('says why it cannot go when the fixup is no longer in the history', () => {
    const revealFixupLines = renderReplied({
      fixupsByThread: new Map([['t2', [{ ...fixup, sha: 'other', patchId: 'other' }]]]),
    });

    click(`${placeName}, 지금 이력에 없는 fixup이라 갈 곳이 없습니다`);

    expect(revealFixupLines).not.toHaveBeenCalled();
  });

  it('says a rejected fixup is not shown, even with the overlay on', () => {
    const revealFixupLines = renderReplied({
      fixupsByThread: byThread,
      reachableFixupFiles: new Set(),
      decisions: [
        {
          threadId: 't1',
          kind: 'rejected',
          fixupSha: fixup.sha,
          at: '2026-01-03T00:00:00Z',
        },
      ] as FixupOverlayState['decisions'],
    });

    click(`${placeName}, 거절한 fixup은 겹쳐 보기에 나오지 않아 갈 수 없습니다`);

    expect(revealFixupLines).not.toHaveBeenCalled();
  });

  const rejectedFixup = [
    { threadId: 't1', kind: 'rejected', fixupSha: fixup.sha, at: '2026-01-03T00:00:00Z' },
  ] as FixupOverlayState['decisions'];
  const rejectedName = `${placeName}, 거절한 fixup은 겹쳐 보기에 나오지 않아 갈 수 없습니다`;

  it('says the fixup was rejected after another fixup replaced it', () => {
    const replacement = { ...fixup, sha: 'def5678def5678' };
    renderReplied({
      fixupsByThread: new Map([['t1', [fixup, replacement]]]),
      reachableFixupFiles: new Set(),
      decisions: rejectedFixup,
    });

    click(rejectedName);
  });

  it.each([{ enabled: true }, { enabled: false }])(
    'says a fixup is rejected while a part of the review is shown (overlay $enabled)',
    ({ enabled }) => {
      const revealFixupLines = renderReplied({
        enabled,
        fixupsByThread: byThread,
        reachableFixupFiles: null,
        decisions: rejectedFixup,
      });

      click(rejectedName);

      expect(revealFixupLines).not.toHaveBeenCalled();
    },
  );

  it('says a fixup that is in the history but not drawn is not shown', () => {
    renderReplied({ fixupsByThread: byThread, reachableFixupFiles: new Set() });

    click(`${placeName}, 이 fixup은 겹쳐 보기에 나오지 않아 갈 수 없습니다`);
  });

  it('keeps the link live until the fixups are loaded', () => {
    const revealFixupLines = renderReplied({
      fixupsLoaded: false,
      fixupsByThread: new Map(),
      reachableFixupFiles: new Set(),
    });

    const place = click(placeName);

    expect(place).not.toHaveAttribute('aria-disabled');
    expect(revealFixupLines).toHaveBeenCalledWith(fixupLines, 't1');
  });

  it('keeps the link live while a part of the review is shown', () => {
    const revealFixupLines = renderReplied({
      fixupsByThread: byThread,
      reachableFixupFiles: null,
    });

    click(placeName);

    expect(revealFixupLines).toHaveBeenCalledWith(fixupLines, 't1');
  });

  it('still finds a fixup that a rebase gave a new sha', () => {
    const rebased = { ...fixup, sha: 'def5678def5678' };
    const revealFixupLines = renderReplied({
      fixupsByThread: new Map([['t1', [rebased]]]),
      reachableFixupFiles: new Set([`${rebased.sha}:src/example.ts`]),
    });

    click('def5678 · example.ts · 지운 줄 L12 · 수정 후 L12-L13');

    expect(revealFixupLines).toHaveBeenCalledWith(fixupLines, 't1');
  });
});
