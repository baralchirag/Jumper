// Profiles (pins, stats), referrals and the embeddable viewer.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@jumper/db';
import { commitFiles, createHarness, dbAvailable, type Harness } from '../testing/harness';

describe.skipIf(!dbAvailable)('profiles, referrals and embeds', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ env: { PLANS_ENFORCED: 'true', REFERRAL_BONUS_MB: '1024', REFERRAL_MAX_BONUS_MB: '2048' } });
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  it('pins repositories to a profile and counts public work', async () => {
    const alice = await h.user('alice');
    const bob = await h.user('bob');
    await h.repo(alice, 'one');
    await h.repo(alice, 'two');
    await h.repo(alice, 'hidden', { visibility: 'private' });
    expect((await bob.put('/api/namespaces/alice/pins', { repos: ['one'] })).status).toBe(403);
    expect((await alice.put('/api/namespaces/alice/pins', { repos: ['nope'] })).status).toBe(400);
    expect((await alice.put('/api/namespaces/alice/pins', { repos: ['two', 'hidden', 'one'] })).status).toBe(200);

    const mine = await alice.get('/api/namespaces/alice');
    expect(mine.json.pinned.map((r: { name: string }) => r.name)).toEqual(['two', 'hidden', 'one']);
    // Visitors only see pins they can read, and stats count public work.
    const theirs = await h.anon.get('/api/namespaces/alice');
    expect(theirs.json.pinned.map((r: { name: string }) => r.name)).toEqual(['two', 'one']);
    expect(theirs.json.stats).toEqual({ repos: 2 });
  });

  it('records referrals and adds capped bonus storage to the inviter', async () => {
    const alice = await h.user('alice');
    const before = (await alice.get('/api/usage/alice')).json.plan.limits.storageMb;
    for (const name of ['bob', 'carol', 'dave']) {
      const r = await h.app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: name, email: `${name}@example.com`, password: 'correct-horse-battery', ref: 'Alice' } });
      expect(r.statusCode, r.body).toBe(200);
    }
    // A ref naming nobody is ignored rather than refused.
    expect((await h.app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'erin', email: 'erin@example.com', password: 'correct-horse-battery', ref: 'ghost' } })).statusCode).toBe(200);

    const r = await alice.get('/api/user/referrals');
    expect(r.status, r.body).toBe(200);
    expect(r.json.link).toMatch(/\/signup\?ref=alice$/);
    expect(r.json.invited.map((u: { username: string }) => u.username).sort()).toEqual(['bob', 'carol', 'dave']);
    expect(r.json.counted).toBe(3);
    expect(r.json.bonusMb).toBe(2048);
    const usage = (await alice.get('/api/usage/alice')).json;
    expect(usage.plan.limits.storageMb).toBe(before + 2048);
    expect(usage.referralBonusMb).toBe(2048);
  });

  it('tells the embeddable viewer which board to open, for public repositories only', async () => {
    const alice = await h.user('alice');
    const pub = await h.repo(alice, 'board');
    const priv = await h.repo(alice, 'closed', { visibility: 'private' });
    expect((await h.anon.get('/api/repos/alice/board/embed')).status).toBe(404);
    for (const r of [pub, priv]) {
      const sha = await commitFiles(r.git, { 'hw/main.kicad_pro': '{}', 'hw/main.kicad_pcb': '(kicad_pcb)', 'hw/main.kicad_sch': '(kicad_sch)' });
      await h.ctx.db.execute(sql`update repositories set pushed_at = now() where id = ${r.id}`);
      expect(sha).toBeTruthy();
    }
    const e = await h.anon.get('/api/repos/alice/board/embed');
    expect(e.status, e.body).toBe(200);
    expect(e.json).toMatchObject({ owner: 'alice', repo: 'board', ref: 'main', pcb: 'hw/main.kicad_pcb', sch: 'hw/main.kicad_sch' });
    expect((await alice.get('/api/repos/alice/closed/embed')).status).toBe(404);
  });
});
