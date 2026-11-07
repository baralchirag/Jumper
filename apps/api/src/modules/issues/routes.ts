import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, issueComments, issues, milestones, or, repositories, sql, users, type Issue } from '@jumper/db';
import { createIssueSchema, issueLocationSchema, milestoneInputSchema, updateIssueSchema, type IssueCommentInfo, type IssueInfo, type MilestoneInfo } from '@jumper/shared';
import { requireUser } from '../auth/plugin';
import type { Ctx } from '../../context';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { loadRepo, type RepoCtx } from '../repos/access';
import { audit } from '../audit/audit';
import { summary, usersById } from '../_shared/people';
import { notify, notifyMentions } from '../notifications/service';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const numParams = params.extend({ number: z.coerce.number().int().positive() });

async function toInfos(ctx: Ctx, rows: Issue[]): Promise<IssueInfo[]> {
  if (!rows.length) return [];
  const people = await usersById(ctx, rows.flatMap((i) => [i.authorId, i.assigneeId]));
  const counts = await ctx.db
    .select({ issueId: issueComments.issueId, n: sql<number>`count(*)::int` })
    .from(issueComments)
    .where(inArray(issueComments.issueId, rows.map((r) => r.id)))
    .groupBy(issueComments.issueId);
  const msIds = [...new Set(rows.map((r) => r.milestoneId).filter((x): x is string => !!x))];
  const ms = msIds.length ? await ctx.db.select({ id: milestones.id, title: milestones.title }).from(milestones).where(inArray(milestones.id, msIds)) : [];
  return rows.map((i) => ({
    id: i.id,
    number: i.number,
    kind: i.kind,
    title: i.title,
    body: i.body,
    state: i.state,
    author: summary(people, i.authorId),
    assignee: i.assigneeId ? summary(people, i.assigneeId) : null,
    milestone: ms.find((m) => m.id === i.milestoneId) ?? null,
    labels: i.labels,
    locations: i.locations,
    commentCount: counts.find((c) => c.issueId === i.id)?.n ?? 0,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    closedAt: i.closedAt?.toISOString() ?? null,
  }));
}

async function loadIssue(ctx: Ctx, r: RepoCtx, number: number): Promise<Issue> {
  const row = (await ctx.db.select().from(issues).where(and(eq(issues.repoId, r.repo.id), eq(issues.number, number))).limit(1))[0];
  if (!row) throw notFound('Issue not found');
  return row;
}

/** Resolve an assignee username to a user who can read the repository. */
async function resolveAssignee(ctx: Ctx, name: string | null | undefined): Promise<string | null> {
  if (!name) return null;
  const u = (await ctx.db.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = lower(${name})`).limit(1))[0];
  if (!u) throw badRequest(`Unknown user "${name}"`);
  return u.id;
}

async function checkMilestone(ctx: Ctx, repoId: string, id: string | null | undefined): Promise<void> {
  if (!id) return;
  const m = (await ctx.db.select({ id: milestones.id }).from(milestones).where(and(eq(milestones.id, id), eq(milestones.repoId, repoId))).limit(1))[0];
  if (!m) throw badRequest('Milestone not found in this repository');
}

const issueRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get(
    '/repos/:owner/:repo/issues',
    {
      schema: {
        params,
        querystring: z.object({
          kind: z.enum(['issue', 'discussion']).default('issue'),
          state: z.enum(['open', 'closed', 'all']).default('open'),
          q: z.string().max(200).optional(),
          label: z.string().max(40).optional(),
          milestone: z.uuid().optional(),
          assignee: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => {
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const q = req.query;
      const conds = [eq(issues.repoId, r.repo.id), eq(issues.kind, q.kind)];
      if (q.state !== 'all') conds.push(eq(issues.state, q.state));
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
        conds.push(or(ilike(issues.title, like), ilike(issues.body, like))!);
      }
      if (q.label) conds.push(sql`${q.label} = any(${issues.labels})`);
      if (q.milestone) conds.push(eq(issues.milestoneId, q.milestone));
      if (q.assignee) conds.push(sql`${issues.assigneeId} = (select id from users where lower(username) = lower(${q.assignee}))`);
      const where = and(...conds);
      const rows = await ctx.db.select().from(issues).where(where).orderBy(desc(issues.createdAt)).limit(q.limit).offset(q.offset);
      const [{ n }] = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(issues).where(where)) as [{ n: number }];
      const counts = await ctx.db
        .select({ state: issues.state, n: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.repoId, r.repo.id), eq(issues.kind, q.kind)))
        .groupBy(issues.state);
      return {
        total: n,
        open: counts.find((c) => c.state === 'open')?.n ?? 0,
        closed: counts.find((c) => c.state === 'closed')?.n ?? 0,
        items: await toInfos(ctx, rows),
      };
    },
  );

  app.post('/repos/:owner/:repo/issues', { schema: { params, body: createIssueSchema } }, async (req): Promise<IssueInfo> => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const b = req.body;
    await checkMilestone(ctx, r.repo.id, b.milestoneId);
    // Only collaborators triage: assignment and milestones need write access.
    const canTriage = r.permission !== 'read';
    const assigneeId = canTriage ? await resolveAssignee(ctx, b.assignee) : null;
    const issue = await ctx.db.transaction(async (tx) => {
      const [{ number }] = (await tx
        .update(repositories)
        .set({ nextNumber: sql`${repositories.nextNumber} + 1` })
        .where(eq(repositories.id, r.repo.id))
        .returning({ number: sql<number>`${repositories.nextNumber} - 1` })) as [{ number: number }];
      const [row] = await tx
        .insert(issues)
        .values({
          repoId: r.repo.id,
          number,
          kind: b.kind,
          title: b.title,
          body: b.body,
          authorId: user.id,
          assigneeId,
          milestoneId: canTriage ? (b.milestoneId ?? null) : null,
          labels: canTriage ? [...new Set(b.labels)] : [],
          locations: b.locations,
        })
        .returning();
      return row!;
    });
    const url = `/${r.ns.slug}/${r.repo.name}/${issue.kind === 'issue' ? 'issues' : 'discussions'}/${issue.number}`;
    await notifyMentions(ctx, r.repo, r.ns, user.id, `${b.title}\n${b.body}`, `${user.username} mentioned you in "${b.title}"`, url);
    if (assigneeId) await notify(ctx, { repo: r.repo, ns: r.ns, actorId: user.id, kind: 'assigned', title: `${user.username} assigned you to "${b.title}"`, url, recipients: [assigneeId] });
    await ctx.publish({ type: 'issue', repoId: r.repo.id, number: issue.number, action: 'opened' });
    await audit(req, 'issue.create', { type: 'issue', id: issue.id }, { number: issue.number });
    return (await toInfos(ctx, [issue]))[0]!;
  });

  app.get('/repos/:owner/:repo/issues/:number', { schema: { params: numParams } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const issue = await loadIssue(ctx, r, req.params.number);
    const cs = await ctx.db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)).orderBy(issueComments.createdAt);
    const people = await usersById(ctx, cs.map((c) => c.authorId));
    const comments: IssueCommentInfo[] = cs.map((c) => ({ id: c.id, author: summary(people, c.authorId), body: c.body, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() }));
    return { issue: (await toInfos(ctx, [issue]))[0]!, comments };
  });

  app.patch('/repos/:owner/:repo/issues/:number', { schema: { params: numParams, body: updateIssueSchema } }, async (req): Promise<IssueInfo> => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const issue = await loadIssue(ctx, r, req.params.number);
    const b = req.body;
    const isAuthor = issue.authorId === user.id;
    const canTriage = r.permission !== 'read';
    if (!canTriage && !isAuthor) throw forbidden();
    // Authors without write access may edit text and close/reopen their own issue, nothing else.
    if (!canTriage && (b.labels !== undefined || b.assignee !== undefined || b.milestoneId !== undefined)) throw forbidden('Only collaborators can change labels, assignees and milestones');
    await checkMilestone(ctx, r.repo.id, b.milestoneId);
    const set: Partial<typeof issues.$inferInsert> = { updatedAt: new Date() };
    if (b.title !== undefined) set.title = b.title;
    if (b.body !== undefined) set.body = b.body;
    if (b.labels !== undefined) set.labels = [...new Set(b.labels)];
    if (b.locations !== undefined) set.locations = b.locations;
    if (b.milestoneId !== undefined) set.milestoneId = b.milestoneId;
    if (b.assignee !== undefined) set.assigneeId = await resolveAssignee(ctx, b.assignee);
    if (b.state !== undefined && b.state !== issue.state) {
      set.state = b.state;
      set.closedAt = b.state === 'closed' ? new Date() : null;
    }
    const [row] = await ctx.db.update(issues).set(set).where(eq(issues.id, issue.id)).returning();
    const url = `/${r.ns.slug}/${r.repo.name}/${row!.kind === 'issue' ? 'issues' : 'discussions'}/${row!.number}`;
    if (set.assigneeId && set.assigneeId !== issue.assigneeId) {
      await notify(ctx, { repo: r.repo, ns: r.ns, actorId: user.id, kind: 'assigned', title: `${user.username} assigned you to "${row!.title}"`, url, recipients: [set.assigneeId] });
    }
    if (b.body !== undefined) await notifyMentions(ctx, r.repo, r.ns, user.id, b.body, `${user.username} mentioned you in "${row!.title}"`, url);
    await ctx.publish({ type: 'issue', repoId: r.repo.id, number: row!.number, action: set.state ?? 'edited' });
    await audit(req, 'issue.update', { type: 'issue', id: issue.id }, { fields: Object.keys(b) });
    return (await toInfos(ctx, [row!]))[0]!;
  });

  app.post('/repos/:owner/:repo/issues/:number/comments', { schema: { params: numParams, body: z.object({ body: z.string().trim().min(1).max(65_536) }) } }, async (req): Promise<IssueCommentInfo> => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const issue = await loadIssue(ctx, r, req.params.number);
    const [c] = await ctx.db.insert(issueComments).values({ issueId: issue.id, authorId: user.id, body: req.body.body }).returning();
    await ctx.db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
    const url = `/${r.ns.slug}/${r.repo.name}/${issue.kind === 'issue' ? 'issues' : 'discussions'}/${issue.number}`;
    await notifyMentions(ctx, r.repo, r.ns, user.id, req.body.body, `${user.username} mentioned you in "${issue.title}"`, url);
    await notify(ctx, { repo: r.repo, ns: r.ns, actorId: user.id, kind: 'comment', title: `${user.username} commented on "${issue.title}"`, url, recipients: [issue.authorId, ...(issue.assigneeId ? [issue.assigneeId] : [])] });
    await ctx.publish({ type: 'issue', repoId: r.repo.id, number: issue.number, action: 'commented' });
    return { id: c!.id, author: summary(new Map([[user.id, user]]), user.id), body: c!.body, createdAt: c!.createdAt.toISOString(), updatedAt: c!.updatedAt.toISOString() };
  });

  app.patch(
    '/repos/:owner/:repo/issue-comments/:id',
    { schema: { params: params.extend({ id: z.uuid() }), body: z.object({ body: z.string().trim().min(1).max(65_536) }) } },
    async (req) => {
      const user = requireUser(req);
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const c = await commentInRepo(ctx, r, req.params.id);
      if (c.authorId !== user.id) throw forbidden('You can only edit your own comments');
      await ctx.db.update(issueComments).set({ body: req.body.body, updatedAt: new Date() }).where(eq(issueComments.id, c.id));
      return { ok: true };
    },
  );

  app.delete('/repos/:owner/:repo/issue-comments/:id', { schema: { params: params.extend({ id: z.uuid() }) } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const c = await commentInRepo(ctx, r, req.params.id);
    if (c.authorId !== user.id && r.permission !== 'admin') throw forbidden();
    await ctx.db.delete(issueComments).where(eq(issueComments.id, c.id));
    await audit(req, 'issue.comment.delete', { type: 'issue_comment', id: c.id });
    return { ok: true };
  });

  // ---------- milestones ----------

  app.get('/repos/:owner/:repo/milestones', { schema: { params } }, async (req): Promise<MilestoneInfo[]> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const rows = await ctx.db.select().from(milestones).where(eq(milestones.repoId, r.repo.id)).orderBy(sql`${milestones.dueOn} nulls last`, milestones.title);
    const counts = await ctx.db
      .select({ id: issues.milestoneId, state: issues.state, n: sql<number>`count(*)::int` })
      .from(issues)
      .where(and(eq(issues.repoId, r.repo.id), sql`${issues.milestoneId} is not null`))
      .groupBy(issues.milestoneId, issues.state);
    return rows.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      dueOn: m.dueOn?.toISOString() ?? null,
      state: m.state,
      openIssues: counts.find((c) => c.id === m.id && c.state === 'open')?.n ?? 0,
      closedIssues: counts.find((c) => c.id === m.id && c.state === 'closed')?.n ?? 0,
    }));
  });

  app.post('/repos/:owner/:repo/milestones', { schema: { params, body: milestoneInputSchema } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'write');
    const dup = (await ctx.db.select({ id: milestones.id }).from(milestones).where(and(eq(milestones.repoId, r.repo.id), sql`lower(${milestones.title}) = lower(${req.body.title})`)).limit(1))[0];
    if (dup) throw badRequest('A milestone with that title already exists');
    const [m] = await ctx.db.insert(milestones).values({ repoId: r.repo.id, title: req.body.title, description: req.body.description, dueOn: req.body.dueOn ? new Date(req.body.dueOn) : null }).returning();
    return { id: m!.id };
  });

  app.patch(
    '/repos/:owner/:repo/milestones/:id',
    { schema: { params: params.extend({ id: z.uuid() }), body: milestoneInputSchema.partial().extend({ state: z.enum(['open', 'closed']).optional() }) } },
    async (req) => {
      const r = await loadRepo(req, req.params.owner, req.params.repo, 'write');
      const b = req.body;
      const set: Partial<typeof milestones.$inferInsert> = {};
      if (b.title !== undefined) set.title = b.title;
      if (b.description !== undefined) set.description = b.description;
      if (b.dueOn !== undefined) set.dueOn = b.dueOn ? new Date(b.dueOn) : null;
      if (b.state !== undefined) set.state = b.state;
      if (!Object.keys(set).length) return { ok: true };
      const res = await ctx.db.update(milestones).set(set).where(and(eq(milestones.id, req.params.id), eq(milestones.repoId, r.repo.id))).returning({ id: milestones.id });
      if (!res.length) throw notFound('Milestone not found');
      return { ok: true };
    },
  );

  app.delete('/repos/:owner/:repo/milestones/:id', { schema: { params: params.extend({ id: z.uuid() }) } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'write');
    const res = await ctx.db.delete(milestones).where(and(eq(milestones.id, req.params.id), eq(milestones.repoId, r.repo.id))).returning({ id: milestones.id });
    if (!res.length) throw notFound('Milestone not found');
    return { ok: true };
  });
};

async function commentInRepo(ctx: Ctx, r: RepoCtx, id: string) {
  const row = (
    await ctx.db
      .select({ c: issueComments })
      .from(issueComments)
      .innerJoin(issues, eq(issues.id, issueComments.issueId))
      .where(and(eq(issueComments.id, id), eq(issues.repoId, r.repo.id)))
      .limit(1)
  )[0];
  if (!row) throw notFound('Comment not found');
  return row.c;
}

// Re-exported so the schema's location type is part of this module's surface for clients.
export const locationSchema = issueLocationSchema;
export default issueRoutes;
