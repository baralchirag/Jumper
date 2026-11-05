import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, auditLog, desc, eq, gt, personalAccessTokens, sessions, sql, users } from '@jumper/db';
import { changePasswordSchema, createTokenSchema, updateProfileSchema, type AuditEntry, type SessionInfo, type TokenInfo } from '@jumper/shared';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { requireUser, SESSION_COOKIE, TOKEN_PREFIX } from '../auth/plugin';
import { deleteUserAccount, deletionPreview } from './deletion';
import { randomToken, sha256 } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { audit } from '../audit/audit';
import { currentUser } from '../auth/routes';
import { sendVerification } from '../auth/verify';

const userRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  // Account management is never allowed through API tokens.
  app.addHook('onRequest', async (req) => {
    if (req.authMethod === 'token') throw forbidden('Use the web session to manage your account');
  });

  app.patch('/', { schema: { body: updateProfileSchema } }, async (req) => {
    const user = requireUser(req);
    const emailChanging = Boolean(req.body.email) && req.body.email!.toLowerCase() !== user.email.toLowerCase();
    if (emailChanging) {
      // The address controls password resets, so changing it needs proof it is really you, not just a session.
      if (user.passwordHash !== null && (!req.body.currentPassword || !(await verifyPassword(user.passwordHash, req.body.currentPassword)))) {
        throw forbidden('Enter your current password to change your email address');
      }
      const taken = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = lower(${req.body.email}) and ${users.id} <> ${user.id}`)
        .limit(1);
      if (taken[0]) throw conflict('Email already in use');
    }
    // Optional free-text profile fields: an empty string clears them.
    const patch: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined || k === 'currentPassword' || typeof v === 'boolean') continue;
      patch[k] = k === 'email' ? v : v.trim() === '' ? null : v.trim();
    }
    if (!emailChanging) delete patch.email;
    const [updated] = await ctx.db
      .update(users)
      .set({ ...patch, ...(req.body.notifyEmail === undefined ? {} : { notifyEmail: req.body.notifyEmail }), ...(req.body.digestEmail === undefined ? {} : { digestEmail: req.body.digestEmail }), ...(emailChanging ? { emailVerifiedAt: null } : {}), updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    if (emailChanging) {
      await sendVerification(ctx, updated!, (m) => req.log.warn(m));
      await audit(req, 'user.email_changed', { type: 'user', id: user.id }, { from: user.email, to: updated!.email });
    }
    return currentUser(ctx, updated!);
  });

  app.post('/password', { schema: { body: changePasswordSchema } }, async (req) => {
    const user = requireUser(req);
    if (user.passwordHash && !(await verifyPassword(user.passwordHash, req.body.currentPassword ?? ''))) {
      throw badRequest('Current password is incorrect');
    }
    await ctx.db.update(users).set({ passwordHash: await hashPassword(req.body.newPassword) }).where(eq(users.id, user.id));
    // Sign out every other session.
    const current = req.cookies.jumper_session ? sha256(req.cookies.jumper_session) : '';
    await ctx.db.delete(sessions).where(and(eq(sessions.userId, user.id), sql`${sessions.id} <> ${current}`));
    await audit(req, 'user.password_changed', { type: 'user', id: user.id });
    return { ok: true };
  });

  // ---------- sessions ----------

  app.get('/sessions', async (req): Promise<SessionInfo[]> => {
    const user = requireUser(req);
    const current = req.cookies.jumper_session ? sha256(req.cookies.jumper_session) : '';
    const rows = await ctx.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, user.id), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.createdAt));
    return rows.map((r) => ({
      // The row id is a hash of the cookie; expose only a short, non-reversible handle.
      id: r.id.slice(0, 16),
      userAgent: r.userAgent,
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      current: r.id === current,
    }));
  });

  app.delete('/sessions/:id', { schema: { params: z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }) } }, async (req) => {
    const user = requireUser(req);
    const res = await ctx.db
      .delete(sessions)
      .where(and(eq(sessions.userId, user.id), sql`left(${sessions.id}, 16) = ${req.params.id}`))
      .returning({ id: sessions.id });
    if (!res.length) throw notFound();
    await audit(req, 'session.revoke', { type: 'session', id: req.params.id });
    return { ok: true };
  });

  app.delete('/sessions', async (req) => {
    const user = requireUser(req);
    const current = req.cookies.jumper_session ? sha256(req.cookies.jumper_session) : '';
    const res = await ctx.db
      .delete(sessions)
      .where(and(eq(sessions.userId, user.id), sql`${sessions.id} <> ${current}`))
      .returning({ id: sessions.id });
    await audit(req, 'session.revoke_others', { type: 'user', id: user.id }, { count: res.length });
    return { ok: true, revoked: res.length };
  });

  // ---------- account deletion ----------

  app.get('/deletion-preview', async (req) => deletionPreview(ctx, requireUser(req)));

  app.delete(
    '/',
    {
      schema: { body: z.object({ confirm: z.string().min(1).max(100), password: z.string().max(256).optional() }) },
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    },
    async (req, reply) => {
      const user = requireUser(req);
      // A leaked token must not be able to destroy an account: this needs the signed-in browser session.
      if (req.authMethod === 'token') throw forbidden('Use the web session to delete your account');
      if (req.body.confirm !== user.username) throw badRequest('Type your username exactly to confirm');
      if (user.passwordHash !== null) {
        if (!req.body.password || !(await verifyPassword(user.passwordHash, req.body.password))) throw forbidden('Incorrect password');
      }
      const preview = await deletionPreview(ctx, user);
      if (preview.isLastAdmin) throw conflict('You are the only administrator. Grant admin to someone else first (pnpm admin:grant <username>).');
      if (preview.soleOwnerOrgs.length) {
        throw conflict(`You are the only owner of ${preview.soleOwnerOrgs.map((o) => o.slug).join(', ')}. Add another owner or delete the organization first.`, { orgs: preview.soleOwnerOrgs });
      }
      await audit(req, 'user.delete', { type: 'user', id: user.id }, { username: user.username, repos: preview.ownedRepos.length });
      const res = await deleteUserAccount(ctx, user);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true, repos: res.repos };
    },
  );

  // ---------- security log ----------

  app.get('/audit', { schema: { querystring: z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) } }, async (req): Promise<AuditEntry[]> => {
    const user = requireUser(req);
    const conds = [eq(auditLog.actorId, user.id)];
    if (req.query.before) conds.push(sql`${auditLog.createdAt} < ${new Date(req.query.before)}`);
    const rows = await ctx.db.select().from(auditLog).where(and(...conds)).orderBy(desc(auditLog.createdAt)).limit(req.query.limit);
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: r.metadata,
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
    }));
  });

  // ---------- data export ----------

  app.get('/export', async (req, reply) => {
    const user = requireUser(req);
    const [tokens, log] = await Promise.all([
      ctx.db.select().from(personalAccessTokens).where(eq(personalAccessTokens.userId, user.id)),
      ctx.db.select().from(auditLog).where(eq(auditLog.actorId, user.id)).orderBy(desc(auditLog.createdAt)).limit(1000),
    ]);
    const body = {
      exportedAt: new Date().toISOString(),
      profile: await currentUser(ctx, user),
      tokens: tokens.map((t) => ({ name: t.name, prefix: t.prefix, scopes: t.scopes, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt })),
      securityLog: log.map((r) => ({ action: r.action, targetType: r.targetType, targetId: r.targetId, metadata: r.metadata, ip: r.ip, createdAt: r.createdAt })),
    };
    await audit(req, 'user.export', { type: 'user', id: user.id });
    reply.header('content-disposition', `attachment; filename="jumper-${user.username}.json"`);
    return body;
  });

  app.get('/tokens', async (req): Promise<TokenInfo[]> => {
    const user = requireUser(req);
    const rows = await ctx.db
      .select()
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, user.id))
      .orderBy(desc(personalAccessTokens.createdAt));
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      scopes: t.scopes,
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      expiresAt: t.expiresAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    }));
  });

  app.post('/tokens', { schema: { body: createTokenSchema } }, async (req) => {
    const user = requireUser(req);
    const raw = TOKEN_PREFIX + randomToken(30);
    const expiresAt = req.body.expiresInDays ? new Date(Date.now() + req.body.expiresInDays * 86400_000) : null;
    const [row] = await ctx.db
      .insert(personalAccessTokens)
      .values({ userId: user.id, name: req.body.name, tokenHash: sha256(raw), prefix: raw.slice(0, 12), scopes: req.body.scopes, expiresAt })
      .returning();
    await audit(req, 'token.create', { type: 'token', id: row!.id }, { scopes: req.body.scopes });
    // The raw token is returned exactly once.
    return { id: row!.id, token: raw };
  });

  app.delete('/tokens/:id', { schema: { params: z.object({ id: z.uuid() }) } }, async (req) => {
    const user = requireUser(req);
    const res = await ctx.db
      .delete(personalAccessTokens)
      .where(and(eq(personalAccessTokens.id, req.params.id), eq(personalAccessTokens.userId, user.id)))
      .returning({ id: personalAccessTokens.id });
    if (!res.length) throw notFound();
    await audit(req, 'token.revoke', { type: 'token', id: req.params.id });
    return { ok: true };
  });
};

export default userRoutes;
