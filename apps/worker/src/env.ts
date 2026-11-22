import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveDataPath } from '@jumper/shared/node';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REPOS_DIR: z.string().default('./data/repos'),
  /**
   * How kicad-cli is isolated from the rest of the server:
   *  - bwrap: bubblewrap, no network, sees only system files and the job's scratch directory (no Docker needed);
   *  - docker: a fresh container per call;
   *  - none: a scrubbed environment and timeouts only (use only inside the hardened worker container);
   *  - auto (default): bwrap when it works on this machine, otherwise none with a warning at startup.
   */
  WORKER_SANDBOX: z.enum(['auto', 'bwrap', 'docker', 'none']).default('auto'),
  WORKER_KICAD_IMAGE: z.string().default('jumper/kicad-worker:latest'),
  /** Slow lane: renders and exports. Each running job wants about 2 vCPU and 4 GB. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  /** Fast lane: ERC, DRC and BOM. Light, so review feedback arrives in about a minute even when renders queue up. */
  WORKER_CHECKS_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  WORKER_JOB_TIMEOUT_MS: z.coerce.number().int().default(10 * 60_000),
  WORKER_STEP_TIMEOUT_MS: z.coerce.number().int().default(5 * 60_000),
  WORKER_MAX_CHECKOUT_BYTES: z.coerce.number().int().default(1024 * 1024 * 1024),
  WORKER_DOCKER_MEMORY: z.string().default('4g'),
  WORKER_DOCKER_CPUS: z.string().default('2'),
  /**
   * kicad-cli binary. "auto" uses kicad-cli on PATH, or the host's kicad-cli via
   * flatpak-spawn when the worker itself runs inside a Flatpak sandbox (e.g. an IDE terminal).
   */
  KICAD_CLI: z.string().default('auto'),
  /** KiCad 3D model library as seen by kicad-cli (host path in Flatpak mode, image path in Docker mode). */
  WORKER_KICAD_3DMODEL_DIR: z.string().default('/usr/share/kicad/3dmodels'),
  /** KiCad's standard symbol (*.kicad_sym) and footprint (*.pretty) libraries, to tell standard libraries from missing ones. */
  WORKER_KICAD_SYMBOL_DIR: z.string().default('/usr/share/kicad/symbols'),
  WORKER_KICAD_FOOTPRINT_DIR: z.string().default('/usr/share/kicad/footprints'),
  /** Scratch space for checkouts. Must be visible to kicad-cli (shared with the host in Flatpak mode). */
  WORKER_TMP_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

export type WorkerEnv = z.output<typeof envSchema> & {
  reposDir: string;
  tmpDir: string;
  /** Run kicad-cli on the Flatpak host (flatpak-spawn --host). */
  hostSpawn: boolean;
};

const inFlatpak = () => existsSync('/.flatpak-info') && existsSync('/usr/bin/flatpak-spawn');

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  const d = parsed.data;
  const hostSpawn = (d.WORKER_SANDBOX === 'none' || d.WORKER_SANDBOX === 'auto') && (d.KICAD_CLI === 'host' || (d.KICAD_CLI === 'auto' && inFlatpak()));
  // The Flatpak sandbox has a private /tmp, so host-side kicad-cli needs a shared scratch dir.
  const tmpDir = d.WORKER_TMP_DIR ? resolveDataPath(d.WORKER_TMP_DIR) : hostSpawn ? resolveDataPath('./data/tmp') : tmpdir();
  return { ...d, reposDir: resolveDataPath(d.REPOS_DIR), tmpDir, hostSpawn };
}
