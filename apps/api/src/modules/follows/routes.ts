// Following people: follow / unfollow, and the follower and following lists shown on a profile.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, follows, sql, users, type User } from '@jumper/db';
import type { FollowList } from '@jumper/shared';
import { requireUser } from '../auth/plugin';
import { badRequest, notFound } from '../../lib/errors';
import { toUserSummary } from '../repos/serialize';
import type { Ctx } from '../../context';

const PAGE = 50;
const username = z.object({ username: z.string().min(1).max(100) });
/** Following is cheap to spam; keep it to human speed. */
const writeLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };

/** An active user by username (case-insensitive); disabled accounts are treated as missing. */
async function findUser(ctx: Ctx, name: string): Promise<User | undefined> {
  const [u] = await ctx.db.select().from(users).where(sql`lower(${users.username}) = lower(${name})`).limit(1);
  return u && !u.disabled ? u : undefined;
}

/** Follower and following counts for a user, plus whether `viewerId` follows them. */
export async function followStats(ctx: Ctx, userId: string, viewerId?: string) {
  const [row] = (await ctx.db.execute(sql`
    select
      (select count(*)::int from follows f join users u on u.id = f.follower_id where f.followee_id = ${userId} and not u.disabled) as followers,
      (select count(*)::int from follows f join users u on u.id = f.followee_id where f.follower_id = ${userId} and not u.disabled) as following,
      ${viewerId ? sql`exists(select 1 from follows where follower_id = ${viewerId} and followee_id = ${userId})` : sql`false`} as "viewerFollows"
  `)) as unknown as [{ followers: number; following: number; viewerFollows: boolean }];
  return row;
}

const followRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  const list = (direction: 'followers' | 'following') =>
    app.get(
      `/users/:username/${direction}`,
      { schema: { params: username, querystring: z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) }) } },
      async (req): Promise<FollowList> => {
        const target = await findUser(ctx, req.params.username);
        if (!target) throw notFound('User not found');
        // followers: people whose follower_id points at target; following: people target points at.
        const [mine, theirs] = direction === 'followers' ? [follows.followeeId, follows.followerId] : [follows.followerId, follows.followeeId];
        const rows = await ctx.db
          .select({ user: users, since: follows.createdAt })
          .from(follows)
          .innerJoin(users, eq(users.id, theirs))
          .where(and(eq(mine, target.id), eq(users.disabled, false)))
          .orderBy(desc(follows.createdAt))
          .limit(PAGE + 1)
          .offset((req.query.page - 1) * PAGE);
        const page = rows.slice(0, PAGE);
        let followedByViewer = new Set<string>();
        if (req.user && page.length) {
          const ids = page.map((r) => r.user.id);
          const mineRows = await ctx.db
            .select({ id: follows.followeeId })
            .from(follows)
            .where(and(eq(follows.followerId, req.user.id), sql`${follows.followeeId} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`));
          followedByViewer = new Set(mineRows.map((r) => r.id));
        }
        return {
          users: page.map((r) => ({ ...toUserSummary(r.user), bio: r.user.bio, viewerFollows: followedByViewer.has(r.user.id) })),
          nextPage: rows.length > PAGE ? req.query.page + 1 : null,
        };
      },
    );
  list('followers');
  list('following');

  app.put('/user/following/:username', { schema: { params: username }, config: writeLimit }, async (req) => {
    const me = requireUser(req);
    const target = await findUser(ctx, req.params.username);
    if (!target) throw notFound('User not found');
    if (target.id === me.id) throw badRequest('You cannot follow yourself');
    await ctx.db.insert(follows).values({ followerId: me.id, followeeId: target.id }).onConflictDoNothing();
    return followStats(ctx, target.id, me.id);
  });

  app.delete('/user/following/:username', { schema: { params: username }, config: writeLimit }, async (req) => {
    const me = requireUser(req);
    const target = await findUser(ctx, req.params.username);
    if (!target) throw notFound('User not found');
    await ctx.db.delete(follows).where(and(eq(follows.followerId, me.id), eq(follows.followeeId, target.id)));
    return followStats(ctx, target.id, me.id);
  });
};

export default followRoutes;
