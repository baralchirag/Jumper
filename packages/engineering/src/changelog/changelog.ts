import type { DiffResult } from '@jumper/kicad-core/types';

export interface ChangelogOptions {
  /** Cap on listed references per bullet. */
  maxRefs?: number;
}

const NOUN: Record<string, [string, string]> = {
  footprint: ['footprint', 'footprints'],
  track: ['track segment', 'track segments'],
  via: ['via', 'vias'],
  zone: ['zone', 'zones'],
  symbol: ['symbol', 'symbols'],
  wire: ['wire', 'wires'],
  label: ['label', 'labels'],
  sheet: ['sheet', 'sheets'],
  graphic: ['graphic', 'graphics'],
  text: ['text item', 'text items'],
};

const plural = (kind: string, n: number) => (NOUN[kind] ?? [kind, `${kind}s`])[n === 1 ? 0 : 1];

/** Human-readable change summary for a semantic diff, as Markdown bullets. */
export function summarizeDiff(diff: DiffResult, { maxRefs = 6 }: ChangelogOptions = {}): string[] {
  const out: string[] = [];
  const refs = (labels: string[]) => {
    const shown = labels.slice(0, maxRefs).join(', ');
    return labels.length > maxRefs ? `${shown} and ${labels.length - maxRefs} more` : shown;
  };
  const kinds = [...new Set(diff.changes.map((c) => c.object))];
  for (const kind of kinds) {
    for (const op of ['added', 'removed', 'modified'] as const) {
      const items = diff.changes.filter((c) => c.object === kind && c.op === op);
      if (!items.length) continue;
      const named = kind === 'footprint' || kind === 'symbol';
      out.push(`${cap(op)} ${items.length} ${plural(kind, items.length)}${named ? ` (${refs(items.map((i) => i.label))})` : ''}`);
    }
  }
  for (const c of diff.changes) {
    if (c.op !== 'modified' || (c.object !== 'footprint' && c.object !== 'symbol')) continue;
    for (const f of c.fields) {
      if (f.field === 'value') out.push(`${c.label}: value ${fmt(f.before)} → ${fmt(f.after)}`);
    }
  }
  for (const n of diff.nets) {
    if (n.op === 'added') out.push(`New net ${n.name}`);
    else if (n.op === 'removed') out.push(`Removed net ${n.name}`);
    else {
      const parts: string[] = [];
      if (n.viasBefore !== n.viasAfter) parts.push(`vias ${n.viasBefore} → ${n.viasAfter}`);
      if (Math.abs(n.lengthAfter - n.lengthBefore) >= 0.5) parts.push(`length ${n.lengthBefore.toFixed(1)} → ${n.lengthAfter.toFixed(1)} mm`);
      if (n.padsBefore.join() !== n.padsAfter.join()) parts.push('pads changed');
      if (parts.length) out.push(`Net ${n.name}: ${parts.join(', ')}`);
    }
  }
  return out;
}

export function changelogMarkdown(title: string, diffs: { file: string; diff: DiffResult }[], opts?: ChangelogOptions): string {
  const lines = [`## ${title}`, ''];
  let any = false;
  for (const { file, diff } of diffs) {
    const bullets = summarizeDiff(diff, opts);
    if (!bullets.length) continue;
    any = true;
    lines.push(`### ${file}`, ...bullets.map((b) => `- ${b}`), '');
  }
  if (!any) lines.push('No design changes.', '');
  return lines.join('\n');
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const fmt = (v: unknown) => (typeof v === 'string' ? `\`${v}\`` : JSON.stringify(v));
