// Flat status badges (SVG) for READMEs, in the familiar two-part "label | message" shape.

const COLORS = {
  success: '#2f9e44',
  failure: '#d9480f',
  pending: '#c99a06',
  neutral: '#868e96',
  info: '#3f6fb5',
} as const;
export type BadgeTone = keyof typeof COLORS;

// Approximate advance widths for 11px Verdana, the de-facto badge font; wide and narrow glyphs differ a lot.
const NARROW = new Set('ijlI.,:;|!\'`()[]{} ');
const WIDE = new Set('mwMW@%');
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += NARROW.has(ch) ? 3.6 : WIDE.has(ch) ? 10 : /[A-Z0-9]/.test(ch) ? 7.5 : 6.6;
  return Math.ceil(w);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function badgeSvg(label: string, message: string, tone: BadgeTone): string {
  const l = label.slice(0, 40);
  const m = message.slice(0, 40);
  const lw = textWidth(l) + 12;
  const mw = textWidth(m) + 12;
  const w = lw + mw;
  const color = COLORS[tone];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(l)}: ${esc(m)}">
<title>${esc(l)}: ${esc(m)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#3b3a38"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(l)}</text><text x="${lw / 2}" y="14">${esc(l)}</text>
<text x="${lw + mw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(m)}</text><text x="${lw + mw / 2}" y="14">${esc(m)}</text>
</g></svg>`;
}

export interface CheckState {
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
}

/** Collapse one or more check runs into a badge message: any failure fails, anything running is pending. */
export function summarize(runs: CheckState[]): { message: string; tone: BadgeTone } {
  if (!runs.length) return { message: 'no checks', tone: 'neutral' };
  if (runs.some((r) => r.status === 'completed' && (r.conclusion === 'failure' || r.conclusion === 'timed_out'))) return { message: 'failing', tone: 'failure' };
  if (runs.some((r) => r.status !== 'completed')) return { message: 'running', tone: 'pending' };
  if (runs.every((r) => r.conclusion === 'skipped' || r.conclusion === 'cancelled')) return { message: 'skipped', tone: 'neutral' };
  if (runs.some((r) => r.conclusion === 'neutral')) return { message: 'warnings', tone: 'pending' };
  return { message: 'passing', tone: 'success' };
}
