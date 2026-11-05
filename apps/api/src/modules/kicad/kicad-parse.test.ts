import { afterAll, describe, expect, it } from 'vitest';
import { KicadPool } from './kicad-pool';

const pool = new KicadPool(1, true);
afterAll(() => pool.close());

describe('KicadPool.parse', () => {
  it('parses a board into the typed model', async () => {
    const p = await pool.parse('(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal)) (net 0 ""))', 'pcb');
    expect(p.kind).toBe('pcb');
    if (p.kind === 'pcb') expect(p.model.layers[0]?.name).toBe('F.Cu');
  });
  it('rejects garbage', async () => {
    await expect(pool.parse('(kicad_pcb', 'pcb')).rejects.toThrow();
  });
});
