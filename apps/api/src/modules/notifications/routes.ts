import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, namespaces, notifications, repoFollows, repositories, sql } from '@jumper/db';
import type { NotificationInfo } from '@jumper/shared';
import { requireUser } from '../auth/plugin';
import { loadRepo } from '../repos/access';
import { summary, usersById } from '../_shared/people';

const notificationRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get(
    '/notifications',
    { schema: { querystring: z.object({ unread: z.stringbool().default(false), limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) }) } },
    async (req) => {
      const user = requireUser(req);
      const conds = [eq(notifications.userId, user.id)];
      if (req.query.unread) conds.push(isNull(notifications.readAt));
      const rows = await ctx.db
        .select({ n: notifications, repo: sql<string | null>`(select ns.slug || '/' || r.name from ${repositories} r join ${namespaces} ns on ns.id = r.namespace_id where r.id = ${notifications.repoId})` })
        .from(notifications)
        .where(and(...conds))
        .orderBy(desc(notifications.createdAt))
        .limit(req.query.limit)
        .offset(req.query.offset);
      const people = await usersById(ctx, rows.map((r) => r.n.actorId));
      const [{ unread }] = (await ctx.db.select({ unread: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)))) as [{ unread: number }];
      const items: NotificationInfo[] = rows.map(({ n, repo }) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        url: n.url,
        repo,
        actor: n.actorId ? summary(people, n.actorId) : null,
        read: n.readAt !== null,
        createdAt: n.createdAt.toISOString(),
      }));
      return { unread, items };
    },
  );

  app.post(
    '/notifications/read',
    { schema: { body: z.object({ ids: z.array(z.uuid()).max(200).optional() }) } },
    async (req) => {
      const user = requireUser(req);
      const where = req.body.ids ? and(eq(notifications.userId, user.id), inArray(notifications.id, req.body.ids)) : and(eq(notifications.userId, user.id), isNull(notifications.readAt));
      await ctx.db.update(notifications).set({ readAt: new Date() }).where(where);
      return { ok: true };
    },
  );

  // Following a repository: get notified of its activity.
  const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
  app.get('/repos/:owner/:repo/follow', { schema: { params } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const row = (await ctx.db.select().from(repoFollows).where(and(eq(repoFollows.userId, user.id), eq(repoFollows.repoId, r.repo.id))).limit(1))[0];
    return { following: Boolean(row) };
  });
  app.put('/repos/:owner/:repo/follow', { schema: { params, body: z.object({ following: z.boolean() }) } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    if (req.body.following) await ctx.db.insert(repoFollows).values({ userId: user.id, repoId: r.repo.id }).onConflictDoNothing();
    else await ctx.db.delete(repoFollows).where(and(eq(repoFollows.userId, user.id), eq(repoFollows.repoId, r.repo.id)));
    return { following: req.body.following };
  });
};

export default notificationRoutes;
