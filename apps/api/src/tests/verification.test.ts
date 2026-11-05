import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@jumper/db';
import { createVerification } from '../modules/auth/verify';
import { commitFiles, createHarness, dbAvailable, type Client, type Harness } from '../testing/harness';

const PW = 'correct-horse-battery';
const q = async (h: Harness, query: ReturnType<typeof sql>) => (await h.ctx.db.execute(query)) as unknown as Record<string, unknown>[];
const userRow = async (h: Harness, name: string) => (await h.ctx.db.execute(sql`select id, email, email_verified_at from users where username = ${name}`) as unknown as { id: string; email: string; email_verified_at: Date | null }[])[0]!;

describe.skipIf(!dbAvailable)('email verification is off without a mail server', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  it('does not block anyone (nobody could verify), and says so', async () => {
    const alice = await h.user('alice');
    expect((await h.anon.get('/api/auth/providers')).json.emailVerification).toBe(false);
    expect((await userRow(h, 'alice')).email_verified_at).toBeNull();
    expect((await alice.post('/api/repos', { name: 'ok', initReadme: false })).status).toBe(200);
  });
});

describe.skipIf(!dbAvailable)('email verification enforced', () => {
  let h: Harness;
  let alice: Client;
  beforeAll(async () => {
    // An SMTP server that is not there: enforcement turns on, sending fails quietly, as during a mail outage.
    h = await createHarness({ env: { SMTP_URL: 'smtp://127.0.0.1:1' } });
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
  });

  it('lets an unverified account read and manage itself but not write', async () => {
    expect((await h.anon.get('/api/auth/providers')).json.emailVerification).toBe(true);
    const me = await alice.get('/api/auth/me');
    expect(me.json.emailVerified).toBe(false);
    expect((await alice.get('/api/repos')).status).toBe(200);
    const blocked = await alice.post('/api/repos', { name: 'nope', initReadme: false });
    expect(blocked.status).toBe(403);
    expect(blocked.json.error).toBe('email_unverified');
    expect((await alice.post('/api/user/tokens', { name: 't', scopes: ['repo:write'], expiresInDays: 1 })).status).toBe(200);
    expect((await alice.post('/api/orgs', { slug: 'acme', name: 'Acme' })).status).toBe(403);
  });

  it('also blocks API tokens and git pushes of unverified accounts', async () => {
    const tok = (await alice.post('/api/user/tokens', { name: 't', scopes: ['repo:write'], expiresInDays: 1 })).json.token;
    const viaToken = await h.app.inject({ method: 'POST', url: '/api/repos', headers: { authorization: `Bearer ${tok}` }, payload: { name: 'x' } });
    expect(viaToken.statusCode).toBe(403);
    // Make a repo as a verified user to push to, then try as the unverified one.
    await h.ctx.db.execute(sql`update users set email_verified_at = now() where username = 'alice'`);
    const repo = await h.repo(alice, 'board');
    await commitFiles(repo.git, { 'a.txt': 'x' });
    await h.ctx.db.execute(sql`update users set email_verified_at = null where username = 'alice'`);
    const basic = 'Basic ' + Buffer.from(`alice:${tok}`).toString('base64');
    const push = await h.app.inject({ method: 'GET', url: '/alice/board.git/info/refs?service=git-receive-pack', headers: { authorization: basic } });
    expect(push.statusCode).toBe(403);
    expect(push.body).toContain('Confirm your email');
    const pull = await h.app.inject({ method: 'GET', url: '/alice/board.git/info/refs?service=git-upload-pack', headers: { authorization: basic } });
    expect(pull.statusCode).toBe(200);
  });

  it('verifies with the emailed link, once, and unblocks writes', async () => {
    const u = await userRow(h, 'alice');
    const token = await createVerification(h.ctx, { id: u.id, email: u.email });
    expect((await h.anon.get(`/api/auth/verify/${token}`)).json.email).toBe('alice@example.com');
    expect((await alice.post('/api/auth/verify', { token })).status).toBe(200);
    expect((await userRow(h, 'alice')).email_verified_at).not.toBeNull();
    expect((await alice.get('/api/auth/me')).json.emailVerified).toBe(true);
    expect((await alice.post('/api/repos', { name: 'now-ok', initReadme: false })).status).toBe(200);
    expect((await alice.post('/api/auth/verify', { token })).status).toBe(400);
    expect((await h.anon.get(`/api/auth/verify/${token}`)).status).toBe(404);
  });

  it('rejects expired and unknown links, and stores only a hash', async () => {
    const u = await userRow(h, 'alice');
    const token = await createVerification(h.ctx, { id: u.id, email: u.email });
    expect(JSON.stringify(await q(h, sql`select token_hash from email_verifications`))).not.toContain(token);
    await h.ctx.db.execute(sql`update email_verifications set expires_at = now() - interval '1 minute'`);
    expect((await alice.post('/api/auth/verify', { token })).status).toBe(400);
    expect((await alice.post('/api/auth/verify', { token: 'nonsense' })).status).toBe(400);
  });

  it('a new link replaces the previous one', async () => {
    const u = await userRow(h, 'alice');
    const first = await createVerification(h.ctx, { id: u.id, email: u.email });
    const second = await createVerification(h.ctx, { id: u.id, email: u.email });
    expect((await alice.post('/api/auth/verify', { token: first })).status).toBe(400);
    expect((await alice.post('/api/auth/verify', { token: second })).status).toBe(200);
  });

  it('changing the email needs the password and resets verification', async () => {
    await h.ctx.db.execute(sql`update users set email_verified_at = now() where username = 'alice'`);
    expect((await alice.patch('/api/user', { email: 'new@example.com' })).status).toBe(403);
    expect((await alice.patch('/api/user', { email: 'new@example.com', currentPassword: 'wrong-password-1' })).status).toBe(403);
    const ok = await alice.patch('/api/user', { email: 'new@example.com', currentPassword: PW });
    expect(ok.status).toBe(200);
    expect(ok.json.email).toBe('new@example.com');
    expect(ok.json.emailVerified).toBe(false);
    // Saving other profile fields never asks for a password or touches verification.
    await h.ctx.db.execute(sql`update users set email_verified_at = now() where username = 'alice'`);
    expect((await alice.patch('/api/user', { bio: 'hello' })).json.emailVerified).toBe(true);
    // The old address's link cannot verify the new address.
    const u = await userRow(h, 'alice');
    const stale = await createVerification(h.ctx, { id: u.id, email: 'alice@example.com' });
    expect((await alice.post('/api/auth/verify', { token: stale })).status).toBe(400);
    await h.user('bob');
    expect((await alice.patch('/api/user', { email: 'bob@example.com', currentPassword: PW })).status).toBe(409);
  });

  it('lets an administrator mark an address verified', async () => {
    const bob = await h.user('bob');
    await h.ctx.db.execute(sql`update users set is_admin = true, email_verified_at = now() where username = 'bob'`);
    const id = (await userRow(h, 'alice')).id;
    expect((await alice.patch(`/api/admin/users/${id}`, { emailVerified: true })).status).toBe(403);
    expect((await bob.patch(`/api/admin/users/${id}`, { emailVerified: true })).status).toBe(200);
    expect((await alice.post('/api/repos', { name: 'unblocked', initReadme: false })).status).toBe(200);
    const list = await bob.get('/api/admin/users');
    expect(list.json.find((u: { username: string }) => u.username === 'alice').emailVerified).toBe(true);
  });

  it('existing accounts are not locked out: the migration verified them', async () => {
    const sqlText = (await import('node:fs')).readFileSync(new URL('../../../../packages/db/drizzle/0005_modern_deathbird.sql', import.meta.url), 'utf8');
    expect(sqlText).toMatch(/UPDATE "users" SET "email_verified_at" = "created_at"/);
  });
});
