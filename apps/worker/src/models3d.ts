/**
 * Rewrites footprint 3D model paths in a board so kicad-cli can find them.
 *
 * Boards made with older KiCad versions reference `${KICAD6_3DMODEL_DIR}/…/X.wrl`,
 * but the KiCad 8/9 libraries ship STEP only and kicad-cli (unlike the GUI)
 * does not fall back to other extensions. Paths that point outside the
 * checkout (absolute Windows paths, unknown variables) are matched by file name
 * against the installed library as a last resort.
 */

const MODEL_RE = /\(model\s+"((?:[^"\\]|\\.)*)"/g;
const EXTS = ['.step', '.stp', '.STEP', '.STP', '.wrl', '.WRL'];
const LIB_VAR = /^(?:\$\{KICAD\d*_3DMODEL_DIR\}|:KICAD\d*_3DMODEL_DIR:)\/?/;

export interface ModelIndex {
  /** Library root as seen by kicad-cli. */
  root: string;
  /** Paths relative to root. */
  files: Set<string>;
  /** Lower-case basename (without extension) → relative path, preferring STEP. */
  byStem: Map<string, string>;
}

export function buildModelIndex(root: string, relPaths: string[]): ModelIndex {
  const files = new Set(relPaths);
  const byStem = new Map<string, string>();
  for (const rel of relPaths) {
    const stem = stemOf(rel).toLowerCase();
    const prev = byStem.get(stem);
    if (!prev || (/\.wrl$/i.test(prev) && !/\.wrl$/i.test(rel))) byStem.set(stem, rel);
  }
  return { root: root.replace(/\/+$/, ''), files, byStem };
}

function stemOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, '');
}

function withExt(path: string, ext: string): string {
  return path.replace(/\.[^./]+$/, '') + ext;
}

/** Resolve one model reference; returns null when no library file matches. */
export function resolveModel(ref: string, index: ModelIndex, projectFiles: Set<string>): string | null {
  const raw = ref.replace(/\\\\/g, '/').replace(/\\/g, '/');
  // Project-relative models are left to kicad-cli (KIPRJMOD), but also accept a STEP twin.
  const prj = raw.match(/^\$\{KIPRJMOD\}\/?(.*)$/);
  if (prj) {
    const rel = prj[1]!;
    if (projectFiles.has(rel)) return null;
    for (const ext of EXTS) if (projectFiles.has(withExt(rel, ext))) return `\${KIPRJMOD}/${withExt(rel, ext)}`;
    return null;
  }
  const lib = raw.match(LIB_VAR);
  if (lib) {
    const rel = raw.slice(lib[0].length);
    if (index.files.has(rel)) return `${index.root}/${rel}`;
    for (const ext of EXTS) if (index.files.has(withExt(rel, ext))) return `${index.root}/${withExt(rel, ext)}`;
  }
  const hit = index.byStem.get(stemOf(raw).toLowerCase());
  return hit ? `${index.root}/${hit}` : null;
}

export function fixModelPaths(board: string, index: ModelIndex, projectFiles: Set<string>): { text: string; fixed: number; missing: string[] } {
  let fixed = 0;
  const missing = new Set<string>();
  const text = board.replace(MODEL_RE, (whole, ref: string) => {
    const resolved = resolveModel(ref, index, projectFiles);
    if (resolved === null) {
      if (!ref.startsWith('${KIPRJMOD}')) missing.add(ref);
      return whole;
    }
    fixed++;
    return `(model "${resolved.replace(/"/g, '\\"')}"`;
  });
  return { text, fixed, missing: [...missing] };
}
