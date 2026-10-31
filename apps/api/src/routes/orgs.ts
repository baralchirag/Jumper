import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, namespaces, orgMembers, organizations, sql, users } from '@pcbhub/db';
import { createOrgSchema, orgMemberSchema } from '@pcbhub/shared';
import { requireScope, requireUser } from '../auth/plugin';
import { conflict, forbidden, notFound } from '../lib/errors';
import { findNamespace, orgRoleFor } from '../services/access';
import { audit } from '../services/audit';

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
      await ctx.db
        .insert(orgMembers)
        .values({ orgId, userId: target.id, role: req.body.role })
        .onConflictDoUpdate({ target: [orgMembers.orgId, orgMembers.userId], set: { role: req.body.role } });
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
};

export default orgRoutes;
