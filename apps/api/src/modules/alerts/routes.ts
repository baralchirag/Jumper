import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bomWatches } from '@jumper/db';
import { bomWatchSchema, type BomWatchInfo } from '@jumper/shared';
import { conflict } from '../../lib/errors';
import { audit } from '../audit/audit';
import { requireUser } from '../auth/plugin';
import { loadRepo } from '../repos/access';
import { alertsAvailable, checkRepoStock, watchInfo } from './service';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const UNAVAILABLE = 'Stock alerts need supplier pricing, which is switched off on this instance';

const alertRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get('/repos/:owner/:repo/bom-watch', { schema: { params } }, async (req): Promise<BomWatchInfo> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    return watchInfo(ctx, r.repo.id);
  });

  app.put('/repos/:owner/:repo/bom-watch', { schema: { params, body: bomWatchSchema } }, async (req): Promise<BomWatchInfo> => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'write');
    if (req.body.enabled && !alertsAvailable(ctx)) throw conflict(UNAVAILABLE);
    await ctx.db
      .insert(bomWatches)
      .values({ repoId: r.repo.id, enabled: req.body.enabled, boards: req.body.boards, createdBy: user.id })
      .onConflictDoUpdate({ target: bomWatches.repoId, set: { enabled: req.body.enabled, boards: req.body.boards } });
    await audit(req, 'bom_watch.update', { type: 'repo', id: r.repo.id }, req.body);
    return watchInfo(ctx, r.repo.id);
  });

  // Check now instead of waiting for the daily run. Each check asks the suppliers about every part, so it is limited.
  app.post('/repos/:owner/:repo/bom-watch/check', { schema: { params }, config: { rateLimit: { max: 4, timeWindow: '10 minutes' } } }, async (req): Promise<BomWatchInfo> => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'write');
    if (!alertsAvailable(ctx)) throw conflict(UNAVAILABLE);
    await ctx.db.insert(bomWatches).values({ repoId: r.repo.id, enabled: false, createdBy: user.id }).onConflictDoNothing();
    await checkRepoStock(ctx, r.repo, r.ns);
    return watchInfo(ctx, r.repo.id);
  });
};

export default alertRoutes;
