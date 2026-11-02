import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { SkillSummary } from '../../types/diff';
import { fetchSkills } from '../services/skills';
import {
  filterSkills,
  insertSkill,
  type SlashQuery,
  skillMentionSegments,
  slashQueryAt,
} from '../utils/skillMentions';

type TextareaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>;

interface SkillTextareaProps extends TextareaProps {
  value: string;
  onValueChange: (value: string) => void;
}

const MAX_ITEMS = 8;

const TYPING = new Set(['insertText', 'insertCompositionText']);

// Same box metrics as the textarea, so the marks behind it line up with its text.
const BOX = 'border border-transparent px-3 py-2 text-sm leading-6';

export function SkillTextarea({
  value,
  onValueChange,
  onKeyDown,
  className = '',
  ...props
}: SkillTextareaProps) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [slash, setSlash] = useState<SlashQuery | null>(null);
  const [active, setActive] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    let alive = true;
    void fetchSkills().then((list) => {
      if (alive) setSkills(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  const known = useMemo(() => new Set(skills.map((s) => s.name)), [skills]);
  const segments = useMemo(() => skillMentionSegments(value, known), [value, known]);
  const items = useMemo(() => {
    if (!slash || known.has(slash.query)) return [];
    return filterSkills(skills, slash.query).slice(0, MAX_ITEMS);
  }, [skills, known, slash]);
  const open = items.length > 0;
  const activeIndex = Math.min(active, items.length - 1);

  // The textarea's scrollbar narrows its text; the backdrop leaves the same room on the right.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const backdrop = backdropRef.current;
    if (!textarea || !backdrop) return;
    const fit = () => {
      const bar = textarea.offsetWidth - textarea.clientWidth - textarea.clientLeft * 2;
      backdrop.style.paddingRight = bar > 0 ? `calc(0.75rem + ${bar}px)` : '';
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(textarea);
    return () => observer.disconnect();
  });

  const follow = (text: string, caret: number, typed: boolean) => {
    const found = slashQueryAt(text, caret);
    if (found?.start === slash?.start && found?.query === slash?.query) return;
    setSlash(typed ? found : null);
    setActive(0);
  };

  const choose = (skill: SkillSummary) => {
    if (!slash) return;
    const next = insertSkill(value, slash, skill.name);
    onValueChange(next.text);
    setSlash(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + step + items.length) % items.length);
        return;
      }
      const plainEnter = e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey;
      if (plainEnter || e.key === 'Tab') {
        e.preventDefault();
        const skill = items[activeIndex];
        if (skill) choose(skill);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setSlash(null);
        return;
      }
      if (e.key === 'Enter') setSlash(null);
    }
    onKeyDown?.(e);
  };

  return (
    <div className="relative mb-2 rounded bg-github-bg-secondary">
      <div
        ref={backdropRef}
        aria-hidden="true"
        data-skill-backdrop="true"
        className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-transparent ${BOX}`}
      >
        {segments.map((segment, i) =>
          segment.skill ? (
            <mark key={i} className="rounded-sm bg-blue-500/25 text-transparent">
              {segment.text}
            </mark>
          ) : (
            <span key={i}>{segment.text}</span>
          ),
        )}
        {/* A text ending in a newline still shows that empty line. */}{' '}
      </div>
      <textarea
        {...props}
        ref={textareaRef}
        className={`relative block w-full bg-transparent ${className}`}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          const { inputType } = e.nativeEvent as Partial<InputEvent>;
          const typed = inputType === undefined || TYPING.has(inputType);
          const caret = e.target.selectionStart;
          const found = slashQueryAt(e.target.value, caret);
          const shortened =
            slash !== null && found?.start === slash.start && slash.query.startsWith(found.query);
          follow(e.target.value, caret, typed || shortened);
        }}
        onSelect={(e) => follow(e.currentTarget.value, e.currentTarget.selectionStart, false)}
        onBlur={() => setSlash(null)}
        onScroll={(e) => {
          if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={handleKeyDown}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="스킬"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-md border border-github-border bg-github-bg-primary py-1 shadow-lg"
        >
          {items.map((skill, i) => (
            <li
              key={skill.name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(skill);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer gap-2 px-3 py-1.5 text-sm ${
                i === activeIndex ? 'bg-blue-500/15' : ''
              }`}
            >
              <span className="shrink-0 font-mono text-github-text-primary">/{skill.name}</span>
              <span className="min-w-0 truncate text-github-text-secondary">
                {skill.description}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
