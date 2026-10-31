import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq, namespaces, orgMembers, organizations, sql, users, type User } from '@pcbhub/db';
import { loginSchema, registerSchema, type CurrentUser } from '@pcbhub/shared';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../auth/passwords';
import { endSession, startSession } from '../auth/plugin';
import { randomToken, safeEqual } from '../lib/crypto';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors';
import { findNamespace } from '../services/access';
import { audit } from '../services/audit';
import type { Ctx } from '../context';

export async function currentUser(ctx: Ctx, user: User): Promise<CurrentUser> {
  const orgs = await ctx.db
    .select({ slug: namespaces.slug, name: organizations.name, role: orgMembers.role })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .innerJoin(namespaces, eq(namespaces.orgId, organizations.id))
    .where(eq(orgMembers.userId, user.id));
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    avatarUrl: user.avatarUrl,
    email: user.email,
    bio: user.bio,
    isAdmin: user.isAdmin,
    hasPassword: user.passwordHash !== null,
    githubLinked: user.githubId !== null,
    orgs,
  };
}

/** Create a user and their namespace in one transaction. */
export async function createUser(
  ctx: Ctx,
  data: { username: string; email: string; passwordHash: string | null; name?: string | null; avatarUrl?: string | null; githubId?: string | null },
): Promise<User> {
  if (await findNamespace(ctx, data.username)) throw conflict('That username is taken');
  const taken = await ctx.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${data.email})`).limit(1);
  if (taken[0]) throw conflict('An account with that email already exists');
  return ctx.db.transaction(async (tx) => {
    // The very first account becomes the instance administrator.
    const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(users)) as [{ n: number }];
    const [user] = await tx
      .insert(users)
      .values({ ...data, isAdmin: n === 0 })
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
    const user = await createUser(ctx, {
      username: req.body.username,
      email: req.body.email,
      passwordHash: await hashPassword(req.body.password),
    });
    await startSession(req, reply, user.id);
    await audit(req, 'user.register', { type: 'user', id: user.id });
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
    await startSession(req, reply, user.id);
    await audit(req, 'user.login', { type: 'user', id: user.id });
    return currentUser(ctx, user);
  });

  app.post('/logout', async (req, reply) => {
    await endSession(req, reply);
    return { ok: true };
  });

  app.get('/me', async (req) => (req.user ? currentUser(ctx, req.user) : null));

  app.get('/providers', async () => ({ github: Boolean(ctx.env.GITHUB_CLIENT_ID && ctx.env.GITHUB_CLIENT_SECRET), signup: ctx.env.ALLOW_SIGNUP }));

  // ---------- GitHub OAuth ----------
  const callbackUrl = () => `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/api/auth/github/callback`;

  app.get('/github', async (_req, reply) => {
    if (!ctx.env.GITHUB_CLIENT_ID) throw badRequest('GitHub sign-in is not configured');
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
      const gh = { Authorization: `Bearer ${tokenJson.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'PCBHub' };
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
        user = await createUser(ctx, { username, email, passwordHash: null, name: profile.name, avatarUrl: profile.avatar_url, githubId });
      }
      if (user.disabled) throw forbidden('Account disabled');
      await startSession(req, reply, user.id);
      await audit(req, 'user.login.github', { type: 'user', id: user.id });
      return reply.redirect(ctx.env.PUBLIC_URL);
    },
  );
};

export default authRoutes;
