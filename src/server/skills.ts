import { readdir, readFile } from 'fs/promises';
import { load } from 'js-yaml';
import { homedir } from 'os';
import { basename, join } from 'path';

import type { SkillSummary } from '../types/diff.js';

// Lists what a Claude Code session started in the reviewed repository can call with `/name`,
// read from the files the session itself loads.

export interface SkillLocations {
  claudeDir: string;
  repoPath: string;
}

export function skillLocations(
  repoPath: string,
  env: NodeJS.ProcessEnv = process.env,
): SkillLocations {
  return { claudeDir: env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), repoPath };
}

// Shipped inside Claude Code, so there is no file to read them from.
export const BUILT_IN_SKILLS: readonly SkillSummary[] = [
  {
    name: 'code-review',
    description: 'Review the current diff for correctness bugs',
    source: 'built-in',
  },
  {
    name: 'simplify',
    description: 'Review the changed code for reuse and simplification, then apply the fixes',
    source: 'built-in',
  },
  {
    name: 'security-review',
    description: 'Security review of the pending changes on the current branch',
    source: 'built-in',
  },
  {
    name: 'init',
    description: 'Initialize a new CLAUDE.md file with codebase documentation',
    source: 'built-in',
  },
];

interface Frontmatter {
  name?: string;
  description?: string;
  body: string;
  userInvocable: boolean;
}

function firstLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
}

function readFrontmatter(file: string): Frontmatter {
  const text = file.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const body = match ? text.slice(match[0].length) : text;
  let data: unknown;
  try {
    data = match ? load(match[1] ?? '') : undefined;
  } catch {
    data = undefined;
  }
  const fields = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const description =
    typeof fields.description === 'string' ? firstLine(fields.description) : undefined;
  return {
    ...(typeof fields.name === 'string' && fields.name.trim() ? { name: fields.name.trim() } : {}),
    ...(description ? { description } : {}),
    body,
    userInvocable: fields['user-invocable'] !== false,
  };
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}

async function readSkillsDir(
  dir: string,
  source: SkillSummary['source'],
  prefix: string,
): Promise<SkillSummary[]> {
  const skills: SkillSummary[] = [];
  for (const entry of await listDir(dir)) {
    const text = await readText(join(dir, entry, 'SKILL.md'));
    if (text === null) continue;
    const meta = readFrontmatter(text);
    if (!meta.userInvocable) continue;
    skills.push({
      name: prefix + (meta.name ?? entry),
      description: meta.description ?? '',
      source,
    });
  }
  return skills;
}

async function readCommandsDir(
  dir: string,
  source: SkillSummary['source'],
  prefix: string,
): Promise<SkillSummary[]> {
  const commands: SkillSummary[] = [];
  for (const entry of await listDir(dir)) {
    if (!entry.endsWith('.md')) continue;
    const text = await readText(join(dir, entry));
    if (text === null) continue;
    const meta = readFrontmatter(text);
    commands.push({
      name: prefix + basename(entry, '.md'),
      description: meta.description ?? firstLine(meta.body) ?? '',
      source,
    });
  }
  return commands;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    const data: unknown = JSON.parse(text);
    return typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface InstallRecord {
  installPath: string;
  projectPath?: string;
}

function isInstallRecord(value: unknown): value is InstallRecord {
  if (typeof value !== 'object' || value === null) return false;
  const fields = value as Record<string, unknown>;
  return (
    typeof fields.installPath === 'string' &&
    (fields.projectPath === undefined || typeof fields.projectPath === 'string')
  );
}

// The repository's settings override the user's, and its local file overrides both.
async function enabledPluginPaths(
  locations: SkillLocations,
): Promise<{ name: string; path: string }[]> {
  const { claudeDir, repoPath } = locations;
  const settingsFiles = await Promise.all([
    readJson(join(claudeDir, 'settings.json')),
    readJson(join(repoPath, '.claude', 'settings.json')),
    readJson(join(repoPath, '.claude', 'settings.local.json')),
  ]);
  const enabled: Record<string, unknown> = {};
  for (const settings of settingsFiles) {
    const layer = settings?.enabledPlugins;
    if (typeof layer === 'object' && layer !== null) Object.assign(enabled, layer);
  }
  const installed = await readJson(join(claudeDir, 'plugins', 'installed_plugins.json'));
  const plugins = installed?.plugins;
  if (typeof plugins !== 'object' || plugins === null) return [];

  const paths: { name: string; path: string }[] = [];
  for (const [id, records] of Object.entries(plugins as Record<string, unknown>)) {
    if (enabled[id] !== true || !Array.isArray(records)) continue;
    const installs = records.filter(isInstallRecord);
    const install =
      installs.find((r) => r.projectPath === repoPath) ??
      installs.find((r) => r.projectPath === undefined);
    if (!install) continue;
    paths.push({ name: id.split('@')[0] ?? id, path: install.installPath });
  }
  return paths.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listSkills(locations: SkillLocations): Promise<SkillSummary[]> {
  const { claudeDir, repoPath } = locations;
  const groups = await Promise.all([
    readSkillsDir(join(repoPath, '.claude', 'skills'), 'repository', ''),
    readCommandsDir(join(repoPath, '.claude', 'commands'), 'repository', ''),
    readSkillsDir(join(claudeDir, 'skills'), 'user', ''),
    readCommandsDir(join(claudeDir, 'commands'), 'user', ''),
    enabledPluginPaths(locations).then(async (plugins) =>
      (
        await Promise.all(
          plugins.flatMap(({ name, path }) => [
            readSkillsDir(join(path, 'skills'), 'plugin', `${name}:`),
            readCommandsDir(join(path, 'commands'), 'plugin', `${name}:`),
          ]),
        )
      ).flat(),
    ),
  ]);

  const seen = new Set<string>();
  const skills: SkillSummary[] = [];
  for (const skill of [...groups.flat(), ...BUILT_IN_SKILLS]) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    skills.push(skill);
  }
  return skills;
}
