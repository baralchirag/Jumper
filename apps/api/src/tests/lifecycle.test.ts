import { existsSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@jumper/db';
import { commitFiles, createHarness, dbAvailable, type Client, type Harness } from '../testing/harness';

const PW = 'correct-horse-battery';
const q = async (h: Harness, query: ReturnType<typeof sql>) => (await h.ctx.db.execute(query)) as unknown as Record<string, unknown>[];

describe.skipIf(!dbAvailable)('account deletion', () => {
  let h: Harness;
  let alice: Client, bob: Client;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
    bob = await h.user('bob');
  });

  it('requires the exact username and the password, and refuses API tokens', async () => {
    expect((await bob.req('DELETE', '/api/user', { confirm: 'nope', password: PW })).status).toBe(400);
    expect((await bob.req('DELETE', '/api/user', { confirm: 'bob', password: 'wrong-password-1' })).status).toBe(403);
    expect((await bob.req('DELETE', '/api/user', { confirm: 'bob' })).status).toBe(403);
    const tok = await bob.post('/api/user/tokens', { name: 't', scopes: ['admin'], expiresInDays: 1 });
    const viaToken = await h.app.inject({ method: 'DELETE', url: '/api/user', headers: { authorization: `Bearer ${tok.json.token}` }, payload: { confirm: 'bob', password: PW } });
    expect(viaToken.statusCode).toBe(403);
    expect((await h.anon.req('DELETE', '/api/user', { confirm: 'bob' })).status).toBe(401);
    expect((await bob.get('/api/auth/me')).json.username).toBe('bob');
  });

  it('deletes the account, its repositories and their files, and signs it out', async () => {
    const repo = await h.repo(bob, 'mine');
    await commitFiles(repo.git, { 'a.txt': 'x' });
    expect(existsSync(repo.git.path)).toBe(true);
    const preview = await bob.get('/api/user/deletion-preview');
    expect(preview.json.ownedRepos.map((r: { name: string }) => r.name)).toEqual(['mine']);
    const res = await bob.req('DELETE', '/api/user', { confirm: 'bob', password: PW });
    expect(res.status).toBe(200);
    expect(res.json.repos).toBe(1);
    expect((await bob.get('/api/auth/me')).json).toBeNull();
    expect((await h.anon.get('/api/repos/bob/mine')).status).toBe(404);
    expect(existsSync(repo.git.path)).toBe(false);
    expect((await q(h, sql`select 1 from users where username = 'bob'`)).length).toBe(0);
    const login = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'bob', password: PW } });
    expect(login.statusCode).toBe(401);
  });

  it("keeps what the user wrote on other people's repositories, attributed to a ghost account", async () => {
    await h.repo(alice, 'board');
    await bob.post('/api/repos/alice/board/issues', { title: 'Bob found a bug', body: 'details' });
    await bob.post('/api/repos/alice/board/issues/1/comments', { body: 'a comment' });
    expect((await bob.req('DELETE', '/api/user', { confirm: 'bob', password: PW })).status).toBe(200);
    const view = await h.anon.get('/api/repos/alice/board/issues/1');
    expect(view.status).toBe(200);
    expect(view.json.issue.title).toBe('Bob found a bug');
    expect(view.json.issue.author.username).toBe('ghost');
    expect(view.json.comments[0].author.username).toBe('ghost');
  });

  it('frees the username but reserves "ghost"', async () => {
    await bob.req('DELETE', '/api/user', { confirm: 'bob', password: PW });
    await h.user('bob');
    const g = await h.app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ghost', email: 'g@example.com', password: PW } });
    // Reserved outright, so nobody can register "ghost" before the first deletion and inherit deleted users' comments.
    expect(g.statusCode).toBe(400);
    expect(g.body).toContain('reserved');
  });

  it('is blocked while the user is the only owner of an organization, and works once another owner exists', async () => {
    expect((await bob.post('/api/orgs', { slug: 'acme', name: 'Acme' })).status).toBe(200);
    const blocked = await bob.req('DELETE', '/api/user', { confirm: 'bob', password: PW });
    expect(blocked.status).toBe(409);
    expect(blocked.json.message).toContain('acme');
    expect((await bob.get('/api/user/deletion-preview')).json.blocked).toBe(true);
    expect((await bob.put('/api/orgs/acme/members', { username: 'alice', role: 'owner' })).status).toBe(200);
    expect((await bob.req('DELETE', '/api/user', { confirm: 'bob', password: PW })).status).toBe(200);
    expect((await alice.get('/api/namespaces/acme')).json.members.map((m: { username: string }) => m.username)).toEqual(['alice']);
  });

  it('refuses to delete the only administrator', async () => {
    await h.ctx.db.execute(sql`update users set is_admin = true where username = 'alice'`);
    const res = await alice.req('DELETE', '/api/user', { confirm: 'alice', password: PW });
    expect(res.status).toBe(409);
    expect(res.json.message).toContain('only administrator');
  });

  it('lets an administrator delete another account, with the same protections', async () => {
    await h.ctx.db.execute(sql`update users set is_admin = true where username = 'alice'`);
    const repo = await h.repo(bob, 'mine');
    const id = (await q(h, sql`select id from users where username = 'bob'`))[0]!.id as string;
    expect((await bob.del(`/api/admin/users/${id}`)).status).toBe(403);
    const aliceId = (await q(h, sql`select id from users where username = 'alice'`))[0]!.id as string;
    expect((await alice.del(`/api/admin/users/${aliceId}`)).status).toBe(400);
    expect((await alice.del(`/api/admin/users/${id}`)).status).toBe(200);
    expect(existsSync(repo.git.path)).toBe(false);
    expect((await h.anon.get('/api/repos/bob/mine')).status).toBe(404);
  });
});

describe.skipIf(!dbAvailable)('organizations', () => {
  let h: Harness;
  let alice: Client, bob: Client;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
    bob = await h.user('bob');
    expect((await alice.post('/api/orgs', { slug: 'acme', name: 'Acme' })).status).toBe(200);
    expect((await alice.put('/api/orgs/acme/members', { username: 'bob', role: 'member' })).status).toBe(200);
  });

  it('only owners can edit', async () => {
    expect((await bob.patch('/api/orgs/acme', { name: 'Hacked' })).status).toBe(403);
    expect((await alice.patch('/api/orgs/acme', { name: 'Acme Labs', description: 'Boards' })).status).toBe(200);
    const ns = await h.anon.get('/api/namespaces/acme');
    expect(ns.json.name).toBe('Acme Labs');
    expect(ns.json.bio).toBe('Boards');
  });

  it('members can leave but the last owner cannot', async () => {
    expect((await alice.del('/api/orgs/acme/members/alice')).status).toBe(409);
    expect((await bob.del('/api/orgs/acme/members/bob')).status).toBe(200);
  });

  it('deleting needs the exact name, owner rights, and removes repositories and files', async () => {
    expect((await alice.post('/api/repos', { owner: 'acme', name: 'product', initReadme: false })).status).toBe(200);
    const row = await q(h, sql`select r.id from repositories r join namespaces n on n.id = r.namespace_id where n.slug = 'acme'`);
    expect((await bob.req('DELETE', '/api/orgs/acme', { confirm: 'acme' })).status).toBe(403);
    expect((await alice.req('DELETE', '/api/orgs/acme', { confirm: 'wrong' })).status).toBe(400);
    const res = await alice.req('DELETE', '/api/orgs/acme', { confirm: 'ACME' });
    expect(res.status).toBe(200);
    expect(res.json.repos).toBe(1);
    expect((await h.anon.get('/api/namespaces/acme')).status).toBe(404);
    expect(row.length).toBe(1);
    expect((await q(h, sql`select 1 from repositories where id = ${row[0]!.id as string}`)).length).toBe(0);
    // The name is free again.
    expect((await alice.post('/api/orgs', { slug: 'acme', name: 'Acme again' })).status).toBe(200);
  });
});

describe.skipIf(!dbAvailable)('forks', () => {
  let h: Harness;
  let alice: Client, bob: Client, carol: Client;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
    bob = await h.user('bob');
    carol = await h.user('carol');
  });

  it('copies history into the forker’s account and stays independent', async () => {
    const src = await h.repo(alice, 'board');
    const sha = await commitFiles(src.git, { 'README.md': '# board', 'hw/a.kicad_pcb': '(kicad_pcb)' });
    await commitFiles(src.git, { 'README.md': '# v2' }, { branch: 'dev' });
    const res = await bob.post('/api/repos/alice/board/fork', {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ owner: 'bob', name: 'board', forkOf: { owner: 'alice', name: 'board' }, permission: 'admin' });
    const tree = await h.anon.get(`/api/repos/bob/board/tree?ref=${sha}`);
    expect(tree.status).toBe(200);
    const branches = await h.anon.get('/api/repos/bob/board/branches');
    expect(branches.json.map((b: { name: string }) => b.name).sort()).toEqual(['dev', 'main']);
    const info = await h.anon.get('/api/repos/bob/board');
    expect(info.json.forkOf).toEqual({ owner: 'alice', name: 'board' });
    expect((await h.anon.get('/api/repos/alice/board')).json.forkCount).toBe(1);
    expect((await h.anon.get('/api/repos/alice/board/forks')).json.map((f: { fullName: string }) => f.fullName)).toEqual(['bob/board']);
    // Pushing to the fork's branch leaves the original alone.
    const fork = (await q(h, sql`select r.id from repositories r where r.name = 'board' and r.fork_of_id is not null`))[0]!.id as string;
    expect(fork).not.toBe(src.id);
    await commitFiles(src.git, { 'README.md': '# only in original' }, { branch: 'main' });
    const forkMain = (await h.anon.get('/api/repos/bob/board/branches')).json.find((b: { name: string }) => b.name === 'main').sha;
    expect(forkMain).toBe(sha);
  });

  it('rejects forking into yourself, name clashes, empty repositories and anonymous callers', async () => {
    await h.repo(alice, 'empty');
    expect((await bob.post('/api/repos/alice/empty/fork', {})).status).toBe(400);
    const src = await h.repo(alice, 'board');
    await commitFiles(src.git, { 'a.txt': 'x' });
    expect((await alice.post('/api/repos/alice/board/fork', {})).status).toBe(409);
    expect((await h.anon.post('/api/repos/alice/board/fork', {})).status).toBe(401);
    expect((await bob.post('/api/repos/alice/board/fork', {})).status).toBe(200);
    expect((await bob.post('/api/repos/alice/board/fork', {})).status).toBe(409);
    expect((await bob.post('/api/repos/alice/board/fork', { name: 'board-2' })).status).toBe(200);
    expect((await bob.post('/api/repos/alice/board/fork', { owner: 'carol', name: 'x' })).status).toBe(403);
  });

  it('does not let people without access fork or discover private repositories', async () => {
    const src = await h.repo(alice, 'secret', { visibility: 'private' });
    await commitFiles(src.git, { 'a.txt': 'x' });
    expect((await carol.post('/api/repos/alice/secret/fork', {})).status).toBe(404);
    expect((await alice.put('/api/repos/alice/secret/collaborators/bob', { role: 'read' })).status).toBe(200);
    const forked = await bob.post('/api/repos/alice/secret/fork', {});
    expect(forked.status).toBe(200);
    expect(forked.json.visibility).toBe('private');
    expect((await carol.get('/api/repos/bob/secret')).status).toBe(404);
    expect((await carol.get('/api/repos/alice/secret/forks')).status).toBe(404);
  });

  it('survives deletion of the original', async () => {
    const src = await h.repo(alice, 'board');
    await commitFiles(src.git, { 'a.txt': 'x' });
    await bob.post('/api/repos/alice/board/fork', {});
    expect((await alice.del('/api/repos/alice/board')).status).toBe(200);
    const info = await h.anon.get('/api/repos/bob/board');
    expect(info.status).toBe(200);
    expect(info.json.forkOf).toBeNull();
  });
});

describe.skipIf(!dbAvailable)('password reset', () => {
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

  /** The mailer logs the message when SMTP is not configured; capture the link from there. */
  async function requestLink(login: string): Promise<string | null> {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const res = await h.anon.post('/api/auth/forgot', { login });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true });
    } finally {
      process.stderr.write = orig;
    }
    return lines.join('\n').match(/\/reset\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
  }

  it('answers identically for known and unknown accounts', async () => {
    const known = await h.anon.post('/api/auth/forgot', { login: 'alice@example.com' });
    const unknown = await h.anon.post('/api/auth/forgot', { login: 'nobody@example.com' });
    expect(known.json).toEqual(unknown.json);
    expect(known.status).toBe(unknown.status);
  });

  it('resets the password once, signs everyone out, and rejects reuse', async () => {
    const token = await requestLink('alice@example.com');
    expect(token).toBeTruthy();
    expect((await h.anon.get(`/api/auth/reset/${token}`)).json.username).toBe('alice');
    expect((await h.anon.post('/api/auth/reset', { token, password: 'short' })).status).toBe(400);
    expect((await h.anon.post('/api/auth/reset', { token, password: 'a-brand-new-password' })).status).toBe(200);
    expect((await alice.get('/api/auth/me')).json).toBeNull();
    const old = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'alice', password: PW } });
    expect(old.statusCode).toBe(401);
    const fresh = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'alice', password: 'a-brand-new-password' } });
    expect(fresh.statusCode).toBe(200);
    expect((await h.anon.post('/api/auth/reset', { token, password: 'another-new-password' })).status).toBe(400);
    expect((await h.anon.get(`/api/auth/reset/${token}`)).status).toBe(404);
  });

  it('expires after an hour, and a new request invalidates the previous link', async () => {
    const first = await requestLink('alice');
    const second = await requestLink('alice');
    expect(first).not.toBe(second);
    expect((await h.anon.get(`/api/auth/reset/${first}`)).status).toBe(404);
    await h.ctx.db.execute(sql`update password_resets set expires_at = now() - interval '1 minute'`);
    expect((await h.anon.get(`/api/auth/reset/${second}`)).status).toBe(404);
    expect((await h.anon.post('/api/auth/reset', { token: second, password: 'a-brand-new-password' })).status).toBe(400);
  });

  it('stores only a hash, and does nothing for disabled accounts', async () => {
    const token = await requestLink('alice');
    const rows = await q(h, sql`select token_hash from password_resets`);
    expect(JSON.stringify(rows)).not.toContain(token!);
    await h.ctx.db.execute(sql`update users set disabled = true where username = 'alice'`);
    expect(await requestLink('alice')).toBeNull();
    expect((await h.anon.get(`/api/auth/reset/${token}`)).status).toBe(404);
  });

  it('lets an administrator hand out a link when email is not set up', async () => {
    await h.ctx.db.execute(sql`update users set is_admin = true where username = 'alice'`);
    const bob = await h.user('bob');
    const id = (await q(h, sql`select id from users where username = 'bob'`))[0]!.id as string;
    expect((await bob.post(`/api/admin/users/${id}/reset-link`)).status).toBe(403);
    const link = await alice.post(`/api/admin/users/${id}/reset-link`);
    expect(link.status).toBe(200);
    const token = link.json.url.split('/reset/')[1];
    expect((await h.anon.post('/api/auth/reset', { token, password: 'a-brand-new-password' })).status).toBe(200);
  });
});
