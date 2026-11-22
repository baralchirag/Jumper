// Features reachable over HTTP: org policy and roles, audit export, SSO connections, instance administration,
// SCIM and BOM watches.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@jumper/db';
import { createHarness, dbAvailable, type Harness } from '../testing/harness';
import { outbox } from '../modules/mail/mailer';
import { totpAt } from '../modules/auth/totp';

describe.skipIf(!dbAvailable)('business features over HTTP', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ env: { SMTP_URL: 'json:', REQUIRE_VERIFIED_EMAIL: 'false', PRICING_ENABLED: 'false' } });
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    outbox.length = 0;
  });

  async function org(owner: Awaited<ReturnType<Harness['user']>>, slug: string) {
    const r = await owner.post('/api/orgs', { slug, name: slug });
    expect(r.status, r.body).toBe(200);
  }

  it('manages org policy, custom roles and the audit export', async () => {
    const alice = await h.user('alice');
    const bob = await h.user('bob');
    await org(alice, 'acme');
    expect((await alice.put('/api/orgs/acme/members', { username: 'bob', role: 'member' })).status).toBe(200);

    const pol = await alice.get('/api/owners/acme/policy');
    expect(pol.status, pol.body).toBe(200);
    const put = await alice.put('/api/owners/acme/policy', { ...pol.json.policy, minApprovals: 2 });
    expect(put.status, put.body).toBe(200);
    expect((await bob.put('/api/owners/acme/policy', pol.json.policy)).status).toBe(403);

    const role = await alice.post('/api/owners/acme/roles', { name: 'Layout reviewer', description: '', base: 'review', capabilities: [] });
    expect(role.status, role.body).toBe(200);
    const id = role.json[0].id;
    expect((await alice.put('/api/orgs/acme/members/bob/role', { role: `custom:${id}` })).status).toBe(200);
    const members = await alice.get('/api/orgs/acme/members');
    expect(members.json.find((m: { username: string }) => m.username === 'bob').customRole.name).toBe('Layout reviewer');

    const csv = await alice.get('/api/owners/acme/audit?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe('time,actor,action,target_type,target_id,ip,details');
    expect(csv.body).toContain('policy.update');
    expect(csv.body).toContain('org.member.role');
  });

  it('serves instance administration to administrators only', async () => {
    const alice = await h.user('alice');
    const root = await h.user('root');
    await h.ctx.db.execute(sql`update users set is_admin = true where username = 'root'`);
    expect((await alice.get('/api/admin/instance/retention')).status).toBe(403);
    for (const path of ['retention', 'legal-holds', 'scim/tokens', 'version']) {
      const r = await root.get(`/api/admin/instance/${path}`);
      expect(r.status, `${path}: ${r.body}`).toBe(200);
    }
    expect((await h.anon.get('/api/version')).json.version).toBeTruthy();
  });

  it('requires a provisioning token for SCIM', async () => {
    const root = await h.user('root');
    await h.ctx.db.execute(sql`update users set is_admin = true where username = 'root'`);
    expect((await h.anon.get('/api/scim/v2/Users')).status).toBe(401);
    const t = await root.post('/api/admin/instance/scim/tokens', { name: 'Okta' });
    expect(t.status, t.body).toBe(200);
    const token = t.json.token as string;
    const res = await h.app.inject({ method: 'GET', url: '/api/scim/v2/Users', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).totalResults).toBeGreaterThanOrEqual(1);
  });

  it('lists SSO connections and discovers none for unknown domains', async () => {
    const alice = await h.user('alice');
    await org(alice, 'acme');
    const r = await alice.get('/api/sso/acme/connections');
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual([]);
    expect((await h.anon.get('/api/auth/sso/discover?email=x@nowhere.test')).json.provider).toBeNull();
  });

  it('reports BOM watch state and refuses to enable it without pricing', async () => {
    const alice = await h.user('alice');
    await h.repo(alice, 'board');
    const w = await alice.get('/api/repos/alice/board/bom-watch');
    expect(w.status, w.body).toBe(200);
    expect(w.json.enabled).toBe(false);
    expect((await alice.put('/api/repos/alice/board/bom-watch', { enabled: true, boards: 10 })).status).toBe(409);
  });

  it('starts repositories from the ESP32, STM32 and RP2040 templates', async () => {
    const alice = await h.user('alice');
    const list = await h.anon.get('/api/templates');
    expect(list.json.map((t: { id: string }) => t.id)).toEqual(['esp32-s3', 'stm32', 'rp2040']);
    for (const id of ['esp32-s3', 'stm32', 'rp2040']) {
      const r = await alice.post('/api/repos', { name: `board-${id}`, visibility: 'public', template: id });
      expect(r.status, r.body).toBe(200);
      const tree = await alice.get(`/api/repos/alice/board-${id}/tree`);
      expect(tree.status, tree.body).toBe(200);
      const names = JSON.stringify(tree.json);
      for (const f of [`${id}.kicad_pro`, `${id}.kicad_sch`, `${id}.kicad_pcb`, '.jumper.yml', 'README.md']) expect(names).toContain(f);
    }
    expect((await alice.post('/api/repos', { name: 'nope', visibility: 'public', template: 'z80' })).status).toBe(400);
  });

  it('turns on two-factor login and then asks for a code at sign-in', async () => {
    const alice = await h.user('alice');
    expect((await alice.get('/api/user/two-factor')).json).toMatchObject({ enabled: false });
    const setup = await alice.post('/api/user/two-factor/setup');
    expect(setup.status, setup.body).toBe(200);
    expect(setup.json.uri).toMatch(/^otpauth:\/\/totp\//);
    expect((await alice.post('/api/user/two-factor/enable', { code: '000000' })).status).toBe(400);
    const on = await alice.post('/api/user/two-factor/enable', { code: totpAt(setup.json.secret, Date.now()) });
    expect(on.status, on.body).toBe(200);
    expect(on.json.recoveryCodes).toHaveLength(10);

    const login = (body: Record<string, string>) => h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'alice', password: 'correct-horse-battery', ...body } });
    const noCode = await login({});
    expect(noCode.statusCode).toBe(401);
    expect(JSON.parse(noCode.body).error).toBe('two_factor_required');
    expect((await login({ code: totpAt(setup.json.secret, Date.now()) })).statusCode).toBe(200);
    // A recovery code works once.
    expect((await login({ code: on.json.recoveryCodes[0] })).statusCode).toBe(200);
    expect((await login({ code: on.json.recoveryCodes[0] })).statusCode).toBe(401);
  });
});
