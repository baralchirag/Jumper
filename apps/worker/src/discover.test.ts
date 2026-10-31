import { describe, expect, it } from 'vitest';
import { discoverProjects } from './discover';

describe('discoverProjects', () => {
  it('pairs project files with their schematic and board', () => {
    const p = discoverProjects(['hw/main.kicad_pro', 'hw/main.kicad_sch', 'hw/main.kicad_pcb', 'hw/power.kicad_sch', 'README.md']);
    expect(p).toEqual([{ dir: 'hw', name: 'main', path: 'hw/main.kicad_pro', schematic: 'hw/main.kicad_sch', board: 'hw/main.kicad_pcb' }]);
  });

  it('picks up boards committed without a project file', () => {
    const p = discoverProjects(['adapter.kicad_pcb']);
    expect(p).toEqual([{ dir: '', name: 'adapter', path: 'adapter.kicad_pcb', schematic: null, board: 'adapter.kicad_pcb' }]);
  });

  it('honours explicit project lists', () => {
    const p = discoverProjects(['a/a.kicad_pro', 'b/b.kicad_pro', 'b/b.kicad_pcb'], ['b/b.kicad_pro']);
    expect(p.map((x) => x.path)).toEqual(['b/b.kicad_pro']);
  });
});
