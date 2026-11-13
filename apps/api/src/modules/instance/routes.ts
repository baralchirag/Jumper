// Instance-level administration for self-hosted and enterprise installs: the licence, legal holds, retention,
// directory provisioning tokens, export clearance and the version check.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { desc, eq, isNull, legalHolds, namespaces, repositories, scimTokens, users } from '@jumper/db';
import { FEATURE_LABELS, legalHoldSchema, retentionSchema, type Entitlements, type LegalHoldInfo, type LicenseStatus, type RetentionSettings, type ScimTokenInfo, type VersionInfo } from '@jumper/shared';
import { randomToken, sha256 } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { usersById } from '../_shared/people';
import { adminOnly } from '../admin/routes';
import { audit } from '../audit/audit';
import { requireUser } from '../auth/plugin';
import { clearLicenseCache, entitlementsFor, evaluateLicense, installedKey, licenseStatus, requireFeature, saveLicense } from '../license/license';
import { findNamespace, findRepo } from '../repos/access';
import { toUserSummary } from '../repos/serialize';
import { retentionSettings, setSetting } from './settings';
import { VERSION, checkForUpdate, versionInfo } from './version';

export const SCIM_TOKEN_PREFIX = 'jscim_';

export const versionRoutes: FastifyPluginAsyncZod = async (app) => {
  /** Anyone may ask which version is running; the rest is for administrators (Admin, Version). */
  app.get('/version', async () => ({ version: VERSION }));
};

const instanceRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  app.addHook('onRequest', adminOnly);

  app.get('/entitlements', async (): Promise<Entitlements & { labels: typeof FEATURE_LABELS; plansEnforced: boolean }> => ({
    ...(await entitlementsFor(ctx, null)),
    labels: FEATURE_LABELS,
    plansEnforced: ctx.env.PLANS_ENFORCED,
  }));

  // ---------- licence ----------

  const licenseView = async (): Promise<LicenseStatus & { source: 'env' | 'file' | 'admin' | null; enforced: boolean; host: string }> => {
    const [{ source }, status] = await Promise.all([installedKey(ctx), licenseStatus(ctx, true)]);
    return { ...status, source, enforced: ctx.env.licenseEnforced, host: new URL(ctx.env.PUBLIC_URL).hostname };
  };

  app.get('/license', licenseView);

  app.put('/license', { schema: { body: z.object({ key: z.string().trim().min(10).max(8000) }) } }, async (req) => {
    const { source } = await installedKey(ctx);
    if (source === 'env' || source === 'file') throw conflict(`The licence is set by ${source === 'env' ? 'LICENSE_KEY' : 'LICENSE_FILE'} on the server and cannot be replaced here`);
    const testKey = ctx.env.NODE_ENV !== 'production' ? ctx.env.LICENSE_PUBLIC_KEY : undefined;
    // Check before saving, so a mistyped key never replaces a working one.
    const judged = evaluateLicense(req.body.key, new URL(ctx.env.PUBLIC_URL).hostname, 0, new Date(), testKey);
    if (judged.state === 'invalid' || judged.state === 'wrong_domain') throw badRequest(judged.message);
    await saveLicense(ctx, req.body.key);
    await audit(req, 'admin.license.install', undefined, { id: judged.license?.id, licensee: judged.license?.licensee, expires: judged.license?.expires });
    return licenseView();
  });

  app.delete('/license', async (req) => {
    const { source } = await installedKey(ctx);
    if (source === 'env' || source === 'file') throw conflict('The licence is set on the server and cannot be removed here');
    await saveLicense(ctx, null);
    clearLicenseCache();
    await audit(req, 'admin.license.remove');
    return licenseView();
  });

  // ---------- legal holds ----------

  const holdInfos = async (): Promise<LegalHoldInfo[]> => {
    const rows = await ctx.db
      .select({ h: legalHolds, ns: namespaces, repo: repositories })
      .from(legalHolds)
      .leftJoin(repositories, eq(repositories.id, legalHolds.repoId))
      .leftJoin(namespaces, eq(namespaces.id, legalHolds.namespaceId))
      .orderBy(desc(legalHolds.placedAt));
    const owners = new Map((await ctx.db.select().from(namespaces)).map((n) => [n.id, n.slug]));
    const people = await usersById(ctx, rows.flatMap((r) => [r.h.placedBy, r.h.releasedBy]));
    const who = (id: string | null) => (id && people.get(id) ? toUserSummary(people.get(id)!) : null);
    return rows.map(({ h, ns, repo }) => ({
      id: h.id,
      target: repo ? `${owners.get(repo.namespaceId) ?? '?'}/${repo.name}` : (ns?.slug ?? '?'),
      scope: repo ? 'repository' : 'owner',
      reason: h.reason,
      placedBy: who(h.placedBy),
      placedAt: h.placedAt.toISOString(),
      releasedBy: who(h.releasedBy),
      releasedAt: h.releasedAt?.toISOString() ?? null,
    }));
  };

  app.get('/legal-holds', holdInfos);

  app.post('/legal-holds', { schema: { body: legalHoldSchema } }, async (req) => {
    const user = requireUser(req);
    await requireFeature(ctx, null, 'legal_hold');
    const [owner, repo] = req.body.target.split('/');
    let values: { namespaceId?: string; repoId?: string };
    if (repo) {
      const found = await findRepo(ctx, owner!, repo);
      if (!found) throw notFound(`No repository called ${req.body.target}`);
      values = { repoId: found.repo.id };
    } else {
      const ns = await findNamespace(ctx, owner!);
      if (!ns) throw notFound(`No user or organization called ${owner}`);
      values = { namespaceId: ns.id };
    }
    await ctx.db.insert(legalHolds).values({ ...values, reason: req.body.reason, placedBy: user.id });
    await audit(req, 'admin.legal_hold.place', undefined, { target: req.body.target, reason: req.body.reason });
    return holdInfos();
  });

  // Releasing keeps the row: the history of holds is itself a record.
  app.post('/legal-holds/:id/release', { schema: { params: z.object({ id: z.uuid() }) } }, async (req) => {
    const user = requireUser(req);
    const res = await ctx.db.update(legalHolds).set({ releasedAt: new Date(), releasedBy: user.id }).where(eq(legalHolds.id, req.params.id)).returning();
    if (!res.length) throw notFound('Hold not found');
    await audit(req, 'admin.legal_hold.release', undefined, { id: req.params.id });
    return holdInfos();
  });

  // ---------- retention ----------

  app.get('/retention', async (): Promise<{ settings: RetentionSettings; editable: boolean; activeHolds: number }> => {
    const e = await entitlementsFor(ctx, null);
    const holds = await ctx.db.select({ id: legalHolds.id }).from(legalHolds).where(isNull(legalHolds.releasedAt));
    return { settings: await retentionSettings(ctx), editable: e.features.includes('retention'), activeHolds: holds.length };
  });

  app.put('/retention', { schema: { body: retentionSchema } }, async (req) => {
    await requireFeature(ctx, null, 'retention');
    await setSetting(ctx, 'retention', req.body);
    await audit(req, 'admin.retention.update', undefined, req.body);
    return { settings: req.body };
  });

  // ---------- SCIM tokens ----------

  const tokenInfos = async (): Promise<ScimTokenInfo[]> =>
    (await ctx.db.select().from(scimTokens).orderBy(desc(scimTokens.createdAt))).map((t) => ({ id: t.id, name: t.name, lastUsedAt: t.lastUsedAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString() }));

  app.get('/scim/tokens', async () => ({ baseUrl: `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/api/scim/v2`, tokens: await tokenInfos() }));

  app.post('/scim/tokens', { schema: { body: z.object({ name: z.string().trim().min(1).max(80) }) } }, async (req) => {
    const user = requireUser(req);
    await requireFeature(ctx, null, 'scim');
    const token = SCIM_TOKEN_PREFIX + randomToken(32);
    await ctx.db.insert(scimTokens).values({ name: req.body.name, tokenHash: sha256(token), createdBy: user.id });
    await audit(req, 'admin.scim_token.create', undefined, { name: req.body.name });
    // Shown once; only the hash is stored.
    return { token, tokens: await tokenInfos() };
  });

  app.delete('/scim/tokens/:id', { schema: { params: z.object({ id: z.uuid() }) } }, async (req) => {
    await ctx.db.delete(scimTokens).where(eq(scimTokens.id, req.params.id));
    await audit(req, 'admin.scim_token.delete', undefined, { id: req.params.id });
    return { tokens: await tokenInfos() };
  });

  // ---------- export clearance ----------

  app.put('/users/:id/export-clearance', { schema: { params: z.object({ id: z.uuid() }), body: z.object({ cleared: z.boolean() }) } }, async (req) => {
    if (req.body.cleared) await requireFeature(ctx, null, 'export_control');
    const [u] = await ctx.db.update(users).set({ exportCleared: req.body.cleared, updatedAt: new Date() }).where(eq(users.id, req.params.id)).returning();
    if (!u) throw notFound();
    await audit(req, req.body.cleared ? 'admin.export_clearance.grant' : 'admin.export_clearance.revoke', { type: 'user', id: u.id }, { username: u.username });
    return { ...toUserSummary(u), exportCleared: u.exportCleared };
  });

  // ---------- version ----------

  app.get('/version', async (): Promise<VersionInfo> => versionInfo(ctx));

  app.post('/version/check', async (): Promise<VersionInfo> => {
    await checkForUpdate(ctx);
    return versionInfo(ctx);
  });
};

export default instanceRoutes;
