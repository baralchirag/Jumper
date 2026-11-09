// Turn a BOM line into supplier search queries.
import type { BomLine } from '@jumper/kicad-core/types';

export interface PartQuery {
  /** LCSC/JLCPCB part number (C123). */
  lcsc: string | null;
  mouser: string | null;
  digikey: string | null;
  mpn: string | null;
  manufacturer: string | null;
  /** Parametric search ("4.7kΩ 0603 resistor") when no part number is known. */
  keyword: string | null;
  datasheet: string | null;
  /** Mounting holes, test points, logos, … */
  skip: boolean;
}

const field = (fields: Record<string, string>, pred: (k: string) => boolean): string | null => {
  for (const [k, v] of Object.entries(fields)) {
    const val = v.trim();
    if (val && val !== '~' && pred(k.toLowerCase())) return val;
  }
  return null;
};

const NON_PARTS = /^(MountingHole|TestPoint|Fiducial|PWR_FLAG|Logo|NetTie|SolderJumper|Hole|Pad)(_|$)/i;
const NON_PART_REFS = /^(H|MH|TP|FID|LOGO|NT|#)\d*$/i;
const NON_PART_LIBS = /^(Mechanical|Graphic|TestPoint|power):/i;

/** "R_0603_1608Metric" → "0603", "SOIC-8_3.9x4.9mm_P1.27mm" → "SOIC-8". */
export function packageOf(footprint: string): string | null {
  const name = footprint.slice(footprint.indexOf(':') + 1);
  const chip = name.match(/(?:^|_)(01005|0201|0402|0603|0805|1008|1206|1210|1812|2010|2512)(?:_|$)/);
  if (chip) return chip[1]!;
  const ic = name.match(/(?:^|_)((?:H?T?SSOP|E?SOIC|E?SOP|MSOP|TSOT|SOT|SOD|DFN|QFN|LQFP|TQFP|VQFN|WQFN|UQFN|TO|SC|DO|BGA)-\d+(?:-\d+)?)/i);
  if (ic) return ic[1]!.toUpperCase();
  const diode = name.match(/(?:^|_)(SMA|SMB|SMC|MELF|MiniMELF)(?:_|$)/i);
  return diode ? diode[1]!.toUpperCase() : null;
}

const SI: Record<string, string> = { p: 'p', n: 'n', u: 'u', µ: 'u', m: 'm', k: 'k', K: 'k', M: 'M', G: 'G', R: '', r: '' };

/** "4.7k" → "4.7kΩ", "4k7" → "4.7kΩ", "100" → "100Ω". Null when not a resistance. */
export function normalizeResistance(v: string): string | null {
  const s = v.trim().replace(/\s*(ohms?|Ω)$/i, '');
  let m = s.match(/^(\d+(?:\.\d+)?)\s*([RrkKM]?)$/);
  if (m) return `${m[1]}${SI[m[2]!] ?? ''}Ω`;
  m = s.match(/^(\d+)([RrkKM])(\d+)$/);
  if (m) return `${m[1]}.${m[3]}${SI[m[2]!] ?? ''}Ω`;
  return null;
}

/** "0.1uf" → "100nF", "10u" → "10uF", "4u7" → "4.7uF". Null when not a capacitance. */
export function normalizeCapacitance(v: string): string | null {
  const s = v.trim().split(/[\s/,]/)[0]!.replace(/f$/i, '');
  let m = s.match(/^(\d+(?:\.\d+)?)\s*([pnuµm]?)$/i);
  if (!m) {
    const alt = s.match(/^(\d+)([pnuµ])(\d+)$/i);
    if (!alt) return null;
    m = [s, `${alt[1]}.${alt[3]}`, alt[2]!] as unknown as RegExpMatchArray;
  }
  const scale: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, '': 1e-6 };
  const farads = Number(m[1]) * (scale[m[2]!.toLowerCase()] ?? 1e-6);
  const units: [number, string][] = [[1e-6, 'uF'], [1e-9, 'nF'], [1e-12, 'pF']];
  for (const [mult, unit] of units) {
    const n = farads / mult;
    if (n >= 1 - 1e-9) return `${+n.toPrecision(3)}${unit}`;
  }
  return `${+(farads / 1e-12).toPrecision(3)}pF`;
}

function inductance(v: string): string | null {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([nuµm]?)H?$/i);
  return m ? `${m[1]}${(m[2] || 'u').replace('µ', 'u')}H` : null;
}

/** Component class from the library symbol, falling back to the reference prefix. */
function categoryOf(line: BomLine): string {
  const sym = line.libId.split(':').pop() ?? '';
  if (/^(R|R_Small|R_US|R_Pack\d+)$/.test(sym)) return 'R';
  if (/^(C|C_Small|C_Polarized|CP|CP_Small|C_Polarized_Small)$/.test(sym)) return 'C';
  if (/^(L|L_Small|L_Core\w*)$/.test(sym)) return 'L';
  if (/^LED/.test(sym) || /^LED/i.test(line.footprint.split(':').pop() ?? '')) return 'LED';
  const ref = (line.references[0] ?? '').replace(/\d.*$/, '').toUpperCase();
  if (ref === 'LED') return 'LED';
  if (/^R/.test(ref) && normalizeResistance(line.value)) return 'R';
  if (/^C/.test(ref) && !/^CON/.test(ref) && normalizeCapacitance(line.value)) return 'C';
  return ref;
}

const MPN_LIKE = /^[A-Z0-9][A-Z0-9\-_./+#]{3,}$/i;

export function buildQuery(line: BomLine): PartQuery {
  const f = line.fields;
  const datasheet = f.Datasheet && /^https?:\/\//.test(f.Datasheet) ? f.Datasheet : null;
  const prefix = categoryOf(line);
  const skip = NON_PARTS.test(line.value) || NON_PART_LIBS.test(line.libId) || line.references.every((r) => NON_PART_REFS.test(r)) || /^MountingHole/i.test(line.footprint.split(':').pop() ?? '');

  const lcscRaw = field(f, (k) => k.includes('lcsc') || k.includes('jlc'));
  const lcsc = lcscRaw && /^C\d{2,}$/i.test(lcscRaw) ? lcscRaw.toUpperCase() : null;
  const mouser = field(f, (k) => k.includes('mouser') && !k.includes('testing'));
  const digikey = field(f, (k) => k.includes('digikey') || k.includes('digi-key'));
  const mpn =
    field(f, (k) => k === 'mpn' || k === 'manufacturer_part_number' || k === 'manufacturer part number' || k === 'mfr part number' || k === 'mfr_pn' || k === 'part number') ??
    // Specific-looking values ("TP4056", "MIC5219-3.3YM5") double as part numbers.
    (!['R', 'C', 'L', 'FB'].includes(prefix) && MPN_LIKE.test(line.value) && /\d/.test(line.value) && /[A-Z]{2}/i.test(line.value) && !/^(Conn|USB|SW|LED|Crystal)_/i.test(line.value) ? line.value : null);
  const manufacturer = field(f, (k) => k === 'manufacturer' || k === 'manufacturer_name' || k === 'mfr');

  const pkg = packageOf(line.footprint);
  let keyword: string | null = null;
  if (!mpn && !lcsc) {
    const parts: string[] = [];
    if (prefix === 'R') parts.push(normalizeResistance(line.value) ?? line.value);
    else if (prefix === 'C') parts.push(normalizeCapacitance(line.value) ?? line.value);
    else if (prefix === 'L') parts.push(inductance(line.value) ?? line.value, 'inductor');
    else if (prefix === 'LED') {
      // LED values are often labels ("CHG", "PWR"); only a colour helps the search.
      const colour = line.value.match(/red|green|blue|yellow|white|orange|amber|warm|rgb/i)?.[0];
      parts.push('LED', colour ?? '');
    }
    else parts.push(line.value.replace(/_/g, ' '));
    if (pkg) parts.push(pkg);
    keyword = parts.filter(Boolean).join(' ').trim() || null;
  }
  return { lcsc, mouser, digikey, mpn, manufacturer, keyword, datasheet, skip };
}
