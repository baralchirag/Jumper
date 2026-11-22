import { tmpdir } from 'node:os';
import { lstat, mkdir, mkdtemp, readdir, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkerEnv } from './env';
import { buildModelIndex, type ModelIndex } from './models3d';
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
  private modelIndex: Promise<ModelIndex | null> | null = null;
  private libIndex: Promise<{ symbols: Set<string> | null; footprints: Set<string> | null }> | null = null;

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
          ...Object.entries(this.modelVars()).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
          '-v', `${workdir}:/work:rw`,
          '-w', '/work',
          this.env.WORKER_KICAD_IMAGE,
          'kicad-cli', ...args,
        ],
        { env: { PATH: process.env.PATH }, timeoutMs },
      );
    }
    await mkdir(this.env.tmpDir, { recursive: true });
    const home = await mkdtemp(join(this.env.tmpDir, 'kicad-home-'));
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      LANG: 'C.UTF-8',
      QT_QPA_PLATFORM: 'offscreen',
      KICAD_CONFIG_HOME: join(home, 'config'),
      ...this.modelVars(),
    };
    try {
      if (this.env.hostSpawn) {
        // Inside a Flatpak sandbox: run the host's kicad-cli with a clean environment.
        const hostEnv = { ...env, PATH: '/usr/local/bin:/usr/bin:/bin' };
        return await run(
          'flatpak-spawn',
          ['--host', '--clear-env', `--directory=${workdir}`, ...Object.entries(hostEnv).map(([k, v]) => `--env=${k}=${v}`), 'kicad-cli', ...args],
          { env: this.spawnEnv(), timeoutMs },
        );
      }
      const bin = this.env.KICAD_CLI === 'auto' || this.env.KICAD_CLI === 'host' ? 'kicad-cli' : this.env.KICAD_CLI;
      if (this.env.WORKER_SANDBOX === 'bwrap') return await run('bwrap', [...(await bwrapArgs(workdir, home, env, [this.env.WORKER_KICAD_3DMODEL_DIR, this.env.WORKER_KICAD_SYMBOL_DIR, this.env.WORKER_KICAD_FOOTPRINT_DIR])), bin, ...args], { env: { PATH: process.env.PATH }, timeoutMs });
      return await run(bin, args, { cwd: workdir, env, timeoutMs });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  /** Environment for flatpak-spawn itself: it talks to the host over the session bus. */
  private spawnEnv(): NodeJS.ProcessEnv {
    const keep = ['PATH', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'FLATPAK_ID'];
    return Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  }

  private modelVars(): Record<string, string> {
    const dir = this.env.WORKER_KICAD_3DMODEL_DIR;
    return Object.fromEntries([6, 7, 8, 9, 10].map((v) => [`KICAD${v}_3DMODEL_DIR`, dir]));
  }

  /** Files in the KiCad 3D model library (cached for the worker's lifetime); null when unavailable. */
  models(): Promise<ModelIndex | null> {
    this.modelIndex ??= this.listModels().catch(() => null);
    return this.modelIndex;
  }

  private async listModels(): Promise<ModelIndex | null> {
    const root = this.env.WORKER_KICAD_3DMODEL_DIR;
    const findArgs = [root, '-type', 'f', '(', '-iname', '*.step', '-o', '-iname', '*.stp', '-o', '-iname', '*.wrl', ')'];
    let paths: string[];
    if (this.env.WORKER_SANDBOX === 'docker') {
      const r = await run('docker', ['run', '--rm', '--network', 'none', this.env.WORKER_KICAD_IMAGE, 'find', ...findArgs], { env: { PATH: process.env.PATH }, timeoutMs: 120_000, maxOutput: 32 << 20 });
      paths = r.stdout.split('\n');
    } else if (this.env.hostSpawn) {
      const r = await run('flatpak-spawn', ['--host', 'find', ...findArgs], { env: this.spawnEnv(), timeoutMs: 120_000, maxOutput: 32 << 20 });
      paths = r.stdout.split('\n');
    } else {
      const entries = await readdir(root, { recursive: true });
      paths = entries.filter((e) => /\.(step|stp|wrl)$/i.test(e)).map((e) => `${root}/${e}`);
    }
    const prefix = root.replace(/\/+$/, '') + '/';
    const rel = paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
    return rel.length ? buildModelIndex(root, rel) : null;
  }

  /** Nicknames of KiCad's standard symbol and footprint libraries (cached); null sets when unavailable. */
  standardLibraries(): Promise<{ symbols: Set<string> | null; footprints: Set<string> | null }> {
    this.libIndex ??= Promise.all([
      this.listDir(this.env.WORKER_KICAD_SYMBOL_DIR, /\.kicad_sym$/),
      this.listDir(this.env.WORKER_KICAD_FOOTPRINT_DIR, /\.pretty$/),
    ]).then(([symbols, footprints]) => ({ symbols, footprints }));
    return this.libIndex;
  }

  /** Entry names in a library folder (without the extension), wherever kicad-cli runs. */
  private async listDir(dir: string, ext: RegExp): Promise<Set<string> | null> {
    try {
      let names: string[];
      if (this.env.WORKER_SANDBOX === 'docker') {
        const r = await run('docker', ['run', '--rm', '--network', 'none', this.env.WORKER_KICAD_IMAGE, 'ls', '-1', dir], { env: { PATH: process.env.PATH }, timeoutMs: 60_000, maxOutput: 4 << 20 });
        names = r.code === 0 ? r.stdout.split('\n') : [];
      } else if (this.env.hostSpawn) {
        const r = await run('flatpak-spawn', ['--host', 'ls', '-1', dir], { env: this.spawnEnv(), timeoutMs: 60_000, maxOutput: 4 << 20 });
        names = r.code === 0 ? r.stdout.split('\n') : [];
      } else {
        names = await readdir(dir);
      }
      const libs = names.filter((n) => ext.test(n)).map((n) => n.replace(ext, ''));
      return libs.length ? new Set(libs) : null;
    } catch {
      return null;
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

/**
 * bubblewrap arguments: new user, network, PID, IPC and UTS namespaces; system files read-only; the job's scratch
 * directory and a throwaway home read-write; nothing else. Repositories, other jobs, stored outputs, the database
 * credentials and the server's secret key are not visible, and there is no network to send anything over.
 */
async function bwrapArgs(workdir: string, home: string, env: Record<string, string>, extraRo: string[]): Promise<string[]> {
  const a = ['--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr'];
  // /bin, /lib… are symlinks into /usr on merged-/usr systems and real directories elsewhere.
  for (const d of ['/bin', '/sbin', '/lib', '/lib32', '/lib64']) {
    const st = await lstat(d).catch(() => null);
    if (!st) continue;
    if (st.isSymbolicLink()) a.push('--symlink', await readlink(d), d);
    else a.push('--ro-bind', d, d);
  }
  a.push('--ro-bind', '/etc', '/etc', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const d of extraRo) if (d && !d.startsWith('/usr/')) a.push('--ro-bind-try', d, d);
  a.push('--bind', workdir, workdir, '--bind', home, home, '--chdir', workdir, '--clearenv');
  for (const [k, v] of Object.entries(env)) a.push('--setenv', k, v);
  a.push('--');
  return a;
}

/**
 * Settle WORKER_SANDBOX=auto: use bubblewrap if it can create its namespaces here (some kernels and Docker's default
 * seccomp profile forbid that), otherwise run without it. Explicit settings are kept as they are, and an explicit
 * bwrap that cannot start fails every job instead of quietly running unsandboxed.
 */
export async function resolveSandbox(env: WorkerEnv): Promise<{ mode: WorkerEnv['WORKER_SANDBOX']; note?: string }> {
  if (env.WORKER_SANDBOX !== 'auto') return { mode: env.WORKER_SANDBOX };
  // Inside a Flatpak sandbox kicad-cli runs on the host through flatpak-spawn; bubblewrap can't wrap that.
  if (env.hostSpawn) return { mode: 'none', note: 'kicad-cli runs on the host through flatpak-spawn, without a sandbox (development setup).' };
  // Probe with exactly the arguments real jobs use, so "works here" means kicad-cli will work too.
  const dir = await mkdtemp(join(env.tmpDir ?? tmpdir(), 'bwrap-probe-')).catch(() => mkdtemp(join(tmpdir(), 'bwrap-probe-')));
  const probe = await run('bwrap', [...(await bwrapArgs(dir, dir, { PATH: '/usr/bin:/bin' }, [])), 'true'], { env: { PATH: process.env.PATH }, timeoutMs: 10_000 })
    .catch((e: Error) => ({ code: -1, stderr: e.message }))
    .finally(() => rm(dir, { recursive: true, force: true }));
  if (probe.code === 0) return { mode: 'bwrap' };
  return { mode: 'none', note: `bubblewrap is unavailable (${String(probe.stderr ?? '').trim().slice(0, 160) || 'not installed'}); kicad-cli runs without a sandbox. Install bubblewrap, or set WORKER_SANDBOX=docker.` };
}
