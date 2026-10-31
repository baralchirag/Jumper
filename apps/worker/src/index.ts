import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb } from '@pcbhub/db';
import { kicadCore } from '@pcbhub/kicad-core/node';
import { QUEUE_ANALYZE, type AnalyzeCommitJob } from '@pcbhub/shared';
import { POSTGRES_HINT, REDIS_HINT, checkServices, watchRedis } from '@pcbhub/shared/node';
import { createStorage } from '@pcbhub/storage';
import { Analyzer } from './analyze';
import { loadEnv } from './env';
import { log, setLogLevel } from './log';

const env = loadEnv();
setLogLevel(env.LOG_LEVEL);
await checkServices([
  { name: 'PostgreSQL', url: env.DATABASE_URL, defaultPort: 5432, hint: POSTGRES_HINT },
  { name: 'Redis', url: env.REDIS_URL, defaultPort: 6379, hint: REDIS_HINT },
]);

const { db, close: closeDb } = createDb(env.DATABASE_URL, { max: env.WORKER_CONCURRENCY + 2 });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const workerRedis = redis.duplicate();
watchRedis(redis, 'events', (m) => log.error(m), (m) => log.info(m));
watchRedis(workerRedis, 'queue', (m) => log.error(m), (m) => log.info(m));
const storage = createStorage();
await storage.ensureReady();

const analyzer = new Analyzer({ env, db, redis, storage, kicad: kicadCore() });

const worker = new Worker<AnalyzeCommitJob>(
  QUEUE_ANALYZE,
  async (job) => {
    log.info('job started', { id: job.id, ...job.data });
    const t0 = Date.now();
    await analyzer.run(job.data);
    log.info('job finished', { id: job.id, ms: Date.now() - t0 });
  },
  {
    connection: workerRedis,
    concurrency: env.WORKER_CONCURRENCY,
    lockDuration: 120_000,
  },
);

worker.on('failed', (job, err) => log.error('job failed', { id: job?.id, error: err.message }));
// Connection errors are reported once by watchRedis; log anything else.
worker.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.name === 'AggregateError') return;
  log.error('worker error', { error: err.message || String(err) });
});
log.info('worker ready', { queue: QUEUE_ANALYZE, concurrency: env.WORKER_CONCURRENCY, sandbox: env.WORKER_SANDBOX });

const shutdown = async (signal: string) => {
  log.info('shutting down', { signal });
  await worker.close();
  redis.disconnect();
  await closeDb();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
