import { basename, dirname, stripExt } from '@jumper/shared';

export interface Project {
  /** Directory of the project, relative to the repo root ('' for root). */
  dir: string;
  name: string;
  /** Repo-relative path used to label checks/artifacts (the .kicad_pro, or the board/schematic). */
  path: string;
  schematic: string | null;
  board: string | null;
}

/**
 * Find KiCad projects: every `.kicad_pro` plus orphan boards/schematics
 * (designs committed without their project file).
 */
export function discoverProjects(paths: string[], explicit?: string[]): Project[] {
  const set = new Set(paths);
  const projects: Project[] = [];
  const claimed = new Set<string>();
  const pros = explicit?.length ? explicit.filter((p) => set.has(p)) : paths.filter((p) => p.endsWith('.kicad_pro'));

  for (const pro of pros) {
    const dir = dirname(pro);
    const name = stripExt(pro);
    const prefix = dir ? `${dir}/` : '';
    const sch = `${prefix}${name}.kicad_sch`;
    const pcb = `${prefix}${name}.kicad_pcb`;
    projects.push({ dir, name, path: pro, schematic: set.has(sch) ? sch : null, board: set.has(pcb) ? pcb : null });
    claimed.add(sch).add(pcb);
  }
  if (explicit?.length) return projects;

  // Orphan top-level designs: boards, and schematics not referenced by a project.
  for (const p of paths) {
    if (claimed.has(p) || !p.endsWith('.kicad_pcb')) continue;
    const dir = dirname(p);
    const name = stripExt(p);
    const sch = `${dir ? `${dir}/` : ''}${name}.kicad_sch`;
    projects.push({ dir, name, path: p, schematic: set.has(sch) ? sch : null, board: p });
    claimed.add(p).add(sch);
  }
  return projects.slice(0, 32);
}

export function projectLabel(p: Project): string {
  return basename(p.path);
}
