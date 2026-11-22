// Card payments with Stripe.
//
// Stripe holds the money side (customers, cards, subscriptions, invoices, receipts, retries, tax); Jumper holds the
// plan. A namespace (a user or an organization) gets one Stripe customer and at most one subscription with a single
// item: the plan's price, quantity = seats in use. Webhooks are the source of truth for the plan; the routes also
// apply the subscription they get back from Stripe straight away so the page doesn't wait for the webhook.
//
// Prices are created in Stripe on first use from packages/shared/src/plans.ts (product `jumper_<plan>`, price with
// lookup key `jumper_<plan>_<cycle>`), so the operator configures nothing but the two keys. When a list price in
// plans.ts changes, a new Stripe price takes over the lookup key; existing subscribers keep their old price until
// they change plan.
import Stripe from 'stripe';
import { eq, invoices, isNotNull, namespaces, stripeEvents, type Namespace } from '@jumper/db';
import { isPlanId, type BillingCycle, type CardPlanId, type PlanId, type SubscriptionInfo } from '@jumper/shared';
import type { Ctx } from '../../context';
import { badRequest, conflict } from '../../lib/errors';
import { usageFor } from '../usage/service';

const clients = new WeakMap<Ctx, Stripe>();

/**
 * Card payments need only the secret key. Webhooks (STRIPE_WEBHOOK_SECRET) keep Jumper in step with changes made on
 * Stripe's side within seconds; without them, Jumper reads the subscription from Stripe when someone returns from
 * checkout and in the hourly sweep.
 */
export function cardPaymentsEnabled(ctx: Ctx): boolean {
  return Boolean(ctx.env.STRIPE_SECRET_KEY);
}

export function stripeFor(ctx: Ctx): Stripe {
  if (!cardPaymentsEnabled(ctx)) throw badRequest('Card payments are not set up on this server. Ask an administrator to switch your plan on by invoice.');
  let s = clients.get(ctx);
  if (!s) {
    const base = ctx.env.STRIPE_API_BASE ? new URL(ctx.env.STRIPE_API_BASE) : null;
    s = new Stripe(ctx.env.STRIPE_SECRET_KEY!, {
      maxNetworkRetries: 2,
      timeout: 20_000,
      appInfo: { name: 'Jumper' },
      ...(base ? { host: base.hostname, port: Number(base.port || (base.protocol === 'https:' ? 443 : 80)), protocol: base.protocol.replace(':', '') as 'http' | 'https' } : {}),
    });
    clients.set(ctx, s);
  }
  return s;
}

// ─── Prices ─────────────────────────────────────────────────────────────────

const lookupKey = (plan: CardPlanId, cycle: BillingCycle) => `jumper_${plan}_${cycle}`;
// Price ids by lookup key and amount. Short-lived, so a price archived in the Stripe dashboard is noticed within the hour.
const priceCache = new Map<string, { id: string; at: number }>();
const PRICE_TTL_MS = 3600_000;

/** Tests only: forget cached price ids. */
export function clearPriceCache(): void {
  priceCache.clear();
}

/** The Stripe price id for a plan and cycle, creating the product and price on first use. */
export async function priceFor(ctx: Ctx, plan: CardPlanId, cycle: BillingCycle): Promise<string> {
  const p = ctx.env.plans[plan];
  const amount = cycle === 'annual' ? p.priceAnnualCents : p.priceMonthlyCents;
  if (!amount) throw badRequest(`The ${p.name} plan cannot be bought by card`);
  const key = lookupKey(plan, cycle);
  const cacheKey = `${key}:${amount}`;
  const hit = priceCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.id;

  const stripe = stripeFor(ctx);
  const found = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const current = found.data[0];
  if (current && current.unit_amount === amount && current.currency === 'usd') {
    priceCache.set(cacheKey, { id: current.id, at: Date.now() });
    return current.id;
  }
  const productId = `jumper_${plan}`;
  try {
    await stripe.products.retrieve(productId);
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 404) throw e;
    await stripe.products.create({ id: productId, name: `Jumper ${p.name}`, description: p.blurb, metadata: { plan } });
  }
  const price = await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: amount,
    recurring: { interval: cycle === 'annual' ? 'year' : 'month' },
    lookup_key: key,
    transfer_lookup_key: true,
    nickname: `${p.name}, ${cycle}, per seat`,
    metadata: { plan, cycle },
    tax_behavior: 'exclusive',
  });
  priceCache.set(cacheKey, { id: price.id, at: Date.now() });
  return price.id;
}

/** Plan and cycle a Stripe price stands for (from its metadata, falling back to the lookup key). */
export function planOfPrice(price: Pick<Stripe.Price, 'metadata' | 'lookup_key' | 'recurring'>): { plan: PlanId; cycle: BillingCycle } | null {
  const fromKey = price.lookup_key?.match(/^jumper_([a-z]+)_(monthly|annual)$/);
  const plan = price.metadata?.plan ?? fromKey?.[1];
  const cycle = (price.metadata?.cycle ?? fromKey?.[2] ?? (price.recurring?.interval === 'year' ? 'annual' : 'monthly')) as BillingCycle;
  return plan && isPlanId(plan) ? { plan, cycle: cycle === 'annual' ? 'annual' : 'monthly' } : null;
}

// ─── Customers and sessions ─────────────────────────────────────────────────

async function seatsFor(ctx: Ctx, ns: Namespace): Promise<number> {
  return Math.max(1, (await usageFor(ctx, ns.id)).seats);
}

/** The namespace's Stripe customer, created on first use. */
export async function customerFor(ctx: Ctx, ns: Namespace, fallbackEmail: string): Promise<string> {
  if (ns.stripeCustomerId) return ns.stripeCustomerId;
  const billing = ns.billing ?? {};
  const customer = await stripeFor(ctx).customers.create(
    {
      email: billing.email || fallbackEmail,
      name: billing.company || ns.slug,
      metadata: { namespaceId: ns.id, owner: ns.slug, kind: ns.kind },
    },
    // A double click must not create two customers.
    { idempotencyKey: `jumper-customer-${ns.id}` },
  );
  await ctx.db.update(namespaces).set({ stripeCustomerId: customer.id }).where(eq(namespaces.id, ns.id));
  return customer.id;
}

const ACTIVE = new Set(['active', 'trialing', 'past_due']);

export function hasLiveSubscription(ns: Namespace): boolean {
  return Boolean(ns.stripeSubscriptionId && ns.subscriptionStatus && (ACTIVE.has(ns.subscriptionStatus) || ns.subscriptionStatus === 'incomplete' || ns.subscriptionStatus === 'unpaid'));
}

/** Where Stripe sends people back to: the billing section of the owner's settings. */
export function billingPath(ns: Namespace): string {
  return ns.kind === 'org' ? `/organizations/${encodeURIComponent(ns.slug)}/settings/billing` : '/settings/usage';
}

export async function createCheckout(ctx: Ctx, ns: Namespace, email: string, plan: CardPlanId, cycle: BillingCycle, from: 'pricing' | 'billing' = 'billing'): Promise<string> {
  if (hasLiveSubscription(ns)) throw conflict('This account already has a card subscription. Change the plan instead.');
  const stripe = stripeFor(ctx);
  const [customer, price, seats] = await Promise.all([customerFor(ctx, ns, email), priceFor(ctx, plan, cycle), seatsFor(ctx, ns)]);
  const limit = ctx.env.plans[plan].limits.seats;
  if (limit !== null && seats > limit) throw badRequest(`${ns.slug} has ${seats} seats in use; the ${ctx.env.plans[plan].name} plan allows ${limit}. Choose a bigger plan.`);
  const site = ctx.env.PUBLIC_URL.replace(/\/$/, '');
  const back = from === 'pricing' ? `${site}/pricing` : `${site}${billingPath(ns)}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: ns.id,
    line_items: [{ price, quantity: seats }],
    // A thank-you page that waits for the webhook, then says the plan is on.
    success_url: `${site}/checkout/done?owner=${encodeURIComponent(ns.slug)}&plan=${plan}`,
    cancel_url: `${back}?checkout=cancelled`,
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    tax_id_collection: { enabled: true },
    customer_update: { address: 'auto', name: 'auto' },
    automatic_tax: { enabled: ctx.env.STRIPE_AUTOMATIC_TAX },
    subscription_data: { metadata: { namespaceId: ns.id, plan, cycle } },
    metadata: { namespaceId: ns.id, plan, cycle },
  });
  if (!session.url) throw new Error('Stripe returned a checkout session without a URL');
  return session.url;
}

export async function createPortal(ctx: Ctx, ns: Namespace): Promise<string> {
  if (!ns.stripeCustomerId) throw badRequest('There is no card billing for this account yet');
  const session = await stripeFor(ctx).billingPortal.sessions.create({
    customer: ns.stripeCustomerId,
    return_url: `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}${billingPath(ns)}`,
  });
  return session.url;
}

async function liveSubscription(ctx: Ctx, ns: Namespace): Promise<Stripe.Subscription> {
  if (!ns.stripeSubscriptionId || !hasLiveSubscription(ns)) throw badRequest('This account has no card subscription');
  return stripeFor(ctx).subscriptions.retrieve(ns.stripeSubscriptionId);
}

/** Switch plan or billing cycle, prorated. */
export async function changePlan(ctx: Ctx, ns: Namespace, plan: CardPlanId, cycle: BillingCycle): Promise<void> {
  const sub = await liveSubscription(ctx, ns);
  const item = sub.items.data[0];
  if (!item) throw new Error('Subscription has no items');
  const [price, seats] = await Promise.all([priceFor(ctx, plan, cycle), seatsFor(ctx, ns)]);
  const limit = ctx.env.plans[plan].limits.seats;
  if (limit !== null && seats > limit) throw badRequest(`${ns.slug} has ${seats} seats in use; the ${ctx.env.plans[plan].name} plan allows ${limit}. Remove people first or choose a bigger plan.`);
  if (item.price.id === price && item.quantity === seats && !sub.cancel_at_period_end) return;
  const updated = await stripeFor(ctx).subscriptions.update(sub.id, {
    items: [{ id: item.id, price, quantity: seats }],
    proration_behavior: 'create_prorations',
    cancel_at_period_end: false,
    metadata: { namespaceId: ns.id, plan, cycle },
  });
  await applySubscription(ctx, updated);
}

/** Stop renewing at the end of the paid period (or undo that). */
export async function setCancelAtPeriodEnd(ctx: Ctx, ns: Namespace, cancel: boolean): Promise<void> {
  const sub = await liveSubscription(ctx, ns);
  const updated = await stripeFor(ctx).subscriptions.update(sub.id, { cancel_at_period_end: cancel });
  await applySubscription(ctx, updated);
}

/**
 * Bill the seats actually in use. Called after membership changes and hourly. Prorated, so adding someone mid-month
 * costs the rest of that month on the next invoice.
 */
export async function syncSeats(ctx: Ctx, ns: Namespace): Promise<boolean> {
  if (!cardPaymentsEnabled(ctx) || !ns.stripeSubscriptionId || !ns.subscriptionStatus || !ACTIVE.has(ns.subscriptionStatus)) return false;
  const sub = await stripeFor(ctx).subscriptions.retrieve(ns.stripeSubscriptionId);
  const item = sub.items.data[0];
  const seats = await seatsFor(ctx, ns);
  if (!item || item.quantity === seats) return false;
  await stripeFor(ctx).subscriptions.update(sub.id, { items: [{ id: item.id, quantity: seats }], proration_behavior: 'create_prorations' });
  return true;
}

/**
 * Fire-and-forget seat sync after someone joins or leaves. Never fails the request that changed membership; the
 * hourly sweep catches anything missed.
 */
export function seatsChanged(ctx: Ctx, where: { orgId?: string | null; namespaceId?: string | null }): void {
  if (!cardPaymentsEnabled(ctx)) return;
  void (async () => {
    const cond = where.namespaceId ? eq(namespaces.id, where.namespaceId) : where.orgId ? eq(namespaces.orgId, where.orgId) : null;
    if (!cond) return;
    const [ns] = await ctx.db.select().from(namespaces).where(cond).limit(1);
    if (ns) await syncSeats(ctx, ns);
  })().catch(() => {});
}

/**
 * Read the namespace's subscription and recent invoices straight from Stripe and apply them. Used when someone returns
 * from checkout (so the plan switches on even if the webhook is late or not configured) and by the hourly sweep.
 */
export async function syncFromStripe(ctx: Ctx, ns: Namespace): Promise<Namespace> {
  if (!cardPaymentsEnabled(ctx) || !ns.stripeCustomerId) return ns;
  const stripe = stripeFor(ctx);
  const subs = await stripe.subscriptions.list({ customer: ns.stripeCustomerId, status: 'all', limit: 5 });
  // The live one if there is one, else the most recent (so an ended subscription is noticed too).
  const pick = subs.data.find((s) => ACTIVE.has(s.status)) ?? subs.data.find((s) => s.status === 'incomplete') ?? subs.data[0];
  let current = ns;
  if (pick) current = (await applySubscription(ctx, pick)) ?? ns;
  const invs = await stripe.invoices.list({ customer: ns.stripeCustomerId, limit: 12 });
  for (const inv of invs.data) await applyInvoice(ctx, inv);
  return current;
}

/** Seat sync for every namespace paying by card (the hourly sweep). */
export async function syncAllSeats(ctx: Ctx): Promise<{ checked: number; updated: number; failed: number }> {
  if (!cardPaymentsEnabled(ctx)) return { checked: 0, updated: 0, failed: 0 };
  // Without webhooks, also re-read every card customer's subscription (cancellations made in Stripe's portal, failed
  // renewals). With webhooks, only the paying ones need a seat check.
  const rows = ctx.env.STRIPE_WEBHOOK_SECRET
    ? await ctx.db.select().from(namespaces).where(eq(namespaces.subscriptionStatus, 'active'))
    : await ctx.db.select().from(namespaces).where(isNotNull(namespaces.stripeCustomerId));
  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const ns = ctx.env.STRIPE_WEBHOOK_SECRET ? row : await syncFromStripe(ctx, row);
      if (await syncSeats(ctx, ns)) updated++;
    } catch {
      failed++;
    }
  }
  return { checked: rows.length, updated, failed };
}

// ─── Applying Stripe state ──────────────────────────────────────────────────

const ts = (s: number | null | undefined) => (s ? new Date(s * 1000) : null);

async function namespaceFor(ctx: Ctx, meta: Stripe.Metadata | null | undefined, customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): Promise<Namespace | null> {
  const id = meta?.namespaceId;
  if (id && /^[0-9a-f-]{36}$/.test(id)) {
    const [ns] = await ctx.db.select().from(namespaces).where(eq(namespaces.id, id)).limit(1);
    if (ns) return ns;
  }
  const cid = typeof customer === 'string' ? customer : customer?.id;
  if (!cid) return null;
  const [ns] = await ctx.db.select().from(namespaces).where(eq(namespaces.stripeCustomerId, cid)).limit(1);
  return ns ?? null;
}

/** Record a subscription's state and set the plan it pays for. */
export async function applySubscription(ctx: Ctx, sub: Stripe.Subscription): Promise<Namespace | null> {
  const ns = await namespaceFor(ctx, sub.metadata, sub.customer);
  if (!ns) return null;
  // An event for an older subscription must not overwrite the current one.
  if (ns.stripeSubscriptionId && ns.stripeSubscriptionId !== sub.id && hasLiveSubscription(ns) && sub.status !== 'active') return ns;
  const item = sub.items.data[0];
  const priced = item?.price ? planOfPrice(item.price) : null;
  // Since API version 2025-03-31 the period lives on the item; older versions keep it on the subscription.
  const periodEnd = ts((item as { current_period_end?: number } | undefined)?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end);
  const set: Partial<Namespace> = {
    stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    stripeSubscriptionId: sub.id,
    subscriptionStatus: sub.status,
    subscriptionPeriodEnd: periodEnd,
    subscriptionCancelAtPeriodEnd: sub.cancel_at_period_end,
  };
  if (ACTIVE.has(sub.status) && priced) {
    // Paid (or in Stripe's retry window after a failed payment): the plan follows the subscription.
    set.plan = priced.plan;
    set.billing = { ...(ns.billing ?? {}), cycle: priced.cycle };
  } else if (sub.status === 'canceled' || sub.status === 'unpaid' || sub.status === 'incomplete_expired') {
    // Ended or given up on: back to Free. Nothing is deleted; the Free plan's limits apply again.
    set.plan = 'free';
  }
  const [updated] = await ctx.db.update(namespaces).set(set).where(eq(namespaces.id, ns.id)).returning();
  return updated ?? null;
}

/** Mirror a Stripe invoice into the invoice list, so card and manual invoices show in one place. */
export async function applyInvoice(ctx: Ctx, inv: Stripe.Invoice): Promise<void> {
  if (!inv.id || inv.status === 'draft') return;
  const ns = await namespaceFor(ctx, inv.metadata ?? inv.parent?.subscription_details?.metadata, inv.customer);
  if (!ns) return;
  const status = inv.status === 'paid' ? 'paid' : inv.status === 'open' ? 'open' : 'void';
  const lines = inv.lines.data.map((l) => {
    const quantity = Math.max(1, l.quantity ?? 1);
    return { description: (l.description ?? 'Jumper subscription').slice(0, 200), quantity, unitCents: Math.round(l.amount / quantity) };
  });
  const first = inv.lines.data[0];
  const total = inv.total;
  const beforeTax = (inv as unknown as { total_excluding_tax?: number | null }).total_excluding_tax ?? inv.subtotal;
  const tax = Math.max(0, total - beforeTax);
  const values = {
    namespaceId: ns.id,
    number: inv.number ?? `STRIPE-${inv.id}`,
    status: status as 'paid' | 'open' | 'void',
    lines: lines.length ? lines : [{ description: 'Jumper subscription', quantity: 1, unitCents: total }],
    subtotalCents: beforeTax,
    taxPercent: beforeTax > 0 ? Math.round((tax / beforeTax) * 10_000) : 0,
    taxCents: tax,
    totalCents: total,
    periodStart: ts(first?.period?.start) ?? ts(inv.period_start) ?? new Date(),
    periodEnd: ts(first?.period?.end) ?? ts(inv.period_end) ?? new Date(),
    issuedAt: ts(inv.status_transitions?.finalized_at) ?? ts(inv.created),
    dueAt: ts(inv.due_date),
    paidAt: ts(inv.status_transitions?.paid_at),
    notes: '',
    billTo: {
      company: inv.customer_name ?? '',
      email: inv.customer_email ?? '',
      address: [inv.customer_address?.line1, inv.customer_address?.line2, [inv.customer_address?.postal_code, inv.customer_address?.city].filter(Boolean).join(' '), inv.customer_address?.country].filter(Boolean).join('\n'),
      taxId: inv.customer_tax_ids?.[0]?.value ?? '',
      poNumber: '',
      cycle: (ns.billing?.cycle as string) ?? 'monthly',
    },
    stripeInvoiceId: inv.id,
    hostedUrl: inv.hosted_invoice_url ?? null,
    pdfUrl: inv.invoice_pdf ?? null,
  };
  await ctx.db
    .insert(invoices)
    .values(values)
    .onConflictDoUpdate({ target: invoices.stripeInvoiceId, set: { status: values.status, paidAt: values.paidAt, dueAt: values.dueAt, issuedAt: values.issuedAt, hostedUrl: values.hostedUrl, pdfUrl: values.pdfUrl, totalCents: values.totalCents, taxCents: values.taxCents, subtotalCents: values.subtotalCents, number: values.number } });
}

/** Handle one verified webhook event. Returns false for events already applied. */
export async function handleEvent(ctx: Ctx, event: Stripe.Event): Promise<boolean> {
  const [seen] = await ctx.db.select({ id: stripeEvents.id }).from(stripeEvents).where(eq(stripeEvents.id, event.id)).limit(1);
  if (seen) return false;
  const stripe = stripeFor(ctx);
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      if (s.mode === 'subscription' && s.subscription) {
        const sub = await stripe.subscriptions.retrieve(typeof s.subscription === 'string' ? s.subscription : s.subscription.id);
        await applySubscription(ctx, sub);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      // Re-read rather than trust the payload order: events can arrive out of order.
      await applySubscription(ctx, event.type === 'customer.subscription.deleted' ? event.data.object : await stripe.subscriptions.retrieve(event.data.object.id));
      break;
    case 'invoice.finalized':
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.voided':
    case 'invoice.marked_uncollectible':
    case 'invoice.updated':
      await applyInvoice(ctx, event.data.object);
      break;
    default:
      break;
  }
  await ctx.db.insert(stripeEvents).values({ id: event.id, type: event.type }).onConflictDoNothing();
  return true;
}

export function subscriptionInfo(ns: Namespace): SubscriptionInfo | null {
  if (!ns.stripeSubscriptionId || !ns.subscriptionStatus || ns.subscriptionStatus === 'canceled' || ns.subscriptionStatus === 'incomplete_expired') return null;
  return {
    status: ns.subscriptionStatus,
    plan: isPlanId(ns.plan) ? ns.plan : 'free',
    cycle: ns.billing?.cycle === 'annual' ? 'annual' : 'monthly',
    quantity: 0,
    periodEnd: ns.subscriptionPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: ns.subscriptionCancelAtPeriodEnd,
  };
}
