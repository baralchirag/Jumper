/** Helpers for classifying repository paths. */

export const KICAD_EXTENSIONS = ['.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_sym', '.kicad_mod', '.kicad_wks', '.kicad_dru'];

export type KicadFileKind = 'pcb' | 'sch' | 'project' | 'symbol_lib' | 'footprint' | 'other';

export function kicadFileKind(path: string): KicadFileKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.kicad_pcb')) return 'pcb';
  if (lower.endsWith('.kicad_sch')) return 'sch';
  if (lower.endsWith('.kicad_pro')) return 'project';
  if (lower.endsWith('.kicad_sym')) return 'symbol_lib';
  if (lower.endsWith('.kicad_mod')) return 'footprint';
  if (KICAD_EXTENSIONS.some((e) => lower.endsWith(e))) return 'other';
  return null;
}

export function isDesignFile(path: string): boolean {
  const k = kicadFileKind(path);
  return k === 'pcb' || k === 'sch';
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function stripExt(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i <= 0 ? b : b.slice(0, i);
}

/** Validate a user-supplied repo-relative path (no traversal, no absolute paths). */
export function isSafeRepoPath(path: string): boolean {
  if (path.length > 4096 || path.startsWith('/') || path.includes('\0')) return false;
  return path.split('/').every((seg) => seg !== '..' && seg !== '.' && seg !== '.git');
}

export function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

const MARKDOWN_README = /^readme(\.(md|markdown))?$/i;
export function isReadme(name: string): boolean {
  return MARKDOWN_README.test(name);
}
