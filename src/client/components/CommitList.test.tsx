import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';

import type { ReviewCommit, ReviewView } from '../../types/diff';

import { CommitList } from './CommitList';
import type { RewordControls } from './CommitMessageForm';

const commit = (digit: string, subject: string): ReviewCommit => ({
  sha: digit.repeat(40),
  shortSha: digit.repeat(7),
  parentSha: String(Number(digit) - 1).repeat(40),
  subject,
});
const COMMITS = [
  commit('1', 'pin the old behavior'),
  commit('2', 'change the behavior'),
  commit('3', 'tidy up'),
  commit('4', 'document it'),
];
const REVIEW = {
  requested: { baseCommitish: '0'.repeat(40), targetCommitish: '4'.repeat(40) },
  commits: COMMITS,
};

function renderList(
  shown: ReviewView = { kind: 'all' },
  {
    commits = COMMITS,
    ...options
  }: {
    rangeStart?: string;
    inDrawer?: boolean;
    onClose?: () => void;
    commits?: ReviewCommit[];
  } = {},
) {
  const onSelect = vi.fn();
  const review = { ...REVIEW, commits };
  const { rerender } = render(
    <CommitList review={review} shown={shown} onSelect={onSelect} {...options} />,
  );
  return {
    onSelect,
    pickFrom: (rangeStart: string) =>
      rerender(
        <CommitList
          review={review}
          shown={shown}
          onSelect={onSelect}
          {...options}
          rangeStart={rangeStart}
        />,
      ),
  };
}

const list = () => screen.getByRole('list');
const row = (name: RegExp | string) => within(list()).getByRole('button', { name });
const header = () => screen.getByRole('button', { expanded: true });
const COPY_NAME = /^(해시 복사|복사됨)$/;
const choices = () =>
  within(list())
    .getAllByRole('button')
    .filter((item) => !COPY_NAME.test(item.getAttribute('aria-label') ?? ''));
const painted = () =>
  choices()
    .filter((item) => item.getAttribute('aria-current') === 'true')
    .map((item) => item.textContent);
const previewed = () =>
  choices()
    .filter((item) => item.hasAttribute('data-drag-preview'))
    .map((item) => item.textContent?.slice(0, 7));

describe('CommitList', () => {
  it('lists the whole review first and then the commits oldest first', () => {
    renderList();

    expect(choices().map((item) => item.textContent)).toEqual([
      '전체',
      '1111111pin the old behavior',
      '2222222change the behavior',
      '3333333tidy up',
      '4444444document it',
    ]);
  });

  it('marks what is shown and names it in the header', () => {
    renderList({ kind: 'commit', sha: COMMITS[1]!.sha });

    expect(painted()).toEqual(['2222222change the behavior']);
    expect(screen.getByRole('button', { name: '전체' })).not.toHaveAttribute('aria-current');
    expect(header()).toHaveTextContent('2222222 change the behavior');
  });

  it('names the whole review in the header while it is shown', () => {
    renderList();

    expect(screen.getByRole('button', { name: '전체' })).toHaveAttribute('aria-current', 'true');
    expect(header()).toHaveTextContent('커밋 4개전체');
  });

  it('paints the shown run as one block and names its first and last commit in the header', () => {
    renderList({ kind: 'range', startSha: COMMITS[1]!.sha, endSha: COMMITS[2]!.sha });

    expect(painted()).toEqual(['2222222change the behavior', '3333333tidy up']);
    expect(screen.getByRole('button', { name: '전체' })).not.toHaveAttribute('aria-current');
    expect(header()).toHaveTextContent('2222222~3333333 (2개)');
    expect(within(header()).getByTitle('change the behavior ~ tidy up')).toBeInTheDocument();
  });

  it('asks for a click or a Shift+click with the clicked commit, and for the whole review', () => {
    const { onSelect } = renderList({ kind: 'commit', sha: COMMITS[0]!.sha });

    fireEvent.click(row(/2222222/));
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'click', sha: COMMITS[1]!.sha });

    fireEvent.click(row(/3333333/), { shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'shift-click', sha: COMMITS[2]!.sha });

    fireEvent.click(screen.getByRole('button', { name: '전체' }));
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'all' });
  });

  it('paints the run a drop would choose while dragging', () => {
    renderList({ kind: 'commit', sha: COMMITS[0]!.sha });

    fireEvent.mouseDown(row(/3333333/), { button: 0 });
    expect(previewed()).toEqual([]);
    fireEvent.mouseEnter(row(/2222222/));
    expect(previewed()).toEqual(['2222222', '3333333']);

    fireEvent.mouseEnter(row(/4444444/));
    expect(previewed()).toEqual(['3333333', '4444444']);
  });

  it('paints every commit while dragging over a run that covers them all', () => {
    renderList();

    fireEvent.mouseDown(row(/4444444/), { button: 0 });
    fireEvent.mouseEnter(row(/1111111/));

    expect(previewed()).toEqual(['1111111', '2222222', '3333333', '4444444']);
  });

  it('asks for a drop when the mouse is released on another commit', () => {
    const { onSelect } = renderList();

    fireEvent.mouseDown(row(/2222222/), { button: 0 });
    fireEvent.mouseEnter(row(/4444444/));
    fireEvent.mouseUp(row(/4444444/));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      kind: 'drop',
      fromSha: COMMITS[1]!.sha,
      toSha: COMMITS[3]!.sha,
    });
    expect(previewed()).toEqual([]);
  });

  it('drops nothing and paints nothing when released outside the list', () => {
    const { onSelect } = renderList();

    fireEvent.mouseDown(row(/2222222/), { button: 0 });
    fireEvent.mouseEnter(row(/3333333/));
    fireEvent.mouseUp(window);

    expect(previewed()).toEqual([]);
    fireEvent.mouseEnter(row(/4444444/));
    fireEvent.mouseUp(row(/4444444/));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('treats a press and release on the same commit as a click', () => {
    const { onSelect } = renderList();

    fireEvent.mouseDown(row(/2222222/), { button: 0 });
    fireEvent.mouseEnter(row(/3333333/));
    fireEvent.mouseEnter(row(/2222222/));
    fireEvent.mouseUp(row(/2222222/));
    fireEvent.click(row(/2222222/));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ kind: 'click', sha: COMMITS[1]!.sha });
  });

  it('starts no drag on a Shift+press', () => {
    renderList();

    fireEvent.mouseDown(row(/2222222/), { button: 0, shiftKey: true });
    fireEvent.mouseEnter(row(/3333333/));

    expect(previewed()).toEqual([]);
  });

  it('shows the open comments of a commit beside it and nothing beside a commit with none', () => {
    render(
      <CommitList
        review={REVIEW}
        shown={{ kind: 'all' }}
        onSelect={vi.fn()}
        openCounts={new Map([[COMMITS[1]!.sha, 2]])}
      />,
    );

    expect(within(row(/2222222/)).getByTitle('열린 지적 2개')).toHaveTextContent('2');
    expect(within(row(/1111111/)).queryByTitle(/^열린 지적/)).not.toBeInTheDocument();
  });

  describe('amended messages', () => {
    function renderAmended(message: string, { inDrawer = false } = {}) {
      render(
        <CommitList
          review={REVIEW}
          shown={{ kind: 'all' }}
          onSelect={vi.fn()}
          inDrawer={inDrawer}
          amendedMessages={new Map([[COMMITS[1]!.sha, message]])}
        />,
      );
    }

    it('strikes the subject of a commit an amend! rewords and shows the subject it will get', () => {
      renderAmended('change the behavior on purpose\n\nwith a body');

      const amended = row(/2222222/);
      expect(within(amended).getByText('change the behavior').tagName).toBe('DEL');
      expect(within(amended).getByText('change the behavior on purpose')).toBeInTheDocument();
      expect(within(amended).getByText('바뀔 메시지')).toBeInTheDocument();
      expect(within(amended).queryByText(/with a body/)).not.toBeInTheDocument();
      expect(amended).toHaveAttribute(
        'title',
        'change the behavior\n\n바뀔 메시지:\nchange the behavior on purpose\n\nwith a body',
      );
      expect(within(row(/1111111/)).queryByText('바뀔 메시지')).not.toBeInTheDocument();
      expect(row(/1111111/).querySelector('del')).toBeNull();
    });

    it('keeps the subject unstruck when only the body changes', () => {
      renderAmended('change the behavior\n\nwith a new body');

      const amended = row(/2222222/);
      expect(within(amended).getByText('change the behavior').tagName).not.toBe('DEL');
      expect(within(amended).getByText('본문 변경됨')).toBeInTheDocument();
    });

    it('reads the subject as git does, joining the lines of the first paragraph', () => {
      renderAmended('change the  \nbehavior\n\nwith a new body');

      expect(within(row(/2222222/)).getByText('본문 변경됨')).toBeInTheDocument();
    });

    it('counts leading spaces as part of the subject, as git does', () => {
      renderAmended('  change the behavior');

      expect(row(/2222222/).querySelector('del')).toHaveTextContent('change the behavior');
      expect(within(row(/2222222/)).queryByText('본문 변경됨')).not.toBeInTheDocument();
    });

    it('shows the subject it will get in the phone drawer too', () => {
      renderAmended('change the behavior on purpose', { inDrawer: true });

      const amended = row(/2222222/);
      expect(within(amended).getByText('change the behavior').tagName).toBe('DEL');
      expect(within(amended).getByText('change the behavior on purpose')).toBeInTheDocument();
    });
  });

  describe('rewording a message', () => {
    const MESSAGE = 'change the behavior\n\nBecause the old one was wrong.';

    function renderRewordable({
      load = vi.fn(async () => MESSAGE),
      save = vi.fn(async () => null),
      inDrawer = false,
    }: {
      load?: (sha: string) => Promise<string | null>;
      save?: RewordControls['save'];
      inDrawer?: boolean;
    } = {}) {
      const onSelect = vi.fn();
      render(
        <CommitList
          review={REVIEW}
          shown={{ kind: 'all' }}
          onSelect={onSelect}
          inDrawer={inDrawer}
          reword={{ load, save }}
        />,
      );
      return { onSelect, load, save };
    }

    const itemOf = (name: RegExp) => row(name).closest('li')!;
    const editButtonOf = (name: RegExp) =>
      within(itemOf(name)).getByRole('button', { name: '메시지 고치기' });

    it('offers no editing without a way to save', () => {
      renderList();

      expect(screen.queryByRole('button', { name: '메시지 고치기' })).not.toBeInTheDocument();
    });

    it('opens an editor holding the whole message without choosing the commit', async () => {
      const { onSelect, load } = renderRewordable();

      fireEvent.click(editButtonOf(/2222222/));

      const editor = await within(itemOf(/2222222/)).findByRole('textbox', {
        name: '커밋 메시지',
      });
      expect(editor).toHaveValue(MESSAGE);
      expect(load).toHaveBeenCalledWith(COMMITS[1]!.sha);
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    });

    it('saves the new message against the one it started from and closes', async () => {
      const { save } = renderRewordable();
      fireEvent.click(editButtonOf(/2222222/));
      const editor = await screen.findByRole('textbox', { name: '커밋 메시지' });

      fireEvent.change(editor, { target: { value: 'change the behavior on purpose' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '저장' }));
      });

      expect(save).toHaveBeenCalledWith({
        commit: COMMITS[1]!.sha,
        original: MESSAGE,
        message: 'change the behavior on purpose',
      });
      expect(screen.queryByRole('textbox', { name: '커밋 메시지' })).not.toBeInTheDocument();
    });

    it('keeps the editor open with the reason when saving fails', async () => {
      renderRewordable({
        save: vi.fn(async () => ({ message: 'refused', output: 'git said no' })),
      });
      fireEvent.click(editButtonOf(/2222222/));
      const editor = await screen.findByRole('textbox', { name: '커밋 메시지' });

      fireEvent.change(editor, { target: { value: 'better' } });
      await act(async () => {
        fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
      });

      expect(screen.getByRole('alert')).toHaveTextContent('refused');
      expect(screen.getByRole('alert')).toHaveTextContent('git said no');
      expect(screen.getByRole('textbox', { name: '커밋 메시지' })).toHaveValue('better');
    });

    const hintOf = (editor: HTMLElement) => within(editor.closest('form')!).getByRole('status');

    it('keeps saving off while the message is blank and says why', async () => {
      const { save } = renderRewordable();
      fireEvent.click(editButtonOf(/2222222/));
      const editor = await screen.findByRole('textbox', { name: '커밋 메시지' });

      fireEvent.change(editor, { target: { value: '  \n ' } });
      await act(async () => {
        fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
      });

      expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
      expect(hintOf(editor)).toHaveTextContent('메시지를 비울 수는 없습니다.');
      expect(save).not.toHaveBeenCalled();

      fireEvent.change(editor, { target: { value: 'Review-Thread: abc' } });

      expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
      expect(hintOf(editor)).toHaveTextContent('메시지를 비울 수는 없습니다.');
    });

    it('keeps saving off when only trailing spaces or blank lines were added', async () => {
      renderRewordable();
      fireEvent.click(editButtonOf(/2222222/));
      const editor = await screen.findByRole('textbox', { name: '커밋 메시지' });

      fireEvent.change(editor, { target: { value: `${MESSAGE}  \n\n\n` } });

      expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
      expect(hintOf(editor)).toHaveTextContent('');
    });

    it('says nothing about a blank message the commit already had', async () => {
      renderRewordable({ load: vi.fn(async () => '') });
      fireEvent.click(editButtonOf(/2222222/));
      const editor = await screen.findByRole('textbox', { name: '커밋 메시지' });

      expect(hintOf(editor)).toHaveTextContent('');

      fireEvent.change(editor, { target: { value: '   ' } });

      expect(hintOf(editor)).toHaveTextContent('');
      expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    });

    it('saves again with the warnings acknowledged when told to go ahead', async () => {
      const save = vi.fn<RewordControls['save']>(async (request) =>
        request.acknowledged
          ? null
          : { message: '기본 브랜치의 이력이 바뀝니다.', warnings: ['default-branch' as const] },
      );
      renderRewordable({ save });
      fireEvent.click(editButtonOf(/2222222/));
      const editor = await screen.findByRole('textbox', { name: '커밋 메시지' });
      fireEvent.change(editor, { target: { value: 'better' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '저장' }));
      });

      expect(screen.getByRole('alert')).toHaveTextContent('기본 브랜치의 이력이 바뀝니다.');
      expect(screen.getByRole('textbox', { name: '커밋 메시지' })).toHaveValue('better');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '그래도 저장' }));
      });

      expect(save).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: 'better', acknowledged: ['default-branch'] }),
      );
      expect(screen.queryByRole('textbox', { name: '커밋 메시지' })).not.toBeInTheDocument();
    });

    it('offers no way past a plain refusal', async () => {
      renderRewordable({ save: vi.fn(async () => ({ message: 'refused' })) });
      fireEvent.click(editButtonOf(/2222222/));
      fireEvent.change(await screen.findByRole('textbox', { name: '커밋 메시지' }), {
        target: { value: 'better' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '저장' }));
      });

      expect(screen.queryByRole('button', { name: '그래도 저장' })).not.toBeInTheDocument();
    });

    it('drops an earlier refusal once the message is edited again', async () => {
      renderRewordable({ save: vi.fn(async () => ({ message: 'refused' })) });
      fireEvent.click(editButtonOf(/2222222/));
      const editor = await screen.findByRole('textbox', { name: '커밋 메시지' });
      fireEvent.change(editor, { target: { value: 'better' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '저장' }));
      });
      expect(screen.getByRole('alert')).toHaveTextContent('refused');

      fireEvent.change(editor, { target: { value: 'even better' } });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '저장' })).toBeEnabled();
    });

    it('closes without saving on cancel and on Escape', async () => {
      const { save } = renderRewordable();
      fireEvent.click(editButtonOf(/2222222/));
      fireEvent.click(await screen.findByRole('button', { name: '취소' }));

      expect(screen.queryByRole('textbox', { name: '커밋 메시지' })).not.toBeInTheDocument();

      fireEvent.click(editButtonOf(/3333333/));
      fireEvent.keyDown(await screen.findByRole('textbox', { name: '커밋 메시지' }), {
        key: 'Escape',
      });

      expect(screen.queryByRole('textbox', { name: '커밋 메시지' })).not.toBeInTheDocument();
      expect(save).not.toHaveBeenCalled();
    });

    it('keeps every pencil still while saving, so a refusal still shows', async () => {
      let refuse: (failure: { message: string }) => void = () => {};
      renderRewordable({
        save: vi.fn(() => new Promise<{ message: string }>((resolve) => (refuse = resolve))),
      });
      fireEvent.click(editButtonOf(/2222222/));
      const editor = await screen.findByRole('textbox', { name: '커밋 메시지' });
      fireEvent.change(editor, { target: { value: 'better' } });
      fireEvent.click(screen.getByRole('button', { name: '저장' }));

      expect(editButtonOf(/2222222/)).toBeDisabled();
      expect(editButtonOf(/3333333/)).toBeDisabled();
      await act(async () => refuse({ message: 'refused' }));

      expect(screen.getByRole('alert')).toHaveTextContent('refused');
      expect(editButtonOf(/3333333/)).toBeEnabled();
    });

    it('closes the editor when its pencil is pressed again', async () => {
      renderRewordable();
      fireEvent.click(editButtonOf(/2222222/));
      await screen.findByRole('textbox', { name: '커밋 메시지' });

      fireEvent.click(editButtonOf(/2222222/));

      expect(screen.queryByRole('textbox', { name: '커밋 메시지' })).not.toBeInTheDocument();
    });

    it('offers no editing on a merge, whose message folding cannot change', () => {
      const merge = { ...COMMITS[1]!, isMerge: true as const };
      render(
        <CommitList
          review={{ ...REVIEW, commits: [COMMITS[0]!, merge] }}
          shown={{ kind: 'all' }}
          onSelect={vi.fn()}
          reword={{ load: vi.fn(async () => ''), save: vi.fn(async () => null) }}
        />,
      );

      expect(within(itemOf(/2222222/)).queryByRole('button', { name: '메시지 고치기' })).toBeNull();
      expect(editButtonOf(/1111111/)).toBeInTheDocument();
    });

    it('says so when the message cannot be read', async () => {
      renderRewordable({ load: vi.fn(async () => null) });

      fireEvent.click(editButtonOf(/2222222/));

      expect(await screen.findByRole('alert')).toHaveTextContent('메시지를 읽지 못했습니다');
      expect(screen.queryByRole('textbox', { name: '커밋 메시지' })).not.toBeInTheDocument();
    });

    it('offers editing in the phone drawer too', () => {
      renderRewordable({ inDrawer: true });

      expect(editButtonOf(/2222222/)).toBeInTheDocument();
    });
  });

  describe('copying the hash', () => {
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const copyButtonOf = (name: RegExp) =>
      within(row(name).closest('li')!).getByRole('button', { name: COPY_NAME });

    it('copies the first ten characters of the full hash without choosing the commit', async () => {
      const { onSelect } = renderList();

      await act(async () => {
        fireEvent.click(copyButtonOf(/2222222/));
      });

      expect(writeText).toHaveBeenCalledExactlyOnceWith('2222222222');
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('says it copied for two seconds, on that commit only', async () => {
      vi.useFakeTimers();
      renderList();

      await act(async () => {
        fireEvent.click(copyButtonOf(/2222222/));
      });

      expect(copyButtonOf(/2222222/)).toHaveAccessibleName('복사됨');
      expect(copyButtonOf(/2222222/)).toHaveAttribute('title', '복사됨');
      expect(copyButtonOf(/3333333/)).toHaveAccessibleName('해시 복사');

      act(() => vi.advanceTimersByTime(1999));
      expect(copyButtonOf(/2222222/)).toHaveAccessibleName('복사됨');
      act(() => vi.advanceTimersByTime(1));
      expect(copyButtonOf(/2222222/)).toHaveAccessibleName('해시 복사');
    });

    it('offers copying in the phone drawer too', () => {
      renderList({ kind: 'all' }, { inDrawer: true });

      expect(copyButtonOf(/2222222/)).toHaveAccessibleName('해시 복사');
    });
  });

  describe('closing the phone drawer', () => {
    const closeButton = () => screen.queryByRole('button', { name: '커밋 서랍 닫기' });

    it('offers closing in the title row', () => {
      const onClose = vi.fn();
      renderList({ kind: 'all' }, { inDrawer: true, onClose });

      fireEvent.click(closeButton()!);

      expect(onClose).toHaveBeenCalledOnce();
    });

    it('still offers closing while a range is being picked', () => {
      const onClose = vi.fn();
      const { pickFrom } = renderList({ kind: 'all' }, { inDrawer: true, onClose });

      pickFrom('1'.repeat(40));
      fireEvent.click(closeButton()!);

      expect(onClose).toHaveBeenCalledOnce();
    });

    it('keeps the desktop list and its range row free of it', () => {
      const { pickFrom } = renderList({ kind: 'all' }, { onClose: vi.fn() });
      expect(closeButton()).toBeNull();

      pickFrom('1'.repeat(40));
      expect(closeButton()).toBeNull();
    });
  });

  describe('commenting on a whole commit', () => {
    const MERGE: ReviewCommit = {
      ...commit('3', 'merge the side branch'),
      isMerge: true,
      merged: [{ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'side first' }],
    };

    function renderCommentable(shown: ReviewView = { kind: 'all' }, { inDrawer = false } = {}) {
      const onAddCommitComment = vi.fn(async () => {});
      render(
        <CommitList
          review={{ ...REVIEW, commits: [COMMITS[0]!, COMMITS[1]!, MERGE] }}
          shown={shown}
          onSelect={vi.fn()}
          inDrawer={inDrawer}
          onAddCommitComment={onAddCommitComment}
        />,
      );
      return { onAddCommitComment };
    }

    const commentButtonOf = (shortSha: string) =>
      within(row(new RegExp(shortSha)).closest('li')!).getByRole('button', {
        name: '커밋에 지적 달기',
      });

    it('offers no comment button without a way to add one', () => {
      renderList();

      expect(screen.queryByRole('button', { name: /커밋에 지적 달기/ })).toBeNull();
    });

    it('adds a comment on the commit of the row from a view that shows another commit', async () => {
      const { onAddCommitComment } = renderCommentable({ kind: 'commit', sha: COMMITS[1]!.sha });

      fireEvent.click(commentButtonOf('1111111'));
      fireEvent.change(screen.getByPlaceholderText(/comment/i), {
        target: { value: 'Split this commit' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

      await vi.waitFor(() =>
        expect(onAddCommitComment).toHaveBeenCalledWith(COMMITS[0]!.sha, 'Split this commit'),
      );
      await vi.waitFor(() => expect(screen.queryByPlaceholderText(/comment/i)).toBeNull());
    });

    it('offers it on a merge but not on the commits the merge brings in', () => {
      renderCommentable();

      expect(commentButtonOf('3333333')).toBeInTheDocument();
      expect(
        within(
          within(list())
            .getByText(/aaaaaaa/)
            .closest('li')!,
        ).queryByRole('button', {
          name: '커밋에 지적 달기',
        }),
      ).toBeNull();
    });

    it('lets the comment be selected and pasted inside the list', () => {
      renderCommentable();

      fireEvent.click(commentButtonOf('1111111'));
      const field = screen.getByPlaceholderText(/comment/i);

      expect(fireEvent.contextMenu(field)).toBe(true);
      expect(field.closest('.select-text')).not.toBeNull();
    });

    it('keeps it on screen in the phone drawer', () => {
      renderCommentable({ kind: 'all' }, { inDrawer: true });

      expect(commentButtonOf('2222222').parentElement!.className).not.toContain('opacity-0');
    });
  });

  describe('message card', () => {
    const MESSAGE = 'change the behavior\n\nThe old one dropped data.\nKeep it.';

    function renderWithCard({
      inDrawer = false,
      amendedMessages,
      loadMessage = vi.fn(async (sha: string) => (sha === COMMITS[1]!.sha ? MESSAGE : 'tidy up')),
    }: {
      inDrawer?: boolean;
      amendedMessages?: ReadonlyMap<string, string>;
      loadMessage?: (sha: string) => Promise<string | null>;
    } = {}) {
      const onSelect = vi.fn();
      render(
        <CommitList
          review={REVIEW}
          shown={{ kind: 'all' }}
          onSelect={onSelect}
          inDrawer={inDrawer}
          amendedMessages={amendedMessages}
          loadMessage={loadMessage}
        />,
      );
      return { onSelect, loadMessage };
    }

    const card = () => screen.queryByRole('tooltip');
    const rest = async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows the hash, the subject and the whole body once the pointer rests on a row', async () => {
      const { onSelect } = renderWithCard();

      fireEvent.mouseEnter(row(/2222222/));
      await rest(349);
      expect(card()).toBeNull();
      await rest(1);

      expect(card()).toHaveTextContent('2222222');
      expect(card()).toHaveTextContent('change the behavior');
      expect(card()!.textContent).toContain('The old one dropped data.\nKeep it.');
      expect(row(/2222222/)).toHaveAttribute('aria-describedby', card()!.id);
      expect(row(/2222222/)).not.toHaveAttribute('title');
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('switches to the next row at once while it is open', async () => {
      renderWithCard();
      fireEvent.mouseEnter(row(/2222222/));
      await rest(350);

      fireEvent.mouseLeave(row(/2222222/));
      fireEvent.mouseEnter(row(/3333333/));
      await rest(0);

      expect(card()).toHaveTextContent('3333333');
      expect(card()).toHaveTextContent('본문 없음');
    });

    it('stays while the pointer crosses the row buttons on its way to the card', async () => {
      renderWithCard();
      fireEvent.mouseEnter(row(/2222222/));
      await rest(350);

      const copy = within(row(/2222222/).parentElement!).getByRole('button', { name: /복사/ });
      fireEvent.mouseOut(row(/2222222/), { relatedTarget: copy });
      await rest(1000);

      expect(card()).toHaveTextContent('2222222');
    });

    it('stays while the pointer is on it and goes once the pointer leaves both', async () => {
      renderWithCard();
      fireEvent.mouseEnter(row(/2222222/));
      await rest(350);

      fireEvent.mouseLeave(row(/2222222/));
      fireEvent.mouseEnter(card()!);
      await rest(1000);
      expect(card()).toHaveTextContent('2222222');

      fireEvent.mouseLeave(card()!);
      await rest(199);
      expect(card()).not.toBeNull();
      await rest(1);
      expect(card()).toBeNull();
    });

    it('shows for a row reached by keyboard and goes on Escape or when focus moves on', async () => {
      renderWithCard();

      fireEvent.focus(row(/2222222/));
      await rest(350);
      expect(card()).toHaveTextContent('The old one dropped data.');

      fireEvent.keyDown(row(/2222222/), { key: 'Escape' });
      expect(card()).toBeNull();

      fireEvent.focus(row(/3333333/));
      await rest(350);
      expect(card()).toHaveTextContent('3333333');
      fireEvent.blur(row(/3333333/));
      await rest(200);
      expect(card()).toBeNull();
    });

    it('never shows when the pointer only passes over a row', async () => {
      const { loadMessage } = renderWithCard();

      fireEvent.mouseEnter(row(/2222222/));
      await rest(100);
      fireEvent.mouseLeave(row(/2222222/));
      await rest(1000);

      expect(card()).toBeNull();
      expect(loadMessage).not.toHaveBeenCalled();
    });

    it('reads each message once', async () => {
      const { loadMessage } = renderWithCard();

      fireEvent.mouseEnter(row(/2222222/));
      await rest(350);
      fireEvent.mouseLeave(row(/2222222/));
      await rest(200);
      fireEvent.mouseEnter(row(/2222222/));
      await rest(350);

      expect(loadMessage).toHaveBeenCalledExactlyOnceWith(COMMITS[1]!.sha);
    });

    it('says so when the message cannot be read', async () => {
      renderWithCard({ loadMessage: vi.fn(async () => null) });

      fireEvent.mouseEnter(row(/2222222/));
      await rest(350);

      expect(card()).toHaveTextContent('메시지를 읽지 못했습니다.');
    });

    it('shows the message an amend! will leave without reading the commit', async () => {
      const { loadMessage } = renderWithCard({
        amendedMessages: new Map([[COMMITS[1]!.sha, 'change the behavior on purpose\n\nWhy.']]),
      });

      fireEvent.mouseEnter(row(/2222222/));
      await rest(350);

      expect(card()).toHaveTextContent('바뀔 메시지');
      expect(card()!.textContent).toContain('change the behavior on purpose\n\nWhy.');
      expect(loadMessage).not.toHaveBeenCalled();
    });

    it('keeps the subject as a tooltip and shows no card in the phone drawer', async () => {
      const { loadMessage } = renderWithCard({ inDrawer: true });

      fireEvent.mouseEnter(row(/2222222/));
      await rest(1000);

      expect(card()).toBeNull();
      expect(loadMessage).not.toHaveBeenCalled();
      expect(row(/2222222/)).toHaveAttribute('title', 'change the behavior');
    });
  });

  describe('row buttons', () => {
    const actionsOf = (name: RegExp) =>
      within(row(name).closest('li')!).getByRole('button', { name: COPY_NAME }).parentElement!;
    const isHidden = (element: HTMLElement) => element.className.split(' ').includes('opacity-0');

    function renderWithButtons({ inDrawer = false } = {}) {
      render(
        <CommitList
          review={REVIEW}
          shown={{ kind: 'all' }}
          onSelect={vi.fn()}
          inDrawer={inDrawer}
          reword={{ load: vi.fn(async () => 'change the behavior'), save: vi.fn() }}
          onAddCommitComment={vi.fn(async () => {})}
        />,
      );
    }

    it('lays them over the end of the subject, hidden until the row is hovered or focused', () => {
      renderWithButtons();

      const actions = actionsOf(/2222222/);
      expect(actions.className).toContain('absolute');
      expect(isHidden(actions)).toBe(true);
      expect(actions.className).toContain('group-hover:opacity-100');
      expect(actions.className).toContain('group-has-[:focus-visible]:opacity-100');
      expect(within(actions).getAllByRole('button')).toHaveLength(3);
    });

    it('turns the open count into the comment button, beside the other buttons rather than under them', () => {
      render(
        <CommitList
          review={REVIEW}
          shown={{ kind: 'all' }}
          onSelect={vi.fn()}
          reword={{ load: vi.fn(async () => 'change the behavior'), save: vi.fn() }}
          onAddCommitComment={vi.fn(async () => {})}
          openCounts={new Map([[COMMITS[1]!.sha, 2]])}
        />,
      );

      const comment = within(row(/2222222/).closest('li')!).getByRole('button', {
        name: '커밋에 지적 달기',
      });
      expect(comment).toHaveTextContent('2');
      expect(comment).toHaveAttribute('title', '열린 지적 2개 · 이 커밋 전체에 지적 달기');
      expect(within(row(/2222222/)).queryByText('2')).toBeNull();
      const actions = actionsOf(/2222222/);
      expect(actions.contains(comment)).toBe(false);
      expect(isHidden(actions)).toBe(true);
      expect(isHidden(comment.parentElement!)).toBe(false);
      expect(actions.className).toContain('right-full');
      expect(within(actions).getAllByRole('button')).toHaveLength(2);

      fireEvent.click(comment);
      expect(screen.getByPlaceholderText(/comment/i)).toBeInTheDocument();
    });

    it('keeps them in line and on screen in the phone drawer', () => {
      renderWithButtons({ inDrawer: true });

      expect(actionsOf(/2222222/).className).toBe('contents');
    });

    it('keeps them on screen while the message editor or the comment form of that row is open', async () => {
      renderWithButtons();

      fireEvent.click(within(actionsOf(/2222222/)).getByRole('button', { name: '메시지 고치기' }));
      await screen.findByRole('textbox');
      expect(isHidden(actionsOf(/2222222/))).toBe(false);
      expect(isHidden(actionsOf(/3333333/))).toBe(true);

      fireEvent.click(within(actionsOf(/2222222/)).getByRole('button', { name: '메시지 고치기' }));
      expect(isHidden(actionsOf(/2222222/))).toBe(true);

      fireEvent.click(
        within(actionsOf(/3333333/)).getByRole('button', { name: '커밋에 지적 달기' }),
      );
      expect(isHidden(actionsOf(/3333333/))).toBe(false);
    });

    it('keeps them on screen while the hash reads as copied', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
      vi.useFakeTimers();
      try {
        renderWithButtons();

        await act(async () => {
          fireEvent.click(within(actionsOf(/2222222/)).getByRole('button', { name: COPY_NAME }));
        });
        expect(isHidden(actionsOf(/2222222/))).toBe(false);

        act(() => vi.advanceTimersByTime(2000));
        expect(isHidden(actionsOf(/2222222/))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('folds the list away and keeps naming what is shown', () => {
    renderList({ kind: 'commit', sha: COMMITS[0]!.sha });

    fireEvent.click(header());

    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { expanded: false })).toHaveTextContent(
      '1111111 pin the old behavior',
    );
  });

  describe('height', () => {
    const region = () => screen.getByRole('region', { name: '리뷰 범위의 커밋' });
    const edge = () => screen.getByRole('separator', { name: '커밋 목록 높이 조절' });

    function renderResizable(height?: number, { listContentHeight = 1000 } = {}) {
      const onResize = vi.fn();
      const { container } = render(
        <CommitList
          review={REVIEW}
          shown={{ kind: 'all' }}
          onSelect={vi.fn()}
          height={height}
          onResize={onResize}
        />,
      );
      Object.defineProperty(container, 'clientHeight', { value: 600 });
      vi.spyOn(region(), 'getBoundingClientRect').mockReturnValue({ height: 200 } as DOMRect);
      Object.defineProperty(list(), 'clientHeight', { value: 150 });
      Object.defineProperty(list(), 'scrollHeight', { value: listContentHeight });
      return onResize;
    }

    it('grows as its top edge is dragged up and always leaves the files room', () => {
      const onResize = renderResizable();

      fireEvent.mouseDown(edge(), { clientY: 500 });
      fireEvent.mouseMove(document, { clientY: 450 });
      expect(onResize).toHaveBeenLastCalledWith(250);
      fireEvent.mouseMove(document, { clientY: 0 });
      expect(onResize).toHaveBeenLastCalledWith(440);
      fireEvent.mouseMove(document, { clientY: 900 });
      expect(onResize).toHaveBeenLastCalledWith(80);
      fireEvent.mouseUp(document);
      fireEvent.mouseMove(document, { clientY: 450 });

      expect(onResize).toHaveBeenCalledTimes(3);
    });

    it('grows no taller than its commits need', () => {
      const onResize = renderResizable(undefined, { listContentHeight: 250 });

      fireEvent.mouseDown(edge(), { clientY: 500 });
      fireEvent.mouseMove(document, { clientY: 0 });

      expect(onResize).toHaveBeenLastCalledWith(300);
    });

    it('keeps the chosen height when every commit already shows and the edge is dragged up', () => {
      const onResize = renderResizable(undefined, { listContentHeight: 150 });

      fireEvent.mouseDown(edge(), { clientY: 500 });
      fireEvent.mouseMove(document, { clientY: 0 });

      expect(onResize).not.toHaveBeenCalled();
    });

    it('takes at most part of the sidebar until a height is chosen, then at most that', () => {
      renderResizable();
      expect(region().style.maxHeight).toBe('40%');

      cleanup();
      renderResizable(300);
      expect(region().style.maxHeight).toContain('300px');
    });

    it('offers no edge to drag once folded', () => {
      renderResizable();

      fireEvent.click(header());

      expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    });
  });

  describe('commit graph', () => {
    const MERGE: ReviewCommit = {
      ...commit('3', 'merge the side branch'),
      merged: [
        { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'side first' },
        { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'side second' },
      ],
    };
    const WITH_MERGE = [COMMITS[0]!, COMMITS[1]!, MERGE, COMMITS[3]!];
    const dotColors = () =>
      [...list().querySelectorAll('li')]
        .filter((item) => item.querySelector('circle'))
        .map((item) => [
          item.textContent?.slice(0, 7),
          item.querySelector('circle')?.getAttribute('fill'),
        ]);
    const branchRow = (text: string) => within(list()).getByText(text).closest('li')!;

    it('draws a dot on the line for every commit in the colour of the line, whatever is shown', () => {
      renderList({ kind: 'range', startSha: COMMITS[1]!.sha, endSha: COMMITS[2]!.sha });

      expect(dotColors().map(([, color]) => color)).toEqual(
        Array(4).fill('var(--color-github-accent)'),
      );
    });

    it('lists the commits a merge brings in just above it, where they cannot be chosen', () => {
      const { onSelect } = renderList({ kind: 'all' }, { commits: WITH_MERGE });

      expect([...list().querySelectorAll('li')].map((item) => item.textContent)).toEqual([
        '전체',
        '1111111pin the old behavior',
        '2222222change the behavior',
        'aaaaaaaside first',
        'bbbbbbbside second',
        '3333333merge the side branch',
        '4444444document it',
      ]);
      expect(
        within(branchRow('side first'))
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label')),
      ).toEqual(['해시 복사']);

      fireEvent.click(within(list()).getByText('side first'));
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('copies the hash of a commit a merge brings in too', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      renderList({ kind: 'all' }, { commits: WITH_MERGE });

      await act(async () => {
        fireEvent.click(within(branchRow('side first')).getByRole('button', { name: '해시 복사' }));
      });

      expect(writeText).toHaveBeenCalledExactlyOnceWith('aaaaaaaaaa');
    });

    it('draws the dots of the branch the same size as the others', () => {
      renderList({ kind: 'all' }, { commits: WITH_MERGE });

      const radii = [...list().querySelectorAll('circle')].map((dot) => dot.getAttribute('r'));
      expect(new Set(radii).size).toBe(1);
      expect(radii).toHaveLength(6);
    });

    it('draws the branch in a colour of its own and marks it shown with its merge', () => {
      renderList({ kind: 'commit', sha: MERGE.sha }, { commits: WITH_MERGE });

      const colors = Object.fromEntries(dotColors());
      expect(colors['aaaaaaa']).toBe('var(--commit-graph-branch-1)');
      expect(colors['bbbbbbb']).toBe('var(--commit-graph-branch-1)');
      expect(colors['3333333']).toBe('var(--color-github-accent)');
      expect(branchRow('side first')).toHaveAttribute('aria-current', 'true');
      expect(painted()).toEqual(['3333333merge the side branch']);
    });

    it('counts the commits of a branch too long to list', () => {
      renderList({ kind: 'all' }, { commits: [COMMITS[0]!, { ...MERGE, mergedOmitted: 30 }] });

      expect(within(list()).getByText('커밋 30개 더')).toBeInTheDocument();
    });
  });
});

describe('CommitList on a phone', () => {
  const at = (y: number) => ({ touches: [{ clientX: 10, clientY: y }] });
  const ended = (y: number) => ({ changedTouches: [{ clientX: 10, clientY: y }] });
  // Rows sit 10px apart from y=10 in this test, the first commit at 10.
  const rowUnder = (y: number) => row(new RegExp(String(y / 10).repeat(7)));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'elementFromPoint').mockImplementation((_x, y) => rowUnder(y));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const hold = (y: number) => {
    fireEvent.touchStart(rowUnder(y), at(y));
    act(() => vi.advanceTimersByTime(500));
  };

  it('asks for a click on a short tap', () => {
    const { onSelect } = renderList();

    fireEvent.touchStart(rowUnder(20), at(20));
    act(() => vi.advanceTimersByTime(300));
    fireEvent.touchEnd(rowUnder(20), ended(20));
    fireEvent.click(rowUnder(20));
    act(() => vi.advanceTimersByTime(500));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ kind: 'click', sha: COMMITS[1]!.sha });
  });

  it('asks for a long press once the finger is held still, and no click on release', () => {
    const { onSelect } = renderList();

    hold(20);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ kind: 'long-press', sha: COMMITS[1]!.sha });

    expect(fireEvent.touchEnd(rowUnder(20), ended(20))).toBe(false);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('starts no long press when the finger moves away to scroll the list', () => {
    const { onSelect } = renderList();

    fireEvent.touchStart(rowUnder(20), at(20));
    expect(fireEvent.touchMove(rowUnder(20), at(40))).toBe(true);
    act(() => vi.advanceTimersByTime(500));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps the browser from scrolling, selecting text or opening its menu on a long press', () => {
    const { pickFrom } = renderList();

    hold(20);
    pickFrom(COMMITS[1]!.sha);

    expect(fireEvent.contextMenu(rowUnder(20))).toBe(false);
    expect(fireEvent.touchMove(rowUnder(20), at(30))).toBe(false);
    expect(list()).toHaveClass('select-none', '[-webkit-touch-callout:none]');
  });

  it('paints the run while the held finger drags and asks for a drop where it is lifted', () => {
    const { onSelect, pickFrom } = renderList();

    hold(20);
    pickFrom(COMMITS[1]!.sha);
    expect(previewed()).toEqual(['2222222']);
    fireEvent.touchMove(rowUnder(20), at(40));
    expect(previewed()).toEqual(['2222222', '3333333', '4444444']);
    fireEvent.touchEnd(rowUnder(20), ended(40));

    expect(onSelect).toHaveBeenLastCalledWith({
      kind: 'drop',
      fromSha: COMMITS[1]!.sha,
      toSha: COMMITS[3]!.sha,
    });
  });

  it('asks for nothing more when the held finger is lifted on the commit it pressed', () => {
    const { onSelect, pickFrom } = renderList();

    hold(20);
    pickFrom(COMMITS[1]!.sha);
    fireEvent.touchMove(rowUnder(20), at(30));
    fireEvent.touchMove(rowUnder(20), at(20));
    fireEvent.touchEnd(rowUnder(20), ended(20));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(previewed()).toEqual(['2222222']);
  });

  it('shows that a run is being chosen above the list, with a cancel button', () => {
    const { onSelect } = renderList(
      { kind: 'commit', sha: COMMITS[0]!.sha },
      { rangeStart: COMMITS[2]!.sha },
    );

    expect(screen.getByRole('status')).toHaveTextContent('범위 고르는 중');
    expect(previewed()).toEqual(['3333333']);
    expect(painted()).toEqual(['1111111pin the old behavior']);

    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ kind: 'cancel' });
  });

  it('shows no cancel button while no run is being chosen', () => {
    renderList();

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument();
  });

  it('keeps the list open in a drawer and names what is shown above it', () => {
    renderList({ kind: 'commit', sha: COMMITS[0]!.sha }, { inDrawer: true });

    expect(screen.queryByRole('button', { expanded: true })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '리뷰 범위의 커밋' })).toHaveTextContent(
      '커밋 4개1111111 pin the old behavior',
    );
    expect(list()).toBeInTheDocument();
  });
});

describe('CommitList reorder handle', () => {
  const handleLabel = '순서 바꾸기';
  const handles = () => screen.queryAllByRole('button', { name: handleLabel });
  const rowElement = (name: RegExp) => row(name).closest<HTMLElement>('[data-reorder-at]')!;
  const SHA = (digit: string) => digit.repeat(40);

  function renderReorderable({
    onReorder = vi.fn(async () => null),
    commits = COMMITS,
    inDrawer = false,
    onAddCommitComment,
  }: {
    onReorder?: ComponentProps<typeof CommitList>['onReorder'];
    commits?: ReviewCommit[];
    inDrawer?: boolean;
    onAddCommitComment?: (sha: string, body: string) => Promise<void>;
  } = {}) {
    const onSelect = vi.fn();
    render(
      <CommitList
        review={{ ...REVIEW, commits }}
        shown={{ kind: 'all' }}
        onSelect={onSelect}
        onReorder={onReorder}
        inDrawer={inDrawer}
        onAddCommitComment={onAddCommitComment}
      />,
    );
    return { onSelect, onReorder };
  }

  // The row's top half is y 0..4 and its bottom half 6..10 in these tests.
  function pointAt(element: Element | null) {
    document.elementFromPoint = vi.fn(() => element);
    if (element) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        height: 10,
      } as DOMRect);
    }
  }
  const grab = (index: number) => fireEvent.pointerDown(handles()[index]!, { button: 0 });
  const moveOver = (element: Element | null, y: number) => {
    pointAt(element);
    fireEvent.pointerMove(window, { clientX: 5, clientY: y });
  };
  const drop = (y = 0) => fireEvent.pointerUp(window, { clientX: 5, clientY: y });
  const dropLines = () => document.querySelectorAll('[data-drop-line]');

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'elementFromPoint');
  });

  it('shows no handle without a way to save, and none for a single commit', () => {
    renderList();
    expect(handles()).toEqual([]);
    cleanup();

    renderReorderable({ commits: [COMMITS[0]!] });
    expect(handles()).toEqual([]);
  });

  it('asks for the new order when a handle is dragged and dropped', async () => {
    const { onReorder, onSelect } = renderReorderable();

    grab(1);
    moveOver(rowElement(/4444444/), 8);
    await act(async () => {
      drop(8);
    });

    expect(onReorder).toHaveBeenCalledExactlyOnceWith({
      order: [SHA('1'), SHA('3'), SHA('4'), SHA('2')],
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('moves a commit up to before the row it is dropped on', async () => {
    const { onReorder } = renderReorderable();

    grab(3);
    moveOver(rowElement(/2222222/), 2);
    await act(async () => {
      drop(2);
    });

    expect(onReorder).toHaveBeenCalledWith({
      order: [SHA('1'), SHA('4'), SHA('2'), SHA('3')],
    });
  });

  it('still asks for a range when the row itself is dragged, and for no new order', () => {
    const { onReorder, onSelect } = renderReorderable();

    fireEvent.mouseDown(row(/2222222/), { button: 0 });
    fireEvent.mouseEnter(row(/4444444/));
    fireEvent.mouseUp(row(/4444444/));

    expect(onSelect).toHaveBeenCalledWith({
      kind: 'drop',
      fromSha: SHA('2'),
      toSha: SHA('4'),
    });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('draws where the commit will land while dragging and clears it after', async () => {
    renderReorderable();
    expect(dropLines()).toHaveLength(0);

    grab(0);
    moveOver(rowElement(/3333333/), 8);
    const line = dropLines();
    expect(line).toHaveLength(1);
    const lineRow = line[0]!.closest('li')!;
    expect(lineRow.nextElementSibling).toBe(rowElement(/4444444/));

    await act(async () => {
      drop(8);
    });
    expect(dropLines()).toHaveLength(0);
  });

  it('draws the line past the last row when dropping at the end', () => {
    renderReorderable();

    grab(0);
    moveOver(rowElement(/4444444/), 8);

    expect(dropLines()[0]!.closest('li')!.previousElementSibling).toBe(rowElement(/4444444/));
  });

  it('draws no line and asks nothing when dropped back on its own place', async () => {
    const { onReorder } = renderReorderable();

    grab(1);
    moveOver(rowElement(/2222222/), 8);
    expect(dropLines()).toHaveLength(0);
    moveOver(rowElement(/3333333/), 2);
    expect(dropLines()).toHaveLength(0);
    await act(async () => {
      drop(2);
    });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('asks nothing when dropped outside the list or when the drag is cancelled', async () => {
    const { onReorder } = renderReorderable();

    grab(1);
    moveOver(rowElement(/4444444/), 8);
    moveOver(document.body, 8);
    expect(dropLines()).toHaveLength(0);
    await act(async () => {
      drop(8);
    });

    grab(1);
    moveOver(rowElement(/4444444/), 8);
    fireEvent.pointerCancel(window);
    expect(dropLines()).toHaveLength(0);
    pointAt(rowElement(/4444444/));
    await act(async () => {
      drop(8);
    });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('puts a commit dropped on a branch row just before that merge', async () => {
    const merged = { sha: SHA('9'), shortSha: '9999999', subject: 'on the side' };
    const commits = [
      COMMITS[0]!,
      COMMITS[1]!,
      { ...COMMITS[2]!, subject: 'merge', isMerge: true as const, merged: [merged] },
    ];
    const { onReorder } = renderReorderable({ commits });

    expect(handles()).toHaveLength(3);
    grab(0);
    const side = within(list()).getByText('on the side').closest<HTMLElement>('[data-reorder-at]')!;
    moveOver(side, 8);
    await act(async () => {
      drop(8);
    });

    expect(onReorder).toHaveBeenCalledWith({ order: [SHA('2'), SHA('1'), SHA('3')] });
  });

  it('offers the handle in the phone drawer too', async () => {
    const { onReorder } = renderReorderable({ inDrawer: true });

    fireEvent.pointerDown(handles()[0]!, { button: 0, pointerType: 'touch' });
    moveOver(rowElement(/2222222/), 8);
    await act(async () => {
      drop(8);
    });

    expect(onReorder).toHaveBeenCalledWith({
      order: [SHA('2'), SHA('1'), SHA('3'), SHA('4')],
    });
  });

  it('shows a warning and goes ahead only once confirmed', async () => {
    const onReorder = vi
      .fn<NonNullable<ComponentProps<typeof CommitList>['onReorder']>>()
      .mockResolvedValueOnce({
        message: 'push한 커밋이 바뀝니다.',
        warnings: ['pushed-commit'],
      })
      .mockResolvedValueOnce(null);
    renderReorderable({ onReorder });

    grab(1);
    moveOver(rowElement(/3333333/), 8);
    await act(async () => {
      drop(8);
    });

    expect(screen.getByRole('alert')).toHaveTextContent('push한 커밋이 바뀝니다.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '그래도 옮기기' }));
    });

    expect(onReorder).toHaveBeenLastCalledWith({
      order: [SHA('1'), SHA('3'), SHA('2'), SHA('4')],
      acknowledged: ['pushed-commit'],
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('drops the warning on cancel and asks nothing more', async () => {
    const onReorder = vi.fn(async () => ({
      message: '기본 브랜치의 이력이 바뀝니다.',
      warnings: ['default-branch' as const],
    }));
    renderReorderable({ onReorder });

    grab(1);
    moveOver(rowElement(/3333333/), 8);
    await act(async () => {
      drop(8);
    });
    fireEvent.click(screen.getByRole('button', { name: '취소' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onReorder).toHaveBeenCalledTimes(1);
  });

  it('shows why a refused order was refused, with the output', async () => {
    const onReorder = vi.fn(async () => ({
      message: '순서를 바꾸면 충돌이 나서 옮기기 전 이력으로 되돌렸습니다.',
      output: 'CONFLICT (content): Merge conflict in a.ts',
    }));
    renderReorderable({ onReorder });

    grab(1);
    moveOver(rowElement(/3333333/), 8);
    await act(async () => {
      drop(8);
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('옮기기 전 이력으로 되돌렸습니다');
    expect(alert).toHaveTextContent('CONFLICT (content)');
    expect(screen.queryByRole('button', { name: '그래도 옮기기' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('turns the handles off while saving, and shows that it is saving', async () => {
    let finish: (value: null) => void = () => undefined;
    const onReorder = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          finish = resolve;
        }),
    );
    renderReorderable({ onReorder });

    grab(1);
    moveOver(rowElement(/3333333/), 8);
    await act(async () => {
      drop(8);
    });

    expect(screen.getByRole('status')).toHaveTextContent('옮기는 중…');
    expect(handles()[0]).toBeDisabled();
    await act(async () => {
      finish(null);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(handles()[0]).toBeEnabled();
  });

  it('turns the handles off while a comment on a commit is being written', () => {
    renderReorderable({ onAddCommitComment: async () => undefined });

    fireEvent.click(
      within(rowElement(/2222222/)).getByRole('button', { name: '커밋에 지적 달기' }),
    );

    expect(handles()[0]).toBeDisabled();
  });
});
