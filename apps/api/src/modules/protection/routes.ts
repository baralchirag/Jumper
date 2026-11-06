import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { branchProtection, eq } from '@jumper/db';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { audit } from '../audit/audit';
import { loadRepo } from '../repos/access';
import { findRule, rulesFor, validatePattern, isInherited, ownRulesFor } from './service';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const flags = z.object({
  blockDeletion: z.boolean(),
  blockForcePush: z.boolean(),
  requirePullRequest: z.boolean(),
  enforceAdmins: z.boolean(),
});

const protectionRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  const out = (r: Awaited<ReturnType<typeof rulesFor>>[number]) => ({
    id: r.id,
    pattern: r.pattern,
    blockDeletion: r.blockDeletion,
    blockForcePush: r.blockForcePush,
    requirePullRequest: r.requirePullRequest,
    enforceAdmins: r.enforceAdmins,
    /** Set by the owner's policy or a legal hold; cannot be changed here. */
    inherited: isInherited(r) ? (r.id.startsWith('hold:') ? 'legal_hold' : 'policy') : null,
  });

  app.get('/repos/:owner/:repo/branch-protection', { schema: { params } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    return (await rulesFor(ctx, r.repo.id)).map(out).sort((a, b) => a.pattern.localeCompare(b.pattern));
  });

  app.post(
    '/repos/:owner/:repo/branch-protection',
    { schema: { params, body: z.object({ pattern: z.string().trim().min(1).max(100) }).extend(flags.partial().shape) } },
    async (req) => {
      const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
      const bad = validatePattern(req.body.pattern);
      if (bad) throw badRequest(bad);
      const existing = await ownRulesFor(ctx, r.repo.id);
      if (existing.some((x) => x.pattern === req.body.pattern)) throw conflict('That branch pattern already has a rule');
      if (existing.length >= 50) throw badRequest('A repository can have at most 50 protection rules');
      const { pattern, ...rest } = req.body;
      const [row] = await ctx.db.insert(branchProtection).values({ repoId: r.repo.id, pattern, ...rest }).returning();
      await audit(req, 'branch_protection.create', { type: 'repo', id: r.repo.id }, { pattern });
      return out(row!);
    },
  );

  app.patch('/repos/:owner/:repo/branch-protection/:id', { schema: { params: params.extend({ id: z.uuid() }), body: flags.partial() } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const rule = await findRule(ctx, r.repo.id, req.params.id);
    if (!rule) throw notFound('Rule not found');
    if (Object.keys(req.body).length) await ctx.db.update(branchProtection).set(req.body).where(eq(branchProtection.id, rule.id));
    await audit(req, 'branch_protection.update', { type: 'repo', id: r.repo.id }, { pattern: rule.pattern, ...req.body });
    return { ok: true };
  });

  app.delete('/repos/:owner/:repo/branch-protection/:id', { schema: { params: params.extend({ id: z.uuid() }) } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const rule = await findRule(ctx, r.repo.id, req.params.id);
    if (!rule) throw notFound('Rule not found');
    await ctx.db.delete(branchProtection).where(eq(branchProtection.id, rule.id));
    await audit(req, 'branch_protection.delete', { type: 'repo', id: r.repo.id }, { pattern: rule.pattern });
    return { ok: true };
  });
};

export default protectionRoutes;
