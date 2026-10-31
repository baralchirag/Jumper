import { mkdir } from 'node:fs/promises';
import { runMigrations } from '@pcbhub/db';
import { POSTGRES_HINT, REDIS_HINT, checkServices } from '@pcbhub/shared/node';
import { buildApp } from './app';
import { createContext } from './context';
import { loadEnv } from './env';

const env = loadEnv();
await checkServices([
  { name: 'PostgreSQL', url: env.DATABASE_URL, defaultPort: 5432, hint: POSTGRES_HINT },
  { name: 'Redis', url: env.REDIS_URL, defaultPort: 6379, hint: REDIS_HINT },
]);
if (env.AUTO_MIGRATE) await runMigrations(env.DATABASE_URL);
await mkdir(env.reposDir, { recursive: true });

const ctx = createContext(env);
await ctx.storage.ensureReady();
const app = await buildApp(ctx);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await ctx.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.API_HOST, port: env.API_PORT });
