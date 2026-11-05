import { rm } from 'node:fs/promises';
import type { Ctx } from '../../context';
import { repoDiskPath } from './access';

const warn = (msg: string) => process.stderr.write(`${JSON.stringify({ level: 'warn', msg, time: new Date().toISOString() })}\n`);

/** Remove git data and stored artifacts of repositories already deleted from the database. Best effort: failures are logged. */
export async function purgeRepoData(ctx: Ctx, repoIds: string[]): Promise<void> {
  for (const id of repoIds) {
    await rm(repoDiskPath(ctx, id), { recursive: true, force: true }).catch((e) => warn(`purge files ${id}: ${(e as Error).message}`));
    await ctx.storage.deletePrefix(`repos/${id}/`).catch((e) => warn(`purge artifacts ${id}: ${(e as Error).message}`));
  }
}
