// Administrators: who pays, how, since when, until when and how much.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, inArray, invoices, isNotNull, ne, or, orgMembers, organizations, namespaces, repoCollaborators, repositories, sql, users, auditLog, type Invoice, type Namespace } from '@jumper/db';
import { isPlanId, type AdminCustomerDetail, type AdminCustomerRow, type AdminCustomers, type BillingCycle, type PaymentMethod } from '@jumper/shared';
import type { Ctx } from '../../context';
import { notFound } from '../../lib/errors';
import { adminOnly } from '../admin/routes';
import { findNamespace } from '../repos/access';
import { hasLiveSubscription } from '../stripe/service';
import { usageFor } from '../usage/service';
import { profileOf, toInvoice } from './routes';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function dashboardUrl(ctx: Ctx, customerId: string | null): string | null {
  if (!customerId || !ctx.env.STRIPE_SECRET_KEY) return null;
  const test = /^(sk|rk)_test_/.test(ctx.env.STRIPE_SECRET_KEY);
  return `https://dashboard.stripe.com/${test ? 'test/' : ''}customers/${customerId}`;
}

/** Who to contact: the person, or an organization's owners. */
async function contacts(ctx: Ctx, ns: Namespace): Promise<{ name: string | null; avatarUrl: string | null; emails: string[] }> {
  if (ns.kind === 'user' && ns.userId) {
    const [u] = await ctx.db.select().from(users).where(eq(users.id, ns.userId)).limit(1);
    return { name: u?.name ?? null, avatarUrl: u?.avatarUrl ?? null, emails: u ? [u.email] : [] };
  }
  if (!ns.orgId) return { name: null, avatarUrl: null, emails: [] };
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, ns.orgId)).limit(1);
  const owners = await ctx.db
    .select({ email: users.email })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.orgId, ns.orgId), eq(orgMembers.role, 'owner')));
  return { name: org?.name ?? null, avatarUrl: org?.avatarUrl ?? null, emails: owners.map((o) => o.email) };
}

async function row(ctx: Ctx, ns: Namespace, invs: Invoice[]): Promise<AdminCustomerRow> {
  const plan = isPlanId(ns.plan) ? ns.plan : 'free';
  const cycle: BillingCycle = profileOf(ns).cycle;
  const paid = invs.filter((i) => i.status === 'paid').sort((a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0));
  const open = invs.filter((i) => i.status === 'open');
  const card = hasLiveSubscription(ns) || invs.some((i) => i.stripeInvoiceId);
  const method: PaymentMethod = card ? 'card' : invs.length ? 'invoice' : 'assigned';
  const usage = await usageFor(ctx, ns.id);
  const seats = Math.max(1, usage.seats);
  const p = ctx.env.plans[plan];
  const unit = cycle === 'annual' ? p.priceAnnualCents : p.priceMonthlyCents;
  const live = plan !== 'free' && (!ns.subscriptionStatus || !['canceled', 'unpaid', 'incomplete_expired'].includes(ns.subscriptionStatus));
  const mrr = live && unit ? Math.round((unit * seats) / (cycle === 'annual' ? 12 : 1)) : 0;
  // Paid through: the card subscription's period end, or the latest paid manual invoice's period end.
  const manualThrough = paid.filter((i) => !i.stripeInvoiceId).map((i) => i.periodEnd.getTime());
  const firstPaid = paid.length ? paid[paid.length - 1]! : null;
  const who = await contacts(ctx, ns);
  return {
    owner: ns.slug,
    kind: ns.kind,
    name: who.name,
    avatarUrl: who.avatarUrl,
    contactEmails: who.emails,
    plan,
    cycle,
    method,
    status: ns.subscriptionStatus,
    startedAt: iso(ns.subscriptionStartedAt) ?? iso(firstPaid?.periodStart ?? firstPaid?.paidAt),
    paidThrough: iso(ns.subscriptionPeriodEnd) ?? (manualThrough.length ? new Date(Math.max(...manualThrough)).toISOString() : null),
    cancelAtPeriodEnd: ns.subscriptionCancelAtPeriodEnd,
    seats,
    mrrCents: mrr,
    totalPaidCents: paid.reduce((n, i) => n + i.totalCents, 0),
    invoicesPaid: paid.length,
    lastPaymentAt: iso(paid[0]?.paidAt),
    lastPaymentCents: paid[0]?.totalCents ?? null,
    openCents: open.reduce((n, i) => n + i.totalCents, 0),
    createdAt: ns.createdAt.toISOString(),
  };
}

export const customerAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  app.addHook('onRequest', adminOnly);

  app.get('/customers', async (): Promise<AdminCustomers> => {
    // Anyone on a paid plan, with a Stripe customer, or with an invoice.
    const billed = ctx.db.selectDistinct({ id: invoices.namespaceId }).from(invoices);
    const list = await ctx.db
      .select()
      .from(namespaces)
      .where(or(ne(namespaces.plan, 'free'), isNotNull(namespaces.stripeCustomerId), inArray(namespaces.id, billed)))
      .orderBy(desc(namespaces.createdAt))
      .limit(500);
    const invs = list.length ? await ctx.db.select().from(invoices).where(and(inArray(invoices.namespaceId, list.map((n) => n.id)), ne(invoices.status, 'draft'))) : [];
    const rows = await Promise.all(list.map((ns) => row(ctx, ns, invs.filter((i) => i.namespaceId === ns.id))));
    // Paying first, biggest first.
    rows.sort((a, b) => b.mrrCents - a.mrrCents || b.totalPaidCents - a.totalPaidCents);
    const mrr = rows.reduce((n, r) => n + r.mrrCents, 0);
    return {
      rows,
      totals: {
        paying: rows.filter((r) => r.mrrCents > 0).length,
        mrrCents: mrr,
        arrCents: mrr * 12,
        collectedCents: rows.reduce((n, r) => n + r.totalPaidCents, 0),
        openCents: rows.reduce((n, r) => n + r.openCents, 0),
        pastDue: rows.filter((r) => r.status === 'past_due' || r.status === 'unpaid').length,
        cancelling: rows.filter((r) => r.cancelAtPeriodEnd).length,
      },
      stripe: Boolean(ctx.env.STRIPE_SECRET_KEY),
    };
  });

  app.get('/customers/:owner', { schema: { params: z.object({ owner: z.string().max(100) }) } }, async (req): Promise<AdminCustomerDetail> => {
    const ns = await findNamespace(ctx, req.params.owner);
    if (!ns) throw notFound('Owner not found');
    const invs = await ctx.db.select().from(invoices).where(and(eq(invoices.namespaceId, ns.id), ne(invoices.status, 'draft'))).orderBy(desc(invoices.createdAt));
    const base = await row(ctx, ns, invs);
    const usage = await usageFor(ctx, ns.id);

    let profile: AdminCustomerDetail['profile'] = {};
    let members: AdminCustomerDetail['members'] = [];
    if (ns.kind === 'user' && ns.userId) {
      const [u] = await ctx.db.select().from(users).where(eq(users.id, ns.userId)).limit(1);
      const [last] = (await ctx.db.execute(sql`select max(created_at) as at from sessions where user_id = ${ns.userId}`)) as unknown as { at: string | null }[];
      if (u) {
        profile = { username: u.username, email: u.email, emailVerified: Boolean(u.emailVerifiedAt), bio: u.bio, company: u.company, location: u.location, website: u.website, twoFactor: Boolean(u.totpEnabledAt), disabled: u.disabled, lastSignInAt: last?.at ? new Date(last.at).toISOString() : null };
        members = [{ username: u.username, name: u.name, email: u.email, role: 'owner' }];
      }
      // Seats on a personal account: collaborators on its private repositories.
      const collab = await ctx.db
        .selectDistinct({ username: users.username, name: users.name, email: users.email })
        .from(repoCollaborators)
        .innerJoin(repositories, eq(repositories.id, repoCollaborators.repoId))
        .innerJoin(users, eq(users.id, repoCollaborators.userId))
        .where(and(eq(repositories.namespaceId, ns.id), eq(repositories.visibility, 'private')));
      members.push(...collab.filter((c) => c.username !== profile.username).map((c) => ({ ...c, role: 'collaborator' })));
    } else if (ns.orgId) {
      const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, ns.orgId)).limit(1);
      profile = { description: org?.description ?? null };
      members = await ctx.db
        .select({ username: users.username, name: users.name, email: users.email, role: orgMembers.role })
        .from(orgMembers)
        .innerJoin(users, eq(users.id, orgMembers.userId))
        .where(eq(orgMembers.orgId, ns.orgId));
    }
    const [{ n: repos }] = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(repositories).where(eq(repositories.namespaceId, ns.id))) as [{ n: number }];
    const events = await ctx.db
      .select({ at: auditLog.createdAt, action: auditLog.action, actor: users.username, detail: auditLog.metadata })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(and(or(eq(auditLog.namespaceId, ns.id), eq(auditLog.targetId, ns.id)), sql`(${auditLog.action} like 'billing.%' or ${auditLog.action} like 'admin.invoice.%' or ${auditLog.action} like 'admin.plan.%')`))
      .orderBy(desc(auditLog.createdAt))
      .limit(100);
    return {
      ...base,
      profile,
      billingProfile: profileOf(ns),
      stripeCustomerId: ns.stripeCustomerId,
      stripeSubscriptionId: ns.stripeSubscriptionId,
      stripeDashboardUrl: dashboardUrl(ctx, ns.stripeCustomerId),
      members,
      repositories: repos,
      storageBytes: usage.storageBytes,
      checkMinutes: usage.checkMinutes,
      invoices: invs.map((i) => toInvoice(ctx, i, ns.slug)),
      events: events.map((e) => ({ at: e.at.toISOString(), action: e.action, actor: e.actor, detail: e.detail })),
    };
  });
};
