// Attacks tried during the November 2026 security review, kept as regressions.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@jumper/db';
import { commitFiles, createHarness, dbAvailable, type Harness } from '../testing/harness';
import { totpAt } from '../modules/auth/totp';
import { createResetToken } from '../modules/auth/reset-routes';
import { claimOnce } from '../lib/once';

describe.skipIf(!dbAvailable)('security hardening', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ env: { REQUIRE_VERIFIED_EMAIL: 'false' } });
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  const login = (body: Record<string, string>) => h.app.inject({ method: 'POST', url: '/api/auth/login', payload: body, headers: { 'x-requested-with': 'jumper' } });

  it('locks an account after repeated wrong passwords, whatever spelling or address is used', async () => {
    await h.user('alice');
    for (let i = 0; i < 5; i++) expect((await login({ login: i % 2 ? 'alice' : 'ALICE@example.com', password: 'wrong-password-123' })).statusCode).toBe(401);
    // Even the right password waits now: guessing has stopped paying.
    const locked = await login({ login: 'alice', password: 'correct-horse-battery' });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().message).toMatch(/Try again in/);
  });

  it('treats unknown accounts the same way, so lockouts reveal nothing', async () => {
    for (let i = 0; i < 5; i++) expect((await login({ login: 'nobody-here', password: 'wrong-password-123' })).statusCode).toBe(401);
    expect((await login({ login: 'nobody-here', password: 'wrong-password-123' })).statusCode).toBe(429);
  });

  it('a password reset lifts the lockout', async () => {
    await h.user('alice');
    for (let i = 0; i < 6; i++) await login({ login: 'alice', password: 'wrong-password-123' });
    const [u] = (await h.ctx.db.execute(sql`select * from users where username = 'alice'`)) as unknown as any[];
    const token = await createResetToken(h.ctx, { ...u, passwordHash: u.password_hash, emailVerifiedAt: u.email_verified_at } as never);
    expect((await h.app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'a-brand-new-password-1' }, headers: { 'x-requested-with': 'jumper' } })).statusCode).toBe(200);
    expect((await login({ login: 'alice', password: 'a-brand-new-password-1' })).statusCode).toBe(200);
    // And the link works once.
    expect((await h.app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'attacker-password-1' }, headers: { 'x-requested-with': 'jumper' } })).statusCode).toBe(400);
  });

  it('throttles two-factor guessing after the password is known', async () => {
    const alice = await h.user('alice');
    const setup = await alice.post('/api/user/two-factor/setup');
    expect((await alice.post('/api/user/two-factor/enable', { code: totpAt(setup.json.secret, Date.now()) })).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await login({ login: 'alice', password: 'correct-horse-battery', code: String(100000 + i) })).statusCode).toBe(401);
    // The right code is refused while locked: brute force can't race the lockout.
    expect((await login({ login: 'alice', password: 'correct-horse-battery', code: totpAt(setup.json.secret, Date.now()) })).statusCode).toBe(429);
    // A stolen session can't guess its way to turning two-factor off either.
    expect((await alice.post('/api/user/two-factor/disable', { code: '123456' })).status).toBe(429);
  });

  it('the admin database browser never shows secrets, and cannot be sorted by them', async () => {
    const alice = await h.user('alice');
    const root = await h.user('root');
    await h.ctx.db.execute(sql`update users set is_admin = true where username = 'root'`);
    const setup = await alice.post('/api/user/two-factor/setup');
    await alice.post('/api/user/two-factor/enable', { code: totpAt(setup.json.secret, Date.now()) });
    const page = await root.get('/api/admin/tables/users');
    expect(page.status, page.body).toBe(200);
    const hidden = page.json.columns.filter((c: { hidden: boolean }) => c.hidden).map((c: { name: string }) => c.name);
    expect(hidden).toEqual(expect.arrayContaining(['password_hash', 'totp_secret', 'recovery_codes']));
    expect(page.body).not.toContain(setup.json.secret);
    for (const r of page.json.rows) for (const c of hidden) expect(r[c]).toBeNull();
    expect((await root.get('/api/admin/tables/users?sort=password_hash')).status).toBe(400);
    expect((await root.get('/api/admin/tables/sessions?sort=id')).status).toBe(400);
    // Searching for a secret finds nothing.
    expect((await root.get(`/api/admin/tables/users?q=${setup.json.secret.slice(0, 8)}`)).json.total).toBe(0);
  });

  it('hostile files in a repository are never served as active content', async () => {
    const alice = await h.user('alice');
    const r = await h.repo(alice, 'evil');
    await commitFiles(r.git, {
      'x.svg': '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.cookie)"><script>alert(1)</script></svg>',
      'x.html': '<html><body><script>fetch("/api/user")</script></body></html>',
      'x.png': '<script>alert(1)</script>',
    });
    for (const path of ['x.svg', 'x.html', 'x.png']) {
      const res = await h.anon.get(`/api/repos/alice/evil/raw?ref=main&path=${path}`);
      expect(res.status).toBe(200);
      const type = String(res.headers['content-type']);
      expect(type, path).not.toMatch(/text\/html|image\/svg/);
      expect(String(res.headers['x-content-type-options'])).toBe('nosniff');
      expect(String(res.headers['content-security-policy'])).toContain('sandbox');
    }
  });

  it('outsiders cannot read a private repository through generated files, raw files or diffs', async () => {
    const alice = await h.user('alice');
    const mallory = await h.user('mallory');
    const r = await h.repo(alice, 'secret', { visibility: 'private' });
    await commitFiles(r.git, { 'board.kicad_pcb': '(kicad_pcb (version 20240108))' });
    const [row] = (await h.ctx.db.execute(sql`insert into artifacts (repo_id, sha, project_path, kind, name, storage_key, size, content_type) values (${r.id}, 'deadbeef', 'board.kicad_pro', 'pdf', 'board.pdf', 'k/does-not-matter', 1, 'application/pdf') returning id`)) as unknown as { id: string }[];
    const id = row!.id;
    for (const c of [mallory, h.anon]) {
      expect((await c.get(`/api/repos/alice/secret/artifacts/${id}`)).status).toBe(404);
      expect((await c.get(`/api/repos/alice/secret/artifacts?sha=deadbeef`)).status).toBe(404);
      expect((await c.get('/api/repos/alice/secret/raw?ref=main&path=board.kicad_pcb')).status).toBe(404);
      expect((await c.get('/api/repos/alice/secret/tree?ref=main')).status).toBe(404);
    }
    // Guessing the artifact id through a repository the attacker owns doesn't work either.
    await h.repo(mallory, 'mine');
    expect((await mallory.get(`/api/repos/mallory/mine/artifacts/${id}`)).status).toBe(404);
  });

  it('signed sign-in responses (SAML) are accepted once, then refused as replays', async () => {
    const response = 'PHNhbWxwOlJlc3BvbnNlIC8+' + Math.random();
    expect(await claimOnce(h.ctx, 'saml:test', response, 60)).toBe(true);
    expect(await claimOnce(h.ctx, 'saml:test', response, 60)).toBe(false);
    expect(await claimOnce(h.ctx, 'saml:other-connection', response, 60)).toBe(true);
  });
});
