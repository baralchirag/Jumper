// Billing. Two ways to pay, shown in one invoice list:
//  - by card through Stripe (modules/stripe): checkout, subscription, Stripe invoices mirrored here;
//  - by invoice: an administrator assigns the plan, raises invoices and marks them paid (Enterprise, or instances
//    without Stripe keys).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, invoices, namespaces, sql, type Invoice, type Namespace } from '@jumper/db';
import { billingProfileSchema, createInvoiceSchema, isPlanId, planPriceCents, type BillingInfo, type BillingProfile, type InvoiceInfo } from '@jumper/shared';
import type { Ctx } from '../../context';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { adminOnly } from '../admin/routes';
import { audit } from '../audit/audit';
import { requireScope, requireUser } from '../auth/plugin';
import { loadOwner } from '../policy/routes';
import { findNamespace } from '../repos/access';
import { planFor, usageFor } from '../usage/service';
import { cardPaymentsEnabled, subscriptionInfo } from '../stripe/service';

const ownerParams = z.object({ owner: z.string().max(100) });

export function profileOf(ns: Pick<Namespace, 'billing'>): BillingProfile {
  const parsed = billingProfileSchema.safeParse(ns.billing ?? {});
  return parsed.success ? parsed.data : billingProfileSchema.parse({});
}

function toInvoice(ctx: Ctx, inv: Invoice, owner: string): InvoiceInfo {
  return {
    id: inv.id,
    number: inv.number,
    owner,
    status: inv.status,
    currency: 'USD',
    lines: inv.lines.map((l) => ({ ...l, totalCents: l.quantity * l.unitCents })),
    subtotalCents: inv.subtotalCents,
    taxPercent: inv.taxPercent / 100,
    taxCents: inv.taxCents,
    totalCents: inv.totalCents,
    periodStart: inv.periodStart.toISOString(),
    periodEnd: inv.periodEnd.toISOString(),
    issuedAt: inv.issuedAt?.toISOString() ?? null,
    dueAt: inv.dueAt?.toISOString() ?? null,
    paidAt: inv.paidAt?.toISOString() ?? null,
    notes: inv.notes,
    billTo: billingProfileSchema.parse(inv.billTo),
    from: { name: ctx.env.OPERATOR_NAME ?? null, email: ctx.env.OPERATOR_EMAIL ?? null },
    source: inv.stripeInvoiceId ? 'stripe' : 'manual',
    hostedUrl: inv.hostedUrl,
    pdfUrl: inv.pdfUrl,
  };
}

async function billingInfo(ctx: Ctx, ns: Namespace): Promise<BillingInfo> {
  const plan = planFor(ctx, ns);
  const profile = profileOf(ns);
  const usage = await usageFor(ctx, ns.id);
  const rows = await ctx.db.select().from(invoices).where(eq(invoices.namespaceId, ns.id)).orderBy(desc(invoices.createdAt)).limit(100);
  return {
    owner: ns.slug,
    plan: isPlanId(ns.plan) ? ns.plan : 'free',
    profile,
    seats: usage.seats,
    nextPeriodCents: planPriceCents(plan, profile.cycle, usage.seats),
    cycle: profile.cycle,
    // Drafts are the administrator's working copies; the owner sees an invoice once it is issued.
    invoices: rows.filter((r) => r.status !== 'draft').map((r) => toInvoice(ctx, r, ns.slug)),
    cardPayments: cardPaymentsEnabled(ctx),
    subscription: (() => {
      const sub = subscriptionInfo(ns);
      return sub ? { ...sub, quantity: Math.max(1, usage.seats) } : null;
    })(),
  };
}

/** Billing info read fresh from the database (after Stripe calls have updated the namespace). */
export async function billingInfoFor(ctx: Ctx, namespaceId: string): Promise<BillingInfo> {
  const [ns] = await ctx.db.select().from(namespaces).where(eq(namespaces.id, namespaceId)).limit(1);
  if (!ns) throw notFound('Owner not found');
  return billingInfo(ctx, ns);
}

/** INV-2026-0042: the next free number in the year. The unique index settles races; the caller retries. */
async function nextNumber(ctx: Ctx, now: Date): Promise<string> {
  const year = now.getUTCFullYear();
  const [{ n }] = (await ctx.db.select({ n: sql<number>`coalesce(max(substring(${invoices.number} from '\\d+$')::int), 0)` }).from(invoices).where(sql`${invoices.number} like ${`INV-${year}-%`}`)) as [{ n: number }];
  return `INV-${year}-${String(n + 1).padStart(4, '0')}`;
}

export function addPeriod(start: Date, cycle: 'monthly' | 'annual'): Date {
  const d = new Date(start);
  if (cycle === 'annual') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export const billingRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get('/owners/:owner/billing', { schema: { params: ownerParams } }, async (req): Promise<BillingInfo> => {
    const { ns } = await loadOwner(req, req.params.owner, 'owner');
    return billingInfo(ctx, ns);
  });

  app.put('/owners/:owner/billing', { schema: { params: ownerParams, body: billingProfileSchema } }, async (req): Promise<BillingInfo> => {
    requireScope(req, 'admin');
    const { ns } = await loadOwner(req, req.params.owner, 'owner');
    const [updated] = await ctx.db.update(namespaces).set({ billing: req.body }).where(eq(namespaces.id, ns.id)).returning();
    await audit(req, 'billing.update', { type: ns.kind, id: ns.id }, { cycle: req.body.cycle }, undefined, ns.id);
    return billingInfo(ctx, updated!);
  });

  app.get('/owners/:owner/invoices/:id', { schema: { params: ownerParams.extend({ id: z.uuid() }) } }, async (req): Promise<InvoiceInfo> => {
    const { ns, user } = await loadOwner(req, req.params.owner, 'owner');
    const inv = (await ctx.db.select().from(invoices).where(and(eq(invoices.id, req.params.id), eq(invoices.namespaceId, ns.id))).limit(1))[0];
    if (!inv || (inv.status === 'draft' && !user.isAdmin)) throw notFound('Invoice not found');
    return toInvoice(ctx, inv, ns.slug);
  });
};

export const billingAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  app.addHook('onRequest', adminOnly);

  app.get('/invoices', { schema: { querystring: z.object({ status: z.enum(['draft', 'open', 'paid', 'void']).optional() }) } }, async (req): Promise<InvoiceInfo[]> => {
    const rows = await ctx.db
      .select({ inv: invoices, slug: namespaces.slug })
      .from(invoices)
      .innerJoin(namespaces, eq(namespaces.id, invoices.namespaceId))
      .where(req.query.status ? eq(invoices.status, req.query.status) : undefined)
      .orderBy(desc(invoices.createdAt))
      .limit(500);
    return rows.map((r) => toInvoice(ctx, r.inv, r.slug));
  });

  app.post('/namespaces/:owner/invoices', { schema: { params: ownerParams, body: createInvoiceSchema } }, async (req): Promise<InvoiceInfo> => {
    const user = requireUser(req);
    const ns = await findNamespace(ctx, req.params.owner);
    if (!ns) throw notFound('Owner not found');
    const b = req.body;
    const profile = profileOf(ns);
    const plan = planFor(ctx, ns);
    const now = new Date();
    let lines = b.lines;
    if (!lines.length) {
      // No lines given: bill the plan for the seats in use over one period of the owner's billing cycle.
      const seats = Math.max(1, (await usageFor(ctx, ns.id)).seats);
      const unit = profile.cycle === 'annual' ? plan.priceAnnualCents : plan.priceMonthlyCents;
      if (unit === null) throw badRequest(`The ${plan.name} plan is quoted individually: enter the invoice lines`);
      if (unit === 0) throw badRequest(`The ${plan.name} plan is free: there is nothing to invoice. Enter lines to bill something else.`);
      lines = [{ description: `Jumper ${plan.name}, ${profile.cycle === 'annual' ? 'one year' : 'one month'}, per seat`, quantity: seats, unitCents: unit }];
    }
    const subtotal = lines.reduce((n, l) => n + l.quantity * l.unitCents, 0);
    if (subtotal > 2_000_000_000) throw badRequest('That total is too large for one invoice');
    const tax = Math.round((subtotal * b.taxPercent) / 100);
    const issued = b.status === 'open';
    for (let attempt = 0; ; attempt++) {
      try {
        const [inv] = await ctx.db
          .insert(invoices)
          .values({
            namespaceId: ns.id,
            number: await nextNumber(ctx, now),
            status: b.status,
            lines,
            subtotalCents: subtotal,
            taxPercent: Math.round(b.taxPercent * 100),
            taxCents: tax,
            totalCents: subtotal + tax,
            periodStart: now,
            periodEnd: addPeriod(now, profile.cycle),
            issuedAt: issued ? now : null,
            dueAt: issued ? new Date(now.getTime() + b.dueInDays * 24 * 3600_000) : null,
            notes: b.notes,
            billTo: profile,
            createdBy: user.id,
          })
          .returning();
        await audit(req, 'admin.invoice.create', { type: ns.kind, id: ns.id }, { number: inv!.number, totalCents: inv!.totalCents, status: inv!.status }, undefined, ns.id);
        return toInvoice(ctx, inv!, ns.slug);
      } catch (e) {
        // Two invoices raised at the same moment picked the same number: take the next one.
        const text = `${(e as Error).message ?? ''} ${((e as { cause?: Error }).cause?.message ?? '')}`;
        if (attempt >= 4 || !text.includes('invoices_number_idx')) throw e;
      }
    }
  });

  // open -> paid | void, draft -> open | void, paid -> open (a payment recorded by mistake). Void is final.
  app.patch('/invoices/:id', { schema: { params: z.object({ id: z.uuid() }), body: z.object({ status: z.enum(['open', 'paid', 'void']) }) } }, async (req): Promise<InvoiceInfo> => {
    const row = (await ctx.db.select({ inv: invoices, ns: namespaces }).from(invoices).innerJoin(namespaces, eq(namespaces.id, invoices.namespaceId)).where(eq(invoices.id, req.params.id)).limit(1))[0];
    if (!row) throw notFound('Invoice not found');
    const { inv, ns } = row;
    const to = req.body.status;
    if (inv.status === 'void') throw conflict('A void invoice cannot be changed. Raise a new one.');
    if (inv.status === to) return toInvoice(ctx, inv, ns.slug);
    const now = new Date();
    const set: Partial<Invoice> = { status: to };
    if (to === 'paid') set.paidAt = now;
    if (to === 'open') {
      set.paidAt = null;
      if (!inv.issuedAt) {
        set.issuedAt = now;
        set.dueAt = new Date(now.getTime() + 30 * 24 * 3600_000);
        // Issue with the billing details as they are now, not as they were when the draft was started.
        set.billTo = profileOf(ns);
      }
    }
    const [updated] = await ctx.db.update(invoices).set(set).where(eq(invoices.id, inv.id)).returning();
    await audit(req, `admin.invoice.${to}`, { type: ns.kind, id: ns.id }, { number: inv.number }, undefined, ns.id);
    return toInvoice(ctx, updated!, ns.slug);
  });
};
