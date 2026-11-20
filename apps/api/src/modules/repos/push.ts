import type { FastifyBaseLogger } from 'fastify';
import { and, checkRuns, eq, inArray, pullEvents, pullRequests, repositories, type Repository, type User } from '@jumper/db';
import { CHECK_NAMES } from '@jumper/shared';
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

/**
 * Queue analysis of a commit: one job on the fast lane (ERC, DRC, BOM) and one on the slow lane (renders, exports).
 * Bounded: a Redis outage must not freeze pushes, so we give up after a few seconds.
 */
export async function enqueueAnalysis(ctx: Ctx, repoId: string, sha: string, ref?: string, force = false): Promise<void> {
  const jobId = force ? `${repoId}-${sha}-${Date.now()}` : `${repoId}-${sha}`;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Job queue unavailable')), 4000);
  });
  try {
    await Promise.race([
      Promise.all([ctx.queue.add('analyze', { repoId, sha, ref }, { jobId }), ctx.outputsQueue.add('outputs', { repoId, sha, ref }, { jobId })]),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A branch moved on before its earlier commits were analyzed: drop their jobs that have not started yet, so five quick
 * pushes cost one analysis, not five. Only waiting jobs for the same branch are dropped, and never a commit that a
 * branch or tag still points at. Running jobs finish. The dropped commits get a "skipped" result saying why.
 */
export async function dropReplacedJobs(ctx: Ctx, repoId: string, branch: string, newSha: string): Promise<number> {
  // Bounded like enqueueAnalysis: a slow or absent Redis must never hold up a push.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Job queue unavailable')), 3000);
  });
  try {
    return await Promise.race([dropReplaced(ctx, repoId, branch, newSha), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function dropReplaced(ctx: Ctx, repoId: string, branch: string, newSha: string): Promise<number> {
  const stale = new Map<string, { remove: () => Promise<void> }[]>();
  for (const q of [ctx.queue, ctx.outputsQueue]) {
    const waiting = await q.getJobs(['waiting', 'delayed', 'prioritized'], 0, 999);
    for (const j of waiting) {
      if (!j || j.data.repoId !== repoId || j.data.ref !== branch || j.data.sha === newSha) continue;
      stale.set(j.data.sha, [...(stale.get(j.data.sha) ?? []), j]);
    }
  }
  if (!stale.size) return 0;
  const kept = await gitFor(ctx, repoId).pointedCommits();
  let dropped = 0;
  for (const [sha, jobs] of stale) {
    if (kept.has(sha)) continue;
    // A job can start between listing and removing; BullMQ refuses to remove a locked job, and that's fine.
    const removed = await Promise.all(jobs.map((j) => j.remove().then(() => true, () => false)));
    if (!removed.some(Boolean)) continue;
    dropped++;
    await ctx.db
      .insert(checkRuns)
      .values(CHECK_NAMES.map((name) => ({ repoId, sha, name, projectPath: '', status: 'completed' as const, conclusion: 'skipped' as const, summary: `Not analyzed: replaced by a newer push to ${branch} before it started`, completedAt: new Date() })))
      .onConflictDoNothing();
  }
  return dropped;
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
      await dropReplacedJobs(ctx, repo.id, branch, u.after).catch((e) => log.warn(e, 'could not drop replaced jobs'));
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
