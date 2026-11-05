import { afterAll, describe, expect, it } from 'vitest';
import { KicadPool } from './kicad-pool';

const pool = new KicadPool(1, true);
afterAll(() => pool.close());

describe('KicadPool', () => {
  it('runs semantic diffs off the main thread', async () => {
    const before = '(kicad_pcb (net 0 "") (net 1 "GND"))';
    const after = '(kicad_pcb (net 0 "") (net 1 "GND") (net 2 "VCC"))';
    const d = await pool.diff(before, after, 'pcb');
    expect(d.summary.added).toBe(1);
    expect(d.changes[0]).toMatchObject({ op: 'added', object: 'net', label: 'VCC' });
  });

  it('surfaces parse errors', async () => {
    await expect(pool.diff('(kicad_pcb', '', 'pcb')).rejects.toThrow(/unexpected end/);
  });
});
