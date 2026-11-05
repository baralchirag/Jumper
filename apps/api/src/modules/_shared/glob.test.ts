import { describe, expect, it } from 'vitest';
import { matchesGlob } from './glob';

describe('matchesGlob', () => {
  it('matches bare names in any folder', () => {
    expect(matchesGlob('*.kicad_pcb', 'board.kicad_pcb')).toBe(true);
    expect(matchesGlob('*.kicad_pcb', 'hw/rev2/board.kicad_pcb')).toBe(true);
    expect(matchesGlob('*.kicad_pcb', 'board.kicad_pcb.bak')).toBe(false);
  });
  it('anchors patterns containing a slash', () => {
    expect(matchesGlob('power/*.kicad_sch', 'power/ldo.kicad_sch')).toBe(true);
    expect(matchesGlob('power/*.kicad_sch', 'power/sub/ldo.kicad_sch')).toBe(false);
    expect(matchesGlob('power/*.kicad_sch', 'x/power/ldo.kicad_sch')).toBe(false);
  });
  it('supports **', () => {
    expect(matchesGlob('power/**', 'power/a/b/c.kicad_sch')).toBe(true);
    expect(matchesGlob('**/rf/*.kicad_pcb', 'rf/a.kicad_pcb')).toBe(true);
    expect(matchesGlob('**/rf/*.kicad_pcb', 'hw/rf/a.kicad_pcb')).toBe(true);
  });
  it('escapes regex metacharacters', () => {
    expect(matchesGlob('a+b(1).sch', 'a+b(1).sch')).toBe(true);
    expect(matchesGlob('a.b', 'axb')).toBe(false);
  });
  it('is not vulnerable to catastrophic backtracking', () => {
    const t = Date.now();
    matchesGlob('*'.repeat(30) + 'x', 'a'.repeat(5000));
    expect(Date.now() - t).toBeLessThan(500);
  });
});
