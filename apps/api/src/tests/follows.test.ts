// Following people: counts on the profile, lists, idempotency and the guards around it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@jumper/db';
import { createHarness, dbAvailable, type Harness } from '../testing/harness';

describe.skipIf(!dbAvailable)('followers and following', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  it('follows, lists and unfollows, idempotently', async () => {
    const alice = await h.user('alice');
    const bob = await h.user('bob');
    const carol = await h.user('carol');

    expect((await bob.put('/api/user/following/Alice')).status).toBe(200);
    expect((await bob.put('/api/user/following/alice')).json).toMatchObject({ followers: 1, viewerFollows: true });
    await carol.put('/api/user/following/alice');
    await alice.put('/api/user/following/bob');

    const profile = await bob.get('/api/namespaces/alice');
    expect(profile.json).toMatchObject({ followers: 2, following: 1, viewerFollows: true });
    expect((await h.anon.get('/api/namespaces/alice')).json.viewerFollows).toBe(false);

    const followers = await alice.get('/api/users/alice/followers');
    expect(followers.json.users.map((u: { username: string }) => u.username).sort()).toEqual(['bob', 'carol']);
    // alice follows bob back, carol she does not.
    expect(Object.fromEntries(followers.json.users.map((u: { username: string; viewerFollows: boolean }) => [u.username, u.viewerFollows]))).toEqual({ bob: true, carol: false });
    expect((await h.anon.get('/api/users/alice/following')).json.users.map((u: { username: string }) => u.username)).toEqual(['bob']);

    expect((await bob.del('/api/user/following/alice')).json).toMatchObject({ followers: 1, viewerFollows: false });
    expect((await bob.del('/api/user/following/alice')).status).toBe(200);
  });

  it('refuses self-follows, anonymous writes, unknown and disabled users', async () => {
    const alice = await h.user('alice');
    await h.user('dave');
    expect((await alice.put('/api/user/following/alice')).status).toBe(400);
    expect((await h.anon.put('/api/user/following/alice')).status).toBe(401);
    expect((await alice.put('/api/user/following/nobody-here')).status).toBe(404);
    expect((await h.anon.get('/api/users/nobody-here/followers')).status).toBe(404);

    await alice.put('/api/user/following/dave');
    await h.ctx.db.execute(sql`update users set disabled = true where username = 'dave'`);
    expect((await alice.get('/api/users/alice/following')).json.users).toEqual([]);
    expect((await alice.get('/api/namespaces/alice')).json.following).toBe(0);
    expect((await h.anon.get('/api/users/dave/followers')).status).toBe(404);
  });
});
