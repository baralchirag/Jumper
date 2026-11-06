import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { commitFiles, createHarness, dbAvailable, type Client, type Harness } from '../testing/harness';

describe.skipIf(!dbAvailable)('issues, discussions, milestones', () => {
  let h: Harness;
  let alice: Client, bob: Client, carol: Client;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
    bob = await h.user('bob');
    carol = await h.user('carol');
    await h.repo(alice, 'board');
  });

  it('creates issues with sequential numbers and lists them', async () => {
    const a = await bob.post('/api/repos/alice/board/issues', { title: 'LED too dim', body: 'R5 is 10k', locations: [{ type: 'part', ref: 'R5' }] });
    expect(a.status).toBe(200);
    expect(a.json.number).toBe(1);
    const b = await bob.post('/api/repos/alice/board/issues', { title: 'Second' });
    expect(b.json.number).toBe(2);
    const list = await h.anon.get('/api/repos/alice/board/issues');
    expect(list.status).toBe(200);
    expect(list.json.total).toBe(2);
    expect(list.json.items[0].title).toBe('Second');
  });

  it('requires login to create and rejects invalid input', async () => {
    expect((await h.anon.post('/api/repos/alice/board/issues', { title: 'x' })).status).toBe(401);
    expect((await bob.post('/api/repos/alice/board/issues', { title: '' })).status).toBe(400);
    expect((await bob.post('/api/repos/alice/board/issues', { title: 'x', locations: [{ type: 'bogus', ref: 'a' }] })).status).toBe(400);
  });

  it('read-only users cannot triage (labels, assignee, milestone are dropped on create)', async () => {
    const m = await alice.post('/api/repos/alice/board/milestones', { title: 'Rev B' });
    const res = await bob.post('/api/repos/alice/board/issues', { title: 'x', labels: ['bug'], assignee: 'alice', milestoneId: m.json.id });
    expect(res.json.labels).toEqual([]);
    expect(res.json.assignee).toBeNull();
    expect(res.json.milestone).toBeNull();
    const patch = await bob.patch(`/api/repos/alice/board/issues/${res.json.number}`, { labels: ['bug'] });
    expect(patch.status).toBe(403);
  });

  it('lets the author close their own issue but not others', async () => {
    const res = await bob.post('/api/repos/alice/board/issues', { title: 'mine' });
    expect((await carol.patch('/api/repos/alice/board/issues/1', { state: 'closed' })).status).toBe(403);
    const closed = await bob.patch('/api/repos/alice/board/issues/1', { state: 'closed' });
    expect(closed.status).toBe(200);
    expect(closed.json.state).toBe('closed');
    expect(closed.json.closedAt).not.toBeNull();
    const reopened = await alice.patch(`/api/repos/alice/board/issues/${res.json.number}`, { state: 'open' });
    expect(reopened.json.closedAt).toBeNull();
  });

  it('keeps issues and discussions separate', async () => {
    await bob.post('/api/repos/alice/board/issues', { title: 'bug' });
    await bob.post('/api/repos/alice/board/issues', { title: 'idea', kind: 'discussion' });
    expect((await h.anon.get('/api/repos/alice/board/issues?kind=discussion')).json.items.map((i: any) => i.title)).toEqual(['idea']);
    expect((await h.anon.get('/api/repos/alice/board/issues')).json.items.map((i: any) => i.title)).toEqual(['bug']);
  });

  it('searches safely (LIKE wildcards are escaped)', async () => {
    await bob.post('/api/repos/alice/board/issues', { title: '100% broken' });
    await bob.post('/api/repos/alice/board/issues', { title: 'fine' });
    expect((await h.anon.get('/api/repos/alice/board/issues?q=' + encodeURIComponent('%'))).json.total).toBe(1);
    expect((await h.anon.get('/api/repos/alice/board/issues?q=' + encodeURIComponent("'; drop table users;--"))).json.total).toBe(0);
  });

  it('comments, edits and deletes with ownership rules; mentions notify', async () => {
    await bob.post('/api/repos/alice/board/issues', { title: 'help' });
    const c = await carol.post('/api/repos/alice/board/issues/1/comments', { body: 'cc @alice please look' });
    expect(c.status).toBe(200);
    const notes = await alice.get('/api/notifications');
    expect(notes.json.unread).toBeGreaterThanOrEqual(1);
    expect(notes.json.items.some((n: any) => n.kind === 'mention')).toBe(true);
    expect((await bob.patch(`/api/repos/alice/board/issue-comments/${c.json.id}`, { body: 'hijack' })).status).toBe(403);
    expect((await carol.patch(`/api/repos/alice/board/issue-comments/${c.json.id}`, { body: 'edited' })).status).toBe(200);
    expect((await bob.del(`/api/repos/alice/board/issue-comments/${c.json.id}`)).status).toBe(403);
    expect((await alice.del(`/api/repos/alice/board/issue-comments/${c.json.id}`)).status).toBe(200);
  });

  it('does not leak private repositories or notify users who cannot read them', async () => {
    await h.repo(alice, 'secret', { visibility: 'private' });
    expect((await h.anon.get('/api/repos/alice/secret/issues')).status).toBe(404);
    expect((await bob.get('/api/repos/alice/secret/issues')).status).toBe(404);
    expect((await bob.post('/api/repos/alice/secret/issues', { title: 'x' })).status).toBe(404);
    const mine = await alice.post('/api/repos/alice/secret/issues', { title: 'internal', body: 'ping @bob' });
    expect(mine.status).toBe(200);
    expect((await bob.get('/api/notifications')).json.items).toHaveLength(0);
  });

  it("cannot touch another repository's comments by id (IDOR)", async () => {
    await h.repo(alice, 'other');
    const c = await bob.post('/api/repos/alice/board/issues', { title: 'a' }).then(() => bob.post('/api/repos/alice/board/issues/1/comments', { body: 'mine' }));
    const res = await bob.del(`/api/repos/alice/other/issue-comments/${c.json.id}`);
    expect(res.status).toBe(404);
  });

  it('milestones track open/closed counts and reject foreign milestone ids', async () => {
    const m = await alice.post('/api/repos/alice/board/milestones', { title: 'Rev A', dueOn: '2027-01-01T00:00:00.000Z' });
    expect(m.status).toBe(200);
    expect((await alice.post('/api/repos/alice/board/milestones', { title: 'rev a' })).status).toBe(400);
    await alice.post('/api/repos/alice/board/issues', { title: 'one', milestoneId: m.json.id });
    await alice.post('/api/repos/alice/board/issues', { title: 'two', milestoneId: m.json.id });
    await alice.patch('/api/repos/alice/board/issues/2', { state: 'closed' });
    const list = await h.anon.get('/api/repos/alice/board/milestones');
    expect(list.json[0]).toMatchObject({ title: 'Rev A', openIssues: 1, closedIssues: 1 });
    await h.repo(alice, 'other');
    expect((await alice.post('/api/repos/alice/other/issues', { title: 'x', milestoneId: m.json.id })).status).toBe(400);
    expect((await bob.post('/api/repos/alice/board/milestones', { title: 'nope' })).status).toBe(403);
  });
});

describe.skipIf(!dbAvailable)('locks', () => {
  let h: Harness;
  let alice: Client, bob: Client, carol: Client;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
    bob = await h.user('bob');
    carol = await h.user('carol');
    await h.repo(alice, 'board');
    expect((await alice.put('/api/repos/alice/board/collaborators/bob', { role: 'write' })).status).toBe(200);
  });

  it('only collaborators can lock; conflicts are rejected', async () => {
    expect((await h.anon.post('/api/repos/alice/board/locks', { path: 'a.kicad_pcb' })).status).toBe(401);
    expect((await carol.post('/api/repos/alice/board/locks', { path: 'a.kicad_pcb' })).status).toBe(403);
    const l = await alice.post('/api/repos/alice/board/locks', { path: 'a.kicad_pcb', reason: 'routing' });
    expect(l.status).toBe(200);
    expect((await h.anon.get('/api/repos/alice/board/locks')).json).toHaveLength(1);
    const clash = await bob.post('/api/repos/alice/board/locks', { path: 'a.kicad_pcb' });
    expect(clash.status).toBe(409);
    expect(clash.json.message).toContain('locked by alice');
    // Only the owner or a repo admin can release; a second collaborator cannot.
    expect((await bob.del(`/api/repos/alice/board/locks/${l.json.id}`)).status).toBe(403);
    expect((await alice.del(`/api/repos/alice/board/locks/${l.json.id}`)).status).toBe(200);
    expect((await bob.post('/api/repos/alice/board/locks', { path: 'a.kicad_pcb' })).status).toBe(200);
  });

  it('refuses overlapping regions from another user, allows disjoint ones, refreshes own lock', async () => {
    const region = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect((await alice.post('/api/repos/alice/board/locks', { path: 'a.kicad_pcb', region })).status).toBe(200);
    await alice.post('/api/repos/alice/board/locks', { path: 'a.kicad_pcb', region });
    expect((await alice.get('/api/repos/alice/board/locks')).json).toHaveLength(1);
    expect((await bob.post('/api/repos/alice/board/locks', { path: 'a.kicad_pcb', region: { minX: 5, minY: 5, maxX: 15, maxY: 15 } })).status).toBe(409);
    expect((await bob.post('/api/repos/alice/board/locks', { path: 'a.kicad_pcb', region: { minX: 20, minY: 20, maxX: 30, maxY: 30 } })).status).toBe(200);
    expect((await bob.post('/api/repos/alice/board/locks', { path: 'a.kicad_pcb' })).status).toBe(409);
  });

  it('expired locks no longer block', async () => {
    const l = await alice.post('/api/repos/alice/board/locks', { path: 'b.kicad_pcb', ttlMinutes: 1 });
    await h.ctx.db.execute(`update file_locks set expires_at = now() - interval '1 minute' where id = '${l.json.id}'`);
    expect((await bob.post('/api/repos/alice/board/locks', { path: 'b.kicad_pcb' })).status).toBe(200);
  });

  it('rejects malformed regions and absurd lifetimes', async () => {
    expect((await alice.post('/api/repos/alice/board/locks', { path: 'a', region: { minX: 5, minY: 0, maxX: 1, maxY: 1 } })).status).toBe(400);
    expect((await alice.post('/api/repos/alice/board/locks', { path: 'a', ttlMinutes: 10 ** 7 })).status).toBe(400);
  });
});

describe.skipIf(!dbAvailable)('review rules and merge gates', () => {
  let h: Harness;
  let alice: Client, bob: Client;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
    bob = await h.user('bob');
  });

  async function setup(opts: { bobWrites?: boolean } = {}) {
    const repo = await h.repo(alice, 'board');
    if (opts.bobWrites) expect((await alice.put('/api/repos/alice/board/collaborators/bob', { role: 'write' })).status).toBe(200);
    const base = await commitFiles(repo.git, { 'power/ldo.kicad_sch': '(a)', 'README.md': 'x' }, { branch: 'main' });
    await commitFiles(repo.git, { 'power/ldo.kicad_sch': '(b)', 'README.md': 'x' }, { branch: 'feature', parent: base });
    return repo;
  }

  it('only repo admins manage approval rules; patterns are validated', async () => {
    await setup();
    expect((await bob.post('/api/repos/alice/board/approval-rules', { name: 'Power', pathPattern: 'power/**' })).status).toBe(403);
    expect((await alice.post('/api/repos/alice/board/approval-rules', { name: '', pathPattern: 'x' })).status).toBe(400);
    expect((await alice.post('/api/repos/alice/board/approval-rules', { name: 'Power', pathPattern: 'power/**', approvers: ['nobody'] })).status).toBe(400);
    expect((await alice.post('/api/repos/alice/board/approval-rules', { name: 'Power', pathPattern: 'power/**', requiredApprovals: 2, approvers: ['bob'] })).status).toBe(400);
    const ok = await alice.post('/api/repos/alice/board/approval-rules', { name: 'Power', pathPattern: 'power/**', approvers: ['bob'] });
    expect(ok.status).toBe(200);
    const list = await h.anon.get('/api/repos/alice/board/approval-rules');
    expect(list.json[0].approvers[0].username).toBe('bob');
  });

  it('blocks merge until the named approver signs off, and ignores unrelated paths', async () => {
    await setup({ bobWrites: true });
    const rule = await alice.post('/api/repos/alice/board/approval-rules', { name: 'Power', pathPattern: 'power/**', approvers: ['bob'] });
    expect(rule.status).toBe(200);
    const pr = await alice.post('/api/repos/alice/board/pulls', { title: 'LDO tweak', base: 'main', head: 'feature' });
    expect(pr.status).toBe(200);
    const detail = await alice.get(`/api/repos/alice/board/pulls/${pr.json.number}`);
    expect(detail.json.mergeability.blockers.some((b: string) => b.startsWith('Power:'))).toBe(true);
    const rv = await bob.post(`/api/repos/alice/board/pulls/${pr.json.number}/reviews`, { state: 'approved', body: 'LGTM' });
    expect(rv.status).toBe(200);
    const after = await alice.get(`/api/repos/alice/board/pulls/${pr.json.number}`);
    expect(after.json.mergeability.blockers.some((b: string) => b.startsWith('Power:'))).toBe(false);
  });

  it('seeds the checklist from the template once and can require it for merging', async () => {
    await setup();
    const cfg = await alice.put('/api/repos/alice/board/config', { checklistTemplate: ['ERC clean', 'BOM checked'], requireChecklist: true });
    expect(cfg.status).toBe(200);
    const pr = await alice.post('/api/repos/alice/board/pulls', { title: 'x', base: 'main', head: 'feature' });
    const n = pr.json.number;
    const list = await alice.get(`/api/repos/alice/board/pulls/${n}/checklist`);
    expect(list.json.map((i: any) => i.text)).toEqual(['ERC clean', 'BOM checked']);
    expect((await alice.get(`/api/repos/alice/board/pulls/${n}/checklist`)).json).toHaveLength(2);
    let m = await alice.get(`/api/repos/alice/board/pulls/${n}`);
    expect(m.json.mergeability.blockers.some((b: string) => b.includes('checklist'))).toBe(true);
    for (const item of list.json) await alice.patch(`/api/repos/alice/board/pulls/${n}/checklist/${item.id}`, { done: true });
    m = await alice.get(`/api/repos/alice/board/pulls/${n}`);
    expect(m.json.mergeability.blockers.some((b: string) => b.includes('checklist'))).toBe(false);
  });

  it('a non-collaborator cannot tick checklist items or change config', async () => {
    await setup();
    await alice.put('/api/repos/alice/board/config', { checklistTemplate: ['a'] });
    const pr = await alice.post('/api/repos/alice/board/pulls', { title: 'x', base: 'main', head: 'feature' });
    const list = await alice.get(`/api/repos/alice/board/pulls/${pr.json.number}/checklist`);
    expect((await bob.patch(`/api/repos/alice/board/pulls/${pr.json.number}/checklist/${list.json[0].id}`, { done: true })).status).toBe(403);
    expect((await bob.put('/api/repos/alice/board/config', { fabProfiles: [] })).status).toBe(403);
    expect((await alice.put('/api/repos/alice/board/config', { fabProfiles: ['not-a-fab'] })).status).toBe(400);
  });

  it("whole-file locks held by someone else block the merge", async () => {
    await setup({ bobWrites: true });
    expect((await bob.post('/api/repos/alice/board/locks', { path: 'power/ldo.kicad_sch', reason: 'editing' })).status).toBe(200);
    const pr = await alice.post('/api/repos/alice/board/pulls', { title: 'x', base: 'main', head: 'feature' });
    const d = await alice.get(`/api/repos/alice/board/pulls/${pr.json.number}`);
    expect(d.json.mergeability.blockers.some((b: string) => b.includes('locked by another user'))).toBe(true);
  });
});

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
    await h.repo(alice, 'board');
    expect((await h.anon.get('/api/notifications')).status).toBe(401);
    await bob.post('/api/repos/alice/board/issues', { title: 'hey @alice' });
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
