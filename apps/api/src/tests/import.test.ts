import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@jumper/db';
import { commitFiles, createHarness, dbAvailable, type Client, type Harness } from '../testing/harness';

describe.skipIf(!dbAvailable)('import from a git URL', () => {
  let h: Harness;
  let base: string;
  let alice: Client, bob: Client;
  beforeAll(async () => {
    h = await createHarness({ env: { WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true' } });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
    bob = await h.user('bob');
  });

  it('copies every branch and tag, keeps the default branch, and the copy is independent', async () => {
    const src = await h.repo(alice, 'board');
    const sha = await commitFiles(src.git, { 'README.md': '# board', 'hw/a.kicad_pcb': '(kicad_pcb)' });
    await commitFiles(src.git, { 'README.md': '# dev' }, { branch: 'dev' });
    await src.git.updateRef('refs/tags/v1', sha);
    const res = await bob.post('/api/repos/import', { url: `${base}/alice/board.git`, visibility: 'public' });
    expect(res.status, res.body).toBe(200);
    expect(res.json).toMatchObject({ owner: 'bob', name: 'board', defaultBranch: 'main', isEmpty: false, permission: 'admin' });
    const branches = await h.anon.get('/api/repos/bob/board/branches');
    expect(branches.json.map((x: { name: string }) => x.name).sort()).toEqual(['dev', 'main']);
    expect((await h.anon.get(`/api/repos/bob/board/tree?ref=${sha}`)).status).toBe(200);
    const row = (await h.ctx.db.execute(sql`select id from repositories where name = 'board' and fork_of_id is null and namespace_id = (select id from namespaces where slug = 'bob')`)) as unknown as { id: string }[];
    expect(existsSync(`${h.ctx.env.reposDir}/${row[0]!.id}.git`)).toBe(true);
  });

  it('finishes in the background when the copy outlasts the request', async () => {
    const src = await h.repo(alice, 'slow');
    await commitFiles(src.git, { 'README.md': '# slow' });
    process.env.IMPORT_WAIT_MS = '0';
    try {
      const res = await bob.post('/api/repos/import', { url: `${base}/alice/slow.git` });
      expect(res.status, res.body).toBe(200);
      expect(res.json).toMatchObject({ owner: 'bob', name: 'slow', isEmpty: true });
      expect(res.json.importing.source).toContain('/alice/slow');
      let info = res.json;
      for (let i = 0; i < 50 && (info.isEmpty || info.importing); i++) {
        await new Promise((r) => setTimeout(r, 100));
        info = (await bob.get('/api/repos/bob/slow')).json;
      }
      expect(info.isEmpty).toBe(false);
      expect(info.importing).toBeUndefined();
    } finally {
      delete process.env.IMPORT_WAIT_MS;
    }
  });

  it('preserves a non-main default branch', async () => {
    const src = await h.repo(alice, 'trunk');
    await commitFiles(src.git, { 'a.txt': 'x' }, { branch: 'develop' });
    await src.git.setHead('develop');
    await h.ctx.db.execute(sql`update repositories set default_branch = 'develop' where name = 'trunk'`);
    const res = await bob.post('/api/repos/import', { url: `${base}/alice/trunk.git` });
    expect(res.status, res.body).toBe(200);
    expect(res.json.defaultBranch).toBe('develop');
  });

  it('imports a private repository only with credentials, and never stores them', async () => {
    const src = await h.repo(alice, 'secret', { visibility: 'private' });
    await commitFiles(src.git, { 'a.txt': 'x' });
    const tok = (await alice.post('/api/user/tokens', { name: 't', scopes: ['repo:read'], expiresInDays: 1 })).json.token as string;
    const denied = await bob.post('/api/repos/import', { url: `${base}/alice/secret.git` });
    expect(denied.status).toBe(400);
    expect(denied.json.message).toContain('refused access');
    const ok = await alice.post('/api/repos/import', { url: `${base}/alice/secret.git`, name: 'secret-copy', username: 'alice', token: tok });
    expect(ok.status, ok.body).toBe(200);
    expect(ok.json.visibility).toBe('private');
    const audit = (await h.ctx.db.execute(sql`select metadata from audit_log where action = 'repo.import'`)) as unknown as { metadata: unknown }[];
    expect(JSON.stringify(audit)).not.toContain(tok);
    // The token must appear nowhere on disk: grep exits 1 when there is no match.
    const grep = (await import('node:child_process')).spawnSync('grep', ['-rl', tok, h.ctx.env.reposDir], { encoding: 'utf8' });
    expect(grep.status).toBe(1);
    expect(grep.stdout).toBe('');
  });

  it('fails cleanly: unknown repository, empty repository, name clash, bad owner', async () => {
    const missing = await bob.post('/api/repos/import', { url: `${base}/alice/nothing.git` });
    expect(missing.status).toBe(400);
    // A server never confirms whether a private repository exists, so "not found" and "refused" read the same.
    expect(missing.json.message).toMatch(/No repository|refused access|could not read/i);
    await h.repo(alice, 'empty');
    const empty = await bob.post('/api/repos/import', { url: `${base}/alice/empty.git` });
    expect(empty.status).toBe(400);
    expect(await h.ctx.db.execute(sql`select 1 from repositories where namespace_id = (select id from namespaces where slug = 'bob')`)).toHaveLength(0);
    const src = await h.repo(alice, 'board');
    await commitFiles(src.git, { 'a.txt': 'x' });
    expect((await bob.post('/api/repos/import', { url: `${base}/alice/board.git` })).status).toBe(200);
    expect((await bob.post('/api/repos/import', { url: `${base}/alice/board.git` })).status).toBe(409);
    expect((await bob.post('/api/repos/import', { url: `${base}/alice/board.git`, owner: 'alice', name: 'x' })).status).toBe(403);
    expect((await h.anon.post('/api/repos/import', { url: `${base}/alice/board.git` })).status).toBe(401);
  });
});

describe.skipIf(!dbAvailable)('import refuses dangerous sources (production defaults)', () => {
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

  it.each([
    ['a local file', 'file:///etc'],
    ['ssh', 'ssh://git@github.com/x/y.git'],
    ['the git protocol', 'git://github.com/x/y.git'],
    ['an ext:: command', 'ext::sh -c "id"'],
    ['loopback', 'https://127.0.0.1/x.git'],
    ['localhost', 'https://localhost/x.git'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data'],
    ['a private network', 'https://10.0.0.5/x.git'],
    ['plain http', 'http://example.com/x.git'],
    ['embedded credentials', 'https://user:pw@example.com/x.git'],
    ['a query string', 'https://example.com/x.git?service=git-upload-pack'],
    ['garbage', 'not a url'],
  ])('rejects %s', async (_label, url) => {
    const res = await alice.post('/api/repos/import', { url });
    expect(res.status).toBe(400);
    expect(await h.ctx.db.execute(sql`select 1 from repositories`)).toHaveLength(0);
  });
});

describe.skipIf(!dbAvailable)('example board', () => {
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

  it('creates a repository with a complete KiCad project', async () => {
    const res = await alice.post('/api/repos', { name: 'try-it', sample: true });
    expect(res.status, res.body).toBe(200);
    expect(res.json.isEmpty).toBe(false);
    const tree = await alice.get('/api/repos/alice/try-it/tree?ref=main');
    expect(tree.json.entries.map((e: { name: string }) => e.name)).toEqual(expect.arrayContaining(['led-indicator.kicad_sch', 'led-indicator.kicad_pcb', 'led-indicator.kicad_pro', 'README.md', '.jumper.yml']));
    // The board and schematic parse with the project's own KiCad parser.
    const stats = await alice.get('/api/repos/alice/try-it/board-stats?path=led-indicator.kicad_pcb');
    expect(stats.status, stats.body).toBe(200);
    expect(stats.json.stats).toMatchObject({ footprints: 3, nets: 3, copperLayers: 2 });
    const readme = await alice.get('/api/repos/alice/try-it/raw?ref=main&path=README.md');
    expect(readme.body).toContain('LED indicator');
  });

  it('plain creation is unchanged', async () => {
    const res = await alice.post('/api/repos', { name: 'plain' });
    expect(res.status).toBe(200);
    const tree = await alice.get('/api/repos/alice/plain/tree?ref=main');
    expect(tree.json.entries.map((e: { name: string }) => e.name)).not.toContain('led-indicator.kicad_pcb');
  });
});
