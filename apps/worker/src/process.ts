import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawn a process (no shell) with a timeout and bounded output capture. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; input?: NodeJS.ReadableStream; stdoutTo?: NodeJS.WritableStream },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 64 * 1024;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    if (opts.stdoutTo) child.stdout.pipe(opts.stdoutTo);
    else child.stdout.on('data', (c: Buffer) => (stdout.length < cap ? (stdout += c.toString()) : undefined));
    child.stderr.on('data', (c: Buffer) => (stderr.length < cap ? (stderr += c.toString()) : undefined));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.input) opts.input.pipe(child.stdin);
    else child.stdin.end();
  });
}
