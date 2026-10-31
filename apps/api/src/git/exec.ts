import { spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export interface GitRunOptions {
  cwd: string;
  input?: string | Buffer;
  env?: Record<string, string>;
  maxBuffer?: number;
  timeoutMs?: number;
  /** Exit codes treated as success (default [0]). */
  okCodes?: number[];
}

const BASE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/** Run git with an argument array (never a shell) and capture output. */
export function git(args: string[], opts: GitRunOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const ok = opts.okCodes ?? [0];
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...BASE_ENV, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const max = opts.maxBuffer ?? 64 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let killed: string | null = null;
    const timer = setTimeout(() => {
      killed = 'timeout';
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 30_000);

    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        killed = 'maxBuffer';
        child.kill('SIGKILL');
        return;
      }
      chunks.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 16_384) stderr += c.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new GitError(`git ${args[0]} aborted (${killed})`, code, stderr));
      } else if (code !== null && ok.includes(code)) {
        resolve({ stdout: Buffer.concat(chunks), stderr, code });
      } else {
        reject(new GitError(`git ${args[0]} failed: ${stderr.trim()}`, code, stderr));
      }
    });
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function gitText(args: string[], opts: GitRunOptions): Promise<string> {
  return (await git(args, opts)).stdout.toString('utf8');
}

