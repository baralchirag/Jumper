// RoHS and REACH report from the BOM. Answers come from the fields engineers put on symbols ("RoHS", "REACH",
// "SVHC"); where a field is missing and suppliers may be asked, the supplier's RoHS statement fills the gap. A part with
// no answer is "unknown" and keeps the board from being reported as compliant: silence is not a declaration.
import type { ComplianceLine, ComplianceReport, ComplianceStatus, PricedLine } from '@jumper/shared';

export interface BomLineLike {
  references: string[];
  value: string;
  footprint: string;
  libId: string;
  dnp: boolean;
  fields: Record<string, string>;
}

const field = (fields: Record<string, string>, test: RegExp): { name: string; value: string } | null => {
  for (const [k, v] of Object.entries(fields)) if (test.test(k.trim()) && v.trim()) return { name: k.trim(), value: v.trim() };
  return null;
};

/** Read a RoHS field: "Yes", "Compliant", "RoHS3", "Exempt (7a)", "No", "Non-compliant", ... */
export function parseRohsField(text: string): ComplianceStatus {
  const t = text.trim().toLowerCase();
  if (!t || /^(unknown|tbd|n\/?a|\?|-)$/.test(t)) return 'unknown';
  if (/exempt|exemption|\b[67]\([a-c]\)|\b7[a-c]\b/.test(t)) return 'exempt';
  if (/^(no|n|false|0)$|non.?compliant|not compliant|contains lead|leaded/.test(t)) return 'non_compliant';
  if (/^(yes|y|true|1|ok)$|compliant|rohs ?[236]?|lead.?free|pb.?free|green/.test(t)) return 'compliant';
  return 'unknown';
}

/** Read a REACH field: "Compliant", "No SVHC", "Unaffected", "Contains SVHC", "Affected", ... */
export function parseReachField(text: string): ComplianceStatus {
  const t = text.trim().toLowerCase();
  if (!t || /^(unknown|tbd|n\/?a|\?|-)$/.test(t)) return 'unknown';
  if (/^(no|n|false|0)$|non.?compliant|not compliant|contains|^affected|svhc (present|above)/.test(t)) return 'non_compliant';
  if (/^(yes|y|true|1|ok)$|compliant|no svhc|svhc.?free|unaffected|not affected/.test(t)) return 'compliant';
  return 'unknown';
}

const NON_PART = /^(MountingHole|TestPoint|Fiducial|PWR_FLAG|Logo|NetTie|SolderJumper|Jumper_?NC|LOGO)/i;
const STATUSES: ComplianceStatus[] = ['compliant', 'exempt', 'non_compliant', 'unknown'];

export function buildComplianceReport(lines: BomLineLike[], opts: { sha: string; project: string; priced?: PricedLine[]; now?: Date }): ComplianceReport {
  const pricedByRef = new Map<string, PricedLine>();
  for (const p of opts.priced ?? []) for (const r of p.references) pricedByRef.set(r, p);
  let usedSuppliers = false;
  const out: ComplianceLine[] = [];
  for (const l of lines) {
    // Things that are not bought parts (holes, logos, test points) have nothing to declare.
    if (NON_PART.test(l.value) || /^(Mechanical|Graphic|TestPoint|Jumper):/i.test(l.libId)) continue;
    const rohsField = field(l.fields, /^rohs/i);
    const reachField = field(l.fields, /^reach/i);
    const svhcField = field(l.fields, /svhc/i);
    let rohs: ComplianceStatus = rohsField ? parseRohsField(rohsField.value) : 'unknown';
    let rohsSource = rohsField && rohs !== 'unknown' ? rohsField.name : null;
    if (rohs === 'unknown') {
      const offers = Object.values(pricedByRef.get(l.references[0] ?? '')?.offers ?? {}).filter((o) => o.match !== 'parametric' && typeof o.rohs === 'boolean');
      // A supplier saying "not compliant" outweighs another saying nothing; two suppliers disagreeing is reported as the worse.
      const offer = offers.find((o) => o.rohs === false) ?? offers[0];
      if (offer) {
        rohs = offer.rohs ? 'compliant' : 'non_compliant';
        rohsSource = offer.supplier;
        usedSuppliers = true;
      }
    }
    let reach: ComplianceStatus = reachField ? parseReachField(reachField.value) : 'unknown';
    let reachSource = reachField && reach !== 'unknown' ? reachField.name : null;
    let svhc: string | null = null;
    if (svhcField) {
      const none = /^(no|none|n|false|0|-|n\/?a)$/i.test(svhcField.value);
      if (!none) svhc = svhcField.value;
      if (reach === 'unknown' || !none) {
        reach = none ? 'compliant' : 'non_compliant';
        reachSource = svhcField.name;
      }
    }
    out.push({
      references: l.references,
      value: l.value,
      footprint: l.footprint,
      mpn: field(l.fields, /^(mpn|manufacturer_part_number|manufacturer part number|mfr part number|mfr_pn|part number)$/i)?.value ?? null,
      manufacturer: field(l.fields, /^(manufacturer|manufacturer_name|mfr)$/i)?.value ?? null,
      rohs,
      reach,
      rohsSource,
      reachSource,
      svhc,
      dnp: l.dnp,
    });
  }
  const fitted = out.filter((l) => !l.dnp);
  const tally = (key: 'rohs' | 'reach') => Object.fromEntries(STATUSES.map((s) => [s, fitted.filter((l) => l[key] === s).length])) as Record<ComplianceStatus, number>;
  const verdict = (t: Record<ComplianceStatus, number>): ComplianceStatus => (t.non_compliant ? 'non_compliant' : t.unknown || !fitted.length ? 'unknown' : 'compliant');
  const summary = { rohs: tally('rohs'), reach: tally('reach') };
  return { sha: opts.sha, project: opts.project, generatedAt: (opts.now ?? new Date()).toISOString(), lines: out, summary, rohs: verdict(summary.rohs), reach: verdict(summary.reach), usedSuppliers };
}

const cell = (v: string) => {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function complianceCsv(r: ComplianceReport): string {
  const head = ['References', 'Value', 'Footprint', 'Manufacturer', 'MPN', 'Fitted', 'RoHS', 'RoHS source', 'REACH', 'REACH source', 'SVHC'];
  const rows = r.lines.map((l) => [l.references.join(' '), l.value, l.footprint, l.manufacturer ?? '', l.mpn ?? '', l.dnp ? 'no (DNP)' : 'yes', l.rohs, l.rohsSource ?? '', l.reach, l.reachSource ?? '', l.svhc ?? '']);
  return [head, ...rows].map((row) => row.map(cell).join(',')).join('\n') + '\n';
}
