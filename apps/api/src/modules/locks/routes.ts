import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, fileLocks, gt, lt } from '@jumper/db';
import { createLockSchema, type LockInfo } from '@jumper/shared';
import { requireUser } from '../auth/plugin';
import type { Ctx } from '../../context';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { loadRepo } from '../repos/access';
import { audit } from '../audit/audit';
import { summary, usersById } from '../_shared/people';
import { notify } from '../notifications/service';
import { locksConflict, sameRegion } from './service';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });

export async function activeLocks(ctx: Ctx, repoId: string) {
  const now = new Date();
  await ctx.db.delete(fileLocks).where(and(eq(fileLocks.repoId, repoId), lt(fileLocks.expiresAt, now)));
  return ctx.db.select().from(fileLocks).where(and(eq(fileLocks.repoId, repoId), gt(fileLocks.expiresAt, now)));
}

const lockRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get('/repos/:owner/:repo/locks', { schema: { params } }, async (req): Promise<LockInfo[]> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const rows = await activeLocks(ctx, r.repo.id);
    const people = await usersById(ctx, rows.map((l) => l.lockedBy));
    return rows.map((l) => ({ id: l.id, path: l.path, region: l.region, reason: l.reason, lockedBy: summary(people, l.lockedBy), expiresAt: l.expiresAt.toISOString(), createdAt: l.createdAt.toISOString() }));
  });

  app.post('/repos/:owner/:repo/locks', { schema: { params, body: createLockSchema } }, async (req): Promise<LockInfo> => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'write');
    const b = req.body;
    const path = b.path.replace(/^\/+/, '');
    const region = b.region ?? null;
    // Serialise lock acquisition per repository so two people cannot both win a race.
    const lock = await ctx.db.transaction(async (tx) => {
      await tx.execute(`select pg_advisory_xact_lock(hashtext('lock:${r.repo.id}'))`);
      const now = new Date();
      await tx.delete(fileLocks).where(and(eq(fileLocks.repoId, r.repo.id), lt(fileLocks.expiresAt, now)));
      const existing = await tx.select().from(fileLocks).where(and(eq(fileLocks.repoId, r.repo.id), eq(fileLocks.path, path)));
      const clash = existing.find((l) => l.lockedBy !== user.id && locksConflict({ path, region }, l));
      if (clash) return { clash };
      // Re-locking the same scope refreshes it instead of stacking duplicates.
      const mine = existing.filter((l) => l.lockedBy === user.id && sameRegion(l.region, region));
      const expiresAt = new Date(Date.now() + b.ttlMinutes * 60_000);
      if (mine[0]) {
        const [row] = await tx.update(fileLocks).set({ expiresAt, reason: b.reason }).where(eq(fileLocks.id, mine[0].id)).returning();
        return { row: row! };
      }
      const [row] = await tx.insert(fileLocks).values({ repoId: r.repo.id, path, region, lockedBy: user.id, reason: b.reason, expiresAt }).returning();
      return { row: row! };
    });
    if ('clash' in lock && lock.clash) {
      const owner = (await usersById(ctx, [lock.clash.lockedBy])).get(lock.clash.lockedBy);
      throw conflict(`${path} is locked by ${owner?.username ?? 'someone else'} until ${lock.clash.expiresAt.toISOString()}`, { lockId: lock.clash.id });
    }
    const row = (lock as { row: typeof fileLocks.$inferSelect }).row;
    await audit(req, 'lock.create', { type: 'repo', id: r.repo.id }, { path, region });
    return { id: row.id, path: row.path, region: row.region, reason: row.reason, lockedBy: summary(new Map([[user.id, user]]), user.id), expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString() };
  });

  app.delete('/repos/:owner/:repo/locks/:id', { schema: { params: params.extend({ id: z.uuid() }) } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'write');
    const lock = (await ctx.db.select().from(fileLocks).where(and(eq(fileLocks.id, req.params.id), eq(fileLocks.repoId, r.repo.id))).limit(1))[0];
    if (!lock) throw notFound('Lock not found');
    if (lock.lockedBy !== user.id && r.permission !== 'admin') throw forbidden('Only the lock owner or a repository admin can release this lock');
    await ctx.db.delete(fileLocks).where(eq(fileLocks.id, lock.id));
    if (lock.lockedBy !== user.id) {
      await notify(ctx, { repo: r.repo, ns: r.ns, actorId: user.id, kind: 'lock', title: `${user.username} released your lock on ${lock.path}`, url: `/${r.ns.slug}/${r.repo.name}`, recipients: [lock.lockedBy] });
    }
    await audit(req, 'lock.release', { type: 'repo', id: r.repo.id }, { path: lock.path });
    return { ok: true };
  });
};

export default lockRoutes;
