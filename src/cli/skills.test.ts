import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import pkg from '../../package.json' with { type: 'json' };

import { getClaudeConfigDir, installBundledSkills } from './skills.js';

const RELEASE = '5.0.12-inteh.50';

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

describe('installBundledSkills', () => {
  let root: string;
  let packageRoot: string;
  let claudeDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'difit-skills-'));
    packageRoot = join(root, 'package');
    claudeDir = join(root, 'claude');
    writeFiles(join(packageRoot, 'skills'), {
      'difit/SKILL.md': 'new difit',
      'difit/agents/openai.yaml': 'difit agent',
      'difit-review/SKILL.md': 'new review',
    });
    mkdirSync(claudeDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const install = (options: { selfVersion?: string; env?: NodeJS.ProcessEnv } = {}) =>
    installBundledSkills({
      selfVersion: RELEASE,
      env: {},
      packageRoot,
      claudeDir,
      ...options,
    });

  it('copies every bundled skill into the skills folder', () => {
    expect(install().sort()).toEqual(['difit', 'difit-review']);
    expect(readFileSync(join(claudeDir, 'skills/difit/SKILL.md'), 'utf8')).toBe('new difit');
    expect(readFileSync(join(claudeDir, 'skills/difit/agents/openai.yaml'), 'utf8')).toBe(
      'difit agent',
    );
    expect(readFileSync(join(claudeDir, 'skills/difit-review/SKILL.md'), 'utf8')).toBe(
      'new review',
    );
    expect(readdirSync(join(claudeDir, 'skills')).sort()).toEqual(['difit', 'difit-review']);
    expect(readdirSync(claudeDir)).toEqual(['skills']);
  });

  it('replaces an older copy, dropping files the new one does not have', () => {
    writeFiles(join(claudeDir, 'skills'), {
      'difit/SKILL.md': 'old difit',
      'difit/agents/openai.yaml': 'difit agent',
      'difit/notes.md': 'left over',
      'difit-review/SKILL.md': 'new review',
    });

    expect(install()).toEqual(['difit']);
    expect(readFileSync(join(claudeDir, 'skills/difit/SKILL.md'), 'utf8')).toBe('new difit');
    expect(existsSync(join(claudeDir, 'skills/difit/notes.md'))).toBe(false);
    expect(readdirSync(join(claudeDir, 'skills')).sort()).toEqual(['difit', 'difit-review']);
    expect(readdirSync(claudeDir)).toEqual(['skills']);
  });

  it('replaces older copies even when one cannot be fully deleted', () => {
    writeFiles(join(claudeDir, 'skills'), {
      'difit/SKILL.md': 'old difit',
      'difit/locked/file.md': 'locked',
      'difit-review/SKILL.md': 'old review',
    });
    const skillsDir = join(claudeDir, 'skills');
    chmodSync(join(skillsDir, 'difit/locked'), 0o555);
    try {
      expect(install().sort()).toEqual(['difit', 'difit-review']);
    } finally {
      for (const leftover of readdirSync(skillsDir).filter((name) => name.startsWith('.'))) {
        chmodSync(join(skillsDir, leftover, 'old/locked'), 0o755);
      }
    }

    expect(readFileSync(join(skillsDir, 'difit/SKILL.md'), 'utf8')).toBe('new difit');
    expect(readFileSync(join(skillsDir, 'difit/agents/openai.yaml'), 'utf8')).toBe('difit agent');
    expect(readFileSync(join(skillsDir, 'difit-review/SKILL.md'), 'utf8')).toBe('new review');
  });

  it('writes nothing when the installed skills already match', () => {
    install();
    const skillFile = join(claudeDir, 'skills/difit/SKILL.md');
    const before = statSync(skillFile).mtimeMs;

    expect(install()).toEqual([]);
    expect(statSync(skillFile).mtimeMs).toBe(before);
  });

  it('keeps other skills in the folder', () => {
    writeFiles(join(claudeDir, 'skills'), { 'other/SKILL.md': 'mine' });

    install();

    expect(readFileSync(join(claudeDir, 'skills/other/SKILL.md'), 'utf8')).toBe('mine');
  });

  it('does nothing when the Claude folder does not exist', () => {
    rmSync(claudeDir, { recursive: true });

    expect(install()).toEqual([]);
    expect(existsSync(claudeDir)).toBe(false);
  });

  it('leaves a symlinked skill folder alone', () => {
    const linked = join(root, 'checkout-skill');
    writeFiles(linked, { 'SKILL.md': 'from a checkout' });
    mkdirSync(join(claudeDir, 'skills'));
    symlinkSync(linked, join(claudeDir, 'skills/difit'), 'dir');

    expect(install()).toEqual(['difit-review']);
    expect(readFileSync(join(claudeDir, 'skills/difit/SKILL.md'), 'utf8')).toBe('from a checkout');
  });

  it('runs only on fork release builds', () => {
    expect(install({ selfVersion: '5.0.12' })).toEqual([]);
    expect(install({ selfVersion: '5.0.12-inteh.local.9cc690e' })).toEqual([]);
    expect(existsSync(join(claudeDir, 'skills'))).toBe(false);
  });

  it('can be turned off', () => {
    expect(install({ env: { DIFIT_DISABLE_SKILL_INSTALL: '1' } })).toEqual([]);
    expect(existsSync(join(claudeDir, 'skills'))).toBe(false);
  });

  it('does not throw when the build has no skills', () => {
    rmSync(join(packageRoot, 'skills'), { recursive: true });

    expect(install()).toEqual([]);
  });

  it('installs the skills this repository ships', () => {
    const repoRoot = resolve(import.meta.dirname, '../..');
    const installed = installBundledSkills({
      selfVersion: RELEASE,
      env: {},
      packageRoot: repoRoot,
      claudeDir,
    });

    expect(installed.sort()).toEqual(['difit', 'difit-review']);
    expect(readFileSync(join(claudeDir, 'skills/difit/SKILL.md'), 'utf8')).toBe(
      readFileSync(join(repoRoot, 'skills/difit/SKILL.md'), 'utf8'),
    );
  });

  it('is part of the published package', () => {
    expect(pkg.files).toContain('skills');
  });
});

describe('getClaudeConfigDir', () => {
  it('follows CLAUDE_CONFIG_DIR and falls back to ~/.claude', () => {
    expect(getClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/x/claude' })).toBe('/x/claude');
    expect(getClaudeConfigDir({ CLAUDE_CONFIG_DIR: ' ' })).toBe(join(homedir(), '.claude'));
    expect(getClaudeConfigDir({})).toBe(join(homedir(), '.claude'));
  });
});
