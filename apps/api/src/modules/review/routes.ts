import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, approvalRules, asc, checklistItems, eq, pullEvents, pullRequests, sql, users } from '@jumper/db';
import { approvalRuleSchema, type ApprovalRuleInfo, type ChecklistItemInfo } from '@jumper/shared';
import { requireUser } from '../auth/plugin';
import type { Ctx } from '../../context';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { loadRepo, type RepoCtx } from '../repos/access';
import { audit } from '../audit/audit';
import { summary, usersById } from '../_shared/people';
import { getRepoConfig } from '../_shared/repo-config';
import { matchesGlob } from '../_shared/glob';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const prParams = params.extend({ number: z.coerce.number().int().positive() });

async function loadPull(ctx: Ctx, r: RepoCtx, number: number) {
  const pr = (await ctx.db.select().from(pullRequests).where(and(eq(pullRequests.repoId, r.repo.id), eq(pullRequests.number, number))).limit(1))[0];
  if (!pr) throw notFound('Pull request not found');
  return pr;
}

async function toItems(ctx: Ctx, rows: (typeof checklistItems.$inferSelect)[]): Promise<ChecklistItemInfo[]> {
  const people = await usersById(ctx, rows.map((r) => r.doneBy));
  return rows.map((i) => ({ id: i.id, text: i.text, done: i.doneAt !== null, doneBy: i.doneBy ? summary(people, i.doneBy) : null, doneAt: i.doneAt?.toISOString() ?? null }));
}

const reviewRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  // ---------- approval rules (sign-off by area) ----------

  app.get('/repos/:owner/:repo/approval-rules', { schema: { params } }, async (req): Promise<ApprovalRuleInfo[]> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const rows = await ctx.db.select().from(approvalRules).where(eq(approvalRules.repoId, r.repo.id)).orderBy(asc(approvalRules.name));
    const people = await usersById(ctx, rows.flatMap((x) => x.approverIds));
    return rows.map((x) => ({ id: x.id, name: x.name, pathPattern: x.pathPattern, requiredApprovals: x.requiredApprovals, approvers: x.approverIds.filter((id) => people.has(id)).map((id) => summary(people, id)) }));
  });

  async function resolveApprovers(names: string[]): Promise<string[]> {
    if (!names.length) return [];
    const rows = await ctx.db.select({ id: users.id, username: users.username }).from(users).where(sql`lower(${users.username}) in (${sql.join(names.map((n) => sql`${n.toLowerCase()}`), sql`, `)})`);
    const missing = names.filter((n) => !rows.some((u) => u.username.toLowerCase() === n.toLowerCase()));
    if (missing.length) throw badRequest(`Unknown user(s): ${missing.join(', ')}`);
    return rows.map((u) => u.id);
  }

  app.post('/repos/:owner/:repo/approval-rules', { schema: { params, body: approvalRuleSchema } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const approverIds = await resolveApprovers(req.body.approvers);
    if (approverIds.length && approverIds.length < req.body.requiredApprovals) throw badRequest('More approvals are required than there are named approvers');
    const [row] = await ctx.db.insert(approvalRules).values({ repoId: r.repo.id, name: req.body.name, pathPattern: req.body.pathPattern, requiredApprovals: req.body.requiredApprovals, approverIds }).returning();
    await audit(req, 'approval_rule.create', { type: 'repo', id: r.repo.id }, { name: req.body.name, pattern: req.body.pathPattern });
    return { id: row!.id };
  });

  app.delete('/repos/:owner/:repo/approval-rules/:id', { schema: { params: params.extend({ id: z.uuid() }) } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const res = await ctx.db.delete(approvalRules).where(and(eq(approvalRules.id, req.params.id), eq(approvalRules.repoId, r.repo.id))).returning({ id: approvalRules.id });
    if (!res.length) throw notFound('Rule not found');
    await audit(req, 'approval_rule.delete', { type: 'repo', id: r.repo.id }, { id: req.params.id });
    return { ok: true };
  });

  app.get('/repos/:owner/:repo/approval-rules/test', { schema: { params, querystring: z.object({ paths: z.string().max(8000) }) } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const paths = req.query.paths.split(',').map((p) => p.trim()).filter(Boolean).slice(0, 200);
    const rows = await ctx.db.select().from(approvalRules).where(eq(approvalRules.repoId, r.repo.id));
    return rows.filter((x) => paths.some((p) => matchesGlob(x.pathPattern, p))).map((x) => ({ id: x.id, name: x.name, pathPattern: x.pathPattern }));
  });

  // ---------- checklist ----------

  app.get('/repos/:owner/:repo/pulls/:number/checklist', { schema: { params: prParams } }, async (req): Promise<ChecklistItemInfo[]> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const pr = await loadPull(ctx, r, req.params.number);
    const seeded = (await ctx.db.select({ id: pullEvents.id }).from(pullEvents).where(and(eq(pullEvents.pullId, pr.id), eq(pullEvents.kind, 'checklist_seeded'))).limit(1))[0];
    if (!seeded && req.user) {
      // First view: copy the repository's template onto this pull request (once).
      const cfg = await getRepoConfig(ctx, r.repo.id);
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'checklist:' + pr.id}))`);
        const again = await tx.select({ id: pullEvents.id }).from(pullEvents).where(and(eq(pullEvents.pullId, pr.id), eq(pullEvents.kind, 'checklist_seeded'))).limit(1);
        if (again[0]) return;
        if (cfg.checklistTemplate.length) await tx.insert(checklistItems).values(cfg.checklistTemplate.map((text, position) => ({ pullId: pr.id, text, position })));
        await tx.insert(pullEvents).values({ pullId: pr.id, actorId: null, kind: 'checklist_seeded', data: {} });
      });
    }
    return toItems(ctx, await ctx.db.select().from(checklistItems).where(eq(checklistItems.pullId, pr.id)).orderBy(asc(checklistItems.position), asc(checklistItems.id)));
  });

  app.post('/repos/:owner/:repo/pulls/:number/checklist', { schema: { params: prParams, body: z.object({ text: z.string().trim().min(1).max(300) }) } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const pr = await loadPull(ctx, r, req.params.number);
    if (r.permission === 'read' && pr.authorId !== user.id) throw forbidden();
    const [{ n }] = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(checklistItems).where(eq(checklistItems.pullId, pr.id))) as [{ n: number }];
    if (n >= 100) throw badRequest('A pull request can have at most 100 checklist items');
    const [row] = await ctx.db.insert(checklistItems).values({ pullId: pr.id, text: req.body.text, position: n }).returning();
    return (await toItems(ctx, [row!]))[0]!;
  });

  app.patch('/repos/:owner/:repo/pulls/:number/checklist/:id', { schema: { params: prParams.extend({ id: z.uuid() }), body: z.object({ done: z.boolean() }) } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const pr = await loadPull(ctx, r, req.params.number);
    if (r.permission === 'read') throw forbidden('Only collaborators can tick checklist items');
    const res = await ctx.db
      .update(checklistItems)
      .set(req.body.done ? { doneBy: user.id, doneAt: new Date() } : { doneBy: null, doneAt: null })
      .where(and(eq(checklistItems.id, req.params.id), eq(checklistItems.pullId, pr.id)))
      .returning();
    if (!res[0]) throw notFound('Checklist item not found');
    return (await toItems(ctx, res))[0]!;
  });

  app.delete('/repos/:owner/:repo/pulls/:number/checklist/:id', { schema: { params: prParams.extend({ id: z.uuid() }) } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const pr = await loadPull(ctx, r, req.params.number);
    if (r.permission === 'read' && pr.authorId !== user.id) throw forbidden();
    const res = await ctx.db.delete(checklistItems).where(and(eq(checklistItems.id, req.params.id), eq(checklistItems.pullId, pr.id))).returning({ id: checklistItems.id });
    if (!res.length) throw notFound('Checklist item not found');
    return { ok: true };
  });

};

export default reviewRoutes;
