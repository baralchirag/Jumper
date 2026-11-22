import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq, namespaces } from '@jumper/db';
import { PLAN_IDS, type Plan, type UsageReport } from '@jumper/shared';
import { requireUser } from '../auth/plugin';
import { audit } from '../audit/audit';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { cardPaymentsEnabled, hasLiveSubscription } from '../stripe/service';
import { findNamespace, orgRoleFor } from '../repos/access';
import { usageReport } from './service';

/** Plans, per-owner usage, and (for administrators) assigning plans. */
const usageRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get('/plans', async (): Promise<{ enforced: boolean; cardPayments: boolean; plans: Plan[] }> => ({ enforced: ctx.env.PLANS_ENFORCED, cardPayments: cardPaymentsEnabled(ctx), plans: PLAN_IDS.map((id) => ctx.env.plans[id]) }));

  // A user sees their own usage; organization members see the organization's; administrators see everyone's.
  app.get('/usage/:owner', { schema: { params: z.object({ owner: z.string().max(100) }) } }, async (req): Promise<UsageReport> => {
    const user = requireUser(req);
    const ns = await findNamespace(ctx, req.params.owner);
    if (!ns) throw notFound('Owner not found');
    const allowed = user.isAdmin || (ns.kind === 'user' ? ns.userId === user.id : ns.orgId !== null && (await orgRoleFor(ctx, ns.orgId, user.id)) !== null);
    if (!allowed) throw notFound('Owner not found');
    return usageReport(ctx, ns);
  });

  app.put(
    '/admin/namespaces/:owner/plan',
    { schema: { params: z.object({ owner: z.string().max(100) }), body: z.object({ plan: z.enum(PLAN_IDS) }) } },
    async (req) => {
      const user = requireUser(req);
      if (!user.isAdmin) throw forbidden('Administrators only');
      const ns = await findNamespace(ctx, req.params.owner);
      if (!ns) throw notFound('Owner not found');
      // Stripe webhooks set the plan of an account paying by card; a manual change would be undone at the next event.
      if (hasLiveSubscription(ns)) throw conflict(`${ns.slug} pays by card. Change the plan from their billing page or in Stripe, or cancel the subscription first.`);
      await ctx.db.update(namespaces).set({ plan: req.body.plan }).where(eq(namespaces.id, ns.id));
      await audit(req, 'admin.plan.set', { type: ns.kind, id: ns.id }, { owner: ns.slug, from: ns.plan, to: req.body.plan });
      return usageReport(ctx, { ...ns, plan: req.body.plan });
    },
  );
};

export default usageRoutes;
