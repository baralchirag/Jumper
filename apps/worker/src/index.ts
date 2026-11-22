import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb } from '@jumper/db';
import { kicadCore } from '@jumper/kicad-core/node';
import { QUEUE_ANALYZE, QUEUE_OUTPUTS, type AnalyzeCommitJob, type CheckStage } from '@jumper/shared';
import { POSTGRES_HINT, REDIS_HINT, checkServices, watchRedis } from '@jumper/shared/node';
import { createStorage } from '@jumper/storage';
import { Analyzer } from './analyze';
import { loadEnv } from './env';
import { log, setLogLevel } from './log';
import { resolveSandbox } from './kicad-cli';

const env = loadEnv();
setLogLevel(env.LOG_LEVEL);
await checkServices([
  { name: 'PostgreSQL', url: env.DATABASE_URL, defaultPort: 5432, hint: POSTGRES_HINT },
  { name: 'Redis', url: env.REDIS_URL, defaultPort: 6379, hint: REDIS_HINT },
]);

const { db, close: closeDb } = createDb(env.DATABASE_URL, { max: env.WORKER_CONCURRENCY + env.WORKER_CHECKS_CONCURRENCY + 2 });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const workerRedis = redis.duplicate();
watchRedis(redis, 'events', (m) => log.error(m), (m) => log.info(m));
watchRedis(workerRedis, 'queue', (m) => log.error(m), (m) => log.info(m));
const storage = createStorage();
await storage.ensureReady();

// Decide how kicad-cli is isolated before any job runs.
const sandbox = await resolveSandbox(env);
env.WORKER_SANDBOX = sandbox.mode;
if (sandbox.note) log.error(sandbox.note);
const analyzer = new Analyzer({ env, db, redis, storage, kicad: kicadCore() });

/** One BullMQ worker per lane: the fast lane (ERC, DRC, BOM) never waits behind the slow one (renders, exports). */
function lane(queue: string, stage: CheckStage, concurrency: number): Worker<AnalyzeCommitJob> {
  const w = new Worker<AnalyzeCommitJob>(
    queue,
    async (job) => {
      log.info('job started', { id: job.id, stage, ...job.data });
      const t0 = Date.now();
      await analyzer.run(job.data, stage);
      log.info('job finished', { id: job.id, stage, ms: Date.now() - t0 });
    },
    { connection: workerRedis, concurrency, lockDuration: 120_000 },
  );
  w.on('failed', (job, err) => log.error('job failed', { id: job?.id, stage, error: err.message }));
  // Connection errors are reported once by watchRedis; log anything else.
  w.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.name === 'AggregateError') return;
    log.error('worker error', { stage, error: err.message || String(err) });
  });
  return w;
}

const workers = [lane(QUEUE_ANALYZE, 'checks', env.WORKER_CHECKS_CONCURRENCY), lane(QUEUE_OUTPUTS, 'outputs', env.WORKER_CONCURRENCY)];
log.info('worker ready', { checks: env.WORKER_CHECKS_CONCURRENCY, outputs: env.WORKER_CONCURRENCY, sandbox: env.WORKER_SANDBOX });

const shutdown = async (signal: string) => {
  log.info('shutting down', { signal });
  await Promise.all(workers.map((w) => w.close()));
  redis.disconnect();
  await closeDb();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
