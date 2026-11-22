// Governance for an owner (an organization, or a single user's account): who has which role, custom roles, the
// organization-wide policy and the audit log export.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, auditLog, customRoles, desc, eq, gt, inArray, lt, or, orgMembers, repoCollaborators, repositories, sql, users, type Namespace, type User } from '@jumper/db';
import { customRoleSchema, orgPolicySchema, roleRefSchema, type Capability, type CustomRoleInfo, type OrgMemberInfo, type OrgPolicy } from '@jumper/shared';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { audit } from '../audit/audit';
import { requireScope, requireUser } from '../auth/plugin';
import { validatePattern } from '../protection/service';
import { findNamespace, orgRoleFor } from '../repos/access';
import { toUserSummary } from '../repos/serialize';
import { resolveRoleRef } from '../roles/service';
import { ipAllowed } from './cidr';
import { getOrgPolicy, setOrgPolicy } from './service';

const ownerParams = z.object({ owner: z.string().max(100) });

/** Load an owner and check the caller: `member` = belongs to it, `owner` = runs it. Outsiders get "not found". */
export async function loadOwner(req: FastifyRequest, slug: string, need: 'member' | 'owner'): Promise<{ ns: Namespace; user: User }> {
  const ctx = req.server.ctx;
  const user = requireUser(req);
  const ns = await findNamespace(ctx, slug);
  if (!ns) throw notFound('Owner not found');
  if (user.isAdmin) return { ns, user };
  if (ns.kind === 'user') {
    if (ns.userId !== user.id) throw notFound('Owner not found');
    return { ns, user };
  }
  const role = ns.orgId ? await orgRoleFor(ctx, ns.orgId, user.id) : null;
  if (!role) throw notFound('Owner not found');
  if (need === 'owner' && role !== 'owner') throw forbidden('Only organization owners can do that');
  return { ns, user };
}

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // Spreadsheets run cells that start with these as formulas.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const policyRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  // ---------- members and their roles ----------

  app.get('/orgs/:owner/members', { schema: { params: ownerParams } }, async (req): Promise<OrgMemberInfo[]> => {
    const { ns } = await loadOwner(req, req.params.owner, 'member');
    if (ns.kind !== 'org' || !ns.orgId) throw notFound('Organization not found');
    const rows = await ctx.db
      .select({ user: users, m: orgMembers, custom: customRoles })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .leftJoin(customRoles, eq(customRoles.id, orgMembers.customRoleId))
      .where(eq(orgMembers.orgId, ns.orgId))
      .orderBy(users.username);
    return rows.map(({ user, m, custom }) => ({
      ...toUserSummary(user),
      role: m.role,
      repoRole: m.role === 'owner' ? 'admin' : custom ? custom.base : m.repoRole,
      customRole: m.role !== 'owner' && custom ? { id: custom.id, name: custom.name } : null,
      twoFactor: user.totpEnabledAt !== null,
      joinedAt: m.createdAt.toISOString(),
    }));
  });

  app.put('/orgs/:owner/members/:username/role', { schema: { params: ownerParams.extend({ username: z.string().max(100) }), body: z.object({ role: roleRefSchema }) } }, async (req) => {
    requireScope(req, 'admin');
    const { ns } = await loadOwner(req, req.params.owner, 'owner');
    if (ns.kind !== 'org' || !ns.orgId) throw notFound('Organization not found');
    const target = (await ctx.db.select().from(users).where(sql`lower(${users.username}) = lower(${req.params.username})`).limit(1))[0];
    if (!target) throw notFound('User not found');
    const grant = await resolveRoleRef(ctx, ns, req.body.role);
    const res = await ctx.db
      .update(orgMembers)
      .set({ repoRole: grant.role, customRoleId: grant.customRoleId })
      .where(and(eq(orgMembers.orgId, ns.orgId), eq(orgMembers.userId, target.id)))
      .returning({ userId: orgMembers.userId });
    if (!res.length) throw notFound(`${target.username} is not a member`);
    await audit(req, 'org.member.role', { type: 'org', id: ns.orgId }, { user: target.username, role: req.body.role }, undefined, ns.id);
    return { ok: true };
  });

  // ---------- custom roles ----------

  async function roleInfos(ns: Namespace): Promise<CustomRoleInfo[]> {
    const roles = await ctx.db.select().from(customRoles).where(eq(customRoles.namespaceId, ns.id)).orderBy(customRoles.name);
    if (!roles.length) return [];
    const ids = roles.map((r) => r.id);
    const [members, collabs] = await Promise.all([
      ctx.db.select({ id: orgMembers.customRoleId, n: sql<number>`count(*)::int` }).from(orgMembers).where(inArray(orgMembers.customRoleId, ids)).groupBy(orgMembers.customRoleId),
      ctx.db.select({ id: repoCollaborators.customRoleId, n: sql<number>`count(*)::int` }).from(repoCollaborators).where(inArray(repoCollaborators.customRoleId, ids)).groupBy(repoCollaborators.customRoleId),
    ]);
    const count = (id: string) => (members.find((m) => m.id === id)?.n ?? 0) + (collabs.find((m) => m.id === id)?.n ?? 0);
    return roles.map((r) => ({ id: r.id, name: r.name, description: r.description, base: r.base as CustomRoleInfo['base'], capabilities: r.capabilities as Capability[], members: count(r.id) }));
  }

  /** `push` cannot be granted to a role that sits on Viewer or Reviewer, and merging or releasing needs push. */
  function checkRole(body: z.output<typeof customRoleSchema>): void {
    if (body.base !== 'write' && (body.capabilities.includes('merge') || body.capabilities.includes('release'))) {
      throw badRequest('Merging and publishing releases need a role based on Committer');
    }
  }

  app.get('/owners/:owner/roles', { schema: { params: ownerParams } }, async (req): Promise<CustomRoleInfo[]> => {
    const { ns } = await loadOwner(req, req.params.owner, 'member');
    return roleInfos(ns);
  });

  app.post('/owners/:owner/roles', { schema: { params: ownerParams, body: customRoleSchema } }, async (req): Promise<CustomRoleInfo[]> => {
    requireScope(req, 'admin');
    const { ns } = await loadOwner(req, req.params.owner, 'owner');
    checkRole(req.body);
    const [{ n }] = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(customRoles).where(eq(customRoles.namespaceId, ns.id))) as [{ n: number }];
    if (n >= 30) throw badRequest('An owner can have up to 30 custom roles');
    const dup = await ctx.db.select({ id: customRoles.id }).from(customRoles).where(and(eq(customRoles.namespaceId, ns.id), sql`lower(${customRoles.name}) = lower(${req.body.name})`)).limit(1);
    if (dup.length) throw conflict('A role with that name already exists');
    await ctx.db.insert(customRoles).values({ namespaceId: ns.id, ...req.body });
    await audit(req, 'role.create', { type: ns.kind, id: ns.id }, { name: req.body.name, base: req.body.base, capabilities: req.body.capabilities }, undefined, ns.id);
    return roleInfos(ns);
  });

  app.put('/owners/:owner/roles/:id', { schema: { params: ownerParams.extend({ id: z.uuid() }), body: customRoleSchema } }, async (req): Promise<CustomRoleInfo[]> => {
    requireScope(req, 'admin');
    const { ns } = await loadOwner(req, req.params.owner, 'owner');
    checkRole(req.body);
    const dup = await ctx.db.select({ id: customRoles.id }).from(customRoles).where(and(eq(customRoles.namespaceId, ns.id), sql`lower(${customRoles.name}) = lower(${req.body.name})`)).limit(1);
    if (dup[0] && dup[0].id !== req.params.id) throw conflict('A role with that name already exists');
    const res = await ctx.db.update(customRoles).set(req.body).where(and(eq(customRoles.id, req.params.id), eq(customRoles.namespaceId, ns.id))).returning();
    if (!res.length) throw notFound('Role not found');
    // Memberships keep the base role alongside the custom one; keep the two in step.
    await ctx.db.update(orgMembers).set({ repoRole: req.body.base }).where(eq(orgMembers.customRoleId, req.params.id));
    await ctx.db.update(repoCollaborators).set({ role: req.body.base }).where(eq(repoCollaborators.customRoleId, req.params.id));
    await audit(req, 'role.update', { type: ns.kind, id: ns.id }, { name: req.body.name, base: req.body.base, capabilities: req.body.capabilities }, undefined, ns.id);
    return roleInfos(ns);
  });

  // People holding a deleted role fall back to its base role, which is already stored on their membership.
  app.delete('/owners/:owner/roles/:id', { schema: { params: ownerParams.extend({ id: z.uuid() }) } }, async (req): Promise<CustomRoleInfo[]> => {
    requireScope(req, 'admin');
    const { ns } = await loadOwner(req, req.params.owner, 'owner');
    const role = (await ctx.db.select().from(customRoles).where(and(eq(customRoles.id, req.params.id), eq(customRoles.namespaceId, ns.id))).limit(1))[0];
    if (!role) throw notFound('Role not found');
    await ctx.db.update(orgMembers).set({ customRoleId: null }).where(eq(orgMembers.customRoleId, role.id));
    await ctx.db.update(repoCollaborators).set({ customRoleId: null }).where(eq(repoCollaborators.customRoleId, role.id));
    await ctx.db.delete(customRoles).where(eq(customRoles.id, role.id));
    await audit(req, 'role.delete', { type: ns.kind, id: ns.id }, { name: role.name }, undefined, ns.id);
    return roleInfos(ns);
  });

  // ---------- organization-wide policy ----------

  app.get('/owners/:owner/policy', { schema: { params: ownerParams } }, async (req): Promise<{ policy: OrgPolicy }> => {
    const { ns } = await loadOwner(req, req.params.owner, 'member');
    return { policy: await getOrgPolicy(ctx, ns.id) };
  });

  app.put('/owners/:owner/policy', { schema: { params: ownerParams, body: orgPolicySchema } }, async (req): Promise<{ policy: OrgPolicy }> => {
    requireScope(req, 'admin');
    const { ns, user } = await loadOwner(req, req.params.owner, 'owner');
    const p = req.body;
    const before = await getOrgPolicy(ctx, ns.id);
    for (const b of p.releaseBranches) {
      const err = validatePattern(b);
      if (err) throw badRequest(`Release branch "${b}": ${err}`);
    }
    if (p.requireWatermark && !p.defaultWatermark) throw badRequest('Enter the watermark text to use when a link is created without one');
    if (p.releaseApprovals > 0 && p.releaseApprovers.length < p.releaseApprovals) throw badRequest('Name at least as many release approvers as approvals are required');
    const names = [...new Set([...p.releaseApprovers, ...p.signoffRules.flatMap((r) => r.approvers)].map((n) => n.toLowerCase()))];
    if (names.length) {
      const found = await ctx.db.select({ username: users.username }).from(users).where(sql`lower(${users.username}) in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`);
      const missing = names.filter((n) => !found.some((f) => f.username.toLowerCase() === n));
      if (missing.length) throw badRequest(`No such user: ${missing.join(', ')}`);
    }
    // Do not let an owner lock themselves out with a rule their own session fails.
    if (p.requireTwoFactor && !before.requireTwoFactor && !user.totpEnabledAt && !user.isAdmin) throw badRequest('Turn on two-factor login for your own account first (Settings, Security)');
    if (p.ipAllowlist.length && !user.isAdmin) {
      if (!ipAllowed(p.ipAllowlist, req.ip)) throw badRequest(`Your current address (${req.ip}) is not in the list, so saving would lock you out. Add it first.`);
    }
    await setOrgPolicy(ctx, ns.id, p, user.id);
    await audit(req, 'policy.update', { type: ns.kind, id: ns.id }, { changed: (Object.keys(p) as (keyof OrgPolicy)[]).filter((k) => JSON.stringify(p[k]) !== JSON.stringify(before[k])) }, undefined, ns.id);
    return { policy: p };
  });

  // ---------- audit log ----------

  const auditQuery = z.object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    action: z.string().max(80).optional(),
    format: z.enum(['json', 'csv']).default('json'),
    limit: z.coerce.number().int().min(1).max(50_000).optional(),
  });

  app.get('/owners/:owner/audit', { schema: { params: ownerParams, querystring: auditQuery } }, async (req, reply) => {
    const { ns } = await loadOwner(req, req.params.owner, 'owner');
    const q = req.query;
    const repoIds = (await ctx.db.select({ id: repositories.id }).from(repositories).where(eq(repositories.namespaceId, ns.id))).map((r) => r.id);
    const scope = or(
      eq(auditLog.namespaceId, ns.id),
      repoIds.length ? and(eq(auditLog.targetType, 'repo'), inArray(auditLog.targetId, repoIds)) : undefined,
      ns.orgId ? and(eq(auditLog.targetType, 'org'), eq(auditLog.targetId, ns.orgId)) : undefined,
    );
    const rows = await ctx.db
      .select({ e: auditLog, actor: users.username })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(
        and(
          scope,
          q.from ? gt(auditLog.createdAt, new Date(`${q.from}T00:00:00Z`)) : undefined,
          q.to ? lt(auditLog.createdAt, new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 24 * 3600_000)) : undefined,
          q.action ? sql`${auditLog.action} like ${q.action.replace(/[%_\\]/g, '\\$&') + '%'}` : undefined,
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(q.limit ?? (q.format === 'csv' ? 50_000 : 200));
    const events = rows.map(({ e, actor }) => ({ id: e.id, at: e.createdAt.toISOString(), actor: actor ?? null, action: e.action, targetType: e.targetType, targetId: e.targetId, ip: e.ip, metadata: e.metadata }));
    if (q.format === 'json') return { owner: ns.slug, events };
    await audit(req, 'audit.export', { type: ns.kind, id: ns.id }, { rows: events.length, from: q.from ?? null, to: q.to ?? null }, undefined, ns.id);
    const head = ['time', 'actor', 'action', 'target_type', 'target_id', 'ip', 'details'];
    const body = events.map((e) => [e.at, e.actor, e.action, e.targetType, e.targetId, e.ip, Object.keys(e.metadata).length ? e.metadata : ''].map(csvCell).join(','));
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${ns.slug}-audit-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header('X-Content-Type-Options', 'nosniff')
      .send([head.join(','), ...body].join('\n') + '\n');
  });
};

export default policyRoutes;
