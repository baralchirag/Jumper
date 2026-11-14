// Organization invite links: an owner creates a single-use link (optionally emailed), anyone holding it can see
// which organization it is for, and a signed-in person accepts it to become a member.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, gt, isNull, orgInvites, orgMembers, organizations, sql, users, type OrgInvite } from '@jumper/db';
import { createInviteSchema, type CreatedInvite, type InvitePreview, type OrgInviteInfo } from '@jumper/shared';
import { requireScope, requireUser } from '../auth/plugin';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { randomToken, sha256 } from '../../lib/crypto';
import { findNamespace, orgRoleFor } from '../repos/access';
import { assertOrgSeat } from '../usage/service';
import { audit } from '../audit/audit';
import { sendMail } from '../mail/mailer';

const TTL_DAYS = 7;
const token = z.object({ token: z.string().min(20).max(200) });

const inviteRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  const link = (t: string) => `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/invite/${t}`;

  async function ownedOrg(req: Parameters<typeof requireUser>[0], slug: string) {
    const user = requireUser(req);
    requireScope(req, 'admin');
    const ns = await findNamespace(ctx, slug);
    if (!ns || ns.kind !== 'org' || !ns.orgId) throw notFound('Organization not found');
    if (!user.isAdmin && (await orgRoleFor(ctx, ns.orgId, user.id)) !== 'owner') throw forbidden('Only organization owners can invite people');
    return { user, ns, orgId: ns.orgId };
  }

  const info = (i: OrgInvite, createdBy: string | null): OrgInviteInfo => ({
    id: i.id,
    role: i.role,
    repoRole: i.repoRole,
    email: i.email,
    createdBy,
    createdAt: i.createdAt.toISOString(),
    expiresAt: i.expiresAt.toISOString(),
  });

  /** A live invite (not used, not expired) by its clear-text token. */
  async function live(t: string) {
    const [row] = await ctx.db
      .select({ invite: orgInvites, org: organizations, inviter: users.username })
      .from(orgInvites)
      .innerJoin(organizations, eq(organizations.id, orgInvites.orgId))
      .leftJoin(users, eq(users.id, orgInvites.createdBy))
      .where(and(eq(orgInvites.tokenHash, sha256(t)), isNull(orgInvites.acceptedAt), gt(orgInvites.expiresAt, new Date())))
      .limit(1);
    if (!row) throw notFound('This invite link is invalid, used or expired. Ask for a new one.');
    return row;
  }

  app.post('/orgs/:org/invites', { schema: { params: z.object({ org: z.string().max(100) }), body: createInviteSchema }, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req): Promise<CreatedInvite> => {
    const { user, ns, orgId } = await ownedOrg(req, req.params.org);
    const t = randomToken();
    const [row] = await ctx.db
      .insert(orgInvites)
      .values({ orgId, tokenHash: sha256(t), role: req.body.role, repoRole: req.body.repoRole, email: req.body.email ?? null, createdBy: user.id, expiresAt: new Date(Date.now() + TTL_DAYS * 86_400_000) })
      .returning();
    let emailed = false;
    if (req.body.email) {
      const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
      emailed = (
        await sendMail(ctx.env, {
          to: req.body.email,
          subject: `${user.username} invited you to ${org?.name ?? ns.slug} on Jumper`,
          text: `${user.username} invited you to join ${org?.name ?? ns.slug} on Jumper as ${req.body.role === 'owner' ? 'an owner' : 'a member'}.\n\nJoin here (works once, valid for ${TTL_DAYS} days):\n${link(t)}\n\nIf you were not expecting this, you can ignore it.\n`,
        }).catch((e) => {
          req.log.error(e, 'invite email failed');
          return { sent: false };
        })
      ).sent;
    }
    await audit(req, 'org.invite.create', { type: 'org', id: orgId }, { role: req.body.role, email: req.body.email ?? null });
    return { ...info(row!, user.username), link: link(t), emailed };
  });

  app.get('/orgs/:org/invites', { schema: { params: z.object({ org: z.string().max(100) }) } }, async (req): Promise<OrgInviteInfo[]> => {
    const { orgId } = await ownedOrg(req, req.params.org);
    const rows = await ctx.db
      .select({ invite: orgInvites, by: users.username })
      .from(orgInvites)
      .leftJoin(users, eq(users.id, orgInvites.createdBy))
      .where(and(eq(orgInvites.orgId, orgId), isNull(orgInvites.acceptedAt), gt(orgInvites.expiresAt, new Date())))
      .orderBy(desc(orgInvites.createdAt))
      .limit(200);
    return rows.map((r) => info(r.invite, r.by));
  });

  app.delete('/orgs/:org/invites/:id', { schema: { params: z.object({ org: z.string().max(100), id: z.uuid() }) } }, async (req) => {
    const { orgId } = await ownedOrg(req, req.params.org);
    const gone = await ctx.db.delete(orgInvites).where(and(eq(orgInvites.id, req.params.id), eq(orgInvites.orgId, orgId))).returning({ id: orgInvites.id });
    if (!gone.length) throw notFound('Invite not found');
    await audit(req, 'org.invite.revoke', { type: 'org', id: orgId }, {});
    return { ok: true };
  });

  app.get('/invites/:token', { schema: { params: token }, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<InvitePreview> => {
    const { invite, org, inviter } = await live(req.params.token);
    const [ns] = (await ctx.db.execute(sql`select slug from namespaces where org_id = ${org.id} limit 1`)) as unknown as [{ slug: string }];
    const alreadyMember = req.user ? (await orgRoleFor(ctx, org.id, req.user.id)) !== null : false;
    return { org: { slug: ns!.slug, name: org.name, avatarUrl: org.avatarUrl }, role: invite.role, invitedBy: inviter, expiresAt: invite.expiresAt.toISOString(), alreadyMember };
  });

  app.post('/invites/:token/accept', { schema: { params: token }, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const { invite, org } = await live(req.params.token);
    const ns = (await ctx.db.execute(sql`select * from namespaces where org_id = ${org.id} limit 1`)) as unknown as [{ slug: string }];
    const orgNs = await findNamespace(ctx, ns[0]!.slug);
    if (!orgNs) throw notFound('Organization not found');
    if ((await orgRoleFor(ctx, org.id, user.id)) !== null) throw conflict(`You are already in ${org.name}`);
    await assertOrgSeat(ctx, orgNs, user.id);
    // Claim the invite first so a link raced from two tabs can only ever add one person.
    const claimed = await ctx.db
      .update(orgInvites)
      .set({ acceptedAt: new Date(), acceptedBy: user.id })
      .where(and(eq(orgInvites.id, invite.id), isNull(orgInvites.acceptedAt)))
      .returning({ id: orgInvites.id });
    if (!claimed.length) throw notFound('This invite link has just been used. Ask for a new one.');
    await ctx.db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: invite.role, repoRole: invite.repoRole }).onConflictDoNothing();
    await audit(req, 'org.invite.accept', { type: 'org', id: org.id }, { user: user.username, role: invite.role });
    return { org: orgNs.slug };
  });
};

export default inviteRoutes;
