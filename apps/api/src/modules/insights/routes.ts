import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { InsightsReport } from '@jumper/shared';
import { requireFeature } from '../license/license';
import { loadOwner } from '../policy/routes';
import { buildInsights } from './service';

const insightsRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get(
    '/owners/:owner/insights',
    { schema: { params: z.object({ owner: z.string().max(100) }), querystring: z.object({ weeks: z.coerce.number().int().min(2).max(52).default(12) }) } },
    async (req): Promise<InsightsReport> => {
      const { ns, user } = await loadOwner(req, req.params.owner, 'member');
      await requireFeature(ctx, ns, 'insights');
      return buildInsights(ctx, user, ns, req.query.weeks);
    },
  );
};

export default insightsRoutes;
