import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ComplianceReport } from '@jumper/shared';
import { badRequest, notFound, unprocessable } from '../../lib/errors';
import { priceBom } from '../bom/pricing';
import { collectSheets } from '../code/semantic';
import { isValidRev } from '../git/repo';
import { loadRepo } from '../repos/access';
import { buildComplianceReport, complianceCsv } from './service';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });

const complianceRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get(
    '/repos/:owner/:repo/compliance',
    {
      schema: {
        params,
        querystring: z.object({
          /** Root schematic; defaults to the first KiCad project in the repository. */
          path: z.string().max(4096).optional(),
          sha: z.string().max(255).refine(isValidRev, 'Invalid revision').optional(),
          /** Ask suppliers about parts that carry no RoHS field. Off on air-gapped instances. */
          suppliers: z.stringbool().default(false),
          format: z.enum(['json', 'csv']).default('json'),
        }),
      },
      config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    },
    async (req, reply): Promise<ComplianceReport | void> => {
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const sha = await r.git.resolveCommit(req.query.sha || r.repo.defaultBranch);
      if (!sha) throw notFound('Unknown revision');
      let path = req.query.path;
      if (!path) {
        const files = await r.git.lsFiles(sha);
        path = files.filter((f) => f.endsWith('.kicad_pro')).map((f) => f.replace(/\.kicad_pro$/, '.kicad_sch')).find((f) => files.includes(f));
        if (!path) throw notFound('No KiCad project with a schematic was found at that revision');
      }
      if (!path.endsWith('.kicad_sch')) throw badRequest('Path must be a .kicad_sch file');
      const sheets = await collectSheets(ctx, r.git, sha, path);
      if (!sheets.length) throw notFound('Schematic not found at that revision');
      const lines = await ctx.kicad.bom(sheets).catch((e: Error) => {
        throw unprocessable(`Could not read the BOM: ${e.message}`);
      });
      const askSuppliers = req.query.suppliers && ctx.env.PRICING_ENABLED && !ctx.env.AIR_GAPPED;
      const priced = askSuppliers
        ? (await priceBom(lines, 1, { redis: ctx.redis, config: { mouserApiKey: ctx.env.MOUSER_API_KEY, digikeyClientId: ctx.env.DIGIKEY_CLIENT_ID, digikeyClientSecret: ctx.env.DIGIKEY_CLIENT_SECRET } }).catch(() => null))?.lines
        : undefined;
      const report = buildComplianceReport(lines, { sha, project: path, priced });
      if (req.query.format === 'json') return report;
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${r.repo.name}-rohs-reach-${sha.slice(0, 7)}.csv"`)
        .header('X-Content-Type-Options', 'nosniff')
        .send(complianceCsv(report));
    },
  );
};

export default complianceRoutes;
