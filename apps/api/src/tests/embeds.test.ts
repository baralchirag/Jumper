import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { artifacts, checkRuns } from '@jumper/db';
import { artifactKey } from '@jumper/storage';
import { summarize } from '../modules/embeds/badge';
import { commitFiles, createHarness, dbAvailable, type Client, type Harness } from '../testing/harness';

describe('badge summary', () => {
  it('fails on any failure, waits on anything running', () => {
    expect(summarize([])).toEqual({ message: 'no checks', tone: 'neutral' });
    expect(summarize([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }]).message).toBe('failing');
    expect(summarize([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }]).message).toBe('running');
    expect(summarize([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }]).message).toBe('passing');
    expect(summarize([{ status: 'completed', conclusion: 'neutral' }]).message).toBe('warnings');
  });
});

describe.skipIf(!dbAvailable)('README embeds', () => {
  let h: Harness;
  let alice: Client;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
  });

  it('serves check badges that follow the branch head', async () => {
    const repo = await h.repo(alice, 'board');
    const sha = await commitFiles(repo.git, { 'a.kicad_pro': '{}' });
    const pending = await h.app.inject({ method: 'GET', url: '/api/repos/alice/board/badge.svg?check=DRC' });
    expect(pending.statusCode).toBe(200);
    expect(pending.headers['content-type']).toContain('image/svg+xml');
    expect(pending.body).toContain('DRC: pending');
    expect(pending.headers['cross-origin-resource-policy']).toBe('cross-origin');
    await h.ctx.db.insert(checkRuns).values([
      { repoId: repo.id, sha, name: 'DRC', projectPath: 'a.kicad_pro', status: 'completed', conclusion: 'success' },
      { repoId: repo.id, sha, name: 'ERC', projectPath: 'a.kicad_pro', status: 'completed', conclusion: 'failure' },
    ]);
    expect((await h.app.inject({ method: 'GET', url: '/api/repos/alice/board/badge.svg?check=DRC' })).body).toContain('DRC: passing');
    expect((await h.app.inject({ method: 'GET', url: '/api/repos/alice/board/badge.svg' })).body).toContain('checks: failing');
    expect((await h.app.inject({ method: 'GET', url: '/api/repos/alice/board/badge.svg?label=%3Cscript%3E' })).body).not.toContain('<script>');
  });

  it('shows the newest board picture, falling back to earlier commits and simpler views', async () => {
    const repo = await h.repo(alice, 'board');
    const first = await commitFiles(repo.git, { 'a.kicad_pro': '{}' });
    for (const [kind, name, type, body] of [['thumbnail', 'top.svg', 'image/svg+xml', '<svg/>'], ['render3d', 'iso-top.png', 'image/png', 'PNGDATA']] as const) {
      const key = artifactKey(repo.id, first, 'a.kicad_pro', `${kind}/${name}`);
      await h.ctx.storage.put(key, Buffer.from(body), type);
      await h.ctx.db.insert(artifacts).values({ repoId: repo.id, sha: first, projectPath: 'a.kicad_pro', kind, name, storageKey: key, contentType: type, size: body.length });
    }
    // A newer commit whose checks have not produced anything yet.
    await commitFiles(repo.git, { 'a.kicad_pro': '{ }' });
    const iso = await h.app.inject({ method: 'GET', url: '/api/repos/alice/board/preview.png' });
    expect(iso.statusCode).toBe(200);
    expect(iso.headers['content-type']).toBe('image/png');
    expect(iso.body).toBe('PNGDATA');
    const drawing = await h.app.inject({ method: 'GET', url: '/api/repos/alice/board/preview.svg?view=drawing' });
    expect(drawing.headers['content-type']).toContain('image/svg+xml');
    expect(drawing.headers['content-security-policy']).toContain('sandbox');
    expect((await h.app.inject({ method: 'GET', url: '/api/repos/alice/board/preview?view=bottom' })).statusCode).toBe(404);
  });

  it('keeps private repositories private', async () => {
    const repo = await h.repo(alice, 'secret', { visibility: 'private' });
    await commitFiles(repo.git, { 'a.txt': 'x' });
    expect((await h.anon.get('/api/repos/alice/secret/badge.svg')).status).toBe(404);
    const own = await alice.get('/api/repos/alice/secret/badge.svg');
    expect(own.status).toBe(200);
    expect(own.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(own.headers['cache-control']).toContain('private');
  });
});
