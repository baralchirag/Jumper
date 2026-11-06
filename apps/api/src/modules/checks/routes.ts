import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, artifacts, asc, checkRuns, eq } from '@jumper/db';
import type { ArtifactInfo, ArtifactKind, CheckName, CheckRunInfo } from '@jumper/shared';
import { contentTypeFor } from '@jumper/storage';
import { notFound } from '../../lib/errors';
import { loadRepo } from '../repos/access';
import { audit } from '../audit/audit';
import { enqueueAnalysis } from '../repos/push';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const shaQuery = z.object({ sha: z.string().max(255).optional() });

const checkRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get('/repos/:owner/:repo/checks', { schema: { params, querystring: shaQuery } }, async (req): Promise<{ sha: string; runs: CheckRunInfo[] }> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const sha = await r.git.resolveCommit(req.query.sha || r.repo.defaultBranch);
    if (!sha) throw notFound('Unknown revision');
    const rows = await ctx.db
      .select()
      .from(checkRuns)
      .where(and(eq(checkRuns.repoId, r.repo.id), eq(checkRuns.sha, sha)))
      .orderBy(asc(checkRuns.projectPath), asc(checkRuns.name));
    return {
      sha,
      runs: rows.map((c) => ({
        id: c.id,
        sha: c.sha,
        name: c.name as CheckName,
        projectPath: c.projectPath,
        status: c.status,
        conclusion: c.conclusion,
        summary: c.summary,
        details: c.details,
        startedAt: c.startedAt?.toISOString() ?? null,
        completedAt: c.completedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post('/repos/:owner/:repo/checks/rerun', { schema: { params, body: z.object({ sha: z.string().max(255) }) } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'write');
    const sha = await r.git.resolveCommit(req.body.sha);
    if (!sha) throw notFound('Unknown revision');
    await ctx.db.delete(checkRuns).where(and(eq(checkRuns.repoId, r.repo.id), eq(checkRuns.sha, sha)));
    await enqueueAnalysis(ctx, r.repo.id, sha, undefined, true);
    await audit(req, 'checks.rerun', { type: 'repo', id: r.repo.id }, { sha });
    return { ok: true };
  });

  app.get(
    '/repos/:owner/:repo/artifacts',
    { schema: { params, querystring: shaQuery.extend({ project: z.string().max(4096).optional() }) } },
    async (req): Promise<{ sha: string; artifacts: ArtifactInfo[] }> => {
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const sha = await r.git.resolveCommit(req.query.sha || r.repo.defaultBranch);
      if (!sha) throw notFound('Unknown revision');
      const conds = [eq(artifacts.repoId, r.repo.id), eq(artifacts.sha, sha)];
      if (req.query.project !== undefined) conds.push(eq(artifacts.projectPath, req.query.project));
      const rows = await ctx.db.select().from(artifacts).where(and(...conds)).orderBy(asc(artifacts.kind), asc(artifacts.name));
      return {
        sha,
        artifacts: rows.map((a) => ({
          id: a.id,
          sha: a.sha,
          projectPath: a.projectPath,
          kind: a.kind as ArtifactKind,
          name: a.name,
          contentType: a.contentType,
          size: a.size,
          meta: a.meta,
          url: `/api/repos/${r.ns.slug}/${r.repo.name}/artifacts/${a.id}`,
        })),
      };
    },
  );

  app.get(
    '/repos/:owner/:repo/artifacts/:id',
    { schema: { params: params.extend({ id: z.uuid() }), querystring: z.object({ download: z.stringbool().optional() }) } },
    async (req, reply) => {
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const a = (await ctx.db.select().from(artifacts).where(and(eq(artifacts.id, req.params.id), eq(artifacts.repoId, r.repo.id))).limit(1))[0];
      if (!a) throw notFound('Artifact not found');
      const obj = await ctx.storage.get(a.storageKey);
      if (!obj) throw notFound('Artifact data missing');
      const filename = a.name.split('/').pop()!;
      // Older rows were stored before some types were registered.
      const type = !a.contentType || a.contentType === 'application/octet-stream' ? contentTypeFor(a.name) : a.contentType;
      const isPdf = type === 'application/pdf';
      return reply
        .type(type)
        .header('Content-Length', obj.size)
        .header('X-Content-Type-Options', 'nosniff')
        // KiCad SVGs are rendered via <img>; this CSP neutralises any script if opened directly.
        // PDFs need the browser's built-in viewer, which refuses sandboxed documents; they can only be framed by this site.
        .header(
          'Content-Security-Policy',
          isPdf ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; sandbox",
        )
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(filename)}"`)
        .send(obj.body);
    },
  );
};

export default checkRoutes;
