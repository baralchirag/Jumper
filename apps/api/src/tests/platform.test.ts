import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, webhooks } from '@jumper/db';
import { commitFiles, createHarness, dbAvailable, type Client, type Harness } from '../testing/harness';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(25);
  return cond();
}

describe.skipIf(!dbAvailable)('webhooks', () => {
  let h: Harness;
  let alice: Client, bob: Client;
  let server: Server;
  let received: { headers: IncomingMessage['headers']; body: string }[] = [];
  let status = 200;

  beforeAll(async () => {
    h = await createHarness({ env: { WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true' } });
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = status;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(async () => {
    server.close();
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    received = [];
    status = 200;
    alice = await h.user('alice');
    bob = await h.user('bob');
    await h.repo(alice, 'board');
  });
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

  it('is admin-only and hides the secret after creation', async () => {
    expect((await bob.get('/api/repos/alice/board/hooks')).status).toBe(403);
    expect((await h.anon.post('/api/repos/alice/board/hooks', { url: url() })).status).toBe(401);
    const created = await alice.post('/api/repos/alice/board/hooks', { url: url(), events: ['issues'] });
    expect(created.status).toBe(200);
    expect(created.json.secret).toMatch(/.{16,}/);
    const list = await alice.get('/api/repos/alice/board/hooks');
    expect(JSON.stringify(list.json)).not.toContain(created.json.secret);
  });

  it('delivers signed events and records the delivery', async () => {
    const created = await alice.post('/api/repos/alice/board/hooks', { url: url(), events: ['issues'], secret: 'a-very-long-shared-secret' });
    await alice.post('/api/repos/alice/board/issues', { title: 'Hello hooks' });
    expect(await until(() => received.length > 0)).toBe(true);
    const got = received[0]!;
    const expected = 'sha256=' + createHmac('sha256', 'a-very-long-shared-secret').update(got.body).digest('hex');
    expect(got.headers['x-jumper-signature-256']).toBe(expected);
    expect(got.headers['x-jumper-event']).toBe('issues');
    const payload = JSON.parse(got.body);
    expect(payload).toMatchObject({ event: 'issues', action: 'opened', number: 1, repository: { fullName: 'alice/board' } });
    await until(() => false, 200);
    const deliveries = await alice.get(`/api/repos/alice/board/hooks/${created.json.id}/deliveries`);
    expect(deliveries.json[0]).toMatchObject({ event: 'issues', status: 200 });
  });

  it('only sends subscribed events and skips inactive hooks', async () => {
    const created = await alice.post('/api/repos/alice/board/hooks', { url: url(), events: ['push'] });
    await alice.post('/api/repos/alice/board/issues', { title: 'not subscribed' });
    await sleep(300);
    expect(received).toHaveLength(0);
    await alice.patch(`/api/repos/alice/board/hooks/${created.json.id}`, { events: ['issues'], active: false });
    await alice.post('/api/repos/alice/board/issues', { title: 'inactive' });
    await sleep(300);
    expect(received).toHaveLength(0);
  });

  it('ping reports non-2xx responses and does not follow redirects', async () => {
    const created = await alice.post('/api/repos/alice/board/hooks', { url: url() });
    status = 302;
    const ping = await alice.post(`/api/repos/alice/board/hooks/${created.json.id}/ping`);
    expect(ping.json.status).toBe(302);
    expect(received).toHaveLength(1);
  });

  it("cannot manage another repository's hook by id", async () => {
    await h.repo(alice, 'other');
    const created = await alice.post('/api/repos/alice/board/hooks', { url: url() });
    expect((await alice.del(`/api/repos/alice/other/hooks/${created.json.id}`)).status).toBe(404);
    expect((await alice.get(`/api/repos/alice/other/hooks/${created.json.id}/deliveries`)).status).toBe(404);
  });

  it('rejects invalid URLs', async () => {
    expect((await alice.post('/api/repos/alice/board/hooks', { url: 'ftp://example.com/x' })).status).toBe(400);
    expect((await alice.post('/api/repos/alice/board/hooks', { url: 'https://u:p@example.com/x' })).status).toBe(400);
    expect((await alice.post('/api/repos/alice/board/hooks', { url: 'not a url' })).status).toBe(400);
  });
});

describe.skipIf(!dbAvailable)('webhooks SSRF protection (production defaults)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  it('refuses to register private destinations', async () => {
    const alice = await h.user('alice');
    await h.repo(alice, 'board');
    for (const u of ['http://127.0.0.1:9/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'https://10.0.0.5/x']) {
      expect((await alice.post('/api/repos/alice/board/hooks', { url: u })).status, u).toBe(400);
    }
  });

  it('blocks delivery at connect time even if a private URL is already stored', async () => {
    const alice = await h.user('alice');
    const repo = await h.repo(alice, 'board');
    const [hook] = await h.ctx.db.insert(webhooks).values({ repoId: repo.id, url: 'http://127.0.0.1:1/x', secret: 'secretsecretsecret', events: ['push'] }).returning();
    const ping = await alice.post(`/api/repos/alice/board/hooks/${hook!.id}/ping`);
    expect(ping.status).toBe(200);
    expect(ping.json.status).toBeNull();
    expect(ping.json.error).toBeTruthy();
  });
});

describe.skipIf(!dbAvailable)('share links', () => {
  let h: Harness;
  let alice: Client, bob: Client;
  let sha: string;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
    bob = await h.user('bob');
    const repo = await h.repo(alice, 'board', { visibility: 'private' });
    sha = await commitFiles(repo.git, {
      'README.md': '# private readme',
      'hw/board.kicad_pcb': '(kicad_pcb)',
      'hw/page.html': '<script>alert(1)</script>',
      'hw/render.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'hw-secret/keys.txt': 'top secret',
      'secret/x.txt': 'nope',
    });
  });

  async function link(body: Record<string, unknown> = {}) {
    const res = await alice.post('/api/repos/alice/board/share-links', { ref: 'main', path: 'hw', ...body });
    expect(res.status).toBe(200);
    return res.json as { id: string; token: string; url: string };
  }

  it('is admin-only and stores only a hash of the token', async () => {
    expect((await bob.post('/api/repos/alice/board/share-links', { ref: 'main' })).status).toBe(404);
    expect((await h.anon.post('/api/repos/alice/board/share-links', { ref: 'main' })).status).toBe(401);
    const l = await link();
    expect(l.token.startsWith('pcbs_')).toBe(true);
    const rows = (await h.ctx.db.execute(sql`select token_hash from share_links`)) as unknown as { token_hash: string }[];
    expect(rows[0]!.token_hash).not.toContain(l.token);
    expect(JSON.stringify((await alice.get('/api/repos/alice/board/share-links')).json)).not.toContain(l.token);
  });

  it('gives anonymous viewers access to a private repo, but only within scope', async () => {
    const { token } = await link();
    const meta = await h.anon.get(`/api/share/${token}`);
    expect(meta.status).toBe(200);
    expect(meta.json).toMatchObject({ repository: 'alice/board', sha, path: 'hw', canDownload: false });
    expect((await h.anon.get(`/api/share/${token}/tree?path=hw`)).json.entries.map((e: any) => e.name).sort()).toEqual(['board.kicad_pcb', 'page.html', 'render.svg']);
    // Navigating to the scope from the root shows only the path leading there.
    expect((await h.anon.get(`/api/share/${token}/tree`)).json.entries.map((e: any) => e.name)).toEqual(['hw']);
    expect((await h.anon.get(`/api/share/${token}/file?path=hw/board.kicad_pcb`)).status).toBe(200);
    for (const p of ['README.md', 'secret/x.txt', 'hw-secret/keys.txt', '../README.md', 'hw/../README.md', '%2e%2e/README.md']) {
      expect((await h.anon.get(`/api/share/${token}/file?path=${encodeURIComponent(p)}`)).status, p).toBe(404);
    }
    expect((await h.anon.get(`/api/share/${token}/tree?path=secret`)).status).toBe(404);
    expect((await h.anon.get(`/api/share/${token}/tree?path=hw-secret`)).status).toBe(404);
  });

  it('serves safely: sandbox CSP, nosniff, no-store, active content never inline', async () => {
    const { token } = await link({ canDownload: true });
    const svg = await h.anon.get(`/api/share/${token}/file?path=hw/render.svg`);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(String(svg.headers['content-security-policy'])).toContain('sandbox');
    expect(svg.headers['x-content-type-options']).toBe('nosniff');
    expect(String(svg.headers['cache-control'])).toContain('no-store');
    const html = await h.anon.get(`/api/share/${token}/file?path=hw/page.html`);
    expect(html.headers['content-type']).toBe('application/octet-stream');
    expect(String(html.headers['content-disposition'])).toContain('attachment');
  });

  it('view-only links refuse downloads', async () => {
    const { token } = await link({ canDownload: false });
    expect((await h.anon.get(`/api/share/${token}/file?path=hw/board.kicad_pcb&download=1`)).status).toBe(404);
    expect((await h.anon.get(`/api/share/${token}/file?path=hw/page.html`)).status).toBe(404);
  });

  it('stops working when revoked or expired, and counts views', async () => {
    const a = await link();
    await h.anon.get(`/api/share/${a.token}`);
    await h.anon.get(`/api/share/${a.token}`);
    expect((await alice.get('/api/repos/alice/board/share-links')).json[0].viewCount).toBe(2);
    expect((await alice.del(`/api/repos/alice/board/share-links/${a.id}`)).status).toBe(200);
    expect((await h.anon.get(`/api/share/${a.token}`)).status).toBe(404);
    const b = await link();
    await h.ctx.db.execute(sql`update share_links set expires_at = now() - interval '1 second' where id = ${b.id}`);
    expect((await h.anon.get(`/api/share/${b.token}`)).status).toBe(404);
  });

  it('rejects guessed tokens uniformly and stops when the creator is disabled', async () => {
    expect((await h.anon.get('/api/share/pcbs_notarealtoken')).status).toBe(404);
    expect([404, 414]).toContain((await h.anon.get('/api/share/' + 'a'.repeat(300))).status);
    const { token } = await link();
    await h.ctx.db.execute(sql`update users set disabled = true where username = 'alice'`);
    expect((await h.anon.get(`/api/share/${token}`)).status).toBe(404);
  });

  it('validates input', async () => {
    expect((await alice.post('/api/repos/alice/board/share-links', { ref: 'nope' })).status).toBe(400);
    expect((await alice.post('/api/repos/alice/board/share-links', { ref: 'main', path: '../x' })).status).toBe(400);
    expect((await alice.post('/api/repos/alice/board/share-links', { ref: 'main', path: 'missing/dir' })).status).toBe(400);
    expect((await alice.post('/api/repos/alice/board/share-links', { ref: 'main', expiresInHours: 0 })).status).toBe(400);
  });

  it("cannot revoke another repository's link by id", async () => {
    const l = await link();
    await h.repo(alice, 'other');
    expect((await alice.del(`/api/repos/alice/other/share-links/${l.id}`)).status).toBe(404);
  });
});

describe.skipIf(!dbAvailable)('design analysis', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  it('board stats and fab check read a real board from git', async () => {
    const alice = await h.user('alice');
    const repo = await h.repo(alice, 'board');
    const pcb = `(kicad_pcb (version 20240108) (generator "pcbnew") (general (thickness 1.6))
      (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
      (net 0 "") (net 1 "GND")
      (gr_rect (start 0 0) (end 40 20) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))
      (segment (start 1 1) (end 11 1) (width 0.09) (layer "F.Cu") (net 1))
      (via (at 5 5) (size 0.5) (drill 0.25) (layers "F.Cu" "B.Cu") (net 1)))`;
    await commitFiles(repo.git, { 'a.kicad_pcb': pcb, 'a.txt': 'x' });
    const stats = await h.anon.get('/api/repos/alice/board/board-stats?path=a.kicad_pcb');
    expect(stats.status).toBe(200);
    expect(stats.json.stats).toMatchObject({ copperLayers: 2, widthMm: 40, heightMm: 20, minTrackWidthMm: 0.09, vias: 1 });
    const fab = await h.anon.get('/api/repos/alice/board/fab-check?path=a.kicad_pcb&profile=jlcpcb,oshpark');
    expect(fab.status).toBe(200);
    const jlc = fab.json.reports.find((r: any) => r.profile === 'jlcpcb');
    expect(jlc.ok).toBe(false);
    expect(jlc.issues.map((i: any) => i.rule)).toEqual(expect.arrayContaining(['track-width', 'via-drill']));
    expect((await h.anon.get('/api/repos/alice/board/fab-check?path=a.kicad_pcb&profile=nope')).status).toBe(400);
    expect((await h.anon.get('/api/repos/alice/board/board-stats?path=a.txt')).status).toBe(400);
    expect((await h.anon.get('/api/repos/alice/board/board-stats?path=missing.kicad_pcb')).status).toBe(404);
    expect((await h.anon.get('/api/repos/alice/board/board-stats?path=a.kicad_pcb&sha=--bad')).status).toBe(400);
  });

  it('design routes respect private repositories', async () => {
    const alice = await h.user('alice');
    const bob = await h.user('bob');
    const repo = await h.repo(alice, 'secret', { visibility: 'private' });
    await commitFiles(repo.git, { 'a.kicad_pcb': '(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal)))' });
    expect((await bob.get('/api/repos/alice/secret/board-stats?path=a.kicad_pcb')).status).toBe(404);
    expect((await h.anon.get('/api/repos/alice/secret/pinmap')).status).toBe(404);
  });

  it('cost rollup validates input before contacting any supplier', async () => {
    const alice = await h.user('alice');
    const repo = await h.repo(alice, 'bomrepo');
    await commitFiles(repo.git, { 'a.kicad_pcb': '(kicad_pcb)', 'a.kicad_sch': '(kicad_sch)' });
    expect((await h.anon.get('/api/repos/alice/bomrepo/bom/cost-rollup?path=a.kicad_pcb')).status).toBe(400);
    expect((await h.anon.get('/api/repos/alice/bomrepo/bom/cost-rollup?path=a.kicad_sch&tiers=abc')).status).toBe(400);
    expect((await h.anon.get('/api/repos/alice/bomrepo/bom/cost-rollup?path=missing.kicad_sch')).status).toBe(404);
  });

  it('generates a firmware pin map from the netlist artifact', async () => {
    const alice = await h.user('alice');
    const repo = await h.repo(alice, 'fw');
    const sha = await commitFiles(repo.git, { 'README.md': 'x' });
    const nets = Array.from({ length: 9 }, (_, i) => `(net (code "${i + 1}") (name "${i === 0 ? '/SPI_SCK' : 'N' + i}") (node (ref "U1") (pin "${i + 1}") (pinfunction "${i === 0 ? 'PA5' : 'PB' + i}")))`).join('');
    const netlist = `(export (version "E") (components (comp (ref "U1") (value "STM32"))) (nets ${nets}))`;
    await h.ctx.storage.put('test/netlist.net', Buffer.from(netlist), 'text/plain');
    await h.ctx.db.execute(sql`insert into artifacts (repo_id, sha, project_path, kind, name, storage_key, content_type, size) values (${repo.id}, ${sha}, '', 'netlist', 'netlist.net', 'test/netlist.net', 'text/plain', ${netlist.length})`);
    const json = await h.anon.get('/api/repos/alice/fw/pinmap');
    expect(json.status).toBe(200);
    expect(json.json.mcu).toBe('U1');
    expect(json.json.pins[0]).toEqual({ pin: 'PA5', net: '/SPI_SCK' });
    const header = await h.anon.get('/api/repos/alice/fw/pinmap?format=header');
    expect(header.body).toContain('#define PIN_SPI_SCK 5');
    expect(header.headers['content-type']).toContain('text/plain');
    expect((await h.anon.get('/api/repos/alice/fw/pinmap?mcu=U9')).status).toBe(404);
  });
});
