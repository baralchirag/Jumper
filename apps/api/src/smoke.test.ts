import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { createContext } from './context';
import { loadEnv } from './env';

// Boots the full app against unreachable backing services: verifies every
// route and schema compiles and that the OpenAPI document is generated.
const env = loadEnv({
  DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x',
  REDIS_URL: 'redis://127.0.0.1:1',
  LOG_LEVEL: 'fatal',
  NODE_ENV: 'test',
  REPOS_DIR: './data/test-repos',
});
const ctx = createContext(env);
ctx.redis.on('error', () => {});
const app = await buildApp(ctx);
afterAll(async () => {
  await app.close();
  ctx.redis.disconnect();
  ctx.rateLimitRedis.disconnect();
  await ctx.queue.close().catch(() => {});
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
});
