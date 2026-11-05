import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq, namespaces, orgMembers, organizations, sql, users, type User } from '@jumper/db';
import { isPlanId, loginSchema, registerSchema, type CurrentUser } from '@jumper/shared';
import { burnPasswordCheck, hashPassword, verifyPassword } from './passwords';
import { endSession, startSession } from './plugin';
import { randomToken, safeEqual } from '../../lib/crypto';
import { HttpError, badRequest, conflict, forbidden, unauthorized } from '../../lib/errors';
import { assertLicenseSeat } from '../license/license';
import { checkSecondFactor } from './two-factor';
import { resolveReferrer } from '../referrals/service';
import { publicProviders } from '../sso/providers';
import { findNamespace } from '../repos/access';
import { audit } from '../audit/audit';
import { sendVerification } from './verify';
import type { Ctx } from '../../context';

export async function currentUser(ctx: Ctx, user: User): Promise<CurrentUser> {
  const orgs = await ctx.db
    .select({ slug: namespaces.slug, name: organizations.name, role: orgMembers.role })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .innerJoin(namespaces, eq(namespaces.orgId, organizations.id))
    .where(eq(orgMembers.userId, user.id));
  const own = (await ctx.db.select({ plan: namespaces.plan }).from(namespaces).where(eq(namespaces.userId, user.id)).limit(1))[0];
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    avatarUrl: user.avatarUrl,
    email: user.email,
    bio: user.bio,
    website: user.website,
    location: user.location,
    company: user.company,
    pronouns: user.pronouns,
    createdAt: user.createdAt.toISOString(),
    isAdmin: user.isAdmin,
    emailVerified: user.emailVerifiedAt !== null,
    notifyEmail: user.notifyEmail,
    hasPassword: user.passwordHash !== null,
    githubLinked: user.githubId !== null,
    digestEmail: user.digestEmail,
    twoFactor: user.totpEnabledAt !== null,
    exportCleared: user.exportCleared,
    orgs,
    plan: isPlanId(own?.plan) ? own.plan : 'free',
  };
}

/** Create a user and their namespace in one transaction. */
export async function createUser(
  ctx: Ctx,
  data: { username: string; email: string; passwordHash: string | null; name?: string | null; avatarUrl?: string | null; githubId?: string | null; emailVerified?: boolean; externalId?: string | null; scimManaged?: boolean; referredBy?: string | null },
): Promise<User> {
  await assertLicenseSeat(ctx);
  if (await findNamespace(ctx, data.username)) throw conflict('That username is taken');
  const taken = await ctx.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${data.email})`).limit(1);
  if (taken[0]) throw conflict('An account with that email already exists');
  return ctx.db.transaction(async (tx) => {
    // Never auto-promote: admin is granted only from the server shell (`pnpm admin:grant <username>`).
    const [user] = await tx
      .insert(users)
      .values({ username: data.username, email: data.email, passwordHash: data.passwordHash, name: data.name, avatarUrl: data.avatarUrl, githubId: data.githubId, externalId: data.externalId ?? null, scimManaged: data.scimManaged ?? false, referredBy: data.referredBy ?? null, isAdmin: false, emailVerifiedAt: data.emailVerified ? new Date() : null })
      .returning();
    await tx.insert(namespaces).values({ slug: data.username, kind: 'user', userId: user!.id });
    return user!;
  });
}

const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/register', { ...strict, schema: { body: registerSchema } }, async (req, reply) => {
    if (!ctx.env.ALLOW_SIGNUP) throw forbidden('Sign-up is disabled on this instance');
    const referrer = await resolveReferrer(ctx, req.body.ref);
    const user = await createUser(ctx, {
      username: req.body.username,
      email: req.body.email,
      passwordHash: await hashPassword(req.body.password),
      referredBy: referrer?.id ?? null,
    });
    await sendVerification(ctx, user, (m) => req.log.warn(m));
    await startSession(req, reply, user.id);
    await audit(req, 'user.register', { type: 'user', id: user.id }, {}, user.id);
    return currentUser(ctx, user);
  });

  app.post('/login', { ...strict, schema: { body: loginSchema } }, async (req, reply) => {
    const { login, password } = req.body;
    const rows = await ctx.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = lower(${login}) or lower(${users.email}) = lower(${login})`)
      .limit(1);
    const user = rows[0];
    if (!user) {
      await burnPasswordCheck(password);
      throw unauthorized('Incorrect username or password');
    }
    if (user.disabled || !(await verifyPassword(user.passwordHash, password))) {
      throw unauthorized('Incorrect username or password');
    }
    if (user.totpEnabledAt) {
      // The password was right; say that a code is needed so the form can ask for it. No session yet.
      if (!req.body.code) throw new HttpError(401, 'two_factor_required', 'Enter the code from your authenticator app');
      if (!(await checkSecondFactor(ctx, user, req.body.code))) {
        await audit(req, 'user.login.two_factor_failed', { type: 'user', id: user.id }, {}, user.id);
        throw new HttpError(401, 'two_factor_invalid', 'That code is not right. Codes change every 30 seconds; a recovery code works once.');
      }
    }
    await startSession(req, reply, user.id);
    await audit(req, 'user.login', { type: 'user', id: user.id }, {}, user.id);
    return currentUser(ctx, user);
  });

  app.post('/logout', async (req, reply) => {
    await endSession(req, reply);
    return { ok: true };
  });

  app.get('/me', async (req) => (req.user ? currentUser(ctx, req.user) : null));

  app.get('/providers', async () => ({
    github: Boolean(ctx.env.GITHUB_CLIENT_ID && ctx.env.GITHUB_CLIENT_SECRET) && !ctx.env.AIR_GAPPED,
    signup: ctx.env.ALLOW_SIGNUP,
    emailVerification: ctx.env.emailVerificationRequired,
    /** Single sign-on buttons for the whole instance; organization connections are found by email domain. */
    sso: await publicProviders(ctx),
  }));

  // ---------- GitHub OAuth ----------
  const callbackUrl = () => `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/api/auth/github/callback`;

  app.get('/github', async (_req, reply) => {
    if (!ctx.env.GITHUB_CLIENT_ID || ctx.env.AIR_GAPPED) throw badRequest('GitHub sign-in is not configured');
    const state = randomToken(24);
    reply.setCookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', secure: ctx.env.secureCookies, path: '/api/auth/github', maxAge: 600 });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', ctx.env.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', callbackUrl());
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    return reply.redirect(url.toString());
  });

  app.get(
    '/github/callback',
    { schema: { querystring: z.object({ code: z.string().max(200), state: z.string().max(200) }) } },
    async (req, reply) => {
      const expected = req.cookies.oauth_state;
      reply.clearCookie('oauth_state', { path: '/api/auth/github' });
      if (!expected || !safeEqual(expected, req.query.state)) throw badRequest('Invalid OAuth state');

      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: ctx.env.GITHUB_CLIENT_ID,
          client_secret: ctx.env.GITHUB_CLIENT_SECRET,
          code: req.query.code,
          redirect_uri: callbackUrl(),
        }),
      });
      const tokenJson = (await tokenRes.json()) as { access_token?: string };
      if (!tokenJson.access_token) throw unauthorized('GitHub authorization failed');
      const gh = { Authorization: `Bearer ${tokenJson.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Jumper' };
      const profile = (await (await fetch('https://api.github.com/user', { headers: gh })).json()) as {
        id: number;
        login: string;
        name: string | null;
        avatar_url: string | null;
      };
      const emails = (await (await fetch('https://api.github.com/user/emails', { headers: gh })).json()) as {
        email: string;
        primary: boolean;
        verified: boolean;
      }[];
      const githubId = String(profile.id);

      let user = (await ctx.db.select().from(users).where(eq(users.githubId, githubId)).limit(1))[0];
      if (!user && req.user) {
        // Link to the signed-in account.
        [user] = await ctx.db.update(users).set({ githubId }).where(eq(users.id, req.user.id)).returning();
      }
      if (!user) {
        const email = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified)?.email : undefined;
        if (!email) throw badRequest('Your GitHub account has no verified primary email');
        // Never auto-link to an existing account by email (takeover risk).
        let username = profile.login.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 39);
        for (let i = 2; await findNamespace(ctx, username); i++) username = `${profile.login.slice(0, 35)}-${i}`;
        user = await createUser(ctx, { username, email, passwordHash: null, name: profile.name, avatarUrl: profile.avatar_url, githubId, emailVerified: true });
      }
      if (user.disabled) throw forbidden('Account disabled');
      await startSession(req, reply, user.id);
      await audit(req, 'user.login.github', { type: 'user', id: user.id }, {}, user.id);
      return reply.redirect(ctx.env.PUBLIC_URL);
    },
  );
};

export default authRoutes;
