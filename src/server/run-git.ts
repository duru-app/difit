import { spawn } from 'child_process';

export interface GitRun {
  code: number;
  stdout: Buffer;
  output: string;
}

export interface GitOptions {
  input?: Buffer;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

const GIT_TIMEOUT_MS = 60_000;

export const literalPathspec = (path: string) => `:(literal)${path}`;

export function runGit(
  repoPath: string,
  args: string[],
  options: GitOptions = {},
): Promise<GitRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
      signal: options.signal,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM lets git remove its lock files on the way out.
      child.kill('SIGTERM');
    }, GIT_TIMEOUT_MS);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout);
      const output = `${out.toString('utf8')}${Buffer.concat(stderr).toString('utf8')}`.trim();
      resolvePromise({
        code: code ?? 1,
        stdout: out,
        output: timedOut ? `${output}\ngit ${args[0]} timed out`.trim() : output,
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}
