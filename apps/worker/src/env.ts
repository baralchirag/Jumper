import { resolveDataPath } from '@pcbhub/shared/node';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REPOS_DIR: z.string().default('./data/repos'),
  WORKER_SANDBOX: z.enum(['docker', 'none']).default('none'),
  WORKER_KICAD_IMAGE: z.string().default('pcbhub/kicad-worker:latest'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  WORKER_JOB_TIMEOUT_MS: z.coerce.number().int().default(10 * 60_000),
  WORKER_STEP_TIMEOUT_MS: z.coerce.number().int().default(5 * 60_000),
  WORKER_MAX_CHECKOUT_BYTES: z.coerce.number().int().default(1024 * 1024 * 1024),
  WORKER_DOCKER_MEMORY: z.string().default('4g'),
  WORKER_DOCKER_CPUS: z.string().default('2'),
  KICAD_CLI: z.string().default('kicad-cli'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

export type WorkerEnv = z.output<typeof envSchema> & { reposDir: string };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  return { ...parsed.data, reposDir: resolveDataPath(parsed.data.REPOS_DIR) };
}
