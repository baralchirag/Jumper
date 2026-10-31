import { resolveDataPath } from '@pcbhub/shared/node';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PUBLIC_URL: z.url().default('http://localhost:5173'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REPOS_DIR: z.string().default('./data/repos'),
  MAX_PUSH_BYTES: z.coerce.number().int().default(500 * 1024 * 1024),
  MAX_VIEW_BYTES: z.coerce.number().int().default(64 * 1024 * 1024),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  TRUST_PROXY: z.stringbool().default(false),
  AUTO_MIGRATE: z.stringbool().default(true),
  ALLOW_SIGNUP: z.stringbool().default(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.output<typeof envSchema> & { reposDir: string; secureCookies: boolean };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  return {
    ...env,
    reposDir: resolveDataPath(env.REPOS_DIR),
    secureCookies: env.PUBLIC_URL.startsWith('https://'),
  };
}
