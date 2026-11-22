import type { FastifyPluginAsync } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checkoutSchema } from '@jumper/shared';
import { badRequest } from '../../lib/errors';
import { audit } from '../audit/audit';
import { requireScope } from '../auth/plugin';
import { loadOwner } from '../policy/routes';
import { billingInfoFor } from '../billing/routes';
import { changePlan, createCheckout, createPortal, handleEvent, setCancelAtPeriodEnd, stripeFor } from './service';

const ownerParams = z.object({ owner: z.string().max(100) });

/** Checkout, the customer portal and plan changes for the owner of a namespace. */
export const stripeRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.post('/owners/:owner/billing/checkout', { schema: { params: ownerParams, body: checkoutSchema }, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req): Promise<{ url: string }> => {
    requireScope(req, 'admin');
    const { ns, user } = await loadOwner(req, req.params.owner, 'owner');
    const url = await createCheckout(ctx, ns, user.email, req.body.plan, req.body.cycle, req.body.from);
    await audit(req, 'billing.checkout', { type: ns.kind, id: ns.id }, { plan: req.body.plan, cycle: req.body.cycle }, undefined, ns.id);
    return { url };
  });

  app.post('/owners/:owner/billing/portal', { schema: { params: ownerParams }, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req): Promise<{ url: string }> => {
    requireScope(req, 'admin');
    const { ns } = await loadOwner(req, req.params.owner, 'owner');
    return { url: await createPortal(ctx, ns) };
  });

  app.put('/owners/:owner/billing/subscription', { schema: { params: ownerParams, body: checkoutSchema } }, async (req) => {
    requireScope(req, 'admin');
    const { ns } = await loadOwner(req, req.params.owner, 'owner');
    await changePlan(ctx, ns, req.body.plan, req.body.cycle);
    await audit(req, 'billing.plan.change', { type: ns.kind, id: ns.id }, { from: ns.plan, to: req.body.plan, cycle: req.body.cycle }, undefined, ns.id);
    return billingInfoFor(ctx, ns.id);
  });

  app.post('/owners/:owner/billing/subscription/cancel', { schema: { params: ownerParams } }, async (req) => {
    requireScope(req, 'admin');
    const { ns } = await loadOwner(req, req.params.owner, 'owner');
    await setCancelAtPeriodEnd(ctx, ns, true);
    await audit(req, 'billing.cancel', { type: ns.kind, id: ns.id }, { plan: ns.plan }, undefined, ns.id);
    return billingInfoFor(ctx, ns.id);
  });

  app.post('/owners/:owner/billing/subscription/resume', { schema: { params: ownerParams } }, async (req) => {
    requireScope(req, 'admin');
    const { ns } = await loadOwner(req, req.params.owner, 'owner');
    await setCancelAtPeriodEnd(ctx, ns, false);
    await audit(req, 'billing.resume', { type: ns.kind, id: ns.id }, { plan: ns.plan }, undefined, ns.id);
    return billingInfoFor(ctx, ns.id);
  });
};

/**
 * Stripe webhook. The signature is checked against the raw body, so this plugin parses JSON as a Buffer and is
 * registered on its own. Configure the endpoint in Stripe at https://<your-domain>/api/stripe/webhook.
 */
export const stripeWebhookRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post('/stripe/webhook', { config: { rateLimit: false } }, async (req, reply) => {
    if (!ctx.env.STRIPE_WEBHOOK_SECRET || !ctx.env.STRIPE_SECRET_KEY) return reply.code(404).send({ error: 'not_found', message: 'Card payments are not set up' });
    const sig = req.headers['stripe-signature'];
    if (typeof sig !== 'string' || !Buffer.isBuffer(req.body)) throw badRequest('Missing Stripe signature');
    let event;
    try {
      event = stripeFor(ctx).webhooks.constructEvent(req.body, sig, ctx.env.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw badRequest('Invalid Stripe signature');
    }
    // A failure here returns 500, so Stripe retries the event later (with back-off, for up to three days).
    const applied = await handleEvent(ctx, event);
    req.log.info({ event: event.type, id: event.id, applied }, 'stripe webhook');
    return { received: true };
  });
};
