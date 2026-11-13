import { Queue, Worker } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import type { Ctx } from '../../context';
import { housekeeping } from './housekeeping';
import { syncDueMirrors } from '../mirrors/service';
import { checkDueStock } from '../alerts/service';
import { sendDueDigests } from '../digest/service';

export const QUEUE_SCHEDULED = 'jumper-scheduled';

export interface ScheduledTask {
  /** Cron pattern (UTC) or a fixed interval in ms. */
  pattern?: string;
  every?: number;
  run(ctx: Ctx): Promise<unknown>;
}

/** Every recurring job. */
export const TASKS: Record<string, ScheduledTask> = {
  housekeeping: { every: 3600_000, run: housekeeping },
  mirrors: { every: 60_000, run: (ctx) => syncDueMirrors(ctx) },
  // Each watched repository is priced at most once a day; a few per run keeps supplier API use smooth.
  stock: { every: 15 * 60_000, run: (ctx) => checkDueStock(ctx) },
  // Digests go out a week after each person's previous one; hourly runs pick up whoever is due.
  digest: { every: 3600_000, run: (ctx) => sendDueDigests(ctx) },
};

/**
 * Register the recurring jobs and process them. BullMQ job schedulers are keyed by name, so several API instances
 * upsert the same schedule and each run is handled by exactly one of them.
 */
export async function startScheduler(ctx: Ctx, log: FastifyBaseLogger): Promise<() => Promise<void>> {
  const connection = ctx.redis.duplicate({ maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE_SCHEDULED, {
    connection,
    defaultJobOptions: { removeOnComplete: { count: 200 }, removeOnFail: { count: 500 }, attempts: 2, backoff: { type: 'exponential', delay: 60_000 } },
  });
  for (const [name, task] of Object.entries(TASKS)) {
    await queue.upsertJobScheduler(name, task.pattern ? { pattern: task.pattern, tz: 'UTC' } : { every: task.every! }, { name });
  }
  // Drop schedules for tasks that no longer exist.
  for (const s of await queue.getJobSchedulers()) {
    if (s.key && !TASKS[s.key]) await queue.removeJobScheduler(s.key);
  }
  const worker = new Worker(
    QUEUE_SCHEDULED,
    async (job) => {
      const task = TASKS[job.name];
      if (!task) return;
      const t0 = Date.now();
      const result = await task.run(ctx);
      log.info({ task: job.name, ms: Date.now() - t0, result }, 'scheduled task finished');
    },
    { connection: connection.duplicate({ maxRetriesPerRequest: null }), concurrency: 1 },
  );
  worker.on('failed', (job, err) => log.error({ task: job?.name, err: err.message }, 'scheduled task failed'));
  worker.on('error', () => {});
  return async () => {
    await worker.close();
    await queue.close();
    connection.disconnect();
  };
}
