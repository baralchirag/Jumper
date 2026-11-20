import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { artifacts, checkRuns, eq, repositories, sql } from '@jumper/db';
import { resolvePlans } from '@jumper/shared';
import { createHarness, dbAvailable, type Harness } from '../testing/harness';

const run = promisify(execFile);
const MB = 1024 * 1024;

describe('plan limits', () => {
  it('applies operator overrides and ignores junk', () => {
    const plans = resolvePlans({ free: { storageMb: 10, seats: null, checkMinutes: -5 }, bogus: { seats: 1 }, pro: 'x' });
    expect(plans.free.limits).toEqual({ storageMb: 10, checkMinutes: 500, seats: null });
    expect(plans.pro.limits.storageMb).toBe(20_480);
  });
});

describe.skipIf(!dbAvailable)('usage reporting', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  it('adds up storage, this month’s check minutes per commit, and seats', async () => {
    const alice = await h.user('alice');
    await h.user('bob');
    await h.user('carol');
    const repo = await h.repo(alice, 'board', { visibility: 'private' });
    await h.ctx.db.update(repositories).set({ sizeBytes: 3 * MB }).where(eq(repositories.id, repo.id));
    await h.ctx.db.insert(artifacts).values({ repoId: repo.id, sha: 'a'.repeat(40), kind: 'gerbers', name: 'g.zip', storageKey: 'k', contentType: 'application/zip', size: 2 * MB });
    const now = Date.now();
    const at = (s: number) => new Date(now - s * 1000);
    // Commit A: two checks overlapping, 0–90 s of wall clock → 2 minutes. Commit B: 10 s → 1 minute.
    // A run from last month must not count.
    await h.ctx.db.insert(checkRuns).values([
      { repoId: repo.id, sha: 'a'.repeat(40), name: 'ERC', status: 'completed', startedAt: at(100), completedAt: at(40) },
      { repoId: repo.id, sha: 'a'.repeat(40), name: 'DRC', status: 'completed', startedAt: at(95), completedAt: at(10) },
      { repoId: repo.id, sha: 'b'.repeat(40), name: 'ERC', status: 'completed', startedAt: at(20), completedAt: at(10) },
      { repoId: repo.id, sha: 'c'.repeat(40), name: 'ERC', status: 'completed', startedAt: new Date('2020-01-01T00:00:00Z'), completedAt: new Date('2020-01-01T01:00:00Z') },
    ]);
    expect((await alice.put('/api/repos/alice/board/collaborators/bob', { role: 'write' })).status).toBe(200);

    const r = await alice.get('/api/usage/alice');
    expect(r.status, r.body).toBe(200);
    expect(r.json.plan.id).toBe('free');
    expect(r.json.enforced).toBe(false);
    expect(r.json.usage.storage).toEqual({ repositories: 3 * MB, outputs: 2 * MB, largeFiles: 0 });
    expect(r.json.usage.storageBytes).toBe(5 * MB);
    // The ISO month boundary may fall inside the test's 100 s window only at 00:00 on the 1st; accept 2 or 3.
    expect([2, 3]).toContain(r.json.usage.checkMinutes);
    expect(r.json.usage.seats).toBe(2); // alice + bob on a private repo
    expect(r.json.repositories[0]).toMatchObject({ name: 'board', sizeBytes: 3 * MB, outputsBytes: 2 * MB });
  });

  it('is private to the owner, organization members and administrators', async () => {
    const alice = await h.user('alice');
    const bob = await h.user('bob');
    expect((await bob.get('/api/usage/alice')).status).toBe(404);
    expect((await alice.post('/api/orgs', { slug: 'acme', name: 'Acme' })).status).toBe(200);
    expect((await bob.get('/api/usage/acme')).status).toBe(404);
    expect((await alice.put('/api/orgs/acme/members', { username: 'bob', role: 'member' })).status).toBe(200);
    const org = await bob.get('/api/usage/acme');
    expect(org.status).toBe(200);
    expect(org.json.usage.seats).toBe(2);
  });

  it('lets administrators assign plans', async () => {
    const alice = await h.user('alice');
    const root = await h.user('root');
    await h.ctx.db.execute(sql`update users set is_admin = true where username = 'root'`);
    expect((await alice.put('/api/admin/namespaces/alice/plan', { plan: 'pro' })).status).toBe(403);
    const r = await root.put('/api/admin/namespaces/alice/plan', { plan: 'team' });
    expect(r.status, r.body).toBe(200);
    expect(r.json.plan.id).toBe('team');
    expect((await alice.get('/api/usage/alice')).json.plan.name).toBe('Business');
    expect((await root.put('/api/admin/namespaces/alice/plan', { plan: 'platinum' })).status).toBe(400);
    expect((await h.anon.get('/api/plans')).json.plans.map((p: { id: string }) => p.id)).toEqual(['free', 'pro', 'team', 'enterprise']);
  });
});

describe.skipIf(!dbAvailable)('enforced plan limits', () => {
  let h: Harness;
  let base: string;
  beforeAll(async () => {
    h = await createHarness({ env: { PLANS_ENFORCED: 'true', PLAN_LIMITS: JSON.stringify({ free: { seats: 2, storageMb: 1 } }) } });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    base = `127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  it('stops an organization at its seat limit, but not role changes of existing members', async () => {
    const alice = await h.user('alice');
    await h.user('bob');
    await h.user('carol');
    // Organizations need a paid plan on an enforced instance; the org itself starts on Free (2 seats in this test).
    await h.ctx.db.execute(sql`update namespaces set plan = 'pro' where slug = 'alice'`);
    expect((await alice.post('/api/orgs', { slug: 'acme', name: 'Acme' })).status).toBe(200);
    expect((await alice.put('/api/orgs/acme/members', { username: 'bob', role: 'member' })).status).toBe(200);
    const full = await alice.put('/api/orgs/acme/members', { username: 'carol', role: 'member' });
    expect(full.status).toBe(403);
    expect(full.json.error).toBe('plan_limit');
    expect(full.json.message).toContain('2 seats');
    expect((await alice.put('/api/orgs/acme/members', { username: 'bob', role: 'owner' })).status).toBe(200);
  });

  it('counts collaborators on private repositories only', async () => {
    const alice = await h.user('alice');
    await h.user('bob');
    await h.user('carol');
    await h.repo(alice, 'open', { visibility: 'public' });
    await h.repo(alice, 'secret', { visibility: 'private' });
    expect((await alice.put('/api/repos/alice/open/collaborators/bob', { role: 'write' })).status).toBe(200);
    expect((await alice.put('/api/repos/alice/open/collaborators/carol', { role: 'write' })).status).toBe(200);
    expect((await alice.put('/api/repos/alice/secret/collaborators/bob', { role: 'write' })).status).toBe(200);
    expect((await alice.put('/api/repos/alice/secret/collaborators/carol', { role: 'write' })).status).toBe(403);
  });

  it('refuses pushes over the storage limit with a readable git error, but still allows deleting branches', async () => {
    const alice = await h.user('alice');
    const repo = await h.repo(alice, 'board');
    const tok = (await alice.post('/api/user/tokens', { name: 't', scopes: ['repo:write'], expiresInDays: 1 })).json.token as string;
    const work = await mkdtemp(join(tmpdir(), 'jumper-work-'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = (...args: string[]) => run('git', args, { cwd: work, env, timeout: 30_000 });
    const url = `http://alice:${tok}@${base}/alice/board.git`;
    const push = async (...refspec: string[]) => {
      try {
        await git('push', url, ...refspec);
        return { ok: true, err: '' };
      } catch (e) {
        return { ok: false, err: String((e as { stderr?: string }).stderr ?? e) };
      }
    };
    try {
      await git('init', '-q', '-b', 'main');
      await writeFile(join(work, 'a.txt'), 'hello');
      await git('add', '.');
      await git('commit', '-q', '-m', 'one');
      expect((await push('main', 'main:old')).ok).toBe(true);

      // Push the owner past the 1 MB limit with generated outputs (push processing rewrites sizeBytes, not these).
      await h.ctx.db.insert(artifacts).values({ repoId: repo.id, sha: 'f'.repeat(40), kind: 'gerbers', name: 'big.zip', storageKey: 'k', contentType: 'application/zip', size: 2 * MB });
      await writeFile(join(work, 'b.txt'), 'more');
      await git('add', '.');
      await git('commit', '-q', '-m', 'two');
      const refused = await push('main');
      expect(refused.ok).toBe(false);
      expect(refused.err).toContain('over its storage limit');
      expect(refused.err).toContain('Settings → Usage');
      expect((await push(':old')).ok).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
