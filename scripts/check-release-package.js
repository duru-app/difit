#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pkg from '../package.json' with { type: 'json' };

const CHANGED_FILE = 'changed.txt';
const COMMAND_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const bundledSkillsDir = join(repositoryRoot, 'skills');
const builtDir = join(repositoryRoot, 'dist');
const pathsLeftOutOfPackage = pkg.files
  .filter((pattern) => pattern.startsWith('!'))
  .map((pattern) => join(repositoryRoot, pattern.slice(1)));

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function run(command, args, options) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  }).trim();
}

function createRepository(repo) {
  const git = (...args) =>
    run(
      'git',
      [
        '-c',
        'user.name=check',
        '-c',
        'user.email=check@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: repo },
    );
  mkdirSync(repo);
  git('init', '--quiet');
  writeFileSync(join(repo, CHANGED_FILE), 'before\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'first');
  writeFileSync(join(repo, CHANGED_FILE), 'after\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'second');
}

function assertFilesCopied(sourceDir, targetDir) {
  const sources = readdirSync(sourceDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(
      (path) => !pathsLeftOutOfPackage.some((left) => path === left || path.startsWith(`${left}/`)),
    );
  if (sources.length === 0) throw new Error(`no files in ${sourceDir}`);
  for (const source of sources) {
    const path = relative(sourceDir, source);
    const target = join(targetDir, path);
    if (!existsSync(target)) throw new Error(`${path} is missing from ${targetDir}`);
    if (!readFileSync(source).equals(readFileSync(target))) {
      throw new Error(`${path} in ${targetDir} differs from ${sourceDir}`);
    }
  }
}

async function fetchOk(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  assertEqual(response.status, 200, `status of ${url}`);
  return response;
}

async function checkDiff(serverUrl) {
  const { files } = await (await fetchOk(`${serverUrl}/api/diff`)).json();
  const file = files.find(({ path }) => path === CHANGED_FILE);
  if (!file) throw new Error(`/api/diff does not list ${CHANGED_FILE}`);
  assertEqual(file.additions, 1, `additions of ${CHANGED_FILE}`);
  assertEqual(file.deletions, 1, `deletions of ${CHANGED_FILE}`);
}

async function checkClient(serverUrl) {
  const html = await (await fetchOk(`${serverUrl}/`)).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(([, path]) => path);
  if (!assets.some((path) => path.endsWith('.js'))) {
    throw new Error('the web page does not load a script from /assets');
  }
  await Promise.all(assets.map((path) => fetchOk(`${serverUrl}${path}`)));
}

function checkSkills(claudeDir) {
  const names = readdirSync(bundledSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (names.length === 0) throw new Error(`no skills in ${bundledSkillsDir}`);
  for (const name of names) {
    assertFilesCopied(join(bundledSkillsDir, name), join(claudeDir, 'skills', name));
  }
}

async function checkPackage(tarball, expectedVersion, root) {
  const prefix = join(root, 'install');
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claudeDir,
    DIFIT_CONFIG_DIR: join(root, 'config'),
    DIFIT_DISABLE_AUTOUPDATE: '1',
  };
  delete env.NODE_ENV;

  // Same flags as npmInstall in src/cli/self-update.ts.
  run(
    'npm',
    [
      'install',
      '--prefix',
      prefix,
      '--no-save',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      tarball,
    ],
    { env },
  );
  console.log('ok: installs');

  const installedPackage = join(prefix, 'node_modules', 'difit');
  assertFilesCopied(builtDir, join(installedPackage, 'dist'));
  console.log('ok: the package has every built file');

  createRepository(repo);
  const difit = join(prefix, 'node_modules', '.bin', 'difit');
  const options = { cwd: repo, env };

  assertEqual(run(difit, ['--version'], options), expectedVersion, 'difit --version');
  console.log(`ok: difit --version prints ${expectedVersion}`);

  assertEqual(
    run(
      process.execPath,
      [join(installedPackage, 'dist', 'cli', 'index.js'), '--version'],
      options,
    ),
    expectedVersion,
    'version of the entry an older launcher opens',
  );
  console.log('ok: the entry an older launcher opens runs');

  const server = JSON.parse(run(difit, ['HEAD', '--background'], options));
  try {
    await checkDiff(server.url);
    console.log('ok: the server returns the diff of the repository');
    await checkClient(server.url);
    console.log('ok: the server returns the web page and its assets');
    checkSkills(claudeDir);
    console.log('ok: the bundled skills are installed');
  } finally {
    try {
      process.kill(server.pid);
    } catch {}
  }
}

async function main() {
  const [tarball, expectedVersion] = process.argv.slice(2);
  if (!tarball || !expectedVersion) {
    console.error('Usage: check-release-package.js <tarball> <expected-version>');
    process.exit(2);
  }

  const root = mkdtempSync(join(tmpdir(), 'difit-package-check-'));
  try {
    await checkPackage(resolve(tarball), expectedVersion, root);
  } catch (error) {
    console.error(
      `Package check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

await main();
