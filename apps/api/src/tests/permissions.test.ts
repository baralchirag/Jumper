import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, namespaces, repositories, users } from '@jumper/db';
import { permissionFor, permissionsFor } from '../modules/repos/access';
import { createHarness, dbAvailable, type Harness } from '../testing/harness';

describe.skipIf(!dbAvailable)('batched permissions match the per-repository rules', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await h.reset();
  });
  afterAll(() => h.close());

  it('agrees for owners, collaborators, org members, admins, outsiders and anonymous viewers', async () => {
    const alice = await h.user('alice');
    const bob = await h.user('bob');
    await h.user('carol');
    const dave = await h.user('dave');
    await h.repo(alice, 'pub');
    await h.repo(alice, 'priv', { visibility: 'private' });
    await h.repo(bob, 'bobs', { visibility: 'private' });
    expect((await alice.put('/api/repos/alice/priv/collaborators/bob', { role: 'write' })).status).toBe(200);
    expect((await alice.put('/api/repos/alice/pub/collaborators/carol', { role: 'admin' })).status).toBe(200);
    expect((await alice.post('/api/orgs', { slug: 'acme', name: 'Acme' })).status).toBe(200);
    expect((await alice.put('/api/orgs/acme/members', { username: 'dave', role: 'member' })).status).toBe(200);
    expect((await alice.post('/api/repos', { owner: 'acme', name: 'orgrepo', visibility: 'private', initReadme: false })).status).toBe(200);
    await h.ctx.db.execute(`update users set is_admin = true where username = 'carol'`);

    const rows = await h.ctx.db
      .select({ repo: repositories, ns: namespaces })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const all = await h.ctx.db.select().from(users);
    for (const viewer of [null, ...all]) {
      const batched = await permissionsFor(h.ctx, viewer, rows);
      const single = await Promise.all(rows.map((r) => permissionFor(h.ctx, viewer, r.repo, r.ns)));
      expect(batched, viewer?.username ?? 'anonymous').toEqual(single);
    }
    void bob;
    void dave;
  });
});
