import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, commitComments, eq, type CommitComment } from '@jumper/db';
import { ROLE_RANK, commentAnchorSchema, type CommentInfo } from '@jumper/shared';
import { requireUser } from '../auth/plugin';
import { loadRepo } from '../repos/access';
import { summary, usersById } from '../_shared/people';
import type { Ctx } from '../../context';
import { badRequest, forbidden, notFound } from '../../lib/errors';

// Comments on a commit's design: pinned to a part by KiCad UUID (the thread follows the part to later commits) or to
// an area of the board. Anyone who can read the repository and is signed in may comment; the author, or someone with
// write access, may resolve or delete.

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const idParams = params.extend({ id: z.string().uuid() });
const sha = z.string().regex(/^[0-9a-f]{40,64}$/);

async function serialize(ctx: Ctx, rows: CommitComment[]): Promise<(CommentInfo & { commitSha: string; path: string })[]> {
  const people = await usersById(
    ctx,
    rows.map((r) => r.authorId),
  );
  return rows.map((r) => ({
    id: r.id,
    author: summary(people, r.authorId),
    body: r.body,
    anchor: r.anchor ?? null,
    inReplyTo: r.inReplyTo,
    reviewId: null,
    resolved: r.resolved,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    commitSha: r.commitSha,
    path: r.path,
  }));
}

const commentRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  // Every comment on one design file, across commits: the client shows the ones whose part still exists.
  app.get('/repos/:owner/:repo/commit-comments', { schema: { params, querystring: z.object({ path: z.string().min(1).max(4096) }) } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const rows = await ctx.db
      .select()
      .from(commitComments)
      .where(and(eq(commitComments.repoId, r.repo.id), eq(commitComments.path, req.query.path)))
      .orderBy(asc(commitComments.createdAt))
      .limit(1000);
    return { comments: await serialize(ctx, rows) };
  });

  app.post(
    '/repos/:owner/:repo/commit-comments',
    {
      schema: {
        params,
        body: z.object({
          path: z.string().min(1).max(4096),
          commitSha: sha,
          body: z.string().trim().min(1).max(20000),
          anchor: commentAnchorSchema.nullable().optional(),
          inReplyTo: z.string().uuid().nullable().optional(),
        }),
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const { path, commitSha, body, anchor, inReplyTo } = req.body;
      if (!(await r.git.resolveCommit(commitSha))) throw badRequest('Unknown commit');
      if (anchor && (anchor.path !== path || anchor.commitSha !== commitSha)) throw badRequest('The anchor must point at the same file and commit');
      if (inReplyTo) {
        const parent = (await ctx.db.select().from(commitComments).where(and(eq(commitComments.id, inReplyTo), eq(commitComments.repoId, r.repo.id))).limit(1))[0];
        if (!parent) throw notFound('That thread no longer exists');
        if (parent.inReplyTo) throw badRequest('Reply to the first comment of a thread');
      }
      const [row] = await ctx.db
        .insert(commitComments)
        .values({ repoId: r.repo.id, path, commitSha, authorId: user.id, body, anchor: inReplyTo ? null : (anchor ?? null), inReplyTo: inReplyTo ?? null })
        .returning();
      reply.code(201);
      return (await serialize(ctx, [row!]))[0];
    },
  );

  const editable = async (req: Parameters<typeof loadRepo>[0], owner: string, repo: string, id: string) => {
    const user = requireUser(req);
    const r = await loadRepo(req, owner, repo);
    const row = (await ctx.db.select().from(commitComments).where(and(eq(commitComments.id, id), eq(commitComments.repoId, r.repo.id))).limit(1))[0];
    if (!row) throw notFound('Comment not found');
    if (row.authorId !== user.id && ROLE_RANK[r.permission] < ROLE_RANK.write && !user.isAdmin) throw forbidden('Only the author or someone with write access can do that');
    return row;
  };

  app.patch(
    '/repos/:owner/:repo/commit-comments/:id',
    { schema: { params: idParams, body: z.object({ resolved: z.boolean().optional(), body: z.string().trim().min(1).max(20000).optional() }) } },
    async (req) => {
      const row = await editable(req, req.params.owner, req.params.repo, req.params.id);
      if (req.body.body !== undefined && row.authorId !== req.user!.id) throw forbidden('Only the author can edit a comment');
      const [updated] = await ctx.db
        .update(commitComments)
        .set({ ...(req.body.resolved !== undefined ? { resolved: req.body.resolved } : {}), ...(req.body.body !== undefined ? { body: req.body.body } : {}), updatedAt: new Date() })
        .where(eq(commitComments.id, row.id))
        .returning();
      return (await serialize(ctx, [updated!]))[0];
    },
  );

  app.delete('/repos/:owner/:repo/commit-comments/:id', { schema: { params: idParams } }, async (req, reply) => {
    const row = await editable(req, req.params.owner, req.params.repo, req.params.id);
    // Deleting a thread's first comment removes its replies with it.
    await ctx.db.delete(commitComments).where(eq(commitComments.inReplyTo, row.id));
    await ctx.db.delete(commitComments).where(eq(commitComments.id, row.id));
    reply.code(204);
    return null;
  });
};

export default commentRoutes;
