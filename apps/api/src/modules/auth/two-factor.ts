// Two-factor login: enrol an authenticator app, confirm it with a code, keep recovery codes.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, namespaces, orgMembers, orgPolicies, sql, users, type User } from '@jumper/db';
import { totpCodeSchema, type TwoFactorSetup, type TwoFactorStatus } from '@jumper/shared';
import type { Ctx } from '../../context';
import { badRequest, conflict, forbidden } from '../../lib/errors';
import { decryptSecret, encryptSecret } from '../../lib/secrets';
import { audit } from '../audit/audit';
import { verifyPassword } from './passwords';
import { requireUser } from './plugin';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from './totp';

/** Check an authenticator code, or spend a recovery code. */
export async function checkSecondFactor(ctx: Ctx, user: User, code: string): Promise<boolean> {
  const secret = user.totpSecret ? decryptSecret(ctx.env, user.totpSecret) : null;
  if (secret && /^\d{6}$/.test(code.replace(/\s+/g, '')) && verifyTotp(secret, code)) return true;
  const hash = hashRecoveryCode(code);
  if (!user.recoveryCodes.includes(hash)) return false;
  // Remove it in one statement so the same code cannot be spent twice by parallel requests.
  const spent = await ctx.db
    .update(users)
    .set({ recoveryCodes: sql`array_remove(${users.recoveryCodes}, ${hash})` })
    .where(and(eq(users.id, user.id), sql`${hash} = any(${users.recoveryCodes})`))
    .returning({ id: users.id });
  return spent.length === 1;
}

/** Organizations the user belongs to that require two-factor login. */
async function requiredBy(ctx: Ctx, userId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ slug: namespaces.slug })
    .from(orgMembers)
    .innerJoin(namespaces, eq(namespaces.orgId, orgMembers.orgId))
    .innerJoin(orgPolicies, eq(orgPolicies.namespaceId, namespaces.id))
    .where(and(eq(orgMembers.userId, userId), sql`(${orgPolicies.policy} ->> 'requireTwoFactor')::boolean is true`));
  return rows.map((r) => r.slug);
}

const twoFactorRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.addHook('onRequest', async (req) => {
    if (req.authMethod === 'token') throw forbidden('Use the web session to manage two-factor login');
  });

  app.get('/', async (req): Promise<TwoFactorStatus> => {
    const user = requireUser(req);
    return { enabled: user.totpEnabledAt !== null, enabledAt: user.totpEnabledAt?.toISOString() ?? null, recoveryCodesLeft: user.recoveryCodes.length, requiredBy: await requiredBy(ctx, user.id) };
  });

  // Step 1: a new secret. Nothing changes for sign-in until it is confirmed with a code.
  app.post('/setup', async (req): Promise<TwoFactorSetup> => {
    const user = requireUser(req);
    if (user.totpEnabledAt) throw conflict('Two-factor login is already on. Turn it off first to enrol a new device.');
    const secret = newTotpSecret();
    await ctx.db.update(users).set({ totpSecret: encryptSecret(ctx.env, secret) }).where(eq(users.id, user.id));
    return { secret, uri: otpauthUri(secret, user.email, new URL(ctx.env.PUBLIC_URL).hostname === 'localhost' ? 'Jumper (local)' : `Jumper (${new URL(ctx.env.PUBLIC_URL).hostname})`) };
  });

  // Step 2: prove the app works, and receive the recovery codes (shown once).
  app.post('/enable', { schema: { body: totpCodeSchema } }, async (req) => {
    const user = requireUser(req);
    if (user.totpEnabledAt) throw conflict('Two-factor login is already on');
    const secret = user.totpSecret ? decryptSecret(ctx.env, user.totpSecret) : null;
    if (!secret) throw badRequest('Start setup first');
    if (!verifyTotp(secret, req.body.code)) throw badRequest('That code is not right. Check the time on your phone and try the next code.');
    const { codes, hashes } = newRecoveryCodes();
    await ctx.db.update(users).set({ totpEnabledAt: new Date(), recoveryCodes: hashes }).where(eq(users.id, user.id));
    await audit(req, 'user.two_factor.enabled', { type: 'user', id: user.id });
    return { recoveryCodes: codes };
  });

  app.post('/recovery-codes', { schema: { body: totpCodeSchema } }, async (req) => {
    const user = requireUser(req);
    if (!user.totpEnabledAt) throw badRequest('Two-factor login is off');
    if (!(await checkSecondFactor(ctx, user, req.body.code))) throw badRequest('That code is not right');
    const { codes, hashes } = newRecoveryCodes();
    await ctx.db.update(users).set({ recoveryCodes: hashes }).where(eq(users.id, user.id));
    await audit(req, 'user.two_factor.recovery_codes', { type: 'user', id: user.id });
    return { recoveryCodes: codes };
  });

  // Turning it off needs a current code (or a recovery code), or the password for accounts that have one.
  app.post('/disable', { schema: { body: z.object({ code: z.string().trim().max(20).optional(), password: z.string().max(256).optional() }) } }, async (req) => {
    const user = requireUser(req);
    if (!user.totpEnabledAt) return { ok: true };
    const byCode = req.body.code ? await checkSecondFactor(ctx, user, req.body.code) : false;
    const byPassword = !byCode && req.body.password && user.passwordHash ? await verifyPassword(user.passwordHash, req.body.password) : false;
    if (!byCode && !byPassword) throw badRequest('Enter a current code, a recovery code or your password');
    await ctx.db.update(users).set({ totpEnabledAt: null, totpSecret: null, recoveryCodes: [] }).where(eq(users.id, user.id));
    await audit(req, 'user.two_factor.disabled', { type: 'user', id: user.id });
    return { ok: true, requiredBy: await requiredBy(ctx, user.id) };
  });
};

export default twoFactorRoutes;
