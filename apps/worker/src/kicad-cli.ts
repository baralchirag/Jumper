import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerEnv } from './env';
import { run, type RunResult } from './process';

/**
 * Runs kicad-cli on untrusted designs.
 *
 * `docker` mode: a fresh container per call with no network, read-only root,
 * dropped capabilities, CPU/memory/PID limits; only the job dir is mounted.
 * `none` mode: direct execution, intended for use *inside* the hardened worker
 * image (see docker/worker.Dockerfile), still with a timeout and scrubbed env.
 */
export class KicadCli {
  private versionCache: string | null | undefined;

  constructor(private readonly env: WorkerEnv) {}

  async exec(args: string[], workdir: string, timeoutMs = this.env.WORKER_STEP_TIMEOUT_MS): Promise<RunResult> {
    if (this.env.WORKER_SANDBOX === 'docker') {
      return run(
        'docker',
        [
          'run', '--rm',
          '--network', 'none',
          '--read-only',
          '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g',
          '--tmpfs', '/home/kicad:rw,nosuid,nodev,size=256m',
          '--memory', this.env.WORKER_DOCKER_MEMORY,
          '--cpus', this.env.WORKER_DOCKER_CPUS,
          '--pids-limit', '512',
          '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges',
          '--user', '1000:1000',
          '-e', 'HOME=/home/kicad',
          '-v', `${workdir}:/work:rw`,
          '-w', '/work',
          this.env.WORKER_KICAD_IMAGE,
          'kicad-cli', ...args,
        ],
        { env: { PATH: process.env.PATH }, timeoutMs },
      );
    }
    const home = await mkdtemp(join(tmpdir(), 'kicad-home-'));
    try {
      return await run(this.env.KICAD_CLI, args, {
        cwd: workdir,
        env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', QT_QPA_PLATFORM: 'offscreen', KICAD_CONFIG_HOME: join(home, 'config') },
        timeoutMs,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  /** e.g. "8.0.5", or null when kicad-cli is unavailable. */
  async version(workdir: string): Promise<string | null> {
    if (this.versionCache !== undefined) return this.versionCache;
    try {
      const r = await this.exec(['version'], workdir, 60_000);
      this.versionCache = r.code === 0 ? r.stdout.trim().split(/\s+/).pop() ?? null : null;
    } catch {
      this.versionCache = null;
    }
    return this.versionCache;
  }

  async major(workdir: string): Promise<number> {
    const v = await this.version(workdir);
    return v ? Number.parseInt(v, 10) || 0 : 0;
  }
}

export function describeFailure(r: RunResult): string {
  if (r.timedOut) return 'timed out';
  const msg = (r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n');
  return `exit code ${r.code}${msg ? `: ${msg}` : ''}`;
}
