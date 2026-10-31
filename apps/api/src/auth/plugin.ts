import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '@pcbhub/db';
import fp from 'fastify-plugin';
import { and, eq, gt, isNull, or, personalAccessTokens, sessions, sql, users, type User } from '@pcbhub/db';
import type { TokenScope } from '@pcbhub/shared';
import { randomToken, sha256 } from '../lib/crypto';
import { forbidden, unauthorized } from '../lib/errors';

export const SESSION_COOKIE = 'pcbhub_session';
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

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (header) {
      const [scheme, value] = header.split(' ', 2);
      if (value && /^(bearer|token)$/i.test(scheme ?? '')) {
        const found = await lookupToken(app.ctx.db, value.trim());
        if (!found) throw unauthorized('Invalid or expired token');
        req.user = found.user;
        req.authMethod = 'token';
        req.tokenScopes = found.scopes;
        return;
      }
      // Basic auth is only honoured by the git smart-HTTP routes.
      return;
    }

    const cookie = req.cookies[SESSION_COOKIE];
    if (!cookie) return;
    const id = sha256(cookie);
    const rows = await app.ctx.db
      .select({ user: users, expiresAt: sessions.expiresAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
      .limit(1);
    const row = rows[0];
    if (!row || row.user.disabled) return;

    // CSRF: cookie-authenticated writes must carry a header that browsers
    // never attach cross-origin without a CORS preflight (which we don't allow).
    if (UNSAFE.has(req.method) && req.headers['x-requested-with'] !== 'pcbhub') {
      throw forbidden('Missing X-Requested-With header');
    }
    req.user = row.user;
    req.authMethod = 'session';

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

export async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
  const token = randomToken(32);
  await req.server.ctx.db.insert(sessions).values({
    id: sha256(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
    ip: req.ip,
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
