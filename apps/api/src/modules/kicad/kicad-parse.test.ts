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
  it('repairs the KiCad 9 teardrop bug instead of losing the rest of the board', async () => {
    const fp = (ref: string, pad: string) =>
      `(footprint "R" (layer "F.Cu") (uuid "${ref}") (at 0 0) (property "Reference" "${ref}" (at 0 0 0) (layer "F.SilkS")) ${pad})`;
    // As written by some KiCad 9.0 releases: ")filter_ratio" is missing its opening parenthesis.
    const broken = '(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (teardrops (curved_edges no)filter_ratio 0.9) (enabled yes)))';
    const ok = '(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))';
    const text = `(kicad_pcb (version 20241229) (layers (0 "F.Cu" signal)) (net 0 "") ${fp('R1', broken)} ${fp('R2', ok)})`;
    const p = await pool.parse(text, 'pcb');
    if (p.kind !== 'pcb') throw new Error('expected a board');
    expect(p.model.footprints.map((f) => f.reference)).toEqual(['R1', 'R2']);
  });
});
