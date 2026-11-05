import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '@jumper/db';
import fp from 'fastify-plugin';
import { and, eq, gt, isNull, or, personalAccessTokens, sessions, sql, users, type User } from '@jumper/db';
import type { TokenScope } from '@jumper/shared';
import { randomToken, sha256 } from '../../lib/crypto';
import { forbidden, unauthorized } from '../../lib/errors';
import { emptyFacts, requestContext } from '../../lib/request-context';

export const SESSION_COOKIE = 'jumper_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const TOKEN_PREFIX = 'pcbh_';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    authMethod: 'session' | 'token' | 'basic' | null;
    tokenScopes: TokenScope[] | null;
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const authPlugin = fp(async (app) => {
  app.decorateRequest('user', null);
  app.decorateRequest('authMethod', null);
  app.decorateRequest('tokenScopes', null);

  // Callback style on purpose: everything after `done` (the other hooks and the handler) runs inside the store.
  app.addHook('onRequest', (req, _reply, done) => {
    requestContext.run(emptyFacts({ ip: req.ip }), done);
  });

  app.addHook('onRequest', async (req) => {
    const facts = requestContext.getStore();
    const header = req.headers.authorization;
    if (header) {
      const [scheme, value] = header.split(' ', 2);
      // Short-lived LFS grants from `git-lfs-authenticate` are checked by the LFS routes only and give no API access.
      // Directory provisioning tokens are likewise only understood by the SCIM routes.
      if (value?.startsWith('lfs1.') || value?.startsWith('jscim_')) return;
      if (value && /^(bearer|token)$/i.test(scheme ?? '')) {
        const found = await lookupToken(app.ctx.db, value.trim());
        if (!found) throw unauthorized('Invalid or expired token');
        req.user = found.user;
        req.authMethod = 'token';
        req.tokenScopes = found.scopes;
        if (facts) facts.method = 'token';
        return;
      }
      // Basic auth is only honoured by the git smart-HTTP routes.
      return;
    }

    const cookie = req.cookies[SESSION_COOKIE];
    if (!cookie) return;
    const id = sha256(cookie);
    const rows = await app.ctx.db
      .select({ user: users, expiresAt: sessions.expiresAt, createdAt: sessions.createdAt, ssoConnectionId: sessions.ssoConnectionId })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
      .limit(1);
    const row = rows[0];
    if (!row || row.user.disabled) return;
    // An absolute lifetime, when the operator sets one: activity does not extend it.
    const maxHours = app.ctx.env.SESSION_MAX_HOURS;
    if (maxHours && Date.now() - row.createdAt.getTime() > maxHours * 3600_000) {
      await app.ctx.db.delete(sessions).where(eq(sessions.id, id));
      return;
    }

    // CSRF: cookie-authenticated writes must carry a header that browsers
    // never attach cross-origin without a CORS preflight (which we don't allow).
    if (UNSAFE.has(req.method) && req.headers['x-requested-with'] !== 'jumper') {
      throw forbidden('Missing X-Requested-With header');
    }
    req.user = row.user;
    req.authMethod = 'session';
    if (facts) {
      facts.method = 'session';
      facts.sessionCreatedAt = row.createdAt;
      facts.ssoConnectionId = row.ssoConnectionId;
    }

    // Sliding expiration, refreshed at most daily.
    if (row.expiresAt.getTime() - Date.now() < SESSION_TTL_MS - 24 * 3600 * 1000) {
      await app.ctx.db.update(sessions).set({ expiresAt: new Date(Date.now() + SESSION_TTL_MS) }).where(eq(sessions.id, id));
    }
  });
});

/** Resolve a personal access token (Bearer header or git Basic-auth password). */
export async function lookupToken(
  db: Database,
  raw: string,
): Promise<{ user: User; scopes: TokenScope[] } | null> {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const rows = await db
    .select({ user: users, token: personalAccessTokens })
    .from(personalAccessTokens)
    .innerJoin(users, eq(users.id, personalAccessTokens.userId))
    .where(
      and(
        eq(personalAccessTokens.tokenHash, sha256(raw)),
        or(isNull(personalAccessTokens.expiresAt), gt(personalAccessTokens.expiresAt, new Date())),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.user.disabled) return null;
  await db.update(personalAccessTokens).set({ lastUsedAt: sql`now()` }).where(eq(personalAccessTokens.id, row.token.id));
  return { user: row.user, scopes: row.token.scopes as TokenScope[] };
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** Tokens without the scope cannot perform the action, regardless of role. */
export function requireScope(req: FastifyRequest, scope: TokenScope): void {
  if (req.authMethod !== 'token' && req.authMethod !== 'basic') return;
  const scopes = req.tokenScopes ?? [];
  const ok =
    scopes.includes('admin') ||
    scopes.includes(scope) ||
    (scope === 'repo:read' && scopes.includes('repo:write'));
  if (!ok) throw forbidden(`Token is missing the "${scope}" scope`);
}

export async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string, opts: { ssoConnectionId?: string | null } = {}): Promise<void> {
  const token = randomToken(32);
  await req.server.ctx.db.insert(sessions).values({
    id: sha256(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
    ip: req.ip,
    ssoConnectionId: opts.ssoConnectionId ?? null,
  });
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.server.ctx.env.secureCookies,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function endSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const cookie = req.cookies[SESSION_COOKIE];
  if (cookie) await req.server.ctx.db.delete(sessions).where(eq(sessions.id, sha256(cookie)));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
