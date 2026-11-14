// Stage 3-4 features reachable over HTTP: insights, digests, org policy and roles, audit export, billing, SSO
// connections, instance administration, SCIM and BOM watches.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkRuns, eq, pullRequests, reviews, sql, users } from '@jumper/db';
import { createHarness, dbAvailable, type Harness } from '../testing/harness';
import { outbox } from '../modules/mail/mailer';
import { bucketOf, median, weekStart, weekStarts } from '../modules/insights/service';
import { digestIsEmpty, renderDigest, sendDueDigests } from '../modules/digest/service';
import { TASKS } from '../modules/scheduler/scheduler';
import { totpAt } from '../modules/auth/totp';

describe('insight helpers', () => {
  it('buckets by Monday-starting UTC weeks', () => {
    expect(weekStart(new Date('2026-11-18T15:00:00Z')).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(weekStart(new Date('2026-11-16T00:00:00Z')).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(weekStart(new Date('2026-11-22T23:59:00Z')).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    const w = weekStarts(new Date('2026-11-18T00:00:00Z'), 3);
    expect(w.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
    expect(bucketOf(w, new Date('2026-11-10T00:00:00Z'))).toBe(1);
    expect(bucketOf(w, new Date('2026-10-01T00:00:00Z'))).toBe(-1);
  });
  it('takes medians', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('digest rendering', () => {
  const base = { user: { username: 'alice' }, since: new Date('2026-11-11T00:00:00Z'), waiting: [] };
  const quiet = { path: 'alice/board', pullsOpened: [], pullsMerged: [], issuesOpened: [], issuesClosed: 0, releases: [], failedChecks: 0, openAlerts: 0 };
  it('is empty when nothing happened', () => {
    expect(digestIsEmpty({ ...base, repos: [quiet] })).toBe(true);
  });
  it('lists merges, releases and reviews waiting', () => {
    const c = {
      ...base,
      repos: [{ ...quiet, pullsMerged: [{ number: 3, title: 'Move USB connector' }], releases: [{ tag: 'v1.0', name: 'Rev A' }], failedChecks: 2 }],
      waiting: [{ path: 'acme/power', number: 7, title: 'Bigger inductor', ageDays: 4 }],
    };
    expect(digestIsEmpty(c)).toBe(false);
    const { subject, text } = renderDigest(c, 'https://jumper.test/');
    expect(subject).toBe('Your week on Jumper: 1 merge, 1 release, 1 waiting for review');
    expect(text).toContain('Merged #3 Move USB connector');
    expect(text).toContain('https://jumper.test/acme/power/pull/7');
    expect(text).toContain('https://jumper.test/alice/board/releases/tag/v1.0');
    expect(text).toContain('2 failed checks');
    expect(text).toContain('https://jumper.test/settings/notifications');
  });
  it('is scheduled with stock checks', () => {
    expect(Object.keys(TASKS)).toEqual(expect.arrayContaining(['housekeeping', 'mirrors', 'stock', 'digest']));
  });
});

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

  it('reports team insights for members only', async () => {
    const alice = await h.user('alice');
    const bob = await h.user('bob');
    const eve = await h.user('eve');
    await org(alice, 'acme');
    expect((await alice.put('/api/orgs/acme/members', { username: 'bob', role: 'member' })).status).toBe(200);
    const repo = await h.repo(alice, 'board');
    await h.ctx.db.execute(sql`update repositories set namespace_id = (select id from namespaces where slug = 'acme') where id = ${repo.id}`);
    const [aliceId, bobId] = await Promise.all(['alice', 'bob'].map(async (u) => (await h.ctx.db.select().from(users).where(eq(users.username, u)))[0]!.id));
    const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);
    const [merged, open] = await h.ctx.db
      .insert(pullRequests)
      .values([
        { repoId: repo.id, number: 1, title: 'Merged one', authorId: aliceId!, baseRef: 'main', headRef: 'a', baseSha: 'x', headSha: 'y', state: 'merged', mergedAt: hoursAgo(2), createdAt: hoursAgo(10) },
        { repoId: repo.id, number: 2, title: 'Still open', authorId: aliceId!, baseRef: 'main', headRef: 'b', baseSha: 'x', headSha: 'z', createdAt: hoursAgo(50) },
      ])
      .returning();
    await h.ctx.db.insert(reviews).values([
      { pullId: merged!.id, authorId: bobId!, state: 'approved', commitSha: 'y', createdAt: hoursAgo(6) },
      { pullId: open!.id, authorId: aliceId!, state: 'commented', commitSha: 'z', createdAt: hoursAgo(40) },
    ]);
    await h.ctx.db.insert(checkRuns).values([
      { repoId: repo.id, sha: 'y', name: 'drc', status: 'completed', conclusion: 'failure', completedAt: hoursAgo(1) },
      { repoId: repo.id, sha: 'z', name: 'drc', status: 'completed', conclusion: 'success', completedAt: hoursAgo(1) },
    ]);

    const r = await bob.get('/api/owners/acme/insights?weeks=4');
    expect(r.status, r.body).toBe(200);
    expect(r.json.weeks).toHaveLength(4);
    expect(r.json.pulls.merged.reduce((a: number, b: number) => a + b, 0)).toBe(1);
    expect(r.json.pulls.medianHoursToFirstReview).toBe(4);
    expect(r.json.pulls.medianHoursToMerge).toBe(8);
    // The author's own comment is not a review: #2 is still waiting.
    expect(r.json.open).toMatchObject([{ number: 2, waitingForReview: true, approvals: 0 }]);
    expect(r.json.reviewers).toMatchObject([{ user: { username: 'bob' }, reviews: 1, approvals: 1 }]);
    expect(r.json.checks.failureRate).toBe(0.5);
    expect(r.json.checks.worst).toMatchObject([{ repo: 'board', failures: 1, runs: 2 }]);
    expect((await eve.get('/api/owners/acme/insights')).status).toBe(404);
  });

  it('emails a digest once a week and only when something happened', async () => {
    const alice = await h.user('alice');
    await h.user('quiet');
    await h.repo(alice, 'board');
    await alice.post('/api/repos/alice/board/issues', { title: 'Silkscreen overlaps pad' });
    const preview = await alice.get('/api/user/digest/preview');
    expect(preview.status, preview.body).toBe(200);
    expect(preview.json.empty).toBe(false);
    expect(preview.json.text).toContain('Issues: 1 opened');

    const first = await sendDueDigests(h.ctx);
    expect(first.due).toBeGreaterThanOrEqual(2);
    expect(first.sent).toBe(1);
    expect(outbox.filter((m) => m.subject.startsWith('Your week')).map((m) => m.to)).toEqual(['alice@example.com']);
    // Everyone due was marked, so an immediate second run sends nothing.
    expect(await sendDueDigests(h.ctx)).toEqual({ due: 0, sent: 0 });
    // Opting out stops it.
    expect((await alice.patch('/api/user', { digestEmail: false })).status).toBe(200);
    expect(await sendDueDigests(h.ctx, new Date(Date.now() + 8 * 86_400_000))).toMatchObject({ sent: 0 });
  });

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

  it('keeps billing details and lets administrators raise invoices', async () => {
    const alice = await h.user('alice');
    const root = await h.user('root');
    await h.ctx.db.execute(sql`update users set is_admin = true where username = 'root'`);
    const b = await alice.get('/api/owners/alice/billing');
    expect(b.status, b.body).toBe(200);
    expect((await alice.get('/api/admin/invoices')).status).toBe(403);
    expect((await root.get('/api/admin/invoices')).status).toBe(200);
  });

  it('serves instance administration to administrators only', async () => {
    const alice = await h.user('alice');
    const root = await h.user('root');
    await h.ctx.db.execute(sql`update users set is_admin = true where username = 'root'`);
    expect((await alice.get('/api/admin/instance/license')).status).toBe(403);
    for (const path of ['entitlements', 'license', 'retention', 'legal-holds', 'scim/tokens', 'version']) {
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
