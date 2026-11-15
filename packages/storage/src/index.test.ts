import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { afterAll, describe, expect, it } from 'vitest';
import { FsStorage, artifactKey } from './index';

const dir = await mkdtemp(join(tmpdir(), 'jumper-storage-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('FsStorage', () => {
  const s = new FsStorage(dir);

  it('round-trips objects', async () => {
    await s.put('a/b/c.txt', Buffer.from('hello'), 'text/plain');
    const obj = await s.get('a/b/c.txt');
    expect(obj?.size).toBe(5);
    expect(await text(obj!.body)).toBe('hello');
    await s.deletePrefix('a/');
    expect(await s.exists('a/b/c.txt')).toBe(false);
  });

  it('rejects traversal keys', async () => {
    await expect(s.put('../x', Buffer.from(''), 'text/plain')).rejects.toThrow();
    await expect(s.get('a/../../x')).rejects.toThrow();
  });

  it('builds sanitized artifact keys', () => {
    expect(artifactKey('r', 's', 'hw/my board', 'x.svg')).toBe('repos/r/s/hw/my_board/x.svg');
  });
});
