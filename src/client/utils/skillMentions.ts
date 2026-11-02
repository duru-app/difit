import type { SkillSummary } from '../../types/diff';

const NAME_CHAR = String.raw`[\w:-]`;

export interface SlashQuery {
  start: number;
  query: string;
}

// The `/word` the caret sits at the end of, when it starts a word.
export function slashQueryAt(text: string, caret: number): SlashQuery | null {
  const match = new RegExp(String.raw`(^|\s)/(${NAME_CHAR}*)$`).exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}

export function filterSkills(skills: readonly SkillSummary[], query: string): SkillSummary[] {
  const q = query.toLowerCase();
  const starts = skills.filter((s) => s.name.toLowerCase().startsWith(q));
  const contains = skills.filter(
    (s) => !s.name.toLowerCase().startsWith(q) && s.name.toLowerCase().includes(q),
  );
  return [...starts, ...contains];
}

export function insertSkill(
  text: string,
  slash: SlashQuery,
  name: string,
): { text: string; caret: number } {
  const end = slash.start + 1 + slash.query.length;
  const rest = text.slice(end);
  const inserted = `/${name}${/^\s/.test(rest) ? '' : ' '}`;
  return {
    text: text.slice(0, slash.start) + inserted + rest,
    caret: slash.start + inserted.length,
  };
}

export interface MentionSegment {
  text: string;
  skill: boolean;
}

// Splits the text so that every `/name` of a known skill is its own segment.
export function skillMentionSegments(text: string, known: ReadonlySet<string>): MentionSegment[] {
  const segments: MentionSegment[] = [];
  const pattern = new RegExp(String.raw`(^|\s)(/(${NAME_CHAR}+))(?!${NAME_CHAR})`, 'g');
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const name = match[3] ?? '';
    if (!known.has(name)) continue;
    const start = (match.index ?? 0) + (match[1] ?? '').length;
    if (start > last) segments.push({ text: text.slice(last, start), skill: false });
    segments.push({ text: match[2] ?? '', skill: true });
    last = start + (match[2] ?? '').length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), skill: false });
  return segments;
}
