import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, artifacts, asc, desc, eq, namespaces, repositories, shareLinks, sql, users } from '@jumper/db';
import { createShareLinkSchema, type ShareLinkInfo } from '@jumper/shared';
import { requireUser } from '../auth/plugin';
import { randomToken, sha256 } from '../../lib/crypto';
import { badRequest, notFound } from '../../lib/errors';
import { isValidRev } from '../git/repo';
import { gitFor, loadRepo } from '../repos/access';
import { audit } from '../audit/audit';
import { toUserSummary } from '../repos/serialize';
import { effectivePolicy } from '../policy/service';
import { SHARE_PREFIX, cleanPath, contentTypeFor, inScope, linkState, listingAllowed, resolveLink } from './service';

/** Sandbox everything; PDFs need the browser's viewer, which refuses sandboxed documents, so they may only be framed by this site. */
const cspFor = (type: string) =>
  type === 'application/pdf' ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self'; frame-ancestors 'self'; sandbox";

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const MAX_LINKS_PER_REPO = 100;

const shareRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  // ---------- management (repository admins) ----------

  app.get('/repos/:owner/:repo/share-links', { schema: { params } }, async (req): Promise<ShareLinkInfo[]> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const rows = await ctx.db
      .select({ l: shareLinks, u: users })
      .from(shareLinks)
      .innerJoin(users, eq(users.id, shareLinks.createdBy))
      .where(eq(shareLinks.repoId, r.repo.id))
      .orderBy(desc(shareLinks.createdAt));
    return rows.map(({ l, u }) => ({
      id: l.id,
      label: l.label,
      ref: l.ref,
      path: l.path,
      canDownload: l.canDownload,
      watermark: l.watermark,
      expiresAt: l.expiresAt?.toISOString() ?? null,
      revokedAt: l.revokedAt?.toISOString() ?? null,
      viewCount: l.viewCount,
      lastViewedAt: l.lastViewedAt?.toISOString() ?? null,
      createdAt: l.createdAt.toISOString(),
      createdBy: toUserSummary(u),
      active: linkState(l) === 'active',
    }));
  });

  app.post('/repos/:owner/:repo/share-links', { schema: { params, body: createShareLinkSchema } }, async (req) => {
    const user = requireUser(req);
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const b = req.body;
    if (!isValidRev(b.ref) || !(await r.git.resolveCommit(b.ref))) throw badRequest('Unknown revision');
    const path = cleanPath(b.path ?? '');
    if (path === null) throw badRequest('Invalid path');
    if (path && !(await r.git.entryType((await r.git.resolveCommit(b.ref))!, path))) throw badRequest('Path does not exist at that revision');
    const [{ n }] = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(shareLinks).where(eq(shareLinks.repoId, r.repo.id))) as [{ n: number }];
    if (n >= MAX_LINKS_PER_REPO) throw badRequest('Too many share links; revoke or delete some first');
    const policy = await effectivePolicy(ctx, r.ns);
    // When the owner requires watermarks, a link created without one gets the owner's default text.
    const watermark = b.watermark || (policy.requireWatermark ? policy.defaultWatermark : '') || null;
    const token = SHARE_PREFIX + randomToken(32);
    const [row] = await ctx.db
      .insert(shareLinks)
      .values({
        repoId: r.repo.id,
        createdBy: user.id,
        tokenHash: sha256(token),
        label: b.label,
        ref: b.ref,
        path: path || null,
        canDownload: b.canDownload,
        watermark,
        expiresAt: b.expiresInHours ? new Date(Date.now() + b.expiresInHours * 3600_000) : null,
      })
      .returning();
    await audit(req, 'share.create', { type: 'repo', id: r.repo.id }, { id: row!.id, ref: b.ref, path, download: b.canDownload });
    // The token is shown once; only its hash is stored.
    return { id: row!.id, token, url: `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/share/${token}` };
  });

  app.delete('/repos/:owner/:repo/share-links/:id', { schema: { params: params.extend({ id: z.uuid() }) } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const res = await ctx.db
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(shareLinks.id, req.params.id), eq(shareLinks.repoId, r.repo.id)))
      .returning({ id: shareLinks.id });
    if (!res.length) throw notFound('Share link not found');
    await audit(req, 'share.revoke', { type: 'repo', id: r.repo.id }, { id: req.params.id });
    return { ok: true };
  });

  // ---------- public viewing (token only) ----------

  await app.register(async (instance) => {
    const pub = instance.withTypeProvider<ZodTypeProvider>();
    pub.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Robots-Tag', 'noindex, nofollow');
    });
    const tokenParams = z.object({ token: z.string().max(200) });
    const rl = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

    async function open(token: string) {
      const link = await resolveLink(ctx, token);
      if (!link) throw notFound('This link is invalid, expired or has been revoked');
      const row = (
        await ctx.db
          .select({ repo: repositories, ns: namespaces })
          .from(repositories)
          .innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId))
          .where(eq(repositories.id, link.repoId))
          .limit(1)
      )[0];
      if (!row) throw notFound('This link is invalid, expired or has been revoked');
      const git = gitFor(ctx, row.repo.id);
      const sha = await git.resolveCommit(link.ref);
      if (!sha) throw notFound('The shared revision no longer exists');
      return { link, repo: row.repo, ns: row.ns, git, sha };
    }

    pub.get('/share/:token', { ...rl, schema: { params: tokenParams } }, async (req) => {
      const s = await open(req.params.token);
      await ctx.db.update(shareLinks).set({ viewCount: sql`${shareLinks.viewCount} + 1`, lastViewedAt: new Date() }).where(eq(shareLinks.id, s.link.id));
      return {
        repository: `${s.ns.slug}/${s.repo.name}`,
        label: s.link.label,
        ref: s.link.ref,
        sha: s.sha,
        path: s.link.path,
        watermark: s.link.watermark,
        canDownload: s.link.canDownload,
        expiresAt: s.link.expiresAt?.toISOString() ?? null,
      };
    });

    pub.get('/share/:token/tree', { ...rl, schema: { params: tokenParams, querystring: z.object({ path: z.string().max(4096).optional() }) } }, async (req) => {
      const s = await open(req.params.token);
      const path = cleanPath(req.query.path);
      if (path === null || !listingAllowed(s.link.path, path)) throw notFound('Not found');
      const entries = (await s.git.tree(s.sha, path)).filter((e) => {
        const full = path ? `${path}/${e.name}` : e.name;
        return !s.link.path || inScope(s.link.path, full) || s.link.path.startsWith(`${full}/`);
      });
      return { path, entries };
    });

    pub.get('/share/:token/file', { ...rl, schema: { params: tokenParams, querystring: z.object({ path: z.string().min(1).max(4096), download: z.stringbool().optional() }) } }, async (req, reply) => {
      const s = await open(req.params.token);
      const path = cleanPath(req.query.path);
      if (!path || !inScope(s.link.path, path)) throw notFound('Not found');
      const { type, inline } = contentTypeFor(path);
      const wantsDownload = req.query.download ?? !inline;
      if (wantsDownload && !s.link.canDownload) throw notFound('Downloads are disabled for this link');
      const buf = await s.git.readFile(s.sha, path, ctx.env.MAX_VIEW_BYTES);
      if (!buf) throw notFound('Not found');
      return reply
        .type(type)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', cspFor(type))
        .header('Content-Disposition', `${wantsDownload ? 'attachment' : 'inline'}; filename="${encodeURIComponent(path.split('/').pop()!)}"`)
        .send(buf);
    });

    pub.get('/share/:token/artifacts', { ...rl, schema: { params: tokenParams } }, async (req) => {
      const s = await open(req.params.token);
      const rows = await ctx.db.select().from(artifacts).where(and(eq(artifacts.repoId, s.repo.id), eq(artifacts.sha, s.sha))).orderBy(asc(artifacts.kind), asc(artifacts.name));
      const scope = s.link.path;
      const allowed = rows.filter((a) => !scope || inScope(scope, a.projectPath) || scope === a.projectPath);
      return allowed.map((a) => ({ id: a.id, kind: a.kind, name: a.name, projectPath: a.projectPath, contentType: a.contentType, size: a.size }));
    });

    pub.get('/share/:token/artifacts/:id', { ...rl, schema: { params: tokenParams.extend({ id: z.uuid() }), querystring: z.object({ download: z.stringbool().optional() }) } }, async (req, reply) => {
      const s = await open(req.params.token);
      const a = (await ctx.db.select().from(artifacts).where(and(eq(artifacts.id, req.params.id), eq(artifacts.repoId, s.repo.id), eq(artifacts.sha, s.sha))).limit(1))[0];
      if (!a || (s.link.path && !(inScope(s.link.path, a.projectPath) || s.link.path === a.projectPath))) throw notFound('Not found');
      const { type, inline } = contentTypeFor(a.name);
      const wantsDownload = req.query.download ?? !inline;
      if (wantsDownload && !s.link.canDownload) throw notFound('Downloads are disabled for this link');
      const obj = await ctx.storage.get(a.storageKey);
      if (!obj) throw notFound('Not found');
      return reply
        .type(type)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', cspFor(type))
        .header('Content-Disposition', `${wantsDownload ? 'attachment' : 'inline'}; filename="${encodeURIComponent(a.name.split('/').pop()!)}"`)
        .send(obj.body);
    });
  });
};

export default shareRoutes;
