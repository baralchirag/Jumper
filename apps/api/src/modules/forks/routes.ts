import { rm } from 'node:fs/promises';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq, namespaces, repositories, sql } from '@jumper/db';
import { repoNameSchema } from '@jumper/shared';
import { requireUser } from '../auth/plugin';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { audit } from '../audit/audit';
import { GitRepo } from '../git/repo';
import { canManageNamespace, findNamespace, findRepo, loadRepo, repoDiskPath } from '../repos/access';
import { enqueueAnalysis } from '../repos/push';
import { permissionsFor } from '../repos/access';
import { toRepoInfo } from '../repos/serialize';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });

const forkRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  /** Copy a repository you can read into your own account (or an organization you manage). */
  app.post(
    '/repos/:owner/:repo/fork',
    { schema: { params, body: z.object({ owner: z.string().max(100).optional(), name: repoNameSchema.optional() }) }, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req) => {
      const user = requireUser(req);
      const src = await loadRepo(req, req.params.owner, req.params.repo);
      if (await src.git.isEmpty()) throw badRequest('This repository is empty, so there is nothing to fork');
      const ns = await findNamespace(ctx, req.body.owner ?? user.username);
      if (!ns) throw notFound('Owner not found');
      if (!(await canManageNamespace(ctx, user, ns))) throw forbidden('You cannot create repositories for this owner');
      const name = req.body.name ?? src.repo.name;
      if (ns.id === src.ns.id && name.toLowerCase() === src.repo.name.toLowerCase()) throw conflict('Pick a different name or owner: you cannot fork a repository into itself');
      if (await findRepo(ctx, ns.slug, name)) throw conflict(`${ns.slug} already has a repository called ${name}`);

      const [repo] = await ctx.db
        .insert(repositories)
        .values({ namespaceId: ns.id, name, description: src.repo.description, visibility: src.repo.visibility, defaultBranch: src.repo.defaultBranch, forkOfId: src.repo.id, pushedAt: new Date() })
        .returning();
      const dest = repoDiskPath(ctx, repo!.id);
      try {
        const git = await GitRepo.fork(repoDiskPath(ctx, src.repo.id), dest, src.repo.defaultBranch);
        await ctx.db.update(repositories).set({ sizeBytes: await git.sizeBytes().catch(() => 0) }).where(eq(repositories.id, repo!.id));
        const sha = await git.resolveBranch(src.repo.defaultBranch);
        if (sha) await enqueueAnalysis(ctx, repo!.id, sha, src.repo.defaultBranch).catch((e) => req.log.warn(e, 'enqueue failed'));
      } catch (e) {
        await ctx.db.delete(repositories).where(eq(repositories.id, repo!.id));
        await rm(dest, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      await audit(req, 'repo.fork', { type: 'repo', id: repo!.id }, { from: `${src.ns.slug}/${src.repo.name}`, to: `${ns.slug}/${name}` });
      return toRepoInfo(ctx, repo!, ns, 'admin', { isEmpty: false, forkOf: { owner: src.ns.slug, name: src.repo.name } });
    },
  );

  /** Public forks of a repository (private ones only appear to people who can read them). */
  app.get('/repos/:owner/:repo/forks', { schema: { params } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const rows = await ctx.db
      .select({ repo: repositories, ns: namespaces })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId))
      .where(eq(repositories.forkOfId, r.repo.id))
      .orderBy(sql`${repositories.createdAt} desc`)
      .limit(100);
    const perms = await permissionsFor(ctx, req.user, rows);
    return rows.flatMap((row, i) => (perms[i] === 'none' ? [] : [toRepoInfo(ctx, row.repo, row.ns, perms[i]!, { forkOf: { owner: r.ns.slug, name: r.repo.name } })]));
  });
};

export default forkRoutes;
