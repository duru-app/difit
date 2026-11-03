import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useEffect, useState, type ComponentProps } from 'react';
import { HotkeysProvider, useHotkeysContext } from 'react-hotkeys-hook';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommentThread } from '../../types/diff';
import type { CommentPanelStatus } from '../../utils/reviewDecisions';

import { CommentsPanel, type CommentsPanelFilter, type CommentsPanelHandle } from './CommentsPanel';

const thread = (
  id: string,
  file: string,
  line: CommentThread['line'],
  body: string,
  createdAt = '2024-01-01T00:00:00Z',
): CommentThread => ({
  id,
  file,
  line,
  side: 'new',
  createdAt,
  updatedAt: createdAt,
  messages: [
    { id, body, author: 'User', createdAt, updatedAt: createdAt },
    {
      id: `${id}-reply`,
      body: `Reply to ${id}`,
      author: 'Agent',
      createdAt,
      updatedAt: createdAt,
    },
  ],
});

const THREADS = [
  thread('b5', 'src/b.ts', 5, 'On b five'),
  thread('a20-late', 'src/a.ts', 20, 'On a twenty, later', '2024-01-02T00:00:00Z'),
  thread('a3', 'src/a.ts', [3, 8], 'On a three to eight'),
  thread('a20', 'src/a.ts', 20, 'On a twenty'),
];

const STATUSES = new Map<string, CommentPanelStatus>([
  ['b5', 'open'],
  ['a20-late', 'resolved'],
  ['a3', 'answered'],
  ['a20', 'open'],
]);

type PanelProps = ComponentProps<typeof CommentsPanel>;

function ScopeOff() {
  const { disableScope } = useHotkeysContext();
  useEffect(() => disableScope('navigation'), [disableScope]);
  return null;
}

type HarnessProps = Partial<PanelProps> & {
  initialFilter?: CommentsPanelFilter;
  navigationOff?: boolean;
};

function Harness({ initialFilter = 'remaining', navigationOff = false, ...props }: HarnessProps) {
  const [filter, setFilter] = useState<CommentsPanelFilter>(initialFilter);
  return (
    <HotkeysProvider initiallyActiveScopes={['navigation']}>
      {navigationOff && <ScopeOff />}
      <CommentsPanel
        threads={THREADS}
        statusById={STATUSES}
        resolvedThreadIds={new Set(['a20-late'])}
        filter={filter}
        onFilterChange={setFilter}
        pickedThreadId={null}
        onPick={vi.fn()}
        onResolveThread={vi.fn()}
        onClose={vi.fn()}
        {...props}
      />
    </HotkeysProvider>
  );
}

const rowLabels = () =>
  within(screen.getByLabelText('코멘트 목록'))
    .queryAllByRole('button')
    .map((row) => row.querySelector('[title]')?.textContent);

const renderFocused = (props: HarnessProps = {}) => {
  const ref = createRef<CommentsPanelHandle>();
  const result = render(<Harness ref={ref} {...props} />);
  act(() => ref.current!.focus());
  return { ...result, ref };
};

describe('CommentsPanel', () => {
  const documentKeys: string[] = [];
  const recordKey = (event: KeyboardEvent) => documentKeys.push(event.key);

  beforeEach(() => {
    documentKeys.length = 0;
    document.addEventListener('keydown', recordKey);
  });

  afterEach(() => {
    document.removeEventListener('keydown', recordKey);
  });

  it('lists comments by file, then line, then the time they were made', async () => {
    render(<Harness initialFilter="all" />);

    expect(rowLabels()).toEqual(['a.ts:3-8', 'a.ts:20', 'a.ts:20', 'b.ts:5']);
    const rows = within(screen.getByLabelText('코멘트 목록')).getAllByRole('button');
    expect(rows[1]).toHaveTextContent('On a twenty');
    expect(rows[2]).toHaveTextContent('On a twenty, later');
  });

  it('marks and counts the comments waiting for the reviewer to pick', () => {
    render(<Harness statusById={new Map([...STATUSES, ['b5', 'choosing']])} />);

    const row = screen.getByRole('button', { name: /b\.ts:5/ });
    expect(row).toHaveTextContent('선택 대기');
    expect(screen.getByTestId('choosing-count')).toHaveTextContent('선택 대기 1');
    expect(screen.getByRole('button', { name: '남은 것 3' })).toBeInTheDocument();
  });

  it('marks a comment the agent said it is fixing apart from the open ones', () => {
    render(<Harness statusById={new Map([...STATUSES, ['b5', 'fixing']])} />);

    const row = screen.getByRole('button', { name: /b\.ts:5/ });
    expect(row).toHaveTextContent('수정 중');
    expect(row).not.toHaveTextContent('열림');
  });

  it('shows no pick count when nothing waits for a pick', () => {
    render(<Harness />);

    expect(screen.queryByTestId('choosing-count')).not.toBeInTheDocument();
  });

  it('names only the file of a comment on the whole file and lists it before the lines', () => {
    const onFile = { ...thread('a-file', 'src/a.ts', undefined, 'On all of a'), line: undefined };
    render(
      <Harness
        initialFilter="all"
        threads={[...THREADS, onFile]}
        statusById={new Map([...STATUSES, ['a-file', 'open']])}
      />,
    );

    expect(rowLabels()).toEqual(['a.ts', 'a.ts:3-8', 'a.ts:20', 'a.ts:20', 'b.ts:5']);
  });

  it('names the commit of a comment on a whole commit and lists it before the files', () => {
    const onCommit = {
      id: 'commit',
      commit: '1111111111111111111111111111111111111111',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      messages: [
        {
          id: 'commit',
          body: 'Split this commit',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
      fixupCommit: { shortSha: '1111111', subject: 'first step' },
    };
    const onPick = vi.fn();
    render(
      <Harness
        initialFilter="all"
        threads={[...THREADS, onCommit]}
        statusById={new Map([...STATUSES, ['commit', 'open']])}
        onPick={onPick}
      />,
    );

    expect(rowLabels()).toEqual([
      '커밋 1111111 first step',
      'a.ts:3-8',
      'a.ts:20',
      'a.ts:20',
      'b.ts:5',
    ]);
    fireEvent.click(screen.getByRole('button', { name: /커밋 1111111/ }));
    expect(onPick).toHaveBeenCalledWith(onCommit);
  });

  it('shows where each comment is, its first message and its status', () => {
    render(<Harness />);

    const row = screen.getByRole('button', { name: /a\.ts:3-8/ });
    expect(within(row).getByTitle('src/a.ts')).toHaveTextContent('a.ts:3-8');
    expect(row).toHaveTextContent('On a three to eight');
    expect(row).toHaveTextContent('답함');
    expect(screen.queryByText('Reply to a3')).not.toBeInTheDocument();
  });

  it('lists the remaining comments first and every comment on 전체', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.getByRole('button', { name: '남은 것 3' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(rowLabels()).toEqual(['a.ts:3-8', 'a.ts:20', 'b.ts:5']);

    await user.click(screen.getByRole('button', { name: '전체 4' }));

    expect(screen.getByRole('button', { name: '전체 4' })).toHaveAttribute('aria-pressed', 'true');
    expect(rowLabels()).toHaveLength(4);
    expect(screen.getByRole('button', { name: /On a twenty, later/ })).toHaveTextContent('해결');
  });

  it('leaves a deleted comment out of the list and the counts', () => {
    render(
      <Harness
        threads={[...THREADS, thread('gone', 'src/a.ts', 1, 'Deleted one')]}
        initialFilter="all"
      />,
    );

    expect(screen.queryByText('Deleted one')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '전체 4' })).toBeInTheDocument();
  });

  it('picks a comment by click and stays open', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<Harness onPick={onPick} onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: /On b five/ }));

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(THREADS[0]);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('코멘트 목록')).toBeInTheDocument();
  });

  it('moves with j and k, keeps those keys from the diff, and picks with Enter', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    renderFocused({ onPick });

    expect(screen.getByRole('button', { name: /a\.ts:3-8/ })).toHaveFocus();
    await user.keyboard('k');
    expect(screen.getByRole('button', { name: /a\.ts:3-8/ })).toHaveFocus();
    await user.keyboard('j');
    expect(screen.getByRole('button', { name: /On a twenty/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowUp}');
    await user.keyboard('{Enter}');

    expect(onPick).toHaveBeenCalledWith(THREADS[3]);
    expect(documentKeys).not.toContain('j');
    expect(documentKeys).not.toContain('k');
    expect(documentKeys).not.toContain('ArrowDown');
  });

  it('moves with the j and k keys while Korean input is on', () => {
    renderFocused();

    fireEvent.keyDown(screen.getByRole('button', { name: /a\.ts:3-8/ }), {
      key: 'ㅓ',
      code: 'KeyJ',
    });
    expect(screen.getByRole('button', { name: /On a twenty/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: /On a twenty/ }), {
      key: 'ㅏ',
      code: 'KeyK',
    });
    expect(screen.getByRole('button', { name: /a\.ts:3-8/ })).toHaveFocus();

    expect(documentKeys).not.toContain('ㅓ');
    expect(documentKeys).not.toContain('ㅏ');
  });

  it('lets a key with Shift held through to the page', async () => {
    const user = userEvent.setup();
    renderFocused();

    await user.keyboard('{Shift>}L{/Shift}');

    expect(documentKeys).toContain('L');
  });

  it('takes no keys while another window has turned the page keys off', async () => {
    const user = userEvent.setup();
    const onResolveThread = vi.fn();
    renderFocused({ navigationOff: true, onResolveThread });

    await user.keyboard('jd{Escape}');

    expect(screen.getByRole('button', { name: /a\.ts:3-8/ })).toHaveFocus();
    expect(onResolveThread).not.toHaveBeenCalled();
    expect(documentKeys).toEqual(['j', 'd', 'Escape']);
  });

  it('focuses the picked comment when it is listed', () => {
    renderFocused({ pickedThreadId: 'b5' });

    expect(screen.getByRole('button', { name: /On b five/ })).toHaveFocus();
    expect(screen.getByRole('button', { name: /On b five/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: /a\.ts:3-8/ })).not.toHaveAttribute('aria-current');
  });

  it('resolves the focused comment with d without asking and moves to the next one', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    const onResolveThread = vi.fn();
    const { rerender, ref } = renderFocused({ onResolveThread });

    await user.keyboard('d');

    expect(onResolveThread).toHaveBeenCalledWith('a3');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /On a twenty/ })).toHaveFocus();

    rerender(
      <Harness
        ref={ref}
        statusById={new Map([...STATUSES, ['a3', 'resolved']])}
        resolvedThreadIds={new Set(['a20-late', 'a3'])}
        onResolveThread={onResolveThread}
      />,
    );
    expect(rowLabels()).toEqual(['a.ts:20', 'b.ts:5']);
    expect(screen.getByRole('button', { name: /On a twenty/ })).toHaveFocus();
    vi.unstubAllGlobals();
  });

  it('resolves the focused comment with the d key while Korean input is on', () => {
    const onResolveThread = vi.fn();
    renderFocused({ onResolveThread });

    fireEvent.keyDown(screen.getByRole('button', { name: /a\.ts:3-8/ }), {
      key: 'ㅇ',
      code: 'KeyD',
    });

    expect(onResolveThread).toHaveBeenCalledWith('a3');
    expect(documentKeys).not.toContain('ㅇ');
  });

  it('leaves an already resolved comment alone on d', async () => {
    const user = userEvent.setup();
    const onResolveThread = vi.fn();
    renderFocused({ initialFilter: 'all', onResolveThread, pickedThreadId: 'a20-late' });

    await user.keyboard('d');

    expect(onResolveThread).not.toHaveBeenCalled();
  });

  it('hands the keys back on Escape and does not close', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    const onClose = vi.fn();
    const { ref } = renderFocused({ onEscape, onClose });

    await user.keyboard('{Escape}');

    expect(ref.current!.hasFocus()).toBe(false);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(documentKeys).not.toContain('Escape');
  });

  it('closes from its close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: '코멘트 패널 닫기' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says when there is nothing to list', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness threads={[]} />);
    expect(screen.getByText('코멘트가 없습니다')).toBeInTheDocument();
    unmount();

    render(<Harness threads={[THREADS[1]!]} />);
    expect(screen.getByText('남은 코멘트가 없습니다')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '전체 1' }));
    expect(rowLabels()).toEqual(['a.ts:20']);
  });

  it('takes focus on an empty list so Escape still hands the keys back', async () => {
    const user = userEvent.setup();
    const { ref } = renderFocused({ threads: [] });

    expect(ref.current!.hasFocus()).toBe(true);
    await user.keyboard('{Escape}');
    expect(ref.current!.hasFocus()).toBe(false);
  });
});
