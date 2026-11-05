import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitFiles, createHarness, dbAvailable, type Harness } from './harness';

describe.skipIf(!dbAvailable)('harness', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await h.reset();
  });
  afterAll(() => h.close());

  it('registers users, creates repos and commits', async () => {
    const alice = await h.user('alice');
    const me = await alice.get('/api/auth/me');
    expect(me.json.username).toBe('alice');
    expect(me.json.isAdmin).toBe(false);
    const repo = await h.repo(alice, 'board');
    const sha = await commitFiles(repo.git, { 'README.md': '# hi', 'hw/a.kicad_pcb': '(kicad_pcb)' });
    const tree = await alice.get(`/api/repos/alice/board/tree?ref=${sha}`);
    expect(tree.status).toBe(200);
  });

  it('never makes the first user an admin', async () => {
    await h.reset();
    const first = await h.user('first');
    expect((await first.get('/api/auth/me')).json.isAdmin).toBe(false);
    expect((await first.get('/api/admin/overview')).status).toBe(403);
    expect((await h.anon.get('/api/admin/overview')).status).toBe(401);
  });
});
