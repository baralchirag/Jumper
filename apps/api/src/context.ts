import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb, type Database } from '@jumper/db';
import { EVENTS_CHANNEL, QUEUE_ANALYZE, type AnalyzeCommitJob, type PlatformEvent } from '@jumper/shared';
import { createStorage, type Storage } from '@jumper/storage';
import { watchRedis } from '@jumper/shared/node';
import type { Env } from './env';
import { KicadPool } from './modules/kicad/kicad-pool';

export interface Ctx {
  env: Env;
  db: Database;
  redis: Redis;
  /** Fail-fast connection for rate limiting; requests proceed if Redis is down. */
  rateLimitRedis: Redis;
  queue: Queue<AnalyzeCommitJob>;
  storage: Storage;
  kicad: KicadPool;
  publish(event: PlatformEvent): Promise<void>;
  /** In-process subscribers to platform events (webhooks, notifications). Errors are swallowed. */
  listeners: ((event: PlatformEvent) => void | Promise<void>)[];
  /** Set once the built-in SSH server is listening. */
  sshHostKeyFingerprint?: string;
  close(): Promise<void>;
}

export function createContext(env: Env): Ctx {
  const { db, close: closeDb } = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const rateLimitRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000 });
  rateLimitRedis.on('error', () => {});
  const queueRedis = redis.duplicate();
  const log = (level: 'error' | 'info') => (msg: string) => process.stderr.write(`${JSON.stringify({ level, msg, time: new Date().toISOString() })}\n`);
  watchRedis(redis, 'main', log('error'), log('info'));
  watchRedis(queueRedis, 'queue', log('error'), log('info'));
  const queue = new Queue<AnalyzeCommitJob>(QUEUE_ANALYZE, {
    connection: queueRedis,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  });
  const storage = createStorage();
  return {
    env,
    db,
    redis,
    rateLimitRedis,
    queue,
    storage,
    kicad: new KicadPool(undefined, env.KICAD_POOL === 'inline'),
    listeners: [],
    async publish(event) {
      // Live updates are best effort: never fail or delay a request because Redis is slow or down.
      void redis.publish(EVENTS_CHANNEL, JSON.stringify(event)).catch(() => {});
      for (const l of this.listeners) Promise.resolve(l(event)).catch(() => {});
    },
    async close() {
      await queue.close();
      await this.kicad.close();
      redis.disconnect();
      rateLimitRedis.disconnect();
      await closeDb();
    },
  };
}
