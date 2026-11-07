import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, webhookDeliveries, webhooks } from '@jumper/db';
import { createWebhookSchema, type WebhookDeliveryInfo, type WebhookEvent, type WebhookInfo } from '@jumper/shared';
import { randomToken } from '../../lib/crypto';
import { badRequest, notFound } from '../../lib/errors';
import { loadRepo } from '../repos/access';
import { audit } from '../audit/audit';
import { assertWebhookUrl } from './ssrf';
import { deliver, dispatch } from './service';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const hookParams = params.extend({ id: z.uuid() });
const MAX_HOOKS = 20;

const webhookRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  ctx.listeners.push((e) => dispatch(ctx, e));

  const find = async (repoId: string, id: string) => {
    const h = (await ctx.db.select().from(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.repoId, repoId))).limit(1))[0];
    if (!h) throw notFound('Webhook not found');
    return h;
  };

  app.get('/repos/:owner/:repo/hooks', { schema: { params } }, async (req): Promise<WebhookInfo[]> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const rows = await ctx.db.select().from(webhooks).where(eq(webhooks.repoId, r.repo.id)).orderBy(webhooks.createdAt);
    const out: WebhookInfo[] = [];
    for (const h of rows) {
      const last = (await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, h.id)).orderBy(desc(webhookDeliveries.createdAt)).limit(1))[0];
      out.push({ id: h.id, url: h.url, events: h.events as WebhookEvent[], active: h.active, createdAt: h.createdAt.toISOString(), lastDelivery: last ? { status: last.status, error: last.error, at: last.createdAt.toISOString() } : null });
    }
    return out;
  });

  app.post('/repos/:owner/:repo/hooks', { schema: { params, body: createWebhookSchema } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    try {
      assertWebhookUrl(req.body.url, ctx.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const existing = await ctx.db.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.repoId, r.repo.id));
    if (existing.length >= MAX_HOOKS) throw badRequest(`A repository can have at most ${MAX_HOOKS} webhooks`);
    const secret = req.body.secret ?? randomToken(24);
    const [h] = await ctx.db.insert(webhooks).values({ repoId: r.repo.id, url: req.body.url, secret, events: req.body.events, active: req.body.active, createdBy: req.user!.id }).returning();
    await audit(req, 'webhook.create', { type: 'repo', id: r.repo.id }, { url: req.body.url });
    // The secret is shown exactly once.
    return { id: h!.id, secret };
  });

  app.patch(
    '/repos/:owner/:repo/hooks/:id',
    { schema: { params: hookParams, body: createWebhookSchema.pick({ url: true, events: true, active: true }).partial() } },
    async (req) => {
      const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
      const h = await find(r.repo.id, req.params.id);
      if (req.body.url) {
        try {
          assertWebhookUrl(req.body.url, ctx.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS);
        } catch (e) {
          throw badRequest((e as Error).message);
        }
      }
      await ctx.db.update(webhooks).set({ ...(req.body.url ? { url: req.body.url } : {}), ...(req.body.events ? { events: req.body.events } : {}), ...(req.body.active !== undefined ? { active: req.body.active } : {}) }).where(eq(webhooks.id, h.id));
      await audit(req, 'webhook.update', { type: 'repo', id: r.repo.id }, { id: h.id });
      return { ok: true };
    },
  );

  app.delete('/repos/:owner/:repo/hooks/:id', { schema: { params: hookParams } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const h = await find(r.repo.id, req.params.id);
    await ctx.db.delete(webhooks).where(eq(webhooks.id, h.id));
    await audit(req, 'webhook.delete', { type: 'repo', id: r.repo.id }, { id: h.id });
    return { ok: true };
  });

  app.get('/repos/:owner/:repo/hooks/:id/deliveries', { schema: { params: hookParams } }, async (req): Promise<WebhookDeliveryInfo[]> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const h = await find(r.repo.id, req.params.id);
    const rows = await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, h.id)).orderBy(desc(webhookDeliveries.createdAt)).limit(50);
    return rows.map((d) => ({ id: d.id, event: d.event, status: d.status, error: d.error, durationMs: d.durationMs, createdAt: d.createdAt.toISOString() }));
  });

  app.post('/repos/:owner/:repo/hooks/:id/ping', { schema: { params: hookParams } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const h = await find(r.repo.id, req.params.id);
    const res = await deliver(ctx, h, 'ping', { zen: 'Design is how it works.', repository: { fullName: `${r.ns.slug}/${r.repo.name}` } });
    return { status: res.status, error: res.error, durationMs: res.durationMs };
  });
};

export default webhookRoutes;
