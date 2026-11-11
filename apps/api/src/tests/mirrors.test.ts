import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@jumper/db';
import { commitFiles, createHarness, dbAvailable, type Client, type Harness } from '../testing/harness';
import { rejectedRefs, splitCredentials } from '../modules/mirrors/service';
import { decryptSecret, encryptSecret } from '../lib/secrets';

describe('mirror helpers', () => {
  it('takes credentials out of pasted URLs', () => {
    expect(splitCredentials('https://alice:tok123@github.com/a/b.git')).toEqual({ url: 'https://github.com/a/b.git', username: 'alice', token: 'tok123' });
    expect(splitCredentials('https://tok123@gitlab.com/a/b.git')).toEqual({ url: 'https://gitlab.com/a/b.git', username: null, token: 'tok123' });
    expect(splitCredentials('https://github.com/a/b')).toEqual({ url: 'https://github.com/a/b', username: null, token: null });
  });

  it('finds refs git refused to move', () => {
    const fetch = ' ! [rejected]        main       -> main  (non-fast-forward)\n   1234..5678  dev -> dev';
    expect(rejectedRefs(fetch)).toEqual(['main']);
    const porcelain = 'To https://x\n!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\n \trefs/heads/dev:refs/heads/dev\t[up to date]\nDone';
    expect(rejectedRefs(porcelain)).toEqual(['main']);
    expect(rejectedRefs('everything up to date')).toEqual([]);
  });

  it('encrypts secrets so another key cannot read them', () => {
    const a = { SECRET_KEY: 'key-a-0123456789abcdef', secretKeyFile: '/nonexistent' };
    const b = { SECRET_KEY: 'key-b-0123456789abcdef', secretKeyFile: '/nonexistent' };
    const sealed = encryptSecret(a, 'ghp_token');
    expect(sealed).not.toContain('ghp_token');
    expect(decryptSecret(a, sealed)).toBe('ghp_token');
    expect(decryptSecret(b, sealed)).toBeNull();
    expect(decryptSecret(a, sealed.slice(0, -2) + 'AA')).toBeNull();
  });
});

describe.skipIf(!dbAvailable)('repository mirroring', () => {
  let h: Harness;
  let base: string;
  let alice: Client, bob: Client;
  beforeAll(async () => {
    h = await createHarness({ env: { WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true', MIRROR_MIN_INTERVAL_MINUTES: '1' } });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
    bob = await h.user('bob');
  });

  const branchSha = async (owner: string, repo: string, branch = 'main') =>
    ((await alice.get(`/api/repos/${owner}/${repo}/branches`)).json as { name: string; sha: string }[]).find((b) => b.name === branch)?.sha;

  it('imports as a two-way mirror and keeps both copies in step', async () => {
    const src = await h.repo(alice, 'board');
    await commitFiles(src.git, { 'README.md': '# v1' });
    const tok = (await alice.post('/api/user/tokens', { name: 'mirror', scopes: ['repo:write'], expiresInDays: 1 })).json.token as string;
    const imp = await alice.post('/api/repos/import', { url: `${base}/alice/board.git`, name: 'copy', username: 'alice', token: tok, mirror: 'two-way' });
    expect(imp.status, imp.body).toBe(200);

    const list = await alice.get('/api/repos/alice/copy/mirrors');
    expect(list.status).toBe(200);
    expect(list.json.map((m: { direction: string }) => m.direction).sort()).toEqual(['pull', 'push']);
    expect(JSON.stringify(list.json)).not.toContain(tok);
    const stored = (await h.ctx.db.execute(sql`select secret from repo_mirrors`)) as unknown as { secret: string }[];
    expect(stored.every((r) => r.secret && !r.secret.includes(tok))).toBe(true);
    const pull = list.json.find((m: { direction: string }) => m.direction === 'pull');
    const push = list.json.find((m: { direction: string }) => m.direction === 'push');

    // Upstream moves on: a pull brings it in.
    const v2 = await commitFiles(src.git, { 'README.md': '# v2' });
    const synced = await alice.post(`/api/repos/alice/copy/mirrors/${pull.id}/sync`);
    expect(synced.json.lastError, synced.body).toBeNull();
    expect(await branchSha('alice', 'copy')).toBe(v2);

    // A change here: the push mirror sends it upstream.
    const copyId = ((await h.ctx.db.execute(sql`select id from repositories where name = 'copy'`)) as unknown as { id: string }[])[0]!.id;
    const { GitRepo } = await import('../modules/git/repo');
    const copyGit = new GitRepo(`${h.ctx.env.reposDir}/${copyId}.git`);
    const v3 = await commitFiles(copyGit, { 'README.md': '# v3' });
    const pushed = await alice.post(`/api/repos/alice/copy/mirrors/${push.id}/sync`);
    expect(pushed.json.lastError, pushed.body).toBeNull();
    expect(await branchSha('alice', 'board')).toBe(v3);

    // Both sides change main: neither direction overwrites the other, and both say why.
    await commitFiles(src.git, { 'README.md': '# upstream' });
    await commitFiles(copyGit, { 'README.md': '# local' });
    const p1 = await alice.post(`/api/repos/alice/copy/mirrors/${pull.id}/sync`);
    expect(p1.json.lastError).toContain('both copies changed: main');
    const p2 = await alice.post(`/api/repos/alice/copy/mirrors/${push.id}/sync`);
    expect(p2.json.lastError).toContain('remote has changes');

    // Overwrite turns the pull into a one-way mirror that wins.
    await alice.patch(`/api/repos/alice/copy/mirrors/${pull.id}`, { overwrite: true });
    const p3 = await alice.post(`/api/repos/alice/copy/mirrors/${pull.id}/sync`);
    expect(p3.json.lastError).toBeNull();
    expect(await branchSha('alice', 'copy')).toBe(await branchSha('alice', 'board'));
  });

  it('adds a push mirror from settings, with the token in the URL taken out', async () => {
    const dest = await h.repo(alice, 'dest');
    const tok = (await alice.post('/api/user/tokens', { name: 'm', scopes: ['repo:write'], expiresInDays: 1 })).json.token as string;
    const src = await h.repo(bob, 'src');
    const sha = await commitFiles(src.git, { 'a.txt': 'x' });
    const u = new URL(`${base}/alice/dest.git`);
    u.username = 'alice';
    u.password = tok;
    const res = await bob.post('/api/repos/bob/src/mirrors', { direction: 'push', url: u.toString() });
    expect(res.status, res.body).toBe(200);
    expect(res.json).toMatchObject({ url: `${base}/alice/dest.git`, username: 'alice', hasToken: true, lastError: null });
    expect(await dest.git.resolveBranch('main')).toBe(sha);
  });

  it('only repository admins manage mirrors, and bad remotes are refused up front', async () => {
    const src = await h.repo(alice, 'board');
    await commitFiles(src.git, { 'a.txt': 'x' });
    expect((await bob.get('/api/repos/alice/board/mirrors')).status).toBe(403);
    expect((await bob.post('/api/repos/alice/board/mirrors', { direction: 'push', url: `${base}/bob/x.git` })).status).toBe(403);
    expect((await alice.post('/api/repos/alice/board/mirrors', { direction: 'pull', url: 'file:///etc/passwd' })).status).toBe(400);
    const bad = await alice.post('/api/repos/alice/board/mirrors', { direction: 'pull', url: `${base}/nobody/none.git` });
    expect(bad.status).toBe(200);
    expect(bad.json.lastError).toBeTruthy();
    expect((await alice.post('/api/repos/alice/board/mirrors', { direction: 'pull', url: `${base}/alice/other.git` })).status).toBe(409);
  });
});
