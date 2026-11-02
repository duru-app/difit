import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BUILT_IN_SKILLS, listSkills } from './skills';

let root: string;
let claudeDir: string;
let repoPath: string;

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

function skillFile(name: string, description: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody\n`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'difit-skills-'));
  claudeDir = join(root, 'claude');
  repoPath = join(root, 'repo');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('listSkills', () => {
  it('lists only the built-in skills when no folder exists', async () => {
    expect(await listSkills({ claudeDir, repoPath })).toEqual(BUILT_IN_SKILLS);
  });

  it('reads user and repository skills and commands with the first description line', async () => {
    await put(
      join(claudeDir, 'skills', 'tdd', 'SKILL.md'),
      skillFile('tdd', '"Test first.\\nSecond line"'),
    );
    await put(
      join(claudeDir, 'commands', 'amend.md'),
      '---\ndescription: Amend the last commit\n---\nbody',
    );
    await put(
      join(repoPath, '.claude', 'skills', 'difit-dev', 'SKILL.md'),
      skillFile('difit-dev', 'Dev review'),
    );
    await put(join(repoPath, '.claude', 'commands', 'release.md'), 'no frontmatter');

    const skills = await listSkills({ claudeDir, repoPath });

    expect(skills.filter((s) => s.source !== 'built-in')).toEqual([
      { name: 'difit-dev', description: 'Dev review', source: 'repository' },
      { name: 'release', description: 'no frontmatter', source: 'repository' },
      { name: 'tdd', description: 'Test first.', source: 'user' },
      { name: 'amend', description: 'Amend the last commit', source: 'user' },
    ]);
  });

  it('leaves out skills marked as not user-invocable and folders without SKILL.md', async () => {
    await put(
      join(claudeDir, 'skills', 'hidden', 'SKILL.md'),
      skillFile('hidden', 'x', 'user-invocable: false\n'),
    );
    await put(join(claudeDir, 'skills', 'empty', 'README.md'), 'nothing');

    const names = (await listSkills({ claudeDir, repoPath })).map((s) => s.name);

    expect(names).not.toContain('hidden');
    expect(names).not.toContain('empty');
  });

  it('prefixes skills of enabled plugins with the plugin name and skips disabled ones', async () => {
    const codex = join(root, 'cache', 'codex');
    const off = join(root, 'cache', 'off');
    await put(
      join(codex, 'skills', 'runtime', 'SKILL.md'),
      skillFile('codex-cli-runtime', 'Runtime'),
    );
    await put(join(codex, 'commands', 'rescue.md'), '---\ndescription: Rescue\n---\n');
    await put(join(off, 'skills', 'nope', 'SKILL.md'), skillFile('nope', 'Off'));
    await put(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'codex@openai-codex': [{ scope: 'user', installPath: codex }],
          'off@market': [{ scope: 'user', installPath: off }],
        },
      }),
    );
    await put(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'codex@openai-codex': true, 'off@market': false } }),
    );

    const plugins = (await listSkills({ claudeDir, repoPath })).filter(
      (s) => s.source === 'plugin',
    );

    expect(plugins).toEqual([
      { name: 'codex:codex-cli-runtime', description: 'Runtime', source: 'plugin' },
      { name: 'codex:rescue', description: 'Rescue', source: 'plugin' },
    ]);
  });

  it('lets the repository settings switch plugins on and off over the user settings', async () => {
    const on = join(root, 'cache', 'on');
    const off = join(root, 'cache', 'off');
    await put(join(on, 'commands', 'go.md'), 'Go now');
    await put(join(off, 'commands', 'stop.md'), 'Stop now');
    await put(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'on@m': [{ installPath: on }],
          'off@m': [{ installPath: off }],
        },
      }),
    );
    await put(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'off@m': true } }),
    );
    await put(
      join(repoPath, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'on@m': true } }),
    );
    await put(
      join(repoPath, '.claude', 'settings.local.json'),
      JSON.stringify({ enabledPlugins: { 'off@m': false } }),
    );

    const plugins = (await listSkills({ claudeDir, repoPath })).filter(
      (s) => s.source === 'plugin',
    );

    expect(plugins).toEqual([{ name: 'on:go', description: 'Go now', source: 'plugin' }]);
  });

  it('uses the install made for this repository or for the user, never one for another project', async () => {
    const mine = join(root, 'cache', 'mine');
    const other = join(root, 'cache', 'other');
    await put(join(mine, 'commands', 'go.md'), 'Mine');
    await put(join(other, 'commands', 'go.md'), 'Other');
    await put(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'foo@m': [
            { scope: 'project', projectPath: join(root, 'elsewhere'), installPath: other },
            { scope: 'project', projectPath: repoPath, installPath: mine },
          ],
          'bar@m': [{ scope: 'project', projectPath: join(root, 'elsewhere'), installPath: other }],
        },
      }),
    );
    await put(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'foo@m': true, 'bar@m': true } }),
    );

    const plugins = (await listSkills({ claudeDir, repoPath })).filter(
      (s) => s.source === 'plugin',
    );

    expect(plugins).toEqual([{ name: 'foo:go', description: 'Mine', source: 'plugin' }]);
  });

  it('gives a skill without a description an empty one and reads a file that starts with a byte order mark', async () => {
    await put(join(claudeDir, 'skills', 'plain', 'SKILL.md'), '---\nname: plain\n---\n# Heading\n');
    await put(
      join(claudeDir, 'skills', 'bom', 'SKILL.md'),
      '\uFEFF' + skillFile('bom', 'With mark'),
    );

    const skills = await listSkills({ claudeDir, repoPath });

    expect(skills.find((s) => s.name === 'plain')?.description).toBe('');
    expect(skills.find((s) => s.name === 'bom')?.description).toBe('With mark');
  });

  it('keeps the first of two entries with the same name', async () => {
    await put(
      join(repoPath, '.claude', 'skills', 'code-review', 'SKILL.md'),
      skillFile('code-review', 'Repo version'),
    );

    const reviews = (await listSkills({ claudeDir, repoPath })).filter(
      (s) => s.name === 'code-review',
    );

    expect(reviews).toEqual([
      { name: 'code-review', description: 'Repo version', source: 'repository' },
    ]);
  });

  it('ignores broken settings and frontmatter', async () => {
    await put(join(claudeDir, 'settings.json'), '{ not json');
    await put(join(claudeDir, 'skills', 'odd', 'SKILL.md'), '---\n: : bad\n---\n');

    const skills = await listSkills({ claudeDir, repoPath });

    expect(skills.find((s) => s.name === 'odd')).toEqual({
      name: 'odd',
      description: '',
      source: 'user',
    });
  });
});
