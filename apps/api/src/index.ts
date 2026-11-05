import { mkdir } from 'node:fs/promises';
import { runMigrations } from '@jumper/db';
import { POSTGRES_HINT, REDIS_HINT, checkServices } from '@jumper/shared/node';
import { buildApp } from './app';
import { createContext } from './context';
import { loadEnv } from './env';
import { startScheduler } from './modules/scheduler/scheduler';
import { startSshServer } from './modules/ssh/server';

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  // Refuse to start with credentials that ship in the example files.
  if (/\/\/[^:]+:(pcbhub|jumper|postgres|password|changeme)@/i.test(env.DATABASE_URL)) {
    console.error('Refusing to start in production with a default database password. Set a strong POSTGRES_PASSWORD.');
    process.exit(1);
  }
  if (!env.secureCookies) console.warn('PUBLIC_URL is not https: session cookies will not be marked Secure. Put the API behind TLS.');
  if (env.WEBHOOK_ALLOW_PRIVATE_NETWORKS) console.warn('WEBHOOK_ALLOW_PRIVATE_NETWORKS is enabled: webhooks can reach your internal network.');
}
await checkServices([
  { name: 'PostgreSQL', url: env.DATABASE_URL, defaultPort: 5432, hint: POSTGRES_HINT },
  { name: 'Redis', url: env.REDIS_URL, defaultPort: 6379, hint: REDIS_HINT },
]);
if (env.AUTO_MIGRATE) await runMigrations(env.DATABASE_URL);
await mkdir(env.reposDir, { recursive: true });

const ctx = createContext(env);
await ctx.storage.ensureReady();
const app = await buildApp(ctx);
const stopScheduler = env.SCHEDULER_ENABLED
  ? await startScheduler(ctx, app.log).catch((e: Error) => {
      app.log.error({ err: e.message }, 'scheduler failed to start; scheduled jobs are off');
      return async () => {};
    })
  : async () => {};

const ssh = env.SSH_ENABLED
  ? await startSshServer(ctx, app.log).catch((e: Error) => {
      app.log.error({ err: e.message }, 'SSH server failed to start; git over SSH is off');
      return null;
    })
  : null;
if (ssh) ctx.sshHostKeyFingerprint = ssh.hostKeyFingerprint;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await ssh?.close();
  await stopScheduler();
  await app.close();
  await ctx.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.API_HOST, port: env.API_PORT });
