import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SEARCH_TYPES, type SearchResults } from '@jumper/shared';
import { loadRepo } from '../repos/access';
import { search } from './service';

const query = z.object({ q: z.string().max(200).default(''), type: z.enum(SEARCH_TYPES).default('repos') });

const searchRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  /** Everything the viewer can read. Files, code, parts and nets cover the most recently pushed repositories. */
  app.get('/search', { schema: { querystring: query }, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<SearchResults> => {
    return search(ctx, req.user, req.query.q, req.query.type);
  });

  /** One repository, at its default branch. */
  app.get(
    '/repos/:owner/:repo/search',
    { schema: { params: z.object({ owner: z.string().max(100), repo: z.string().max(100) }), querystring: query.extend({ type: z.enum(SEARCH_TYPES).default('files') }) }, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req): Promise<SearchResults> => {
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      return search(ctx, req.user, req.query.q, req.query.type, { id: r.repo.id, owner: r.ns.slug, name: r.repo.name, defaultBranch: r.repo.defaultBranch });
    },
  );
};

export default searchRoutes;
