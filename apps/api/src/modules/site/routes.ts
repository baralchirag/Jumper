import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { SiteInfo } from '@jumper/shared';

/** Public facts about this instance. The legal pages fill in the operator's details from here. */
const siteRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/site', async (): Promise<SiteInfo> => {
    const env = app.ctx.env;
    return {
      name: 'Jumper',
      publicUrl: env.PUBLIC_URL.replace(/\/$/, ''),
      operator: { name: env.OPERATOR_NAME ?? null, email: env.OPERATOR_EMAIL ?? null, jurisdiction: env.OPERATOR_JURISDICTION ?? null },
      legalUpdated: env.LEGAL_UPDATED ?? null,
      signup: env.ALLOW_SIGNUP,
    };
  });
};

export default siteRoutes;
