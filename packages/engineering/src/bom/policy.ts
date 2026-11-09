// Part policy: approved vendor list, preferred parts, banned parts, applied to a BOM.

export interface PartPolicy {
  /** Manufacturers that may be used. Empty = no restriction. */
  approvedManufacturers: string[];
  /** MPN patterns that are preferred (informational). `*` matches any run of characters. */
  preferredParts: string[];
  /** MPN/value patterns that must not be used. */
  bannedParts: { pattern: string; reason: string }[];
  /** Footprint patterns that must not be used. */
  bannedFootprints: { pattern: string; reason: string }[];
}

export const EMPTY_POLICY: PartPolicy = { approvedManufacturers: [], preferredParts: [], bannedParts: [], bannedFootprints: [] };

export interface PolicyLine {
  references: string[];
  value: string;
  footprint: string;
  mpn?: string | null;
  manufacturer?: string | null;
}

export interface PolicyViolation {
  references: string[];
  rule: 'banned-part' | 'banned-footprint' | 'unapproved-manufacturer';
  message: string;
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function checkPolicy(lines: PolicyLine[], policy: PartPolicy): { violations: PolicyViolation[]; preferred: number; total: number } {
  const violations: PolicyViolation[] = [];
  const banned = policy.bannedParts.map((b) => ({ re: globToRegExp(b.pattern), reason: b.reason }));
  const bannedFp = policy.bannedFootprints.map((b) => ({ re: globToRegExp(b.pattern), reason: b.reason }));
  const preferred = policy.preferredParts.map(globToRegExp);
  const approved = policy.approvedManufacturers.map((m) => m.trim().toLowerCase());
  let pref = 0;
  for (const l of lines) {
    const ids = [l.mpn, l.value].filter((x): x is string => !!x);
    for (const b of banned) {
      if (ids.some((id) => b.re.test(id))) violations.push({ references: l.references, rule: 'banned-part', message: `${l.mpn || l.value} is banned: ${b.reason}` });
    }
    for (const b of bannedFp) {
      if (b.re.test(l.footprint)) violations.push({ references: l.references, rule: 'banned-footprint', message: `Footprint ${l.footprint} is banned: ${b.reason}` });
    }
    if (approved.length && l.manufacturer && !approved.includes(l.manufacturer.trim().toLowerCase())) {
      violations.push({ references: l.references, rule: 'unapproved-manufacturer', message: `${l.manufacturer} is not on the approved vendor list` });
    }
    if (l.mpn && preferred.some((re) => re.test(l.mpn!))) pref++;
  }
  return { violations, preferred: pref, total: lines.length };
}
