import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  and,
  asc,
  comments,
  desc,
  eq,
  inArray,
  pullEvents,
  pullRequests,
  repositories,
  reviews,
  sql,
  users,
  type Comment,
  type PullRequest,
  type Review,
} from '@pcbhub/db';
import type { Conflict } from '@pcbhub/kicad-core/types';
import {
  createCommentSchema,
  createPullSchema,
  createReviewSchema,
  isDesignFile,
  kicadFileKind,
  mergePullSchema,
  updateCommentSchema,
  updatePullSchema,
  PR_STATES,
  type CommentInfo,
  type PullDetail,
  type PullEventInfo,
  type PullInfo,
  type ReviewInfo,
  type TimelineItem,
} from '@pcbhub/shared';
import { requireUser } from '../auth/plugin';
import { EMPTY_TREE } from '../git/repo';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { loadRepo, type RepoCtx } from '../services/access';
import { audit } from '../services/audit';
import { computeMergeability, mergePull } from '../services/merge';
import { toUserSummary } from '../services/serialize';
import type { Ctx } from '../context';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const prParams = params.extend({ number: z.coerce.number().int().min(1) });

type UserRow = typeof users.$inferSelect;

async function usersById(ctx: Ctx, ids: (string | null)[]): Promise<Map<string, UserRow>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map();
  const rows = await ctx.db.select().from(users).where(inArray(users.id, unique));
  return new Map(rows.map((u) => [u.id, u]));
}

async function toPullInfos(ctx: Ctx, prs: PullRequest[]): Promise<PullInfo[]> {
  if (!prs.length) return [];
  const ids = prs.map((p) => p.id);
  const people = await usersById(ctx, prs.flatMap((p) => [p.authorId, p.mergedById]));
  const commentCounts = await ctx.db
    .select({ pullId: comments.pullId, n: sql<number>`count(*)::int` })
    .from(comments)
    .where(inArray(comments.pullId, ids))
    .groupBy(comments.pullId);
  const reviewRows = await ctx.db
    .select({ pullId: reviews.pullId, authorId: reviews.authorId, state: reviews.state, createdAt: reviews.createdAt })
    .from(reviews)
    .where(inArray(reviews.pullId, ids))
    .orderBy(desc(reviews.createdAt));
  return prs.map((p) => {
    const latest = new Map<string, string>();
    for (const r of reviewRows) if (r.pullId === p.id && r.state !== 'commented' && !latest.has(r.authorId)) latest.set(r.authorId, r.state);
    const author = people.get(p.authorId)!;
    const merger = p.mergedById ? people.get(p.mergedById) : undefined;
    return {
      id: p.id,
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.state,
      author: toUserSummary(author),
      base: p.baseRef,
      head: p.headRef,
      baseSha: p.baseSha,
      headSha: p.headSha,
      mergeCommitSha: p.mergeCommitSha,
      mergedBy: merger ? toUserSummary(merger) : null,
      mergedAt: p.mergedAt?.toISOString() ?? null,
      closedAt: p.closedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      commentCount: commentCounts.find((c) => c.pullId === p.id)?.n ?? 0,
      reviewSummary: {
        approved: [...latest.values()].filter((s) => s === 'approved').length,
        changesRequested: [...latest.values()].filter((s) => s === 'changes_requested').length,
      },
    };
  });
}

function toComment(c: Comment, people: Map<string, UserRow>): CommentInfo {
  return {
    id: c.id,
    author: toUserSummary(people.get(c.authorId)!),
    body: c.body,
    anchor: c.anchor ?? null,
    inReplyTo: c.inReplyTo,
    reviewId: c.reviewId,
    resolved: c.resolved,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function toReview(r: Review, people: Map<string, UserRow>): ReviewInfo {
  return {
    id: r.id,
    author: toUserSummary(people.get(r.authorId)!),
    state: r.state,
    body: r.body,
    commitSha: r.commitSha,
    createdAt: r.createdAt.toISOString(),
  };
}

async function loadPull(ctx: Ctx, r: RepoCtx, number: number): Promise<PullRequest> {
  const pr = (
    await ctx.db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, r.repo.id), eq(pullRequests.number, number)))
      .limit(1)
  )[0];
  if (!pr) throw notFound('Pull request not found');
  return pr;
}

const pullRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get(
    '/repos/:owner/:repo/pulls',
    { schema: { params, querystring: z.object({ state: z.enum([...PR_STATES, 'all']).default('open') }) } },
    async (req) => {
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const conds = [eq(pullRequests.repoId, r.repo.id)];
      if (req.query.state !== 'all') conds.push(eq(pullRequests.state, req.query.state));
      const prs = await ctx.db.select().from(pullRequests).where(and(...conds)).orderBy(desc(pullRequests.number)).limit(200);
      const counts = await ctx.db
        .select({ state: pullRequests.state, n: sql<number>`count(*)::int` })
        .from(pullRequests)
        .where(eq(pullRequests.repoId, r.repo.id))
        .groupBy(pullRequests.state);
      return {
        pulls: await toPullInfos(ctx, prs),
        counts: Object.fromEntries(PR_STATES.map((s) => [s, counts.find((c) => c.state === s)?.n ?? 0])),
      };
    },
  );

  app.post('/repos/:owner/:repo/pulls', { schema: { params, body: createPullSchema } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'write');
    const { base, head, title, body } = req.body;
    if (base === head) throw badRequest('Base and head must be different branches');
    const [baseSha, headSha] = await Promise.all([r.git.resolveBranch(base), r.git.resolveBranch(head)]);
    if (!baseSha) throw badRequest(`Branch "${base}" does not exist`);
    if (!headSha) throw badRequest(`Branch "${head}" does not exist`);
    if (await r.git.isAncestor(headSha, baseSha)) throw badRequest(`"${head}" has no commits that are not already in "${base}"`);
    const existing = await ctx.db
      .select({ number: pullRequests.number })
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, r.repo.id), eq(pullRequests.baseRef, base), eq(pullRequests.headRef, head), eq(pullRequests.state, 'open')))
      .limit(1);
    if (existing[0]) throw conflict(`A pull request already exists (#${existing[0].number})`);

    const pr = await ctx.db.transaction(async (tx) => {
      // Row lock on the repo serializes number allocation.
      const [repoRow] = await tx
        .update(repositories)
        .set({ nextNumber: sql`${repositories.nextNumber} + 1` })
        .where(eq(repositories.id, r.repo.id))
        .returning({ number: sql<number>`${repositories.nextNumber} - 1` });
      const [pr] = await tx
        .insert(pullRequests)
        .values({ repoId: r.repo.id, number: repoRow!.number, title, body, authorId: user.id, baseRef: base, headRef: head, baseSha, headSha })
        .returning();
      await tx.insert(pullEvents).values({ pullId: pr!.id, actorId: user.id, kind: 'opened', data: {} });
      return pr!;
    });
    await ctx.publish({ type: 'pr', repoId: r.repo.id, number: pr.number, action: 'opened' });
    await audit(req, 'pull.open', { type: 'pull', id: pr.id });
    return (await toPullInfos(ctx, [pr]))[0];
  });

  app.get('/repos/:owner/:repo/pulls/:number', { schema: { params: prParams } }, async (req): Promise<PullDetail> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const pr = await loadPull(ctx, r, req.params.number);
    const [info] = await toPullInfos(ctx, [pr]);
    const mergeability = pr.state === 'open' ? await computeMergeability(ctx, r.repo, r.git, pr).catch((e) => {
      req.log.error(e, 'mergeability failed');
      return null;
    }) : null;
    return { ...info!, mergeability };
  });

  app.patch('/repos/:owner/:repo/pulls/:number', { schema: { params: prParams, body: updatePullSchema } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const pr = await loadPull(ctx, r, req.params.number);
    const isAuthor = pr.authorId === user.id;
    if (!isAuthor && r.permission === 'read') throw forbidden();
    if (pr.state === 'merged') throw conflict('Merged pull requests cannot be edited');

    const patch: Partial<PullRequest> = { updatedAt: new Date() };
    const events: { kind: string; data: Record<string, unknown> }[] = [];
    if (req.body.title && req.body.title !== pr.title) {
      patch.title = req.body.title;
      events.push({ kind: 'renamed', data: { from: pr.title, to: req.body.title } });
    }
    if (req.body.body !== undefined) patch.body = req.body.body;
    if (req.body.state && req.body.state !== pr.state) {
      if (req.body.state === 'open') {
        const [b, h] = await Promise.all([r.git.resolveBranch(pr.baseRef), r.git.resolveBranch(pr.headRef)]);
        if (!b || !h) throw conflict('Cannot reopen: a branch no longer exists');
        patch.headSha = h;
        patch.baseSha = b;
        patch.closedAt = null;
      } else {
        patch.closedAt = new Date();
      }
      patch.state = req.body.state;
      events.push({ kind: req.body.state === 'open' ? 'reopened' : 'closed', data: {} });
    }
    const [updated] = await ctx.db.update(pullRequests).set(patch).where(eq(pullRequests.id, pr.id)).returning();
    for (const e of events) await ctx.db.insert(pullEvents).values({ pullId: pr.id, actorId: user.id, kind: e.kind, data: e.data });
    await ctx.publish({ type: 'pr', repoId: r.repo.id, number: pr.number, action: 'edited' });
    return (await toPullInfos(ctx, [updated!]))[0];
  });

  app.get('/repos/:owner/:repo/pulls/:number/timeline', { schema: { params: prParams } }, async (req): Promise<TimelineItem[]> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const pr = await loadPull(ctx, r, req.params.number);
    const [cs, rs, es] = await Promise.all([
      ctx.db.select().from(comments).where(eq(comments.pullId, pr.id)).orderBy(asc(comments.createdAt)),
      ctx.db.select().from(reviews).where(eq(reviews.pullId, pr.id)).orderBy(asc(reviews.createdAt)),
      ctx.db.select().from(pullEvents).where(eq(pullEvents.pullId, pr.id)).orderBy(asc(pullEvents.createdAt)),
    ]);
    const people = await usersById(ctx, [...cs.map((c) => c.authorId), ...rs.map((x) => x.authorId), ...es.map((e) => e.actorId)]);
    const items: TimelineItem[] = [
      ...cs.filter((c) => !c.reviewId).map((c) => ({ itemType: 'comment' as const, ...toComment(c, people) })),
      ...rs.map((rv) => ({
        itemType: 'review' as const,
        ...toReview(rv, people),
        comments: cs.filter((c) => c.reviewId === rv.id).map((c) => toComment(c, people)),
      })),
      ...es.map((e): TimelineItem => {
        const actor = e.actorId ? people.get(e.actorId) : undefined;
        const ev: PullEventInfo = {
          id: e.id,
          actor: actor ? toUserSummary(actor) : null,
          kind: e.kind as PullEventInfo['kind'],
          data: e.data,
          createdAt: e.createdAt.toISOString(),
        };
        return { itemType: 'event', ...ev };
      }),
    ];
    return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });

  /** All comments (including review comments), used to place anchors on files/objects. */
  app.get('/repos/:owner/:repo/pulls/:number/comments', { schema: { params: prParams } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const pr = await loadPull(ctx, r, req.params.number);
    const cs = await ctx.db.select().from(comments).where(eq(comments.pullId, pr.id)).orderBy(asc(comments.createdAt));
    const people = await usersById(ctx, cs.map((c) => c.authorId));
    return cs.map((c) => toComment(c, people));
  });

  app.get('/repos/:owner/:repo/pulls/:number/files', { schema: { params: prParams } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const pr = await loadPull(ctx, r, req.params.number);
    // Open PRs track the live branches; closed ones keep their last known shas.
    const headSha = (pr.state === 'open' ? await r.git.resolveBranch(pr.headRef) : null) ?? pr.headSha;
    const baseTip = (pr.state === 'open' ? await r.git.resolveBranch(pr.baseRef) : null) ?? pr.baseSha;
    const mergeBase = pr.state === 'merged' ? await r.git.mergeBase(pr.baseSha, headSha).catch(() => null) : await r.git.mergeBase(baseTip, headSha);
    const from = pr.state === 'merged' && pr.mergeCommitSha ? (await r.git.commit(pr.mergeCommitSha))?.parents[0] ?? mergeBase : mergeBase;
    const [files, commits] = await Promise.all([
      r.git.diff(from ?? EMPTY_TREE, headSha),
      from ? r.git.commitsBetween(from, headSha) : r.git.log(headSha, { limit: 250 }),
    ]);
    return { baseSha: from, headSha, files, commits };
  });

  app.get('/repos/:owner/:repo/pulls/:number/conflicts', { schema: { params: prParams } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const pr = await loadPull(ctx, r, req.params.number);
    const [baseSha, headSha] = await Promise.all([r.git.resolveBranch(pr.baseRef), r.git.resolveBranch(pr.headRef)]);
    if (!baseSha || !headSha) throw conflict('A branch no longer exists');
    const { conflicts: paths } = await r.git.mergeTree(baseSha, headSha);
    const mergeBase = await r.git.mergeBase(baseSha, headSha);
    const files: { path: string; objects: Conflict[] | null; error?: string }[] = [];
    for (const path of paths.slice(0, 50)) {
      if (!isDesignFile(path) || !mergeBase) {
        files.push({ path, objects: null });
        continue;
      }
      const read = async (sha: string) => (await r.git.readFile(sha, path, ctx.env.MAX_VIEW_BYTES))?.toString('utf8') ?? '';
      const [base, ours, theirs] = await Promise.all([read(mergeBase), read(baseSha), read(headSha)]);
      try {
        files.push({ path, objects: await ctx.kicad.conflicts(base, ours, theirs, kicadFileKind(path) === 'pcb' ? 'pcb' : 'sch') });
      } catch (e) {
        files.push({ path, objects: null, error: (e as Error).message });
      }
    }
    return { baseSha, headSha, mergeBase, files };
  });

  app.post('/repos/:owner/:repo/pulls/:number/comments', { schema: { params: prParams, body: createCommentSchema } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const pr = await loadPull(ctx, r, req.params.number);
    if (req.body.inReplyTo) {
      const parent = (await ctx.db.select().from(comments).where(and(eq(comments.id, req.body.inReplyTo), eq(comments.pullId, pr.id))).limit(1))[0];
      if (!parent) throw badRequest('Parent comment not found');
    }
    const [c] = await ctx.db
      .insert(comments)
      .values({ pullId: pr.id, authorId: user.id, body: req.body.body, anchor: req.body.anchor ?? null, inReplyTo: req.body.inReplyTo ?? null })
      .returning();
    await ctx.db.update(pullRequests).set({ updatedAt: new Date() }).where(eq(pullRequests.id, pr.id));
    await ctx.publish({ type: 'pr', repoId: r.repo.id, number: pr.number, action: 'commented' });
    return toComment(c!, new Map([[user.id, user]]));
  });

  app.patch(
    '/repos/:owner/:repo/pulls/:number/comments/:id',
    { schema: { params: prParams.extend({ id: z.uuid() }), body: updateCommentSchema } },
    async (req) => {
      const user = requireUser(req);
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const pr = await loadPull(ctx, r, req.params.number);
      const c = (await ctx.db.select().from(comments).where(and(eq(comments.id, req.params.id), eq(comments.pullId, pr.id))).limit(1))[0];
      if (!c) throw notFound('Comment not found');
      if (req.body.body !== undefined && c.authorId !== user.id) throw forbidden('Only the author can edit a comment');
      if (req.body.resolved !== undefined && c.authorId !== user.id && pr.authorId !== user.id && r.permission === 'read') throw forbidden();
      const [updated] = await ctx.db
        .update(comments)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(comments.id, c.id))
        .returning();
      const people = await usersById(ctx, [updated!.authorId]);
      return toComment(updated!, people);
    },
  );

  app.delete('/repos/:owner/:repo/pulls/:number/comments/:id', { schema: { params: prParams.extend({ id: z.uuid() }) } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const pr = await loadPull(ctx, r, req.params.number);
    const c = (await ctx.db.select().from(comments).where(and(eq(comments.id, req.params.id), eq(comments.pullId, pr.id))).limit(1))[0];
    if (!c) throw notFound('Comment not found');
    if (c.authorId !== user.id && r.permission !== 'admin') throw forbidden();
    await ctx.db.delete(comments).where(eq(comments.id, c.id));
    return { ok: true };
  });

  app.post('/repos/:owner/:repo/pulls/:number/reviews', { schema: { params: prParams, body: createReviewSchema } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const pr = await loadPull(ctx, r, req.params.number);
    if (pr.state !== 'open') throw conflict('Pull request is not open');
    if (req.body.state !== 'commented' && pr.authorId === user.id) throw badRequest('You cannot approve or request changes on your own pull request');
    if (req.body.state !== 'commented' && r.permission === 'read') throw forbidden('Only collaborators can approve or request changes');
    if (req.body.state === 'commented' && !req.body.body && !req.body.comments.length) throw badRequest('A review comment needs a body');
    const headSha = (await r.git.resolveBranch(pr.headRef)) ?? pr.headSha;
    const review = await ctx.db.transaction(async (tx) => {
      const [rv] = await tx.insert(reviews).values({ pullId: pr.id, authorId: user.id, state: req.body.state, body: req.body.body, commitSha: headSha }).returning();
      if (req.body.comments.length) {
        await tx.insert(comments).values(
          req.body.comments.map((c) => ({ pullId: pr.id, authorId: user.id, reviewId: rv!.id, body: c.body, anchor: c.anchor })),
        );
      }
      await tx.update(pullRequests).set({ updatedAt: new Date() }).where(eq(pullRequests.id, pr.id));
      return rv!;
    });
    await ctx.publish({ type: 'pr', repoId: r.repo.id, number: pr.number, action: 'reviewed' });
    return toReview(review, new Map([[user.id, user]]));
  });

  app.post('/repos/:owner/:repo/pulls/:number/merge', { schema: { params: prParams, body: mergePullSchema } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'write');
    const pr = await loadPull(ctx, r, req.params.number);
    const sha = await mergePull(ctx, r.repo, r.git, pr, user, req.body, req.log);
    await audit(req, 'pull.merge', { type: 'pull', id: pr.id }, { sha, method: req.body.method });
    return { sha };
  });
};

export default pullRoutes;
