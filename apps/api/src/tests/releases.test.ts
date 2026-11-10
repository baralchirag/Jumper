import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { artifacts, checkRuns } from '@jumper/db';
import { artifactKey } from '@jumper/storage';
import { commitFiles, createHarness, dbAvailable, type Client, type Harness } from '../testing/harness';

describe.skipIf(!dbAvailable)('releases', () => {
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

  /** Pretend the worker finished: store outputs and mark checks completed. */
  async function fakeOutputs(repoId: string, sha: string, opts: { jlc?: boolean } = {}) {
    const files: { kind: string; name: string; type: string; body: string; meta?: Record<string, unknown> }[] = [
      { kind: 'gerbers', name: 'gerbers.zip', type: 'application/zip', body: 'PKgerbers' },
      { kind: 'bom', name: 'bom.csv', type: 'text/csv', body: 'Ref,Value\nR1,10k\n' },
      { kind: 'bom', name: 'bom.json', type: 'application/json', body: '[]' },
      { kind: 'step', name: 'board.step', type: 'model/step', body: 'ISO-10303-21;' },
      { kind: 'pos', name: 'positions.csv', type: 'text/csv', body: 'Ref,X,Y\n' },
      { kind: 'pdf', name: 'schematic.pdf', type: 'application/pdf', body: '%PDF' },
    ];
    if (opts.jlc !== false) files.push({ kind: 'fab_package', name: 'board-jlcpcb-abc.zip', type: 'application/zip', body: 'PKjlc', meta: { format: 'jlcpcb' } });
    for (const f of files) {
      const key = artifactKey(repoId, sha, 'board.kicad_pro', f.name);
      await h.ctx.storage.put(key, Buffer.from(f.body), f.type);
      await h.ctx.db.insert(artifacts).values({ repoId, sha, projectPath: 'board.kicad_pro', kind: f.kind, name: f.name, storageKey: key, contentType: f.type, size: f.body.length, meta: f.meta ?? {} });
    }
    await h.ctx.db.insert(checkRuns).values({ repoId, sha, name: 'Outputs', projectPath: 'board.kicad_pro', status: 'completed', conclusion: 'success' });
  }

  it('tags a revision and attaches its fabrication files', async () => {
    const repo = await h.repo(alice, 'board');
    const sha = await commitFiles(repo.git, { 'board.kicad_pro': '{}' });
    await fakeOutputs(repo.id, sha);
    const res = await alice.post('/api/repos/alice/board/releases', { tag: 'v1.0', name: 'Rev A', body: 'First fab run' });
    expect(res.status, res.body).toBe(200);
    expect(res.json).toMatchObject({ tag: 'v1.0', name: 'Rev A', sha, latest: true, draft: false, missing: [] });
    expect(res.json.assets.map((a: { name: string }) => a.name).sort()).toEqual(['board-v1.0-board.step', 'board-v1.0-bom.csv', 'board-v1.0-gerbers.zip', 'board-v1.0-jlcpcb.zip', 'board-v1.0-positions.csv', 'board-v1.0-schematic.pdf']);
    expect((await repo.git.tags()).find((t) => t.name === 'v1.0')?.sha).toBe(sha);

    const gerbers = res.json.assets.find((a: { kind: string }) => a.kind === 'gerbers');
    const dl = await h.app.inject({ method: 'GET', url: gerbers.url });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('PKgerbers');
    expect(dl.headers['content-disposition']).toContain('attachment');
    const latest = await h.app.inject({ method: 'GET', url: '/api/repos/alice/board/releases/latest/download/jlcpcb.zip' });
    expect(latest.statusCode).toBe(200);
    expect(latest.body).toBe('PKjlc');
    const again = await alice.get('/api/repos/alice/board/releases/tags/v1.0');
    expect(again.json.assets.find((a: { kind: string }) => a.kind === 'gerbers').downloadCount).toBe(1);
  });

  it('attaches files once checks finish, and explains what is missing', async () => {
    const repo = await h.repo(alice, 'board');
    const sha = await commitFiles(repo.git, { 'board.kicad_pro': '{}' });
    const res = await alice.post('/api/repos/alice/board/releases', { tag: 'rev-B', assets: ['gerbers', 'jlcpcb'] });
    expect(res.json.assets).toEqual([]);
    expect(res.json.missing.map((m: { kind: string }) => m.kind).sort()).toEqual(['gerbers', 'jlcpcb']);
    expect(res.json.missing[0].reason).toMatch(/not run|still running/);
    await fakeOutputs(repo.id, sha, { jlc: false });
    const later = await alice.get('/api/repos/alice/board/releases/tags/rev-B');
    expect(later.json.assets.map((a: { kind: string }) => a.kind)).toEqual(['gerbers']);
    expect(later.json.missing).toEqual([{ kind: 'jlcpcb', reason: expect.stringContaining('fab_package: jlcpcb') }]);
  });

  it('uses an existing tag, refuses duplicates, and keeps drafts private', async () => {
    const repo = await h.repo(alice, 'board');
    const first = await commitFiles(repo.git, { 'a.txt': '1' });
    await commitFiles(repo.git, { 'a.txt': '2' });
    await repo.git.updateRef('refs/tags/v0.9', first);
    const r1 = await alice.post('/api/repos/alice/board/releases', { tag: 'v0.9', assets: [] });
    expect(r1.json.sha).toBe(first);
    expect((await alice.post('/api/repos/alice/board/releases', { tag: 'v0.9' })).status).toBe(409);
    expect((await alice.post('/api/repos/alice/board/releases', { tag: '../evil' })).status).toBe(400);
    expect((await alice.post('/api/repos/alice/board/releases', { tag: 'v2', target: 'nope' })).status).toBe(400);

    const draft = await alice.post('/api/repos/alice/board/releases', { tag: 'v2', draft: true, assets: [] });
    expect(draft.json.publishedAt).toBeNull();
    expect((await bob.get('/api/repos/alice/board/releases')).json.map((x: { tag: string }) => x.tag)).toEqual(['v0.9']);
    expect((await bob.get('/api/repos/alice/board/releases/tags/v2')).status).toBe(404);
    expect((await bob.post('/api/repos/alice/board/releases', { tag: 'v3' })).status).toBe(403);
    const pub = await alice.patch(`/api/repos/alice/board/releases/${draft.json.id}`, { draft: false });
    expect(pub.json.publishedAt).toBeTruthy();
    expect((await bob.get('/api/repos/alice/board/releases/latest')).json.tag).toBe('v2');
  });

  it('accepts uploaded files and deletes releases with their tag', async () => {
    const repo = await h.repo(alice, 'board');
    await commitFiles(repo.git, { 'a.txt': '1' });
    const rel = await alice.post('/api/repos/alice/board/releases', { tag: 'v1', assets: [] });
    const put = await alice.req('PUT', `/api/repos/alice/board/releases/${rel.json.id}/assets/assembly-notes.pdf`, Buffer.from('%PDF-1.4'), { 'content-type': 'application/octet-stream' });
    expect(put.status, put.body).toBe(200);
    expect(put.json.assets).toEqual([expect.objectContaining({ name: 'assembly-notes.pdf', kind: 'upload', size: 8, contentType: 'application/pdf' })]);
    const dup = await alice.req('PUT', `/api/repos/alice/board/releases/${rel.json.id}/assets/assembly-notes.pdf`, Buffer.from('x'), { 'content-type': 'application/octet-stream' });
    expect(dup.status).toBe(409);
    const del = await alice.del(`/api/repos/alice/board/releases/${rel.json.id}?deleteTag=true`);
    expect(del.status).toBe(200);
    expect((await repo.git.tags()).map((t) => t.name)).not.toContain('v1');
    expect((await alice.get('/api/repos/alice/board/releases')).json).toEqual([]);
  });
});
