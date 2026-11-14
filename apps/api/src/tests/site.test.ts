import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, emailVerifications, passwordResets, sessions, sql } from '@jumper/db';
import { housekeeping } from '../modules/scheduler/housekeeping';
import { createHarness, dbAvailable, type Harness } from '../testing/harness';

const DAY = 24 * 3600 * 1000;

describe.skipIf(!dbAvailable)('site info', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ env: { OPERATOR_NAME: 'Acme Hardware Ltd', OPERATOR_EMAIL: 'legal@acme.test', OPERATOR_JURISDICTION: 'England and Wales', LEGAL_UPDATED: '2026-11-01' } });
  });
  afterAll(() => h.close());

  it('serves the operator details publicly', async () => {
    const r = await h.anon.get('/api/site');
    expect(r.status).toBe(200);
    expect(r.json.operator).toEqual({ name: 'Acme Hardware Ltd', email: 'legal@acme.test', jurisdiction: 'England and Wales' });
    expect(r.json.legalUpdated).toBe('2026-11-01');
    expect(r.json.name).toBe('Jumper');
  });
});

describe.skipIf(!dbAvailable)('housekeeping', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ env: { AUDIT_RETENTION_DAYS: '30' } });
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  it('deletes expired sessions, stale tokens and old security-log entries, and keeps the rest', async () => {
    await h.user('alice');
    const userId = ((await h.ctx.db.execute(sql`select id from users where username = 'alice'`)) as unknown as { id: string }[])[0]!.id;
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    await h.ctx.db.insert(sessions).values([
      { id: 'expired', userId: userId, expiresAt: ago(1) },
      { id: 'live', userId: userId, expiresAt: ago(-5) },
    ]);
    await h.ctx.db.insert(passwordResets).values([
      { userId: userId, tokenHash: 'old', expiresAt: ago(3) },
      { userId: userId, tokenHash: 'recent', expiresAt: ago(0.5) },
    ]);
    await h.ctx.db.insert(emailVerifications).values({ userId: userId, email: 'a@x.test', tokenHash: 'v-old', expiresAt: ago(2) });
    await h.ctx.db.insert(auditLog).values([
      { actorId: userId, action: 'test.old', createdAt: ago(31) },
      { actorId: userId, action: 'test.new', createdAt: ago(29) },
    ]);

    const r = await housekeeping(h.ctx, now);
    expect(r).toMatchObject({ sessions: 1, passwordResets: 1, emailVerifications: 1, auditLog: 1 });
    const ids = ((await h.ctx.db.execute(sql`select id from sessions`)) as unknown as { id: string }[]).map((x) => x.id);
    expect(ids).toContain('live');
    expect(ids).not.toContain('expired');
    const actions = ((await h.ctx.db.execute(sql`select action from audit_log where action like 'test.%'`)) as unknown as { action: string }[]).map((x) => x.action);
    expect(actions).toEqual(['test.new']);
    // Running again finds nothing more to do.
    expect(await housekeeping(h.ctx, now)).toMatchObject({ sessions: 0, passwordResets: 0, emailVerifications: 0, auditLog: 0, notifications: 0, outputs: 0, webhookDeliveries: 0, held: false });
  });
});

describe.skipIf(!dbAvailable)('initializing an empty repository', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  it('fills an empty repository with the example board, once', async () => {
    const alice = await h.user('alice');
    expect((await alice.post('/api/repos', { name: 'empty', initReadme: false, visibility: 'public' })).json.isEmpty).toBe(true);
    const res = await alice.post('/api/repos/alice/empty/initialize', { kind: 'sample' });
    expect(res.status, res.body).toBe(200);
    expect(res.json.isEmpty).toBe(false);
    const tree = await alice.get('/api/repos/alice/empty/tree?ref=main');
    expect(tree.json.entries.map((e: { name: string }) => e.name)).toEqual(expect.arrayContaining(['led-indicator.kicad_pcb', 'README.md', '.jumper.yml', '.gitignore']));
    expect((await alice.post('/api/repos/alice/empty/initialize', { kind: 'readme' })).status).toBe(409);
  });

  it('needs write access', async () => {
    const alice = await h.user('alice');
    const bob = await h.user('bob');
    await alice.post('/api/repos', { name: 'empty', initReadme: false, visibility: 'public' });
    expect((await bob.post('/api/repos/alice/empty/initialize', { kind: 'readme' })).status).toBe(403);
    expect((await h.anon.post('/api/repos/alice/empty/initialize', { kind: 'readme' })).status).toBe(401);
    expect((await alice.get('/api/repos/alice/empty')).json.isEmpty).toBe(true);
  });
});
