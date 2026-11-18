import { fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DiffQuickMenu, getPreviousCommitPreset } from './DiffQuickMenu';

const options = {
  specialOptions: [
    { value: '.', label: 'All Uncommitted Changes' },
    { value: 'staged', label: 'Staging Area' },
    { value: 'working', label: 'Working Directory' },
  ],
  branches: [{ name: 'main', current: true }],
  commits: [
    {
      hash: '1f23cd1aaaaabbbbbcccccdddddeeeeefffff000',
      shortHash: '1f23cd1',
      message: 'chore: release v3.1.5',
    },
  ],
  originDefaultBranch: 'origin/main',
};

const FULL_SHA = '0b6a93f4a1c2d3e4f5061728394a5b6c7d8e9f01';

describe('getPreviousCommitPreset', () => {
  it.each(['', '.', 'staged', 'working'])('uses HEAD as target for %s', (targetRevision) => {
    expect(getPreviousCommitPreset(targetRevision)).toEqual({
      baseCommitish: 'HEAD^',
      targetCommitish: 'HEAD',
    });
  });

  it('uses selected target when it is already a commit-ish', () => {
    expect(getPreviousCommitPreset('HEAD')).toEqual({
      baseCommitish: 'HEAD^^',
      targetCommitish: 'HEAD^',
    });

    expect(getPreviousCommitPreset('main')).toEqual({
      baseCommitish: 'main^^',
      targetCommitish: 'main^',
    });

    expect(getPreviousCommitPreset('abc1234')).toEqual({
      baseCommitish: 'abc1234^^',
      targetCommitish: 'abc1234^',
    });
  });
});

describe('DiffQuickMenu', () => {
  it('shows commit label when previous-pair target resolves to a listed commit', () => {
    render(
      createElement(DiffQuickMenu, {
        options,
        selection: { baseCommitish: 'HEAD^^', targetCommitish: 'HEAD^' },
        resolvedBaseRevision: '88aabb0',
        resolvedTargetRevision: '1f23cd1',
        onSelectDiff: vi.fn(),
        onOpenAdvanced: vi.fn(),
      }),
    );

    expect(screen.getByText('1f23cd1 chore: release v3.1.5')).toBeInTheDocument();
  });

  it('highlights resolved commit in Pick Commit list for previous-pair selection', async () => {
    render(
      createElement(DiffQuickMenu, {
        options,
        selection: { baseCommitish: 'HEAD^^', targetCommitish: 'HEAD^' },
        resolvedBaseRevision: '88aabb0',
        resolvedTargetRevision: '1f23cd1',
        onSelectDiff: vi.fn(),
        onOpenAdvanced: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Revision menu:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick Commit...' }));

    const commitButtons = await screen.findAllByRole('button', {
      name: /1f23cd1/,
    });
    const highlightedCommitButton = commitButtons.find((button) =>
      button.className.includes('border-l-diff-selected-border'),
    );
    expect(highlightedCommitButton).toBeDefined();
  });

  it('shows only requested quick diff presets', () => {
    render(
      createElement(DiffQuickMenu, {
        options,
        selection: { baseCommitish: 'HEAD', targetCommitish: '.' },
        onSelectDiff: vi.fn(),
        onOpenAdvanced: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Revision menu:/ }));

    expect(
      screen.getByRole('button', { name: 'HEAD...Uncommitted (merge-base)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'main...Uncommitted (merge-base)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'origin/main...Uncommitted (merge-base)',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'HEAD' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'HEAD...Staging' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Staging...Working' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'main...HEAD' })).not.toBeInTheDocument();
  });

  it('places HEAD at the top of quick diffs', () => {
    render(
      createElement(DiffQuickMenu, {
        options,
        selection: { baseCommitish: 'HEAD', targetCommitish: '.' },
        onSelectDiff: vi.fn(),
        onOpenAdvanced: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Revision menu:/ }));

    const quickDiffSection = screen.getByText('Quick Diffs').parentElement;
    expect(quickDiffSection).not.toBeNull();

    const quickDiffButtons = within(quickDiffSection!).getAllByRole('button');
    expect(quickDiffButtons[0]).toHaveTextContent('HEAD');
  });

  it('selects HEAD commit when HEAD quick preset is clicked', () => {
    const onSelectDiff = vi.fn();
    render(
      createElement(DiffQuickMenu, {
        options,
        selection: { baseCommitish: 'HEAD', targetCommitish: '.' },
        onSelectDiff,
        onOpenAdvanced: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Revision menu:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'HEAD' }));

    expect(onSelectDiff).toHaveBeenCalledWith({
      baseCommitish: 'HEAD^',
      targetCommitish: 'HEAD',
    });
  });

  it('selects origin/main merge-base quick preset when available', () => {
    const onSelectDiff = vi.fn();
    render(
      createElement(DiffQuickMenu, {
        options,
        selection: { baseCommitish: 'HEAD', targetCommitish: '.' },
        onSelectDiff,
        onOpenAdvanced: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Revision menu:/ }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'origin/main...Uncommitted (merge-base)',
      }),
    );

    expect(onSelectDiff).toHaveBeenCalledWith({
      baseCommitish: 'origin/main',
      targetCommitish: '.',
      baseMode: 'merge-base',
    });
  });

  it('filters the menu down to matching commits when typing in the search box', () => {
    render(
      createElement(DiffQuickMenu, {
        options,
        selection: { baseCommitish: 'HEAD', targetCommitish: '.' },
        onSelectDiff: vi.fn(),
        onOpenAdvanced: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Revision menu:/ }));
    fireEvent.change(screen.getByPlaceholderText('Filter branches and commits...'), {
      target: { value: 'release' },
    });

    expect(screen.getByRole('button', { name: /1f23cd1/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'HEAD' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pick Commit...' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Detailed...' })).not.toBeInTheDocument();
  });

  it('selects commit^...commit when a filtered commit is clicked', () => {
    const onSelectDiff = vi.fn();
    render(
      createElement(DiffQuickMenu, {
        options,
        selection: { baseCommitish: 'HEAD', targetCommitish: '.' },
        onSelectDiff,
        onOpenAdvanced: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Revision menu:/ }));
    fireEvent.change(screen.getByPlaceholderText('Filter branches and commits...'), {
      target: { value: 'release' },
    });
    fireEvent.click(screen.getByRole('button', { name: /1f23cd1/ }));

    expect(onSelectDiff).toHaveBeenCalledWith({
      baseCommitish: '1f23cd1^',
      targetCommitish: '1f23cd1',
    });
  });

  it('selects branch...Uncommitted (merge-base) when a filtered branch is clicked', () => {
    const onSelectDiff = vi.fn();
    render(
      createElement(DiffQuickMenu, {
        options,
        selection: { baseCommitish: 'HEAD', targetCommitish: '.' },
        onSelectDiff,
        onOpenAdvanced: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Revision menu:/ }));
    fireEvent.change(screen.getByPlaceholderText('Filter branches and commits...'), {
      target: { value: 'main' },
    });

    const branchesSection = screen.getByText('Branches').parentElement;
    expect(branchesSection).not.toBeNull();
    fireEvent.click(
      within(branchesSection!).getByRole('button', {
        name: /main \(current\)/,
      }),
    );

    expect(onSelectDiff).toHaveBeenCalledWith({
      baseCommitish: 'main',
      targetCommitish: '.',
      baseMode: 'merge-base',
    });
  });

  it('selects the first match when pressing Enter in the search box', () => {
    const onSelectDiff = vi.fn();
    render(
      createElement(DiffQuickMenu, {
        options,
        selection: { baseCommitish: 'HEAD', targetCommitish: '.' },
        onSelectDiff,
        onOpenAdvanced: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Revision menu:/ }));
    const searchInput = screen.getByPlaceholderText('Filter branches and commits...');
    fireEvent.change(searchInput, { target: { value: 'v3.1.5' } });
    fireEvent.keyDown(searchInput, { key: 'Enter' });

    expect(onSelectDiff).toHaveBeenCalledWith({
      baseCommitish: '1f23cd1^',
      targetCommitish: '1f23cd1',
    });
  });

  it('shows an empty state when nothing matches the search query', () => {
    render(
      createElement(DiffQuickMenu, {
        options,
        selection: { baseCommitish: 'HEAD', targetCommitish: '.' },
        onSelectDiff: vi.fn(),
        onOpenAdvanced: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Revision menu:/ }));
    fireEvent.change(screen.getByPlaceholderText('Filter branches and commits...'), {
      target: { value: 'does-not-exist' },
    });

    expect(screen.getByText('No matching branches or commits')).toBeInTheDocument();
  });

  it.each([
    [
      'a target missing from the commit list',
      { baseCommitish: '1f23cd1', targetCommitish: FULL_SHA },
      '1f23cd1...0b6a93f',
    ],
    [
      'a base missing from the commit list',
      { baseCommitish: FULL_SHA, targetCommitish: '1f23cd1' },
      '0b6a93f...1f23cd1',
    ],
    [
      'a parent of a commit missing from the commit list',
      { baseCommitish: `${FULL_SHA}^`, targetCommitish: 'main' },
      '0b6a93f^...main',
    ],
  ])('shortens %s in the current label', (_case, selection, label) => {
    render(
      createElement(DiffQuickMenu, {
        options,
        selection,
        onSelectDiff: vi.fn(),
        onOpenAdvanced: vi.fn(),
      }),
    );

    expect(screen.getByRole('button', { name: `Revision menu: ${label}` })).toBeInTheDocument();
  });

  it('keeps a ref name missing from the commit list as written', () => {
    render(
      createElement(DiffQuickMenu, {
        options,
        selection: { baseCommitish: 'v3.1.5', targetCommitish: 'release/next' },
        onSelectDiff: vi.fn(),
        onOpenAdvanced: vi.fn(),
      }),
    );

    expect(
      screen.getByRole('button', { name: 'Revision menu: v3.1.5...release/next' }),
    ).toBeInTheDocument();
  });

  it('shows merge-base in the current label', () => {
    render(
      createElement(DiffQuickMenu, {
        options,
        selection: {
          baseCommitish: 'origin/main',
          targetCommitish: '.',
          baseMode: 'merge-base',
        },
        onSelectDiff: vi.fn(),
        onOpenAdvanced: vi.fn(),
      }),
    );

    expect(
      screen.getByRole('button', {
        name: 'Revision menu: origin/main...Uncommitted Changes (merge-base)',
      }),
    ).toBeInTheDocument();
  });
});
