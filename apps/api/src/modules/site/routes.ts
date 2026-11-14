import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { FAB_ORDER_PAGES, type SiteInfo } from '@jumper/shared';

const link = (custom: string | undefined, fallback: string) => ({ url: custom ?? fallback, referral: Boolean(custom) });

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
      fabLinks: {
        jlcpcb: link(env.FAB_REFERRAL_JLCPCB, FAB_ORDER_PAGES.jlcpcb),
        pcbway: link(env.FAB_REFERRAL_PCBWAY, FAB_ORDER_PAGES.pcbway),
        oshpark: link(env.FAB_REFERRAL_OSHPARK, FAB_ORDER_PAGES.oshpark),
      },
    };
  });
};

export default siteRoutes;
