import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireUser } from '../auth/plugin';
import { collectDigest, digestIsEmpty, renderDigest } from './service';

const digestRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  // What this week's digest would say, so people can see it before deciding to keep it on.
  app.get('/user/digest/preview', async (req) => {
    const user = requireUser(req);
    const since = new Date(Date.now() - 7 * 86_400_000);
    const content = await collectDigest(ctx, user, since);
    return { empty: digestIsEmpty(content), enabled: user.digestEmail, lastSentAt: user.lastDigestAt?.toISOString() ?? null, ...renderDigest(content, ctx.env.PUBLIC_URL) };
  });
};

export default digestRoutes;
