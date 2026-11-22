// Card payments end to end against a fake Stripe API: the real Stripe SDK talks HTTP to a local server that keeps
// customers, prices, sessions and subscriptions in memory, and webhooks are signed with the real signing scheme.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@jumper/db';
import { createHarness, dbAvailable, type Harness } from '../testing/harness';
import { clearPriceCache } from '../modules/stripe/service';

const SECRET = 'whsec_test_secret';

/** Minimal in-memory Stripe: only the endpoints Jumper calls. */
class FakeStripe {
  server!: Server;
  url = '';
  n = 0;
  products = new Map<string, Record<string, unknown>>();
  prices: Record<string, any>[] = [];
  customers: Record<string, any>[] = [];
  sessions: Record<string, string>[] = [];
  subs = new Map<string, any>();
  calls: string[] = [];

  id(prefix: string) {
    return `${prefix}_${++this.n}`;
  }

  async start() {
    this.server = createServer((req, res) => void this.handle(req).then(([code, body]) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    }));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  reset() {
    this.products.clear();
    this.prices = [];
    this.customers = [];
    this.sessions = [];
    this.subs.clear();
    this.calls = [];
  }

  private async handle(req: IncomingMessage): Promise<[number, unknown]> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    const u = new URL(req.url!, 'http://x');
    const path = u.pathname;
    this.calls.push(`${req.method} ${path}`);
    const err = (code: number, message: string): [number, unknown] => [code, { error: { type: 'invalid_request_error', message } }];

    if (req.method === 'GET' && path === '/v1/prices') {
      const keys = u.searchParams.getAll('lookup_keys[]').concat(u.searchParams.getAll('lookup_keys[0]'));
      return [200, { object: 'list', data: this.prices.filter((p) => keys.includes(p.lookup_key) && p.active), has_more: false }];
    }
    if (req.method === 'GET' && path.startsWith('/v1/products/')) {
      const p = this.products.get(path.split('/').pop()!);
      return p ? [200, p] : err(404, 'No such product');
    }
    if (req.method === 'POST' && path === '/v1/products') {
      const p = { id: form.id, object: 'product', name: form.name };
      this.products.set(form.id!, p);
      return [200, p];
    }
    if (req.method === 'POST' && path === '/v1/prices') {
      if (form.transfer_lookup_key === 'true') for (const p of this.prices) if (p.lookup_key === form.lookup_key) p.lookup_key = null;
      const p = {
        id: this.id('price'), object: 'price', active: true, currency: form.currency, unit_amount: Number(form.unit_amount), product: form.product,
        lookup_key: form.lookup_key, recurring: { interval: form['recurring[interval]'] }, metadata: { plan: form['metadata[plan]'], cycle: form['metadata[cycle]'] },
      };
      this.prices.push(p);
      return [200, p];
    }
    if (req.method === 'POST' && path === '/v1/customers') {
      const c = { id: this.id('cus'), object: 'customer', email: form.email, metadata: { namespaceId: form['metadata[namespaceId]'] } };
      this.customers.push(c);
      return [200, c];
    }
    if (req.method === 'POST' && path === '/v1/checkout/sessions') {
      this.sessions.push(form as Record<string, string>);
      return [200, { id: this.id('cs'), object: 'checkout.session', url: 'https://checkout.stripe.test/pay' }];
    }
    if (req.method === 'POST' && path === '/v1/billing_portal/sessions') return [200, { id: this.id('bps'), object: 'billing_portal.session', url: 'https://billing.stripe.test/p' }];
    if (path.startsWith('/v1/subscriptions/')) {
      const sub = this.subs.get(path.split('/').pop()!);
      if (!sub) return err(404, 'No such subscription');
      if (req.method === 'POST') {
        if (form['items[0][price]']) sub.items.data[0].price = this.prices.find((p) => p.id === form['items[0][price]']);
        if (form['items[0][quantity]']) sub.items.data[0].quantity = Number(form['items[0][quantity]']);
        if (form.cancel_at_period_end) sub.cancel_at_period_end = form.cancel_at_period_end === 'true';
      }
      return [200, sub];
    }
    return err(404, `fake stripe: ${req.method} ${path} not implemented`);
  }

  /** A subscription as Stripe would hold it after a completed checkout. */
  subscribe(customer: string, namespaceId: string, lookup: string, quantity = 1) {
    const price = this.prices.find((p) => p.lookup_key === lookup);
    const sub = {
      id: this.id('sub'), object: 'subscription', customer, status: 'active', cancel_at_period_end: false, metadata: { namespaceId },
      items: { object: 'list', data: [{ id: this.id('si'), object: 'subscription_item', price, quantity, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
    };
    this.subs.set(sub.id, sub);
    return sub;
  }
}

describe.skipIf(!dbAvailable)('card payments with Stripe', () => {
  const stripe = new FakeStripe();
  let h: Harness;
  const signer = new Stripe('sk_test_x');

  beforeAll(async () => {
    await stripe.start();
    h = await createHarness({ env: { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_API_BASE: stripe.url, PUBLIC_URL: 'https://jumper.test' } });
  });
  afterAll(async () => {
    await h.close();
    stripe.server.close();
  });
  beforeEach(async () => {
    await h.reset();
    stripe.reset();
    clearPriceCache();
  });

  const webhook = async (type: string, object: unknown, id = `evt_${Math.random().toString(36).slice(2)}`) => {
    const payload = JSON.stringify({ id, object: 'event', type, api_version: '2025-10-29.clover', created: Math.floor(Date.now() / 1000), data: { object } });
    const sig = signer.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    const res = await h.app.inject({ method: 'POST', url: '/api/stripe/webhook', payload, headers: { 'content-type': 'application/json', 'stripe-signature': sig } });
    return { status: res.statusCode, id };
  };
  const ns = async (slug: string) => ((await h.ctx.db.execute(sql`select * from namespaces where slug = ${slug}`)) as unknown as Record<string, any>[])[0]!;

  it('subscribes by card: checkout, webhook, invoices, plan change, cancel and end', async () => {
    const alice = await h.user('alice');

    const billing0 = await alice.get('/api/owners/alice/billing');
    expect(billing0.json).toMatchObject({ cardPayments: true, subscription: null, plan: 'free' });

    // Checkout creates the customer and the price from plans.ts, and bills one seat.
    const co = await alice.post('/api/owners/alice/billing/checkout', { plan: 'pro', cycle: 'annual' });
    expect(co.status, co.body).toBe(200);
    expect(co.json.url).toBe('https://checkout.stripe.test/pay');
    expect(stripe.prices).toHaveLength(1);
    expect(stripe.prices[0]).toMatchObject({ lookup_key: 'jumper_pro_annual', unit_amount: 12_000, currency: 'usd' });
    const session = stripe.sessions[0]!;
    expect(session['line_items[0][quantity]']).toBe('1');
    expect(session.mode).toBe('subscription');
    expect(session.success_url).toBe('https://jumper.test/checkout/done?owner=alice&plan=pro');
    expect(session.cancel_url).toBe('https://jumper.test/settings/usage?checkout=cancelled');
    const a = await ns('alice');
    expect(a.stripe_customer_id).toBe(stripe.customers[0]!.id);

    // A forged webhook is refused.
    const forged = await h.app.inject({ method: 'POST', url: '/api/stripe/webhook', payload: '{"id":"evt_x","type":"customer.subscription.deleted"}', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' } });
    expect(forged.statusCode).toBe(400);

    // Stripe finishes checkout: the plan follows the subscription.
    const sub = stripe.subscribe(a.stripe_customer_id, a.id, 'jumper_pro_annual');
    const done = await webhook('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'subscription', subscription: sub.id, customer: a.stripe_customer_id });
    expect(done.status).toBe(200);
    let b = await alice.get('/api/owners/alice/billing');
    expect(b.json.plan).toBe('pro');
    expect(b.json.cycle).toBe('annual');
    expect(b.json.subscription).toMatchObject({ status: 'active', plan: 'pro', cycle: 'annual', cancelAtPeriodEnd: false });
    // The same event delivered twice is applied once.
    expect((await webhook('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'subscription', subscription: sub.id }, done.id)).status).toBe(200);

    // A second checkout while subscribed is refused; the plan is changed instead.
    expect((await alice.post('/api/owners/alice/billing/checkout', { plan: 'team', cycle: 'monthly' })).status).toBe(409);

    // Stripe's invoice shows in the invoice list with Stripe's own page.
    const inv = {
      id: 'in_1', object: 'invoice', number: 'JMPR-0001', status: 'paid', customer: a.stripe_customer_id, total: 12_000, subtotal: 12_000, total_excluding_tax: 12_000,
      created: Math.floor(Date.now() / 1000), status_transitions: { finalized_at: Math.floor(Date.now() / 1000), paid_at: Math.floor(Date.now() / 1000) },
      hosted_invoice_url: 'https://invoice.stripe.test/i/1', invoice_pdf: 'https://invoice.stripe.test/i/1.pdf', customer_name: 'Alice', customer_email: 'alice@example.com',
      lines: { object: 'list', data: [{ description: '1 × Jumper Pro (at $120.00 / year)', quantity: 1, amount: 12_000, period: { start: 1, end: 2 } }] },
    };
    expect((await webhook('invoice.paid', inv)).status).toBe(200);
    b = await alice.get('/api/owners/alice/billing');
    expect(b.json.invoices).toHaveLength(1);
    expect(b.json.invoices[0]).toMatchObject({ number: 'JMPR-0001', status: 'paid', totalCents: 12_000, source: 'stripe', hostedUrl: 'https://invoice.stripe.test/i/1' });
    // Redelivery with a new status updates the same row.
    await webhook('invoice.updated', { ...inv, status: 'void' });
    b = await alice.get('/api/owners/alice/billing');
    expect(b.json.invoices).toHaveLength(1);
    expect(b.json.invoices[0].status).toBe('void');

    // Change plan and cycle: a new price is created and the subscription item moves to it.
    const change = await alice.put('/api/owners/alice/billing/subscription', { plan: 'team', cycle: 'monthly' });
    expect(change.status, change.body).toBe(200);
    expect(change.json.plan).toBe('team');
    expect(change.json.cycle).toBe('monthly');
    expect(stripe.subs.get(sub.id).items.data[0].price.lookup_key).toBe('jumper_team_monthly');

    // Cancel at period end, then change of mind.
    const cancel = await alice.post('/api/owners/alice/billing/subscription/cancel');
    expect(cancel.json.subscription.cancelAtPeriodEnd).toBe(true);
    expect(cancel.json.plan).toBe('team');
    const resume = await alice.post('/api/owners/alice/billing/subscription/resume');
    expect(resume.json.subscription.cancelAtPeriodEnd).toBe(false);

    // The portal opens for the customer.
    const portal = await alice.post('/api/owners/alice/billing/portal');
    expect(portal.json.url).toBe('https://billing.stripe.test/p');

    // An administrator cannot override the plan of someone paying by card.
    const root = await h.user('root');
    await h.ctx.db.execute(sql`update users set is_admin = true where username = 'root'`);
    expect((await root.put('/api/admin/namespaces/alice/plan', { plan: 'enterprise' })).status).toBe(409);

    // The subscription ends: back to Free, nothing else removed.
    expect((await webhook('customer.subscription.deleted', { ...stripe.subs.get(sub.id), status: 'canceled' })).status).toBe(200);
    b = await alice.get('/api/owners/alice/billing');
    expect(b.json.plan).toBe('free');
    expect(b.json.subscription).toBeNull();
    expect(b.json.invoices).toHaveLength(1);
  });

  it('keeps billed seats in step with organization members', async () => {
    const alice = await h.user('alice');
    await h.user('bob');
    expect((await alice.post('/api/orgs', { slug: 'acme', name: 'Acme' })).status).toBe(200);
    const co = await alice.post('/api/owners/acme/billing/checkout', { plan: 'team', cycle: 'monthly' });
    expect(co.status, co.body).toBe(200);
    expect(stripe.sessions[0]!.success_url).toBe('https://jumper.test/checkout/done?owner=acme&plan=team');
    expect(stripe.sessions[0]!.cancel_url).toBe('https://jumper.test/organizations/acme/settings/billing?checkout=cancelled');
    const acme = await ns('acme');
    const sub = stripe.subscribe(acme.stripe_customer_id, acme.id, 'jumper_team_monthly', 1);
    expect((await webhook('customer.subscription.created', sub)).status).toBe(200);
    expect((await ns('acme')).plan).toBe('team');

    expect((await alice.put('/api/orgs/acme/members', { username: 'bob', role: 'member' })).status).toBe(200);
    // The sync runs after the response; give it a moment.
    for (let i = 0; i < 50 && stripe.subs.get(sub.id).items.data[0].quantity !== 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(stripe.subs.get(sub.id).items.data[0].quantity).toBe(2);

    expect((await alice.req('DELETE', '/api/orgs/acme/members/bob')).status).toBe(200);
    for (let i = 0; i < 50 && stripe.subs.get(sub.id).items.data[0].quantity !== 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(stripe.subs.get(sub.id).items.data[0].quantity).toBe(1);
  });

  it('a failed payment keeps the plan during retries and drops to Free when Stripe gives up', async () => {
    const alice = await h.user('alice');
    await alice.post('/api/owners/alice/billing/checkout', { plan: 'pro', cycle: 'monthly' });
    const a = await ns('alice');
    const sub = stripe.subscribe(a.stripe_customer_id, a.id, 'jumper_pro_monthly');
    await webhook('customer.subscription.created', sub);
    sub.status = 'past_due';
    await webhook('customer.subscription.updated', sub);
    expect((await ns('alice')).plan).toBe('pro');
    sub.status = 'unpaid';
    await webhook('customer.subscription.updated', sub);
    expect((await ns('alice')).plan).toBe('free');
  });

  it('only owners can start billing, and members of an organization cannot', async () => {
    const alice = await h.user('alice');
    const bob = await h.user('bob');
    await alice.post('/api/orgs', { slug: 'acme', name: 'Acme' });
    await alice.put('/api/orgs/acme/members', { username: 'bob', role: 'member' });
    expect((await bob.post('/api/owners/acme/billing/checkout', { plan: 'team', cycle: 'monthly' })).status).toBe(403);
    expect((await bob.post('/api/owners/alice/billing/checkout', { plan: 'pro', cycle: 'monthly' })).status).toBe(404);
    expect((await alice.post('/api/owners/alice/billing/checkout', { plan: 'enterprise', cycle: 'monthly' })).status).toBe(400);
  });
});

describe.skipIf(!dbAvailable)('without Stripe keys', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  it('offers no card payment and refuses webhooks', async () => {
    const alice = await h.user('alice');
    expect((await alice.get('/api/owners/alice/billing')).json.cardPayments).toBe(false);
    expect((await alice.post('/api/owners/alice/billing/checkout', { plan: 'pro', cycle: 'monthly' })).status).toBe(400);
    const res = await h.app.inject({ method: 'POST', url: '/api/stripe/webhook', payload: '{}', headers: { 'content-type': 'application/json', 'stripe-signature': 'x' } });
    expect(res.statusCode).toBe(404);
  });
});
