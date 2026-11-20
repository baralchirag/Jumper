// The inbox: stock and end-of-life alerts on watched repositories.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notifications } from '@jumper/db';
import { createHarness, dbAvailable, type Harness } from '../testing/harness';

describe.skipIf(!dbAvailable)('notifications', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  it('requires login, marks read, and is scoped to the owner', async () => {
    const alice = await h.user('alice');
    const bob = await h.user('bob');
    const board = await h.repo(alice, 'board');
    expect((await h.anon.get('/api/notifications')).status).toBe(401);
    // A stock alert, the kind of notification Jumper sends.
    const me = (await alice.get('/api/auth/me')).json;
    await h.ctx.db.insert(notifications).values({ userId: me.id, repoId: board.id, kind: 'stock', title: 'U3 is out of stock' });
    const a = await alice.get('/api/notifications');
    expect(a.json.unread).toBe(1);
    expect((await bob.get('/api/notifications')).json.items).toHaveLength(0);
    // Marking someone else's notification id as read must not affect it.
    await bob.post('/api/notifications/read', { ids: [a.json.items[0].id] });
    expect((await alice.get('/api/notifications?unread=true')).json.unread).toBe(1);
    await alice.post('/api/notifications/read', {});
    expect((await alice.get('/api/notifications?unread=true')).json.unread).toBe(0);
  });
});
