import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, gt, isNull, passwordResets, sessions, sql, users, type User } from '@jumper/db';
import { randomToken, sha256 } from '../../lib/crypto';
import { badRequest, notFound } from '../../lib/errors';
import { audit } from '../audit/audit';
import { sendMail } from '../mail/mailer';
import type { Ctx } from '../../context';
import { hashPassword } from './passwords';

const RESET_TTL_MS = 60 * 60 * 1000;
const passwordSchema = z.string().min(10, 'Use at least 10 characters').max(256);

/** Create a single-use reset token for `user`, invalidating earlier ones. Returns the raw token (only ever sent to the user). */
export async function createResetToken(ctx: Ctx, user: User): Promise<string> {
  const token = randomToken(32);
  await ctx.db.transaction(async (tx) => {
    await tx.delete(passwordResets).where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));
    await tx.insert(passwordResets).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
  });
  return token;
}

export const resetUrl = (ctx: Ctx, token: string) => `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/reset/${token}`;

const resetRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  const strict = { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } };

  /** Always answers the same way, so it cannot be used to discover which emails or usernames have accounts. */
  app.post('/forgot', { ...strict, schema: { body: z.object({ login: z.string().min(1).max(254) }) } }, async (req) => {
    const login = req.body.login.trim();
    const user = (await ctx.db.select().from(users).where(sql`lower(${users.email}) = lower(${login}) or lower(${users.username}) = lower(${login})`).limit(1))[0];
    if (user && !user.disabled) {
      const token = await createResetToken(ctx, user);
      await sendMail(ctx.env, {
        to: user.email,
        subject: 'Reset your Jumper password',
        text: `Someone asked to reset the password for ${user.username}.\n\nChoose a new password here (valid for 1 hour, works once):\n${resetUrl(ctx, token)}\n\nIf this was not you, ignore this email: your password stays the same.\n`,
      }).catch((e) => req.log.error(e, 'password reset email failed'));
      await audit(req, 'user.password_reset_requested', { type: 'user', id: user.id }, {}, user.id);
    }
    return { ok: true };
  });

  async function findValid(token: string) {
    const row = (
      await ctx.db
        .select({ reset: passwordResets, user: users })
        .from(passwordResets)
        .innerJoin(users, eq(users.id, passwordResets.userId))
        .where(and(eq(passwordResets.tokenHash, sha256(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())))
        .limit(1)
    )[0];
    return row && !row.user.disabled ? row : null;
  }

  app.get('/reset/:token', { schema: { params: z.object({ token: z.string().max(200) }) } }, async (req) => {
    const row = await findValid(req.params.token);
    if (!row) throw notFound('This reset link is invalid or has expired');
    return { username: row.user.username };
  });

  app.post('/reset', { ...strict, schema: { body: z.object({ token: z.string().max(200), password: passwordSchema }) } }, async (req) => {
    const row = await findValid(req.body.token);
    if (!row) throw badRequest('This reset link is invalid or has expired. Request a new one.');
    const hash = await hashPassword(req.body.password);
    await ctx.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: hash, updatedAt: new Date() }).where(eq(users.id, row.user.id));
      await tx.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, row.reset.id));
      // Whoever had the old password (or a stolen session) is signed out everywhere.
      await tx.delete(sessions).where(eq(sessions.userId, row.user.id));
    });
    await audit(req, 'user.password_reset', { type: 'user', id: row.user.id }, {}, row.user.id);
    return { ok: true };
  });
};

export default resetRoutes;
