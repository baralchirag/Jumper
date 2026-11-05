import fp from 'fastify-plugin';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, emailVerifications, eq, gt, isNull, users, type User } from '@jumper/db';
import type { Ctx } from '../../context';
import { randomToken, sha256 } from '../../lib/crypto';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { audit } from '../audit/audit';
import { sendMail } from '../mail/mailer';
import { requireUser } from './plugin';

const TTL_MS = 24 * 60 * 60 * 1000;

/** Create a verification token for `user`'s current address, replacing earlier unused ones. */
export async function createVerification(ctx: Ctx, user: Pick<User, 'id' | 'email'>): Promise<string> {
  const token = randomToken(32);
  await ctx.db.transaction(async (tx) => {
    await tx.delete(emailVerifications).where(and(eq(emailVerifications.userId, user.id), isNull(emailVerifications.usedAt)));
    await tx.insert(emailVerifications).values({ userId: user.id, email: user.email, tokenHash: sha256(token), expiresAt: new Date(Date.now() + TTL_MS) });
  });
  return token;
}

export const verifyUrl = (ctx: Ctx, token: string) => `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/verify/${token}`;

/** Email the verification link. Never throws: a mail outage must not break sign-up. */
export async function sendVerification(ctx: Ctx, user: Pick<User, 'id' | 'email' | 'username'>, log?: (m: string) => void): Promise<void> {
  try {
    const token = await createVerification(ctx, user);
    await sendMail(
      ctx.env,
      {
        to: user.email,
        subject: 'Confirm your email address for Jumper',
        text: `Hi ${user.username},\n\nConfirm this email address to finish setting up your Jumper account (link valid for 24 hours):\n${verifyUrl(ctx, token)}\n\nIf you did not create this account, ignore this email.\n`,
      },
      log,
    );
  } catch (e) {
    (log ?? ((m) => process.stderr.write(`${m}\n`)))(JSON.stringify({ level: 'error', msg: `verification email failed: ${(e as Error).message}`, time: new Date().toISOString() }));
  }
}

/** Whether this user may perform writes right now. Reads are always allowed. */
export function mustVerify(ctx: Ctx, user: User | null): boolean {
  return Boolean(user && ctx.env.emailVerificationRequired && !user.emailVerifiedAt);
}

export const UNVERIFIED_MESSAGE = 'Confirm your email address to do that. Check your inbox, or resend the link from the banner at the top of the page.';

const verifyRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.post('/verify/resend', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
    const user = requireUser(req);
    if (user.emailVerifiedAt) return { ok: true, alreadyVerified: true };
    await sendVerification(ctx, user);
    return { ok: true, alreadyVerified: false };
  });

  /** Used by the page to say which address is being confirmed; does not change anything. */
  app.get('/verify/:token', { schema: { params: z.object({ token: z.string().max(200) }) } }, async (req) => {
    const row = (await ctx.db.select().from(emailVerifications).where(and(eq(emailVerifications.tokenHash, sha256(req.params.token)), isNull(emailVerifications.usedAt), gt(emailVerifications.expiresAt, new Date()))).limit(1))[0];
    if (!row) throw notFound('This confirmation link is invalid or has expired');
    return { email: row.email };
  });

  app.post('/verify', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } }, schema: { body: z.object({ token: z.string().max(200) }) } }, async (req) => {
    const row = (await ctx.db.select().from(emailVerifications).where(and(eq(emailVerifications.tokenHash, sha256(req.body.token)), isNull(emailVerifications.usedAt), gt(emailVerifications.expiresAt, new Date()))).limit(1))[0];
    if (!row) throw badRequest('This confirmation link is invalid or has expired. Request a new one from the banner after you sign in.');
    const user = (await ctx.db.select().from(users).where(eq(users.id, row.userId)).limit(1))[0];
    // The address may have been changed since the link was sent: confirm only the address the link was for.
    if (!user || user.email.toLowerCase() !== row.email.toLowerCase()) throw badRequest('This link is for an address that is no longer on the account.');
    await ctx.db.transaction(async (tx) => {
      await tx.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
      await tx.update(emailVerifications).set({ usedAt: new Date() }).where(eq(emailVerifications.id, row.id));
    });
    await audit(req, 'user.email_verified', { type: 'user', id: user.id }, { email: row.email }, user.id);
    return { ok: true };
  });
};

export default verifyRoutes;

/** Global: blocks writes from unverified accounts (when enforcement is on). */
export const verifyGuard = fp(async (app) => {
  const ctx = app.ctx;
  // Auth, account and verification routes stay open so people can verify, fix a wrong address, export their data
  // or delete the account.
  app.addHook('onRequest', async (req) => {
    if (!mustVerify(ctx, req.user)) return;
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const path = req.url.split('?')[0]!;
    if (path.startsWith('/api/auth/') || path.startsWith('/api/user')) return;
    throw new HttpError(403, 'email_unverified', UNVERIFIED_MESSAGE);
  });
});
