import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@jumper/db';
import { createHarness, dbAvailable, type Client, type Harness } from '../testing/harness';

describe.skipIf(!dbAvailable)('security regression suite', () => {
  let h: Harness;
  let alice: Client;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
  });

  it('cookie-authenticated writes without the CSRF header are refused', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/repos', headers: { cookie: alice.cookie }, payload: { name: 'x' } });
    expect(res.statusCode).toBe(403);
    // …and the same request with the header works.
    expect((await alice.post('/api/repos', { name: 'x', initReadme: false })).status).toBe(200);
  });

  it('sets HttpOnly, SameSite session cookies', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'alice', password: 'correct-horse-battery' } });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('gives the same answer for an unknown user and a wrong password', async () => {
    const a = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'nobody', password: 'wrong-password-1' } });
    const b = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'alice', password: 'wrong-password-1' } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().message).toBe(b.json().message);
  });

  it('never returns password hashes or token hashes', async () => {
    const me = await alice.get('/api/auth/me');
    expect(JSON.stringify(me.json)).not.toMatch(/argon2|passwordHash|password_hash/i);
  });

  it('refuses duplicate registrations case-insensitively', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ALICE', email: 'other@example.com', password: 'correct-horse-battery' } });
    expect(res.statusCode).toBe(409);
    const res2 = await h.app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'someone', email: 'ALICE@example.com', password: 'correct-horse-battery' } });
    expect(res2.statusCode).toBe(409);
  });

  it('rejects short passwords and malformed usernames', async () => {
    for (const payload of [
      { username: 'bob', email: 'bob@example.com', password: 'short' },
      { username: '../etc', email: 'bob@example.com', password: 'correct-horse-battery' },
      { username: 'a b', email: 'bob@example.com', password: 'correct-horse-battery' },
    ]) {
      const res = await h.app.inject({ method: 'POST', url: '/api/auth/register', payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('admin API is closed to API tokens even for an admin account', async () => {
    await h.ctx.db.execute(sql`update users set is_admin = true where username = 'alice'`);
    expect((await alice.get('/api/admin/overview')).status).toBe(200);
    const tok = await alice.post('/api/user/tokens', { name: 'ci', scopes: ['admin'], expiresInDays: 30 });
    expect(tok.status).toBe(200);
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/overview', headers: { authorization: `Bearer ${tok.json.token}` } });
    expect(res.statusCode).toBe(403);
  });

  it('read-scoped tokens cannot write', async () => {
    await h.repo(alice, 'board');
    const tok = await alice.post('/api/user/tokens', { name: 'ro', scopes: ['repo:read'], expiresInDays: 30 });
    const auth = { authorization: `Bearer ${tok.json.token}` };
    expect((await h.app.inject({ method: 'GET', url: '/api/repos/alice/board/issues', headers: auth })).statusCode).toBe(200);
    const write = await h.app.inject({ method: 'POST', url: '/api/repos/alice/board/issues', headers: auth, payload: { title: 'x' } });
    expect(write.statusCode).toBe(403);
    const comment = await h.app.inject({ method: 'POST', url: '/api/repos/alice/board/issues/1/comments', headers: auth, payload: { body: 'x' } });
    expect(comment.statusCode).toBe(403);
    const rw = await alice.post('/api/user/tokens', { name: 'rw', scopes: ['repo:write'], expiresInDays: 30 });
    const ok = await h.app.inject({ method: 'POST', url: '/api/repos/alice/board/issues', headers: { authorization: `Bearer ${rw.json.token}` }, payload: { title: 'x' } });
    expect(ok.statusCode).toBe(200);
    const del = await h.app.inject({ method: 'DELETE', url: '/api/repos/alice/board', headers: auth });
    expect(del.statusCode).toBe(403);
  });

  it('an invalid or revoked bearer token never falls back to anonymous access on writes', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/repos', headers: { authorization: 'Bearer pcbh_nope' }, payload: { name: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('a disabled account cannot use its existing session', async () => {
    await h.ctx.db.execute(sql`update users set disabled = true where username = 'alice'`);
    expect((await alice.get('/api/auth/me')).json).toBeNull();
  });

  it('private repositories are indistinguishable from missing ones', async () => {
    await h.repo(alice, 'secret', { visibility: 'private' });
    const mallory = await h.user('mallory');
    const priv = await mallory.get('/api/repos/alice/secret');
    const none = await mallory.get('/api/repos/alice/does-not-exist');
    expect(priv.status).toBe(404);
    expect(none.status).toBe(404);
    expect(priv.json.message).toBe(none.json.message);
    expect((await h.anon.get('/api/repos/alice/secret/branches')).status).toBe(404);
  });

  it('API responses carry security headers', async () => {
    const res = await h.anon.get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
  });

  it('error responses do not leak internals', async () => {
    const res = await h.anon.get('/api/repos/alice/board/pulls/not-a-number');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toMatch(/node_modules|at Object\.|\.ts:\d+/);
  });

  it('SQL metacharacters in path and query parameters are inert', async () => {
    for (const evil of ["'; drop table users; --", '" OR 1=1 --', '%27%20OR%20%271%27%3D%271']) {
      await h.anon.get(`/api/repos/${encodeURIComponent(evil)}/x`);
      await h.anon.get(`/api/namespaces/${encodeURIComponent(evil)}`);
      await h.anon.get(`/api/repos?q=${encodeURIComponent(evil)}`);
    }
    const rows = (await h.ctx.db.execute(sql`select count(*)::int as n from users`)) as unknown as { n: number }[];
    expect(rows[0]?.n).toBe(1);
  });

  it('path traversal through repository file endpoints is refused', async () => {
    await h.repo(alice, 'board');
    for (const p of ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', '/etc/passwd']) {
      const res = await h.anon.get(`/api/repos/alice/board/raw?ref=main&path=${p}`);
      expect([400, 404, 422]).toContain(res.status);
      expect(res.body).not.toContain('root:');
    }
  });
});
