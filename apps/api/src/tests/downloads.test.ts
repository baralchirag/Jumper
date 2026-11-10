import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, dbAvailable, type Harness } from '../testing/harness';

describe.skipIf(!dbAvailable)('downloads', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('serves the KiCad plugin as a PCM package', async () => {
    const meta = await h.anon.get('/api/downloads/kicad-plugin');
    expect(meta.status).toBe(200);
    expect(meta.json.version).toMatch(/^\d+\.\d+\.\d+$/);
    const res = await h.app.inject({ method: 'GET', url: '/api/downloads/kicad-plugin.zip' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const body = res.rawPayload;
    expect(body.subarray(0, 2).toString()).toBe('PK');
    const names = body.toString('latin1');
    for (const f of ['metadata.json', 'plugins/__init__.py', 'plugins/jumper_git.py', 'plugins/jumper_action.py', 'resources/icon.png']) expect(names).toContain(f);
    expect(names).not.toContain('__pycache__');
  });
});
