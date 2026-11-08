/**
 * Which symbol, footprint and 3D model libraries a KiCad project uses, and which of them a fresh checkout cannot find.
 *
 * KiCad keeps copies of symbols in the schematic and of footprints in the board, so Jumper still renders a project
 * whose libraries are missing. The person who clones it does not get off so lightly: KiCad warns on every symbol,
 * "Update symbols from library" breaks, and footprints cannot be swapped. This report says exactly what is missing and
 * how to fix it (commit the library and list it in the project's sym-lib-table / fp-lib-table).
 */

export type LibraryStatus =
  /** Listed in the project's own table and the file is in the repository. */
  | 'project'
  /** One of KiCad's standard libraries, installed with KiCad. */
  | 'standard'
  /** Listed in the project table, but the file it points to is not committed. */
  | 'file-missing'
  /** Not in the project table and not a standard library: only on the author's computer. */
  | 'missing'
  /** Could not tell (the worker has no KiCad libraries to compare against). */
  | 'unknown';

export interface LibraryUse {
  nickname: string;
  status: LibraryStatus;
  /** Number of placed symbols / footprints using it. */
  uses: number;
  /** A few example items, e.g. "MyLib:LDO_3V3". */
  examples: string[];
  /** Path from the lib table, when listed there. */
  uri?: string;
}

export interface LibraryReport {
  symbols: LibraryUse[];
  footprints: LibraryUse[];
  /** Hierarchical sheets referenced by the schematic but not committed. */
  missingSheets: string[];
  /** 3D model references that could not be resolved (from the board preparation step). */
  missingModels: string[];
  /** Count of libraries with status missing / file-missing, plus missing sheets. */
  problems: number;
}

export interface LibTableEntry {
  name: string;
  uri: string;
  type: string;
}

/** End index (exclusive) of the s-expression starting at `open`, skipping quoted strings. */
function blockEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Parse a sym-lib-table / fp-lib-table. */
export function parseLibTable(text: string | null | undefined): LibTableEntry[] {
  if (!text) return [];
  const out: LibTableEntry[] = [];
  for (const m of text.matchAll(/\(lib\s/g)) {
    const body = text.slice(m.index, blockEnd(text, m.index));
    const field = (k: string) => {
      const f = new RegExp(`\\(${k}\\s+(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\s)]+))\\)`).exec(body);
      return f ? (f[1] ?? f[2])! : null;
    };
    const name = field('name');
    if (!name) continue;
    out.push({ name, uri: field('uri') ?? '', type: field('type') ?? 'KiCad' });
  }
  return out;
}

const unq = (s: string) => s.replace(/\\"/g, '"');

/** "Lib:Item" ids of placed symbols (not the embedded lib_symbols definitions, which repeat them). */
export function symbolIds(schematic: string): string[] {
  const libSymbols = /\(lib_symbols\b/.exec(schematic);
  let text = schematic;
  if (libSymbols) {
    // Cut the (lib_symbols ...) block: definitions inside it are not placements.
    const end = blockEnd(schematic, libSymbols.index);
    text = schematic.slice(0, libSymbols.index) + schematic.slice(end);
  }
  return [...text.matchAll(/\(lib_id\s+"((?:[^"\\]|\\.)*)"\)/g)].map((m) => unq(m[1]!));
}

/** Footprint ids assigned in the schematic (Footprint property) and placed on the board. */
export function footprintIds(schematics: string[], board: string | null): string[] {
  const ids: string[] = [];
  if (board) for (const m of board.matchAll(/\(footprint\s+"((?:[^"\\]|\\.)*)"/g)) ids.push(unq(m[1]!));
  else for (const s of schematics) for (const m of s.matchAll(/\(property\s+"Footprint"\s+"((?:[^"\\]|\\.)*)"/g)) if (m[1]) ids.push(unq(m[1]));
  return ids;
}

/** Sheet files referenced by a schematic: (property "Sheetfile" "power.kicad_sch"). */
export function sheetFiles(schematic: string): string[] {
  return [...schematic.matchAll(/\(property\s+"Sheet ?[Ff]ile"\s+"((?:[^"\\]|\\.)*)"/g)].map((m) => unq(m[1]!));
}

function projectPathFor(uri: string, projectDir: string): string | null {
  const m = /^\$\{KIPRJMOD\}\/?(.*)$/.exec(uri.replace(/\\/g, '/'));
  if (m) return normalize(projectDir ? `${projectDir}/${m[1]}` : m[1]!);
  if (!/^(\/|[A-Za-z]:|\$\{)/.test(uri)) return normalize(projectDir ? `${projectDir}/${uri}` : uri); // relative
  return null; // absolute or another variable: outside the repository
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** A library's file or folder is in the repository (footprint libraries are .pretty folders). */
function inRepo(path: string, repoFiles: Set<string>): boolean {
  if (repoFiles.has(path)) return true;
  const prefix = `${path}/`;
  for (const f of repoFiles) if (f.startsWith(prefix)) return true;
  return false;
}

function classify(ids: string[], table: LibTableEntry[], standard: Set<string> | null, repoFiles: Set<string>, projectDir: string): LibraryUse[] {
  const byLib = new Map<string, string[]>();
  for (const id of ids) {
    const i = id.indexOf(':');
    if (i <= 0) continue; // no library prefix: nothing to resolve
    const lib = id.slice(0, i);
    byLib.set(lib, [...(byLib.get(lib) ?? []), id]);
  }
  const out: LibraryUse[] = [];
  for (const [nickname, items] of byLib) {
    const entry = table.find((t) => t.name === nickname);
    let status: LibraryStatus;
    if (entry) {
      const path = projectPathFor(entry.uri, projectDir);
      status = path === null ? (standard?.has(nickname) ? 'standard' : 'file-missing') : inRepo(path, repoFiles) ? 'project' : 'file-missing';
    } else if (standard) {
      status = standard.has(nickname) ? 'standard' : 'missing';
    } else {
      status = 'unknown';
    }
    out.push({ nickname, status, uses: items.length, examples: [...new Set(items)].slice(0, 5), ...(entry ? { uri: entry.uri } : {}) });
  }
  const rank: Record<LibraryStatus, number> = { 'file-missing': 0, missing: 1, unknown: 2, project: 3, standard: 4 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.uses - a.uses || a.nickname.localeCompare(b.nickname));
}

export interface LibraryInput {
  /** Directory of the .kicad_pro, relative to the repository root ('' for the root). */
  projectDir: string;
  /** Root schematic first, then sub-sheets, with their repository paths. */
  schematics: { path: string; text: string }[];
  board: string | null;
  symLibTable: string | null;
  fpLibTable: string | null;
  repoFiles: Set<string>;
  /** Nicknames of KiCad's standard libraries, or null when unknown. */
  standardSymbols: Set<string> | null;
  standardFootprints: Set<string> | null;
  missingModels?: string[];
}

export function libraryReport(input: LibraryInput): LibraryReport {
  const symbols = classify(
    input.schematics.flatMap((s) => symbolIds(s.text)),
    parseLibTable(input.symLibTable),
    input.standardSymbols,
    input.repoFiles,
    input.projectDir,
  );
  const footprints = classify(
    footprintIds(input.schematics.map((s) => s.text), input.board),
    parseLibTable(input.fpLibTable),
    input.standardFootprints,
    input.repoFiles,
    input.projectDir,
  );
  const missingSheets: string[] = [];
  for (const s of input.schematics) {
    const dir = s.path.includes('/') ? s.path.slice(0, s.path.lastIndexOf('/')) : '';
    for (const f of sheetFiles(s.text)) {
      const p = normalize(dir ? `${dir}/${f}` : f);
      if (!input.repoFiles.has(p) && !missingSheets.includes(p)) missingSheets.push(p);
    }
  }
  const bad = (l: LibraryUse) => l.status === 'missing' || l.status === 'file-missing';
  return {
    symbols,
    footprints,
    missingSheets,
    missingModels: input.missingModels ?? [],
    problems: symbols.filter(bad).length + footprints.filter(bad).length + missingSheets.length,
  };
}

/** One line for check summaries, or null when nothing is missing. */
export function librarySummary(r: LibraryReport): string | null {
  const parts: string[] = [];
  const sym = r.symbols.filter((l) => l.status === 'missing' || l.status === 'file-missing').length;
  const fp = r.footprints.filter((l) => l.status === 'missing' || l.status === 'file-missing').length;
  if (sym) parts.push(`${sym} symbol librar${sym === 1 ? 'y' : 'ies'}`);
  if (fp) parts.push(`${fp} footprint librar${fp === 1 ? 'y' : 'ies'}`);
  if (r.missingSheets.length) parts.push(`${r.missingSheets.length} sheet file${r.missingSheets.length === 1 ? '' : 's'}`);
  if (r.missingModels.length) parts.push(`${r.missingModels.length} 3D model${r.missingModels.length === 1 ? '' : 's'}`);
  return parts.length ? `Not in the repository: ${parts.join(', ')}` : null;
}
