import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, namespaces, orgMembers, organizations, repositories, sql, users } from '@jumper/db';
import { createOrgSchema, orgMemberSchema } from '@jumper/shared';
import { requireScope, requireUser } from '../auth/plugin';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { findNamespace, orgRoleFor } from '../repos/access';
import { audit } from '../audit/audit';
import { purgeRepoData } from '../repos/purge';
import { assertOrgSeat } from '../usage/service';
import { resolveRoleRef } from '../roles/service';
import { assertNamespaceNotHeld } from '../legal/holds';

const orgRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  async function loadOrg(slug: string) {
    const ns = await findNamespace(ctx, slug);
    if (!ns || ns.kind !== 'org' || !ns.orgId) throw notFound('Organization not found');
    return { ns, orgId: ns.orgId };
  }

  app.post('/', { schema: { body: createOrgSchema } }, async (req) => {
    const user = requireUser(req);
    requireScope(req, 'admin');
    if (await findNamespace(ctx, req.body.slug)) throw conflict('That name is taken');
    const org = await ctx.db.transaction(async (tx) => {
      const [org] = await tx.insert(organizations).values({ name: req.body.name, description: req.body.description }).returning();
      await tx.insert(namespaces).values({ slug: req.body.slug, kind: 'org', orgId: org!.id });
      await tx.insert(orgMembers).values({ orgId: org!.id, userId: user.id, role: 'owner' });
      return org!;
    });
    await audit(req, 'org.create', { type: 'org', id: org.id });
    return { slug: req.body.slug, name: org.name };
  });

  app.put(
    '/:org/members',
    { schema: { params: z.object({ org: z.string() }), body: orgMemberSchema } },
    async (req) => {
      const user = requireUser(req);
      requireScope(req, 'admin');
      const { orgId } = await loadOrg(req.params.org);
      if (!user.isAdmin && (await orgRoleFor(ctx, orgId, user.id)) !== 'owner') throw forbidden();
      const target = (await ctx.db.select().from(users).where(sql`lower(${users.username}) = lower(${req.body.username})`).limit(1))[0];
      if (!target) throw notFound('User not found');
      const orgNs = await findNamespace(ctx, req.params.org);
      if (orgNs) await assertOrgSeat(ctx, orgNs, target.id);
      const grant = req.body.repoRole && orgNs ? await resolveRoleRef(ctx, orgNs, req.body.repoRole) : null;
      const roleCols = grant ? { repoRole: grant.role, customRoleId: grant.customRoleId } : {};
      await ctx.db
        .insert(orgMembers)
        .values({ orgId, userId: target.id, role: req.body.role, ...roleCols })
        .onConflictDoUpdate({ target: [orgMembers.orgId, orgMembers.userId], set: { role: req.body.role, ...roleCols } });
      await audit(req, 'org.member.set', { type: 'org', id: orgId }, { user: target.username, role: req.body.role });
      return { ok: true };
    },
  );

  app.delete(
    '/:org/members/:username',
    { schema: { params: z.object({ org: z.string(), username: z.string() }) } },
    async (req) => {
      const user = requireUser(req);
      requireScope(req, 'admin');
      const { orgId } = await loadOrg(req.params.org);
      const target = (await ctx.db.select().from(users).where(sql`lower(${users.username}) = lower(${req.params.username})`).limit(1))[0];
      if (!target) throw notFound('User not found');
      const self = target.id === user.id;
      if (!self && !user.isAdmin && (await orgRoleFor(ctx, orgId, user.id)) !== 'owner') throw forbidden();
      const owners = await ctx.db
        .select({ userId: orgMembers.userId })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, 'owner')));
      if (owners.length === 1 && owners[0]!.userId === target.id) throw conflict('An organization needs at least one owner');
      await ctx.db.delete(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, target.id)));
      await audit(req, 'org.member.remove', { type: 'org', id: orgId }, { user: target.username });
      return { ok: true };
    },
  );

  const orgParams = z.object({ org: z.string() });

  async function requireOwner(req: Parameters<typeof requireUser>[0], orgId: string) {
    const user = requireUser(req);
    requireScope(req, 'admin');
    if (!user.isAdmin && (await orgRoleFor(ctx, orgId, user.id)) !== 'owner') throw forbidden('Only organization owners can do that');
    return user;
  }

  app.patch('/:org', { schema: { params: orgParams, body: z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().max(500).nullable().optional() }) } }, async (req) => {
    const { orgId } = await loadOrg(req.params.org);
    await requireOwner(req, orgId);
    const set: Partial<typeof organizations.$inferInsert> = {};
    if (req.body.name !== undefined) set.name = req.body.name;
    if (req.body.description !== undefined) set.description = req.body.description;
    if (Object.keys(set).length) await ctx.db.update(organizations).set(set).where(eq(organizations.id, orgId));
    await audit(req, 'org.update', { type: 'org', id: orgId }, req.body);
    return { ok: true };
  });

  /** Deleting an organization removes all of its repositories, so the slug must be typed to confirm. */
  app.delete('/:org', { schema: { params: orgParams, body: z.object({ confirm: z.string().min(1).max(100) }) } }, async (req) => {
    const { ns, orgId } = await loadOrg(req.params.org);
    await requireOwner(req, orgId);
    if (req.body.confirm.toLowerCase() !== ns.slug.toLowerCase()) throw badRequest('Type the organization name exactly to confirm');
    await assertNamespaceNotHeld(ctx, ns.id, ns.slug);
    const repoIds = (await ctx.db.select({ id: repositories.id }).from(repositories).where(eq(repositories.namespaceId, ns.id))).map((r) => r.id);
    await audit(req, 'org.delete', { type: 'org', id: orgId }, { slug: ns.slug, repos: repoIds.length });
    // Cascades remove the namespace, its repositories and the memberships.
    await ctx.db.delete(organizations).where(eq(organizations.id, orgId));
    await purgeRepoData(ctx, repoIds);
    return { ok: true, repos: repoIds.length };
  });
};

export default orgRoutes;
