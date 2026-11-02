import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pkg from '../../package.json' with { type: 'json' };

import { parseForkReleaseVersion } from './versions.js';

const DISABLE_SKILL_INSTALL_ENV = 'DIFIT_DISABLE_SKILL_INSTALL';

export function getClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readTree(root: string, prefix = ''): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [file, content] of readTree(root, path)) files.set(file, content);
    } else {
      files.set(path, readFileSync(join(root, path)));
    }
  }
  return files;
}

function hasSameFiles(source: string, target: string): boolean {
  let installed: Map<string, Buffer>;
  try {
    installed = readTree(target);
  } catch {
    return false;
  }
  const bundled = readTree(source);
  if (installed.size !== bundled.size) return false;
  for (const [file, content] of bundled) {
    const other = installed.get(file);
    if (!other || !other.equals(content)) return false;
  }
  return true;
}

function replaceDirectory(source: string, target: string, skillsDir: string): void {
  const workDir = mkdtempSync(join(skillsDir, '.difit-staging-'));
  const staging = join(workDir, 'new');
  const previous = join(workDir, 'old');
  let keepWorkDir = false;
  try {
    cpSync(source, staging, { recursive: true });
    let hadPrevious = true;
    try {
      renameSync(target, previous);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hadPrevious = false;
    }
    try {
      renameSync(staging, target);
    } catch (error) {
      if (hadPrevious) {
        keepWorkDir = true;
        renameSync(previous, target);
        keepWorkDir = false;
      }
      throw error;
    }
  } finally {
    if (!keepWorkDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

export function installBundledSkills(
  options: {
    selfVersion?: string;
    env?: NodeJS.ProcessEnv;
    packageRoot?: string;
    claudeDir?: string;
  } = {},
): string[] {
  const { selfVersion = pkg.version, env = process.env } = options;
  const installed: string[] = [];
  try {
    if (env[DISABLE_SKILL_INSTALL_ENV] === '1') return installed;
    if (!parseForkReleaseVersion(selfVersion)) return installed;
    const claudeDir = options.claudeDir ?? getClaudeConfigDir(env);
    if (!isDirectory(claudeDir)) return installed;
    const packageRoot = options.packageRoot ?? fileURLToPath(new URL('../..', import.meta.url));
    const sourceRoot = join(packageRoot, 'skills');
    const names = readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const skillsDir = join(claudeDir, 'skills');
    for (const name of names) {
      try {
        const source = join(sourceRoot, name);
        const target = join(skillsDir, name);
        let isLink = false;
        try {
          isLink = lstatSync(target).isSymbolicLink();
        } catch {}
        if (isLink || hasSameFiles(source, target)) continue;
        mkdirSync(skillsDir, { recursive: true });
        replaceDirectory(source, target, skillsDir);
        installed.push(name);
      } catch {}
    }
  } catch {}
  return installed;
}
