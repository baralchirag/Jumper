import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, personalAccessTokens, sessions, sql, users } from '@pcbhub/db';
import { changePasswordSchema, createTokenSchema, updateProfileSchema, type TokenInfo } from '@pcbhub/shared';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { requireUser, TOKEN_PREFIX } from '../auth/plugin';
import { randomToken, sha256 } from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { currentUser } from './auth';

const userRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  // Account management is never allowed through API tokens.
  app.addHook('onRequest', async (req) => {
    if (req.authMethod === 'token') throw forbidden('Use the web session to manage your account');
  });

  app.patch('/', { schema: { body: updateProfileSchema } }, async (req) => {
    const user = requireUser(req);
    if (req.body.email) {
      const taken = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = lower(${req.body.email}) and ${users.id} <> ${user.id}`)
        .limit(1);
      if (taken[0]) throw conflict('Email already in use');
    }
    const [updated] = await ctx.db
      .update(users)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    return currentUser(ctx, updated!);
  });

  app.post('/password', { schema: { body: changePasswordSchema } }, async (req) => {
    const user = requireUser(req);
    if (user.passwordHash && !(await verifyPassword(user.passwordHash, req.body.currentPassword ?? ''))) {
      throw badRequest('Current password is incorrect');
    }
    await ctx.db.update(users).set({ passwordHash: await hashPassword(req.body.newPassword) }).where(eq(users.id, user.id));
    // Sign out every other session.
    const current = req.cookies.pcbhub_session ? sha256(req.cookies.pcbhub_session) : '';
    await ctx.db.delete(sessions).where(and(eq(sessions.userId, user.id), sql`${sessions.id} <> ${current}`));
    await audit(req, 'user.password_changed', { type: 'user', id: user.id });
    return { ok: true };
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
