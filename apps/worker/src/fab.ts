// Manufacturing file formats derived from KiCad outputs.
import type { BomLine } from '@jumper/kicad-core/node';

const csvEsc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const row = (cells: string[]) => cells.map(csvEsc).join(',');

/** Symbol fields that carry an LCSC/JLCPCB part number, most specific first. */
const LCSC_FIELDS = ['LCSC', 'LCSC Part #', 'LCSC Part', 'LCSC_Part', 'JLCPCB Part #', 'JLC', 'JLCPCB'];

export function lcscCode(fields: Record<string, string>): string | null {
  for (const k of LCSC_FIELDS) {
    const v = fields[k]?.trim();
    if (v && /^C\d{2,}$/i.test(v)) return v.toUpperCase();
  }
  for (const [k, v] of Object.entries(fields)) {
    if (/lcsc|jlc/i.test(k) && /^C\d{2,}$/i.test(v.trim())) return v.trim().toUpperCase();
  }
  return null;
}

/** Footprint name without the library prefix ("Resistor_SMD:R_0603_1608Metric" → "R_0603_1608Metric"). */
export const footprintName = (fp: string) => fp.slice(fp.indexOf(':') + 1);

/** Gerber/drill files a fab house needs (no courtyard, fab, user or drill-map layers). */
export function isFabFile(name: string): boolean {
  return !/[-_](Courtyard|Fab|User_\w+|Margin|Adhesive|Eco\d|Comments|Drawings|drl_map)\.\w+$/i.test(name);
}

/** Not placed by an assembler: mounting holes, test points, fiducials, logos, flags. */
export function isNonPart(l: Pick<BomLine, 'value' | 'libId' | 'footprint'>): boolean {
  return /^(MountingHole|TestPoint|Fiducial|PWR_FLAG|Logo|NetTie)/i.test(l.value) || /^(Mechanical|Graphic|TestPoint):/i.test(l.libId) || /^MountingHole/i.test(footprintName(l.footprint));
}

/** JLCPCB assembly BOM: Comment, Designator, Footprint, LCSC Part #. */
export function jlcBom(lines: BomLine[]): string {
  const out = [row(['Comment', 'Designator', 'Footprint', 'LCSC Part #'])];
  for (const l of lines) {
    if (l.dnp || isNonPart(l)) continue;
    out.push(row([l.value, l.references.join(','), footprintName(l.footprint), lcscCode(l.fields) ?? '']));
  }
  return out.join('\n') + '\n';
}

/** Generic BOM with every collected field. */
export function genericBom(lines: BomLine[]): string {
  const extra = [...new Set(lines.flatMap((l) => Object.keys(l.fields)))].sort();
  return (
    [
      row(['References', 'Quantity', 'Value', 'Footprint', 'DNP', ...extra]),
      ...lines.map((l) => row([l.references.join(' '), String(l.quantity), l.value, l.footprint, l.dnp ? 'DNP' : '', ...extra.map((k) => l.fields[k] ?? '')])),
    ].join('\n') + '\n'
  );
}

/** Parse a CSV produced by kicad-cli (quoted fields, no embedded newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (q) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') {
        cells.push(cur);
        cur = '';
      } else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

/** Convert a `kicad-cli pcb export pos --format csv --units mm` file into a JLCPCB CPL. */
export function jlcCpl(posCsv: string, exclude: Set<string> = new Set()): string {
  const [header, ...rows] = parseCsv(posCsv);
  if (!header) return row(['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation']) + '\n';
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const [ref, x, y, rot, side] = [col('Ref'), col('PosX'), col('PosY'), col('Rot'), col('Side')];
  const out = [row(['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'])];
  for (const r of rows) {
    const designator = r[ref] ?? '';
    if (!designator || exclude.has(designator)) continue;
    const layer = (r[side] ?? '').toLowerCase().startsWith('b') ? 'Bottom' : 'Top';
    out.push(row([designator, `${Number(r[x]).toFixed(4)}mm`, `${Number(r[y]).toFixed(4)}mm`, layer, String(Number(r[rot]) || 0)]));
  }
  return out.join('\n') + '\n';
}

const fieldOf = (fields: Record<string, string>, names: RegExp): string => {
  for (const [k, v] of Object.entries(fields)) if (names.test(k.trim()) && v.trim()) return v.trim();
  return '';
};

/** PCBWay assembly BOM, in the column order of their sample spreadsheet. */
export function pcbwayBom(lines: BomLine[]): string {
  const out = [row(['Item #', 'Designator', 'Qty', 'Manufacturer', 'Mfg Part #', 'Description / Value', 'Package/Footprint', 'Type', 'Your Instructions / Notes'])];
  let n = 0;
  for (const l of lines) {
    if (l.dnp || isNonPart(l)) continue;
    const fp = footprintName(l.footprint);
    const type = /_THT|THT_|PinHeader|PinSocket|_DIP|TO-220|Radial|Axial/i.test(l.footprint) ? 'THT' : 'SMD';
    out.push(
      row([
        String(++n),
        l.references.join(','),
        String(l.quantity),
        fieldOf(l.fields, /^(manufacturer|manufacturer_name|mfr)$/i),
        fieldOf(l.fields, /^(mpn|manufacturer_part_number|manufacturer part number|mfr part number|mfr_pn|part number)$/i),
        l.value,
        fp,
        type,
        '',
      ]),
    );
  }
  return out.join('\n') + '\n';
}

/** PCBWay centroid file: millimetres without a unit suffix, layer as Top/Bottom. */
export function pcbwayCpl(posCsv: string, exclude: Set<string> = new Set()): string {
  const head = ['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'];
  const [header, ...rows] = parseCsv(posCsv);
  if (!header) return row(head) + '\n';
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const [ref, x, y, rot, side] = [col('Ref'), col('PosX'), col('PosY'), col('Rot'), col('Side')];
  const out = [row(head)];
  for (const r of rows) {
    const designator = r[ref] ?? '';
    if (!designator || exclude.has(designator)) continue;
    out.push(row([designator, Number(r[x]).toFixed(4), Number(r[y]).toFixed(4), (r[side] ?? '').toLowerCase().startsWith('b') ? 'Bottom' : 'Top', String(Number(r[rot]) || 0)]));
  }
  return out.join('\n') + '\n';
}

export interface FabLayout {
  /** Folder for the gerber and drill files inside the zip ('' = the root). */
  gerberDir: string;
  bom: { name: string; build(lines: BomLine[]): string } | null;
  cpl: { name: string; build(posCsv: string, exclude: Set<string>): string } | null;
}

/**
 * How each fab house wants its upload. JLCPCB and PCBWay assemble boards, so they get a BOM and a placement file in
 * their own column layouts. OSH Park only fabricates and reads a zip with the gerbers at the top level.
 */
export const FAB_LAYOUTS: Record<'jlcpcb' | 'pcbway' | 'oshpark' | 'generic', FabLayout> = {
  jlcpcb: { gerberDir: 'gerbers/', bom: { name: 'assembly/BOM-JLCPCB.csv', build: jlcBom }, cpl: { name: 'assembly/CPL-JLCPCB.csv', build: jlcCpl } },
  pcbway: { gerberDir: 'gerbers/', bom: { name: 'assembly/BOM-PCBWay.csv', build: pcbwayBom }, cpl: { name: 'assembly/Centroid-PCBWay.csv', build: pcbwayCpl } },
  oshpark: { gerberDir: '', bom: null, cpl: null },
  generic: { gerberDir: 'gerbers/', bom: { name: 'assembly/BOM.csv', build: genericBom }, cpl: { name: 'assembly/positions.csv', build: (csv) => csv } },
};
