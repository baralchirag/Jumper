// The Free plan's storage trial and time-limited invite bonuses.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@jumper/db';
import { createHarness, dbAvailable, type Harness } from '../testing/harness';

describe.skipIf(!dbAvailable)('free storage trial and expiring invite bonuses', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ env: { PLANS_ENFORCED: 'true', FREE_TRIAL_DAYS: '30', FREE_STORAGE_AFTER_TRIAL_MB: '0', REFERRAL_BONUS_MB: '1024', REFERRAL_BONUS_DAYS: '15' } });
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  it('gives 2 GB during the first 30 days and nothing after, unless the plan changes', async () => {
    const alice = await h.user('alice');
    const fresh = await alice.get('/api/usage/alice');
    expect(fresh.json.trial.active).toBe(true);
    expect(fresh.json.plan.limits.storageMb).toBe(2048);

    await h.ctx.db.execute(sql`update namespaces set created_at = now() - interval '31 days' where slug = 'alice'`);
    const ended = await alice.get('/api/usage/alice');
    expect(ended.json.trial.active).toBe(false);
    expect(ended.json.plan.limits.storageMb).toBe(0);

    await h.ctx.db.execute(sql`update namespaces set plan = 'pro' where slug = 'alice'`);
    const pro = await alice.get('/api/usage/alice');
    expect(pro.json.trial).toBeNull();
    expect(pro.json.plan.limits.storageMb).toBe(20_480);
  });

  it('counts each invite bonus for 15 days from the day the person joined', async () => {
    const alice = await h.user('alice');
    await h.anon.post('/api/auth/register', { username: 'bob', email: 'bob@example.test', password: 'bob-password-123', ref: 'alice' });
    await h.anon.post('/api/auth/register', { username: 'carol', email: 'carol@example.test', password: 'carol-password-123', ref: 'alice' });

    let r = await alice.get('/api/user/referrals');
    expect(r.json).toMatchObject({ counted: 2, bonusMb: 2048, bonusDays: 15 });
    expect(r.json.bonusExpiresAt).toBeTruthy();

    await h.ctx.db.execute(sql`update users set created_at = now() - interval '16 days' where username = 'bob'`);
    r = await alice.get('/api/user/referrals');
    expect(r.json).toMatchObject({ counted: 2, bonusMb: 1024 });
    expect(r.json.invited.find((u: { username: string }) => u.username === 'bob').active).toBe(false);
    expect((await alice.get('/api/usage/alice')).json.plan.limits.storageMb).toBe(2048 + 1024);
  });
});
