import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, repoMirrors } from '@jumper/db';
import { createMirrorSchema, updateMirrorSchema, type MirrorInfo } from '@jumper/shared';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { encryptSecret } from '../../lib/secrets';
import { audit } from '../audit/audit';
import { resolveRemote } from '../import/service';
import { loadRepo } from '../repos/access';
import { runMirror, splitCredentials, toMirrorInfo } from './service';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const mirrorParams = params.extend({ id: z.uuid() });
const MAX_MIRRORS = 5;

const mirrorRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  const find = async (repoId: string, id: string) => {
    const m = (await ctx.db.select().from(repoMirrors).where(and(eq(repoMirrors.id, id), eq(repoMirrors.repoId, repoId))).limit(1))[0];
    if (!m) throw notFound('Mirror not found');
    return m;
  };

  app.get('/repos/:owner/:repo/mirrors', { schema: { params } }, async (req): Promise<MirrorInfo[]> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const rows = await ctx.db.select().from(repoMirrors).where(eq(repoMirrors.repoId, r.repo.id)).orderBy(repoMirrors.createdAt);
    return rows.map(toMirrorInfo);
  });

  app.post('/repos/:owner/:repo/mirrors', { schema: { params, body: createMirrorSchema }, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req): Promise<MirrorInfo> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const b = req.body;
    const split = splitCredentials(b.url);
    // Validated now so the owner sees a bad URL immediately; re-resolved on every sync against DNS rebinding.
    const target = await resolveRemote(split.url, ctx.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS);
    const existing = await ctx.db.select().from(repoMirrors).where(eq(repoMirrors.repoId, r.repo.id));
    if (existing.length >= MAX_MIRRORS) throw badRequest(`A repository can have at most ${MAX_MIRRORS} mirrors`);
    if (b.direction === 'pull' && existing.some((m) => m.direction === 'pull')) throw conflict('This repository already pulls from a mirror. Remove it first.');
    if (existing.some((m) => m.direction === b.direction && m.url === target.url.toString())) throw conflict('That mirror already exists');
    const token = b.token || split.token;
    const [m] = await ctx.db
      .insert(repoMirrors)
      .values({
        repoId: r.repo.id,
        direction: b.direction,
        url: target.url.toString(),
        username: b.username || split.username || null,
        secret: token ? encryptSecret(ctx.env, token) : null,
        overwrite: b.overwrite,
        intervalMinutes: Math.max(b.intervalMinutes, ctx.env.MIRROR_MIN_INTERVAL_MINUTES),
        createdBy: req.user!.id,
      })
      .returning();
    await audit(req, 'mirror.create', { type: 'repo', id: r.repo.id }, { direction: b.direction, url: m!.url });
    // First sync right away so problems (bad token, diverged history) show up while the owner is still looking.
    await runMirror(ctx, m!, req.log);
    return toMirrorInfo((await find(r.repo.id, m!.id)));
  });

  app.patch('/repos/:owner/:repo/mirrors/:id', { schema: { params: mirrorParams, body: updateMirrorSchema } }, async (req): Promise<MirrorInfo> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const m = await find(r.repo.id, req.params.id);
    const b = req.body;
    const set: Partial<typeof repoMirrors.$inferInsert> = {};
    if (b.enabled !== undefined) set.enabled = b.enabled;
    if (b.overwrite !== undefined) set.overwrite = b.overwrite;
    if (b.intervalMinutes !== undefined) set.intervalMinutes = Math.max(b.intervalMinutes, ctx.env.MIRROR_MIN_INTERVAL_MINUTES);
    if (b.username !== undefined) set.username = b.username || null;
    if (b.token !== undefined) set.secret = b.token ? encryptSecret(ctx.env, b.token) : null;
    if (Object.keys(set).length) await ctx.db.update(repoMirrors).set(set).where(eq(repoMirrors.id, m.id));
    await audit(req, 'mirror.update', { type: 'repo', id: r.repo.id }, { id: m.id, fields: Object.keys(set) });
    return toMirrorInfo(await find(r.repo.id, m.id));
  });

  app.delete('/repos/:owner/:repo/mirrors/:id', { schema: { params: mirrorParams } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const m = await find(r.repo.id, req.params.id);
    await ctx.db.delete(repoMirrors).where(eq(repoMirrors.id, m.id));
    await audit(req, 'mirror.delete', { type: 'repo', id: r.repo.id }, { direction: m.direction, url: m.url });
    return { ok: true };
  });

  app.post('/repos/:owner/:repo/mirrors/:id/sync', { schema: { params: mirrorParams }, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req): Promise<MirrorInfo> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const m = await find(r.repo.id, req.params.id);
    await runMirror(ctx, m, req.log);
    return toMirrorInfo(await find(r.repo.id, m.id));
  });
};

export default mirrorRoutes;
