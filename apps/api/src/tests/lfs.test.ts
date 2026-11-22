import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { commitFiles, createHarness, dbAvailable, type Client, type Harness } from '../testing/harness';

const LFS = 'application/vnd.git-lfs+json';
const oidOf = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe.skipIf(!dbAvailable)('git LFS', () => {
  let h: Harness;
  let alice: Client, bob: Client;
  let aliceAuth: string, bobAuth: string;
  beforeAll(async () => {
    h = await createHarness({ env: { LFS_MAX_OBJECT_MB: '2' } });
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
    bob = await h.user('bob');
    const tok = async (c: Client) => (await c.post('/api/user/tokens', { name: 'lfs', scopes: ['repo:write'], expiresInDays: 1 })).json.token as string;
    aliceAuth = `Basic ${Buffer.from(`alice:${await tok(alice)}`).toString('base64')}`;
    bobAuth = `Basic ${Buffer.from(`bob:${await tok(bob)}`).toString('base64')}`;
  });

  const batch = (path: string, body: unknown, auth?: string) =>
    h.app.inject({ method: 'POST', url: `${path}/info/lfs/objects/batch`, headers: { 'content-type': LFS, accept: LFS, ...(auth ? { authorization: auth } : {}) }, payload: JSON.stringify(body) });

  it('uploads, verifies and downloads objects', async () => {
    await h.repo(alice, 'board', { visibility: 'private' });
    const data = Buffer.from('ISO-10303-21; a STEP model '.repeat(100));
    const oid = oidOf(data);
    const up = await batch('/alice/board.git', { operation: 'upload', transfers: ['basic'], objects: [{ oid, size: data.length }] }, aliceAuth);
    expect(up.statusCode, up.body).toBe(200);
    expect(up.headers['content-type']).toContain(LFS);
    const obj = up.json().objects[0];
    expect(obj.actions.upload.href).toMatch(new RegExp(`/alice/board\\.git/info/lfs/objects/${oid}$`));
    expect(obj.actions.upload.header.Authorization).toBe(aliceAuth);

    const put = await h.app.inject({ method: 'PUT', url: `/alice/board.git/info/lfs/objects/${oid}`, headers: { 'content-type': 'application/octet-stream', authorization: aliceAuth }, payload: data });
    expect(put.statusCode, put.body).toBe(200);
    const verify = await h.app.inject({ method: 'POST', url: '/alice/board.git/info/lfs/verify', headers: { 'content-type': LFS, authorization: aliceAuth }, payload: JSON.stringify({ oid, size: data.length }) });
    expect(verify.statusCode).toBe(200);

    // Uploading again is a no-op: no actions.
    const again = await batch('/alice/board.git', { operation: 'upload', objects: [{ oid, size: data.length }] }, aliceAuth);
    expect(again.json().objects[0].actions).toBeUndefined();

    const down = await batch('/alice/board', { operation: 'download', objects: [{ oid, size: data.length }, { oid: 'a'.repeat(64), size: 1 }] }, aliceAuth);
    const [found, missing] = down.json().objects;
    expect(found.actions.download.href).toContain(oid);
    expect(missing.error.code).toBe(404);
    const get = await h.app.inject({ method: 'GET', url: `/alice/board.git/info/lfs/objects/${oid}`, headers: { authorization: aliceAuth } });
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.equals(data)).toBe(true);
  });

  it('rejects content that does not match its id, and oversized files', async () => {
    await h.repo(alice, 'board');
    const oid = oidOf(Buffer.from('real'));
    const bad = await h.app.inject({ method: 'PUT', url: `/alice/board.git/info/lfs/objects/${oid}`, headers: { 'content-type': 'application/octet-stream', authorization: aliceAuth }, payload: Buffer.from('fake') });
    expect(bad.statusCode).toBe(422);
    const down = await batch('/alice/board.git', { operation: 'download', objects: [{ oid, size: 4 }] }, aliceAuth);
    expect(down.json().objects[0].error.code).toBe(404);

    const huge = await batch('/alice/board.git', { operation: 'upload', objects: [{ oid: 'b'.repeat(64), size: 3 * 1024 * 1024 }] }, aliceAuth);
    expect(huge.json().objects[0].error.code).toBe(422);
  });

  it('applies repository permissions', async () => {
    const src = await h.repo(alice, 'board');
    await commitFiles(src.git, { 'a.txt': 'x' });
    const data = Buffer.from('datasheet');
    const oid = oidOf(data);
    await h.app.inject({ method: 'PUT', url: `/alice/board.git/info/lfs/objects/${oid}`, headers: { 'content-type': 'application/octet-stream', authorization: aliceAuth }, payload: data });

    // Bob can read a public repository's objects but not upload.
    expect((await batch('/alice/board.git', { operation: 'download', objects: [{ oid, size: data.length }] })).json().objects[0].actions).toBeDefined();
    expect((await batch('/alice/board.git', { operation: 'upload', objects: [{ oid: 'e'.repeat(64), size: 1 }] }, bobAuth)).statusCode).toBe(403);
    expect((await batch('/alice/board.git', { operation: 'upload', objects: [{ oid: 'e'.repeat(64), size: 1 }] })).statusCode).toBe(401);

    const get = await h.app.inject({ method: 'GET', url: `/alice/board.git/info/lfs/objects/${oid}`, headers: { authorization: bobAuth } });
    expect(get.rawPayload.toString()).toBe('datasheet');

    const priv = await h.repo(alice, 'secret', { visibility: 'private' });
    expect(priv).toBeTruthy();
    expect((await batch('/alice/secret.git', { operation: 'download', objects: [{ oid, size: 1 }] }, bobAuth)).statusCode).toBe(404);
  });
});
