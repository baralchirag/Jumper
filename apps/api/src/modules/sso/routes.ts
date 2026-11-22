// Single sign-on: the sign-in flow for OpenID Connect and SAML, and managing connections (per organization, or for
// the whole instance by an administrator).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull, namespaces, orgMembers, sql, ssoConnections, ssoIdentities, users, type Namespace, type SsoConfig, type SsoConnection, type User } from '@jumper/db';
import { ssoConnectionSchema, type SsoConnectionInfo, type SsoProvider } from '@jumper/shared';
import type { Ctx } from '../../context';
import { randomToken } from '../../lib/crypto';
import { HttpError, badRequest, forbidden, notFound } from '../../lib/errors';
import { encryptSecret, signToken, verifyToken } from '../../lib/secrets';
import { audit } from '../audit/audit';
import { requireScope, requireUser, startSession } from '../auth/plugin';
import { createUser } from '../auth/routes';
import { requireFeature } from '../license/license';
import { findNamespace, orgRoleFor } from '../repos/access';
import { assertOrgSeat } from '../usage/service';
import { authorizeUrl, exchangeCode, pkcePair, type OidcConfig } from './oidc';
import { builtinConfig, callbackUrl, connectionForEmail, isBuiltin, oidcConfig, toConnectionInfo } from './providers';
import { normalizeCertificate, samlIdentity, samlMetadata, samlRedirectUrl } from './saml';
import { seatsChanged } from '../stripe/service';

const STATE_COOKIE = 'sso_state';
const STATE_TTL_MS = 10 * 60_000;

interface FlowState {
  c: string;
  s: string;
  n: string;
  v: string;
  exp: number;
  /** Where to land afterwards (a path on this site). */
  r: string;
}

const safeReturn = (to: string | undefined): string => (to && /^\/(?!\/)[\w\-./?=&%#~+]*$/.test(to) ? to : '/');

export interface Identity {
  /** Key in sso_identities: a connection id, or `google` / `microsoft`. */
  connection: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatarUrl?: string | null;
  username?: string | null;
}

async function freeUsername(ctx: Ctx, wanted: string): Promise<string> {
  const base = (wanted.replace(/[^a-zA-Z0-9-]/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-') || 'user').slice(0, 35);
  let name = base.length < 2 ? `${base}-user` : base;
  for (let i = 2; await findNamespace(ctx, name); i++) name = `${base}-${i}`;
  return name;
}

/**
 * Find or create the account for a directory identity.
 *
 * An identity seen before maps to its account. A new one is linked to an existing account with the same email only
 * when that is safe: the connection belongs to the whole instance (set up by an administrator), or the account is
 * already a member of the connection's organization, or it was provisioned by SCIM. Public providers (Google,
 * Microsoft) never link by email: anyone can register any address there.
 */
export async function resolveIdentity(ctx: Ctx, id: Identity, conn: SsoConnection | null, signedIn: User | null): Promise<User> {
  const linked = (
    await ctx.db
      .select({ user: users })
      .from(ssoIdentities)
      .innerJoin(users, eq(users.id, ssoIdentities.userId))
      .where(and(eq(ssoIdentities.connection, id.connection), eq(ssoIdentities.subject, id.subject)))
      .limit(1)
  )[0]?.user;
  const link = async (user: User) => {
    await ctx.db
      .insert(ssoIdentities)
      .values({ connection: id.connection, subject: id.subject, userId: user.id, email: id.email, lastLoginAt: new Date() })
      .onConflictDoUpdate({ target: [ssoIdentities.connection, ssoIdentities.subject], set: { lastLoginAt: new Date(), email: id.email } });
    return user;
  };
  if (linked) return link(linked);
  if (signedIn) return link(signedIn);
  if (!id.email) throw new HttpError(401, 'sso_failed', 'Your identity provider did not share an email address, which Jumper needs to find your account');

  const existing = (await ctx.db.select().from(users).where(sql`lower(${users.email}) = lower(${id.email})`).limit(1))[0];
  if (existing) {
    let trusted = existing.scimManaged && conn !== null;
    if (conn && !conn.namespaceId) trusted = true;
    if (conn?.namespaceId && !trusted) {
      const ns = (await ctx.db.select().from(namespaces).where(eq(namespaces.id, conn.namespaceId)).limit(1))[0];
      trusted = Boolean(ns?.orgId && (await orgRoleFor(ctx, ns.orgId, existing.id)));
    }
    if (!trusted) {
      throw new HttpError(409, 'sso_account_exists', `An account for ${id.email} already exists. Sign in to it with your password, then connect single sign-on from Settings.`);
    }
    return link(existing);
  }

  if (conn ? !conn.autoProvision : !ctx.env.ALLOW_SIGNUP) {
    throw new HttpError(403, 'sso_no_account', 'You do not have an account here yet. Ask an administrator to add you.');
  }
  const ns: Namespace | undefined = conn?.namespaceId ? (await ctx.db.select().from(namespaces).where(eq(namespaces.id, conn.namespaceId)).limit(1))[0] : undefined;
  const user = await createUser(ctx, {
    username: await freeUsername(ctx, id.username ?? id.email.split('@')[0]!),
    email: id.email,
    passwordHash: null,
    name: id.name,
    avatarUrl: id.avatarUrl ?? null,
    emailVerified: conn !== null || id.emailVerified,
  });
  // Someone who arrives through an organization's own directory is a member of that organization.
  if (ns?.orgId) {
    await assertOrgSeat(ctx, ns, user.id);
    await ctx.db.insert(orgMembers).values({ orgId: ns.orgId, userId: user.id, role: 'member' }).onConflictDoNothing();
    seatsChanged(ctx, { orgId: ns.orgId });
  }
  return link(user);
}

async function finish(req: FastifyRequest, reply: FastifyReply, ctx: Ctx, id: Identity, conn: SsoConnection | null, returnTo: string) {
  const user = await resolveIdentity(ctx, id, conn, req.user);
  if (user.disabled) throw forbidden('Account disabled');
  await startSession(req, reply, user.id, { ssoConnectionId: conn?.id ?? null });
  await audit(req, 'user.login.sso', { type: 'user', id: user.id }, { connection: conn?.name ?? id.connection, kind: conn?.kind ?? 'oidc' }, user.id);
  return reply.redirect(`${ctx.env.PUBLIC_URL.replace(/\/$/, '')}${returnTo}`);
}

const ssoRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  // SAML responses arrive as an HTML form post.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const loadConnection = async (id: string): Promise<SsoConnection> => {
    const row = /^[0-9a-f-]{36}$/.test(id) ? (await ctx.db.select().from(ssoConnections).where(eq(ssoConnections.id, id)).limit(1))[0] : undefined;
    if (!row) throw notFound('Single sign-on connection not found');
    const ns = row.namespaceId ? ((await ctx.db.select().from(namespaces).where(eq(namespaces.id, row.namespaceId)).limit(1))[0] ?? null) : null;
    await requireFeature(ctx, ns, row.kind === 'saml' ? 'saml' : 'sso');
    return row;
  };

  const resolveOidc = async (id: string): Promise<{ cfg: OidcConfig; conn: SsoConnection | null }> => {
    if (isBuiltin(id)) {
      await requireFeature(ctx, null, 'sso');
      const cfg = builtinConfig(ctx, id);
      if (!cfg) throw badRequest(`Sign-in with ${id === 'google' ? 'Google' : 'Microsoft'} is not configured`);
      return { cfg, conn: null };
    }
    const conn = await loadConnection(id);
    if (conn.kind !== 'oidc') throw badRequest('This connection uses SAML');
    const cfg = oidcConfig(ctx, conn);
    if (!cfg) throw new HttpError(400, 'sso_misconfigured', 'This connection is missing its issuer, client ID or client secret');
    return { cfg, conn };
  };

  // Which button to show for an email address: the connection that claims its domain.
  app.get('/auth/sso/discover', { schema: { querystring: z.object({ email: z.string().max(254) }) }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<{ provider: SsoProvider | null }> => {
    const c = await connectionForEmail(ctx, req.query.email);
    return { provider: c ? { id: c.id, name: c.name, kind: c.kind, url: `/api/auth/sso/${c.id}/start` } : null };
  });

  app.get('/auth/sso/:id/start', { schema: { params: z.object({ id: z.string().max(40) }), querystring: z.object({ to: z.string().max(300).optional(), email: z.string().max(254).optional() }) } }, async (req, reply) => {
    const id = req.params.id;
    const returnTo = safeReturn(req.query.to);
    if (!isBuiltin(id)) {
      const conn = await loadConnection(id);
      if (conn.kind === 'saml') {
        const relay = signToken(ctx.env, { c: conn.id, r: returnTo, exp: Date.now() + STATE_TTL_MS });
        return reply.redirect(await samlRedirectUrl(ctx, conn, relay));
      }
    }
    const { cfg } = await resolveOidc(id);
    const { verifier, challenge } = pkcePair();
    const state: FlowState = { c: id, s: randomToken(16), n: randomToken(16), v: verifier, exp: Date.now() + STATE_TTL_MS, r: returnTo };
    reply.setCookie(STATE_COOKIE, signToken(ctx.env, { ...state }), { httpOnly: true, sameSite: 'lax', secure: ctx.env.secureCookies, path: '/api/auth/sso', maxAge: STATE_TTL_MS / 1000 });
    return reply.redirect(await authorizeUrl(cfg, { redirectUri: callbackUrl(ctx, id), state: state.s, nonce: state.n, challenge, loginHint: req.query.email }));
  });

  app.get(
    '/auth/sso/:id/callback',
    { schema: { params: z.object({ id: z.string().max(40) }), querystring: z.object({ code: z.string().max(4000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional(), error_description: z.string().max(1000).optional() }) } },
    async (req, reply) => {
      const raw = req.cookies[STATE_COOKIE];
      reply.clearCookie(STATE_COOKIE, { path: '/api/auth/sso' });
      if (req.query.error) throw new HttpError(401, 'sso_failed', `The identity provider refused the sign-in: ${req.query.error_description ?? req.query.error}`);
      const state = raw ? verifyToken<FlowState>(ctx.env, raw) : null;
      if (!state || state.exp < Date.now() || state.c !== req.params.id || !req.query.state || state.s !== req.query.state || !req.query.code) {
        throw badRequest('This sign-in attempt has expired or was started elsewhere. Start again from the sign-in page.');
      }
      const { cfg, conn } = await resolveOidc(req.params.id);
      const claims = await exchangeCode(cfg, { code: req.query.code, redirectUri: callbackUrl(ctx, req.params.id), verifier: state.v, nonce: state.n });
      return finish(
        req,
        reply,
        ctx,
        {
          connection: conn?.id ?? req.params.id,
          // Microsoft's `sub` is per application; pair it with the tenant so two directories never collide.
          subject: claims.tid ? `${claims.tid}:${claims.sub}` : claims.sub,
          email: claims.email ?? (claims.preferred_username?.includes('@') ? claims.preferred_username : null) ?? null,
          // Microsoft does not send email_verified; addresses from a work directory are managed by its administrator.
          emailVerified: claims.email_verified === true || Boolean(claims.tid),
          name: claims.name ?? null,
          avatarUrl: claims.picture ?? null,
          username: claims.preferred_username?.split('@')[0] ?? null,
        },
        conn,
        state.r,
      );
    },
  );

  app.post('/auth/sso/:id/acs', { schema: { params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const conn = await loadConnection(req.params.id);
    if (conn.kind !== 'saml') throw badRequest('This connection uses OpenID Connect');
    const body = (req.body ?? {}) as { SAMLResponse?: string; RelayState?: string };
    if (!body.SAMLResponse) throw badRequest('Missing SAMLResponse');
    // RelayState is our own signed token when the sign-in started here; a sign-in started at the identity provider has none.
    const relay = body.RelayState ? verifyToken<{ c: string; r: string; exp: number }>(ctx.env, body.RelayState) : null;
    const returnTo = relay && relay.c === conn.id && relay.exp > Date.now() ? safeReturn(relay.r) : '/';
    const who = await samlIdentity(ctx, conn, body.SAMLResponse);
    return finish(req, reply, ctx, { connection: conn.id, subject: who.subject, email: who.email, emailVerified: true, name: who.name }, conn, returnTo);
  });

  app.get('/auth/sso/:id/metadata', { schema: { params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const conn = (await ctx.db.select().from(ssoConnections).where(eq(ssoConnections.id, req.params.id)).limit(1))[0];
    if (!conn || conn.kind !== 'saml') throw notFound('Single sign-on connection not found');
    return reply.type('application/samlmetadata+xml').send(samlMetadata(ctx, conn));
  });

  // ---------- managing connections ----------

  /** `org` is an organization slug, or `-` for instance-wide connections (administrators). */
  const scope = async (req: FastifyRequest, org: string): Promise<Namespace | null> => {
    const user = requireUser(req);
    requireScope(req, 'admin');
    if (org === '-') {
      if (!user.isAdmin) throw forbidden('Administrators only');
      return null;
    }
    const ns = await findNamespace(ctx, org);
    if (!ns || ns.kind !== 'org' || !ns.orgId) throw notFound('Organization not found');
    if (!user.isAdmin && (await orgRoleFor(ctx, ns.orgId, user.id)) !== 'owner') throw forbidden('Only organization owners can manage single sign-on');
    return ns;
  };
  const list = (ns: Namespace | null) => ctx.db.select().from(ssoConnections).where(ns ? eq(ssoConnections.namespaceId, ns.id) : isNull(ssoConnections.namespaceId));
  const orgParams = z.object({ org: z.string().max(100) });

  app.get('/sso/:org/connections', { schema: { params: orgParams } }, async (req): Promise<SsoConnectionInfo[]> => {
    const ns = await scope(req, req.params.org);
    return Promise.all((await list(ns)).map((c) => toConnectionInfo(ctx, c)));
  });

  const buildConfig = (b: z.infer<typeof ssoConnectionSchema>, old: SsoConfig = {}): SsoConfig => {
    if (b.kind === 'oidc') {
      if (!b.issuer || !b.clientId) throw badRequest('An OpenID Connect connection needs an issuer URL and a client ID');
      const secret = b.clientSecret ? encryptSecret(ctx.env, b.clientSecret) : old.clientSecret;
      if (!secret) throw badRequest('Enter the client secret');
      return { issuer: b.issuer.replace(/\/$/, ''), clientId: b.clientId, clientSecret: secret };
    }
    const certificate = b.certificate ? normalizeCertificate(b.certificate) : old.certificate;
    if (!b.entryPoint || !certificate) throw badRequest('A SAML connection needs the sign-in URL and the signing certificate');
    if (!/^[A-Za-z0-9+/=]{200,}$/.test(certificate)) throw badRequest('That does not look like an X.509 certificate. Paste the PEM block from your identity provider.');
    return { entryPoint: b.entryPoint, idpIssuer: b.idpIssuer || undefined, certificate };
  };

  /** A domain can route sign-ins to one connection only. */
  const assertDomainsFree = async (domains: string[], exceptId?: string) => {
    if (!domains.length) return;
    const taken = (await ctx.db.select().from(ssoConnections)).find((c) => c.id !== exceptId && c.domains.some((d) => domains.includes(d)));
    if (taken) throw new HttpError(409, 'conflict', `${taken.domains.find((d) => domains.includes(d))} is already used by another single sign-on connection`);
  };

  app.post('/sso/:org/connections', { schema: { params: orgParams, body: ssoConnectionSchema } }, async (req): Promise<SsoConnectionInfo> => {
    const ns = await scope(req, req.params.org);
    await requireFeature(ctx, ns, req.body.kind === 'saml' ? 'saml' : 'sso');
    if ((await list(ns)).length >= 5) throw badRequest('At most five connections');
    await assertDomainsFree(req.body.domains);
    const [row] = await ctx.db
      .insert(ssoConnections)
      .values({ namespaceId: ns?.id ?? null, kind: req.body.kind, name: req.body.name, config: buildConfig(req.body), domains: req.body.domains, enforced: ns ? req.body.enforced : false, autoProvision: req.body.autoProvision })
      .returning();
    await audit(req, 'sso.connection.create', ns ? { type: 'org', id: ns.orgId! } : undefined, { name: row!.name, kind: row!.kind, domains: row!.domains }, undefined, ns?.id);
    return toConnectionInfo(ctx, row!);
  });

  app.put('/sso/:org/connections/:id', { schema: { params: orgParams.extend({ id: z.uuid() }), body: ssoConnectionSchema } }, async (req): Promise<SsoConnectionInfo> => {
    const ns = await scope(req, req.params.org);
    const old = (await list(ns)).find((c) => c.id === req.params.id);
    if (!old) throw notFound('Connection not found');
    if (old.kind !== req.body.kind) throw badRequest('The protocol of a connection cannot be changed; add a new connection instead');
    await assertDomainsFree(req.body.domains, old.id);
    // Enforcing a connection nobody has signed in through yet would lock every member out, the owner included.
    if (ns && req.body.enforced && !old.enforced) {
      const used = await ctx.db.select({ u: ssoIdentities.userId }).from(ssoIdentities).where(and(eq(ssoIdentities.connection, old.id), eq(ssoIdentities.userId, req.user!.id))).limit(1);
      if (!used.length) throw badRequest('Sign in through this connection yourself once before requiring it, so you cannot lock yourself out');
    }
    const [row] = await ctx.db
      .update(ssoConnections)
      .set({ name: req.body.name, config: buildConfig(req.body, old.config), domains: req.body.domains, enforced: ns ? req.body.enforced : false, autoProvision: req.body.autoProvision })
      .where(eq(ssoConnections.id, old.id))
      .returning();
    await audit(req, 'sso.connection.update', ns ? { type: 'org', id: ns.orgId! } : undefined, { name: row!.name, enforced: row!.enforced, domains: row!.domains }, undefined, ns?.id);
    return toConnectionInfo(ctx, row!);
  });

  app.delete('/sso/:org/connections/:id', { schema: { params: orgParams.extend({ id: z.uuid() }) } }, async (req) => {
    const ns = await scope(req, req.params.org);
    const old = (await list(ns)).find((c) => c.id === req.params.id);
    if (!old) throw notFound('Connection not found');
    await ctx.db.delete(ssoIdentities).where(eq(ssoIdentities.connection, old.id));
    await ctx.db.delete(ssoConnections).where(eq(ssoConnections.id, old.id));
    await audit(req, 'sso.connection.delete', ns ? { type: 'org', id: ns.orgId! } : undefined, { name: old.name }, undefined, ns?.id);
    return { ok: true };
  });

  // Identities linked to my account, and unlinking one.
  app.get('/user/sso', async (req) => {
    const user = requireUser(req);
    const rows = await ctx.db.select().from(ssoIdentities).where(eq(ssoIdentities.userId, user.id));
    const conns = await ctx.db.select().from(ssoConnections);
    return rows.map((r) => ({ connection: r.connection, name: conns.find((c) => c.id === r.connection)?.name ?? (r.connection === 'google' ? 'Google' : r.connection === 'microsoft' ? 'Microsoft' : 'Removed connection'), email: r.email, lastLoginAt: r.lastLoginAt?.toISOString() ?? null }));
  });

  app.delete('/user/sso/:connection', { schema: { params: z.object({ connection: z.string().max(40) }) } }, async (req) => {
    const user = requireUser(req);
    if (req.authMethod === 'token') throw forbidden('Use the web session to manage sign-in methods');
    const others = await ctx.db.select({ c: ssoIdentities.connection }).from(ssoIdentities).where(eq(ssoIdentities.userId, user.id));
    if (!user.passwordHash && !user.githubId && others.length <= 1) throw badRequest('This is your only way to sign in. Set a password first.');
    await ctx.db.delete(ssoIdentities).where(and(eq(ssoIdentities.userId, user.id), eq(ssoIdentities.connection, req.params.connection)));
    await audit(req, 'user.sso.unlink', { type: 'user', id: user.id }, { connection: req.params.connection });
    return { ok: true };
  });
};

export default ssoRoutes;
