import type { FastifyBaseLogger } from 'fastify';
import { and, eq, inArray, pullEvents, pullRequests, repositories, type Repository, type User } from '@jumper/db';
import type { Ctx } from '../../context';
import { gitFor } from './access';

export interface RefUpdate {
  ref: string;
  before: string | null;
  after: string | null;
}

export function diffRefs(before: Map<string, string>, after: Map<string, string>): RefUpdate[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  const out: RefUpdate[] = [];
  for (const ref of names) {
    const b = before.get(ref) ?? null;
    const a = after.get(ref) ?? null;
    if (b !== a) out.push({ ref, before: b, after: a });
  }
  return out;
}

/** Queue an analysis job. Bounded: a Redis outage must not freeze pushes and merges, so we give up after a few seconds. */
export async function enqueueAnalysis(ctx: Ctx, repoId: string, sha: string, ref?: string, force = false): Promise<void> {
  const jobId = force ? `${repoId}-${sha}-${Date.now()}` : `${repoId}-${sha}`;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Job queue unavailable')), 4000);
  });
  try {
    await Promise.race([ctx.queue.add('analyze', { repoId, sha, ref }, { jobId }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Post-push bookkeeping: default branch, PR heads, analysis jobs, events. */
export async function handleRefUpdates(
  ctx: Ctx,
  repo: Repository,
  updates: RefUpdate[],
  actor: User | null,
  log: FastifyBaseLogger,
  opts: { fromMirror?: string } = {},
): Promise<void> {
  if (!updates.length) return;
  // Send the change on to push mirrors (except the one it came from). Loaded lazily: the mirror module imports this one.
  void import('../mirrors/service').then((m) => m.triggerPushMirrors(ctx, repo.id, log, opts.fromMirror)).catch(() => {});
  const git = gitFor(ctx, repo.id);
  const branchUpdates = updates.filter((u) => u.ref.startsWith('refs/heads/'));

  // First push to a repo whose default branch doesn't exist: adopt a pushed branch.
  let defaultBranch = repo.defaultBranch;
  if (!(await git.resolveBranch(defaultBranch))) {
    const candidate = branchUpdates.find((u) => u.after)?.ref.slice('refs/heads/'.length);
    if (candidate) {
      defaultBranch = candidate;
      await git.setHead(candidate);
    }
  }

  await ctx.db
    .update(repositories)
    .set({ pushedAt: new Date(), updatedAt: new Date(), defaultBranch, sizeBytes: await git.sizeBytes().catch(() => 0) })
    .where(eq(repositories.id, repo.id));

  for (const u of branchUpdates) {
    const branch = u.ref.slice('refs/heads/'.length);
    if (u.after) {
      await enqueueAnalysis(ctx, repo.id, u.after, branch).catch((e) => log.error(e, 'enqueue failed'));
    }

    const heads = await ctx.db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.headRef, branch), eq(pullRequests.state, 'open')));
    for (const pr of heads) {
      if (u.after) {
        await ctx.db.update(pullRequests).set({ headSha: u.after, updatedAt: new Date() }).where(eq(pullRequests.id, pr.id));
      }
      const commits = u.before && u.after ? (await git.commitsBetween(u.before, u.after, 100).catch(() => [])).length : 0;
      await ctx.db.insert(pullEvents).values({
        pullId: pr.id,
        actorId: actor?.id ?? null,
        kind: 'pushed',
        data: { before: u.before, after: u.after, commits, forced: u.before && u.after ? !(await git.isAncestor(u.before, u.after).catch(() => true)) : false },
      });
      await ctx.publish({ type: 'pr', repoId: repo.id, number: pr.number, action: 'synchronize' });
    }

    if (u.after) {
      await ctx.db
        .update(pullRequests)
        .set({ baseSha: u.after })
        .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.baseRef, branch), inArray(pullRequests.state, ['open'])));
    }
    await ctx.publish({ type: 'push', repoId: repo.id, ref: u.ref, before: u.before, after: u.after });
  }
}
