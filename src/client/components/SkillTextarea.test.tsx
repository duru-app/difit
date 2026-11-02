import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SkillSummary } from '../../types/diff';
import { resetSkillsForTests } from '../services/skills';
import { CommentForm } from './CommentForm';

const SKILLS: SkillSummary[] = [
  { name: 'tdd', description: 'Test-driven development', source: 'user' },
  { name: 'grill-me', description: 'Interview the user', source: 'user' },
  { name: 'codex:rescue', description: 'Delegate to Codex', source: 'plugin' },
];

function serveSkills(skills: SkillSummary[] | null) {
  vi.mocked(global.fetch).mockImplementation(async (url) => {
    if (String(url) === '/api/skills' && skills) {
      return new Response(JSON.stringify(skills), { status: 200 });
    }
    return new Response('', { status: 404 });
  });
}

async function renderForm() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  render(<CommentForm onSubmit={onSubmit} onCancel={onCancel} />);
  await act(async () => {});
  const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
  return { onSubmit, onCancel, textarea };
}

function type(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, {
    target: { value, selectionStart: value.length, selectionEnd: value.length },
  });
}

function moveCaret(textarea: HTMLTextAreaElement, position: number) {
  fireEvent.focusIn(textarea);
  textarea.setSelectionRange(position, position);
  fireEvent.keyUp(textarea, { key: 'ArrowLeft' });
}

function erase(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.input(textarea, {
    target: { value, selectionStart: value.length, selectionEnd: value.length },
    inputType: 'deleteContentBackward',
  });
}

function options() {
  return screen.queryAllByRole('option').map((o) => o.textContent);
}

beforeEach(() => {
  resetSkillsForTests();
});

afterEach(() => {
  vi.mocked(global.fetch).mockReset();
});

describe('skill list in the comment box', () => {
  it('opens on a slash and narrows as more letters are typed', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, 'please /');
    expect(options()).toHaveLength(3);

    type(textarea, 'please /gr');
    expect(options()).toEqual(['/grill-meInterview the user']);
  });

  it('does not open for a slash inside a path', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, 'src/');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('picks with the arrow keys and Enter without submitting', async () => {
    serveSkills(SKILLS);
    const { textarea, onSubmit } = await renderForm();

    type(textarea, '/');
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(textarea).toHaveValue('/grill-me ');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('wraps from the first item to the last with the up key', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, '/');
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });

    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('/codex:rescue');
  });

  it('picks with a click', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, 'fix this /td');
    const option = screen.getByRole('option', { name: /tdd/ });
    fireEvent.mouseDown(option);
    fireEvent.mouseUp(textarea);

    expect(textarea).toHaveValue('fix this /tdd ');
  });

  it('closes the list on Escape and cancels only on the next Escape', async () => {
    serveSkills(SKILLS);
    const { textarea, onCancel } = await renderForm();

    type(textarea, '/');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('submits on Enter once the list is closed, with the name as plain text', async () => {
    serveSkills(SKILLS);
    const { textarea, onSubmit } = await renderForm();

    type(textarea, '/tdd write the test first');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith('/tdd write the test first');
  });

  it('submits on Ctrl+Enter even while the list is open', async () => {
    serveSkills(SKILLS);
    const { textarea, onSubmit } = await renderForm();

    type(textarea, 'run /td');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    expect(onSubmit).toHaveBeenCalledWith('run /td');
    await act(async () => {});
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keeps the list closed after Escape until something is typed', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, 'see /t');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    moveCaret(textarea, 5);
    moveCaret(textarea, 6);
    expect(screen.queryByRole('listbox')).toBeNull();

    type(textarea, 'see /td');
    expect(options()).toEqual(['/tddTest-driven development']);
  });

  it('closes the list when the caret leaves the slash word and does not reopen it on return', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, 'run /td');
    moveCaret(textarea, 0);
    expect(screen.queryByRole('listbox')).toBeNull();

    moveCaret(textarea, 7);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('sends on Enter after the caret goes back into a written skill name', async () => {
    serveSkills(SKILLS);
    const { textarea, onSubmit } = await renderForm();

    type(textarea, 'run /tdd now');
    moveCaret(textarea, 7);
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith('run /tdd now');
  });

  it('keeps the word after the caret when a slash is typed in front of it', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    fireEvent.change(textarea, {
      target: { value: 'please /review', selectionStart: 8, selectionEnd: 8 },
    });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(textarea).toHaveValue('please /tdd review');
  });

  it('keeps the highlighted item while the caret stays in the same word', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, '/');
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    moveCaret(textarea, 1);

    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('/grill-me');
  });

  it('does not open for a name that is already complete', async () => {
    serveSkills(SKILLS);
    const { textarea, onSubmit } = await renderForm();

    type(textarea, 'run /tdd');
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('run /tdd');
  });

  it('closes for a complete name even when a longer name starts with it, and reopens on the next letter', async () => {
    serveSkills([...SKILLS, { name: 'tdd-strict', description: 'Stricter', source: 'user' }]);
    const { textarea } = await renderForm();

    type(textarea, '/tdd');
    expect(screen.queryByRole('listbox')).toBeNull();

    type(textarea, '/tdd-');
    expect(options()).toEqual(['/tdd-strictStricter']);
  });

  it('does not open when deleting back into a slash word', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, 'run /gr now');
    erase(textarea, 'run /gr');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keeps an open list open while deleting inside the word', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, 'run /gri');
    erase(textarea, 'run /gr');
    expect(options()).toEqual(['/grill-meInterview the user']);
  });

  it('opens for a typed character and not for a paste', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    fireEvent.input(textarea, {
      target: { value: 'see /co', selectionStart: 7, selectionEnd: 7 },
      inputType: 'insertFromPaste',
    });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.input(textarea, {
      target: { value: 'see /cod', selectionStart: 8, selectionEnd: 8 },
      inputType: 'insertText',
    });
    expect(options()).toEqual(['/codex:rescueDelegate to Codex']);
  });

  it('does not open for a paste while a list is already open', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, 'run /gr');
    fireEvent.input(textarea, {
      target: { value: 'run /co', selectionStart: 7, selectionEnd: 7 },
      inputType: 'insertFromPaste',
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('sends on Enter for a complete name that other names contain', async () => {
    serveSkills([
      ...SKILLS,
      { name: 'review', description: 'Review', source: 'user' },
      { name: 'code-review', description: 'Code review', source: 'built-in' },
    ]);
    const { textarea, onSubmit } = await renderForm();

    type(textarea, 'run /review');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith('run /review');
  });

  it('offers the real name for a name typed in other case', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, '/TDD');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(textarea).toHaveValue('/tdd ');
  });

  it('does not move an open list to another word after a cut', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, '/grill x /gr');
    fireEvent.input(textarea, {
      target: { value: '/grill', selectionStart: 6, selectionEnd: 6 },
      inputType: 'deleteByCut',
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not move an open list to another word after deleting a selection', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, '/grill x /gr');
    erase(textarea, '/grill');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('reopens the list when erasing right after a complete name', async () => {
    serveSkills([
      ...SKILLS,
      { name: 'review', description: 'Review', source: 'user' },
      { name: 'code-review', description: 'Code review', source: 'built-in' },
    ]);
    const { textarea } = await renderForm();

    type(textarea, '/review');
    expect(screen.queryByRole('listbox')).toBeNull();

    erase(textarea, '/revie');
    expect(options()).toEqual(['/reviewReview', '/code-reviewCode review']);
  });

  it('marks known names while typing and leaves unknown ones unmarked', async () => {
    serveSkills(SKILLS);
    const { textarea } = await renderForm();

    type(textarea, 'use /tdd and /deep-research');

    const marks = document.querySelectorAll('[data-skill-backdrop] mark');
    expect([...marks].map((m) => m.textContent)).toEqual(['/tdd']);
  });

  it('behaves as a plain box when no skill can be read', async () => {
    serveSkills(null);
    const { textarea, onSubmit } = await renderForm();

    type(textarea, '/tdd');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.querySelectorAll('[data-skill-backdrop] mark')).toHaveLength(0);

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('/tdd');
  });
});
