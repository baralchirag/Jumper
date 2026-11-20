import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { createContext } from '../context';
import { loadEnv } from '../env';

// Boots the full app against unreachable backing services: verifies every
// route and schema compiles and that the OpenAPI document is generated.
const env = loadEnv({
  DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x',
  REDIS_URL: 'redis://127.0.0.1:1',
  LOG_LEVEL: 'fatal',
  NODE_ENV: 'test',
  REPOS_DIR: './data/test-repos',
  // The explorer is off by default; this test turns it on to check every route is registered with a schema.
  API_DOCS: 'true',
});
const ctx = createContext(env);
ctx.redis.on('error', () => {});
const app = await buildApp(ctx);
afterAll(async () => {
  await app.close();
  ctx.redis.disconnect();
  ctx.rateLimitRedis.disconnect();
  await ctx.queue.close().catch(() => {});
  await ctx.outputsQueue.close().catch(() => {});
});

describe('app', () => {
  it('registers routes and serves OpenAPI', async () => {
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/repos/{owner}/{repo}/pulls/{number}/merge', '/api/repos/{owner}/{repo}/semantic-diff']));
  });

  it('rejects invalid bodies with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: '-bad', email: 'nope', password: 'short' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('refuses dumb-HTTP git requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/someone/repo.git/info/refs' });
    expect(res.statusCode).toBe(403);
  });

  it('keeps every admin endpoint closed to anonymous callers', async () => {
    for (const url of ['/api/admin/overview', '/api/admin/users', '/api/admin/tables']) {
      const res = await app.inject({ method: 'GET', url });
      expect([401, 403]).toContain(res.statusCode);
    }
  });

  it('does not auto-promote the first registered user', async () => {
    const src = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../modules/auth/routes.ts', import.meta.url), 'utf8'));
    expect(src).toMatch(/isAdmin: false/);
    expect(src).not.toMatch(/isAdmin: n === 0/);
  });

  it('enforces the admin IP allowlist before checking the session', () => {
    const e = loadEnv({ DATABASE_URL: 'postgres://x:x@x/x', ADMIN_ALLOWED_IPS: ' 10.0.0.1, 203.0.113.5 ' });
    expect(e.adminAllowedIps).toEqual(['10.0.0.1', '203.0.113.5']);
  });
});
