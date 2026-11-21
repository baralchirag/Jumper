import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitFiles, createHarness, dbAvailable, type Harness } from '../testing/harness';

describe.skipIf(!dbAvailable)('comments on a commit’s design', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await h.reset();
  });
  afterAll(async () => h?.close());

  it('pins threads to parts, keeps replies in the thread, and limits resolve and delete', async () => {
    const owner = await h.user('cc-owner');
    const other = await h.user('cc-other');
    const repo = await h.repo(owner, 'cc-board');
    const sha = await commitFiles(repo.git, { 'board.kicad_pcb': '(kicad_pcb (version 20240108))' });
    const base = `/api/repos/${repo.owner}/${repo.name}/commit-comments`;
    const anchor = { type: 'object', path: 'board.kicad_pcb', commitSha: sha, objectType: 'footprint', objectId: 'uuid-r6', label: 'R6 · 1k', x: 10, y: 20 };

    expect((await h.anon.post(base, { path: 'board.kicad_pcb', commitSha: sha, body: 'hi' })).status).toBe(401);

    const first = await other.post(base, { path: 'board.kicad_pcb', commitSha: sha, body: 'Is 1k right here?', anchor });
    expect(first.status).toBe(201);
    expect(first.json.anchor.objectId).toBe('uuid-r6');

    const area = await other.post(base, {
      path: 'board.kicad_pcb',
      commitSha: sha,
      body: 'Keep this corner clear',
      anchor: { ...anchor, objectType: 'region', objectId: 'region', bbox: [0, 0, 5, 5] },
    });
    expect(area.status).toBe(201);
    expect(area.json.anchor.bbox).toEqual([0, 0, 5, 5]);

    // An anchor must name the same file and commit as the comment.
    expect((await other.post(base, { path: 'other.kicad_pcb', commitSha: sha, body: 'x', anchor })).status).toBe(400);

    const reply = await owner.post(base, { path: 'board.kicad_pcb', commitSha: sha, body: 'Yes, dimmer on purpose.', inReplyTo: first.json.id });
    expect(reply.status).toBe(201);
    expect(reply.json.anchor).toBeNull();
    // Replies go to a thread's first comment only.
    expect((await owner.post(base, { path: 'board.kicad_pcb', commitSha: sha, body: 'nested', inReplyTo: reply.json.id })).status).toBe(400);

    const list = await h.anon.get(`${base}?path=board.kicad_pcb`);
    expect(list.status).toBe(200);
    expect(list.json.comments.map((c: { body: string }) => c.body)).toEqual(['Is 1k right here?', 'Keep this corner clear', 'Yes, dimmer on purpose.']);

    // The repository owner (write access) may resolve someone else's thread; a stranger may not edit its text.
    expect((await owner.patch(`${base}/${first.json.id}`, { resolved: true })).json.resolved).toBe(true);
    expect((await owner.patch(`${base}/${first.json.id}`, { body: 'changed' })).status).toBe(403);

    const third = await h.user('cc-third');
    expect((await third.del(`${base}/${first.json.id}`)).status).toBe(403);
    expect((await other.del(`${base}/${first.json.id}`)).status).toBe(204);
    const after = await h.anon.get(`${base}?path=board.kicad_pcb`);
    expect(after.json.comments.map((c: { body: string }) => c.body)).toEqual(['Keep this corner clear']);
  });
});
