import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { repoConfigSchema } from '@jumper/shared';
import { fabProfileIds } from '@jumper/engineering';
import { loadRepo } from '../repos/access';
import { audit } from '../audit/audit';
import { badRequest } from '../../lib/errors';
import { getRepoConfig, setRepoConfig } from '../_shared/repo-config';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });

const configRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get('/repos/:owner/:repo/config', { schema: { params } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    return { config: await getRepoConfig(ctx, r.repo.id), availableFabProfiles: fabProfileIds };
  });

  app.put('/repos/:owner/:repo/config', { schema: { params, body: repoConfigSchema } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const unknown = req.body.fabProfiles.filter((p) => !fabProfileIds.includes(p));
    if (unknown.length) throw badRequest(`Unknown fab profile(s): ${unknown.join(', ')}`);
    await setRepoConfig(ctx, r.repo.id, req.body);
    await audit(req, 'repo.config.update', { type: 'repo', id: r.repo.id });
    return { config: await getRepoConfig(ctx, r.repo.id) };
  });
};

export default configRoutes;
