import type { SkillSummary } from '../../types/diff';

function isSkillSummary(value: unknown): value is SkillSummary {
  if (typeof value !== 'object' || value === null) return false;
  const fields = value as Record<string, unknown>;
  return typeof fields.name === 'string' && typeof fields.description === 'string';
}

let cachedSkills: Promise<SkillSummary[]> | null = null;

// Read once per page load; an empty list when there is no API server or the request fails.
export function fetchSkills(): Promise<SkillSummary[]> {
  cachedSkills ??= (async () => {
    try {
      const response = await fetch('/api/skills');
      if (!response?.ok) return [];
      const data: unknown = await response.json();
      return Array.isArray(data) ? data.filter(isSkillSummary) : [];
    } catch {
      return [];
    }
  })();
  return cachedSkills;
}

export function resetSkillsForTests(): void {
  cachedSkills = null;
}
