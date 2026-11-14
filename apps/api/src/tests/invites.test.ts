// Organization invite links: who can make them, single use, expiry, revoking, previews and seat limits.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@jumper/db';
import { createHarness, dbAvailable, type Harness } from '../testing/harness';

describe.skipIf(!dbAvailable)('organization invite links', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  const tokenOf = (link: string) => link.split('/invite/')[1]!;

  it('lets an owner invite, previews the link and adds whoever accepts it, once', async () => {
    const alice = await h.user('alice');
    const bob = await h.user('bob');
    const carol = await h.user('carol');
    await alice.post('/api/orgs', { slug: 'acme', name: 'Acme Boards' });

    expect((await bob.post('/api/orgs/acme/invites', {})).status).toBe(403);
    const made = await alice.post('/api/orgs/acme/invites', { role: 'member', repoRole: 'read', email: 'bob@example.test' });
    expect(made.status).toBe(200);
    expect(made.json.link).toContain('/invite/');
    const t = tokenOf(made.json.link);

    const list = await alice.get('/api/orgs/acme/invites');
    expect(list.json).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toContain(t);

    const preview = await h.anon.get(`/api/invites/${t}`);
    expect(preview.json).toMatchObject({ org: { slug: 'acme', name: 'Acme Boards' }, role: 'member', invitedBy: 'alice', alreadyMember: false });
    expect((await h.anon.post(`/api/invites/${t}/accept`)).status).toBe(401);

    expect((await bob.post(`/api/invites/${t}/accept`)).json).toEqual({ org: 'acme' });
    const ns = await alice.get('/api/namespaces/acme');
    expect(ns.json.members.map((m: { username: string }) => m.username).sort()).toEqual(['alice', 'bob']);
    const [row] = (await h.ctx.db.execute(sql`select m.repo_role from org_members m join users u on u.id = m.user_id where u.username = 'bob'`)) as unknown as [{ repo_role: string }];
    expect(row.repo_role).toBe('read');

    // Used: gone for everyone else, and off the pending list.
    expect((await carol.post(`/api/invites/${t}/accept`)).status).toBe(404);
    expect((await h.anon.get(`/api/invites/${t}`)).status).toBe(404);
    expect((await alice.get('/api/orgs/acme/invites')).json).toHaveLength(0);
  });

  it('refuses expired, revoked and unknown links, and existing members', async () => {
    const alice = await h.user('alice');
    const bob = await h.user('bob');
    await alice.post('/api/orgs', { slug: 'acme', name: 'Acme' });

    const a = await alice.post('/api/orgs/acme/invites', {});
    await h.ctx.db.execute(sql`update org_invites set expires_at = now() - interval '1 minute' where id = ${a.json.id}`);
    expect((await bob.post(`/api/invites/${tokenOf(a.json.link)}/accept`)).status).toBe(404);

    const b = await alice.post('/api/orgs/acme/invites', {});
    expect((await alice.del(`/api/orgs/acme/invites/${b.json.id}`)).status).toBe(200);
    expect((await bob.post(`/api/invites/${tokenOf(b.json.link)}/accept`)).status).toBe(404);

    expect((await h.anon.get('/api/invites/not-a-real-token-at-all-xyz')).status).toBe(404);

    const c = await alice.post('/api/orgs/acme/invites', {});
    expect((await alice.post(`/api/invites/${tokenOf(c.json.link)}/accept`)).status).toBe(409);
  });
});
