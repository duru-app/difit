import { describe, expect, it } from 'vitest';

import type { SkillSummary } from '../../types/diff';
import { filterSkills, insertSkill, skillMentionSegments, slashQueryAt } from './skillMentions';

const skill = (name: string): SkillSummary => ({ name, description: '', source: 'user' });

describe('slashQueryAt', () => {
  it('finds the word after a slash at the start or after whitespace', () => {
    expect(slashQueryAt('/td', 3)).toEqual({ start: 0, query: 'td' });
    expect(slashQueryAt('see /', 5)).toEqual({ start: 4, query: '' });
    expect(slashQueryAt('a\n/codex:re', 11)).toEqual({ start: 2, query: 'codex:re' });
  });

  it('ignores slashes inside paths and words the caret has left', () => {
    expect(slashQueryAt('src/a', 5)).toBeNull();
    expect(slashQueryAt('/tdd now', 8)).toBeNull();
    expect(slashQueryAt('/tdd now', 4)).toEqual({ start: 0, query: 'tdd' });
  });
});

describe('filterSkills', () => {
  it('puts names that start with the query before names that contain it', () => {
    const skills = [skill('codex:rescue'), skill('review'), skill('code-review')];
    expect(filterSkills(skills, 're').map((s) => s.name)).toEqual([
      'review',
      'codex:rescue',
      'code-review',
    ]);
    expect(filterSkills(skills, 'RE').map((s) => s.name)).toEqual([
      'review',
      'codex:rescue',
      'code-review',
    ]);
    expect(filterSkills(skills, '')).toHaveLength(3);
  });
});

describe('insertSkill', () => {
  it('replaces the typed word and adds one space', () => {
    expect(insertSkill('fix /td', { start: 4, query: 'td' }, 'tdd')).toEqual({
      text: 'fix /tdd ',
      caret: 9,
    });
  });

  it('keeps a word that follows the caret', () => {
    expect(insertSkill('please /review', { start: 7, query: '' }, 'tdd')).toEqual({
      text: 'please /tdd review',
      caret: 12,
    });
  });

  it('does not add a second space when one already follows', () => {
    expect(insertSkill('/ here', { start: 0, query: '' }, 'tdd')).toEqual({
      text: '/tdd here',
      caret: 4,
    });
  });
});

describe('skillMentionSegments', () => {
  const known = new Set(['tdd', 'codex:rescue']);

  it('marks only known names that stand as their own word', () => {
    expect(skillMentionSegments('use /tdd, not /deep-research or a/tdd', known)).toEqual([
      { text: 'use ', skill: false },
      { text: '/tdd', skill: true },
      { text: ', not /deep-research or a/tdd', skill: false },
    ]);
  });

  it('does not mark a known name that continues into a longer word', () => {
    expect(skillMentionSegments('/tdd-extra', known)).toEqual([
      { text: '/tdd-extra', skill: false },
    ]);
  });

  it('marks names at the start and with a plugin prefix', () => {
    expect(skillMentionSegments('/codex:rescue\n/tdd', known)).toEqual([
      { text: '/codex:rescue', skill: true },
      { text: '\n', skill: false },
      { text: '/tdd', skill: true },
    ]);
  });
});
