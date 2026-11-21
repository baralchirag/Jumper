import type { Footprint, Pcb, Pt } from '@jumper/kicad-core/types';
import type { BoardPoint, Highlight3D } from '@jumper/viewer';

/** What a click on the 3D board selected: a part, or the net of the copper under it. */
export type Pick3D = { kind: 'part'; fp: Footprint } | { kind: 'net'; net: number; name: string };

export const PICK_COLOR = 0x2f9bff;

const isBottom = (fp: Footprint) => fp.layer.startsWith('B');
const area = (fp: Footprint) => (fp.bbox ? (fp.bbox.maxX - fp.bbox.minX) * (fp.bbox.maxY - fp.bbox.minY) : Infinity);

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function inPolygon(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Which copper layer names are on the face that was clicked. */
const onFace = (layer: string, top: boolean) => layer === (top ? 'F.Cu' : 'B.Cu') || /^In\d+\.Cu$/.test(layer);

export function netName(pcb: Pcb, net: number): string {
  return pcb.nets.find((n) => n.id === net)?.name || `Net ${net}`;
}

/**
 * Resolve a click. A hit above the face is a part body. On the face, copper wins (a track, via or pad belongs to a
 * net), then the footprint under the point, then the copper pour.
 */
export function resolvePick(pcb: Pcb, p: BoardPoint): Pick3D | null {
  const parts = pcb.footprints
    .filter((f) => f.bbox && p.x >= f.bbox.minX - 0.2 && p.x <= f.bbox.maxX + 0.2 && p.y >= f.bbox.minY - 0.2 && p.y <= f.bbox.maxY + 0.2)
    .sort((a, b) => Number(isBottom(a) !== !p.top) - Number(isBottom(b) !== !p.top) || area(a) - area(b));
  const part = parts[0];
  if (part && p.lift > 0.2) return { kind: 'part', fp: part };

  const net = (id: number): Pick3D | null => (id > 0 ? { kind: 'net', net: id, name: netName(pcb, id) } : null);
  for (const v of pcb.vias) if (Math.hypot(p.x - v.at.x, p.y - v.at.y) <= v.size / 2 + 0.05) return net(v.net) ?? null;
  for (const t of pcb.tracks) if (onFace(t.layer, p.top) && distToSegment(p, t.start, t.end) <= t.width / 2 + 0.08) return net(t.net) ?? null;
  // A pad belongs to its part: select the part, its nets are one click away in the card.
  if (part) return { kind: 'part', fp: part };
  for (const z of pcb.zones) {
    if (z.keepout || z.net <= 0) continue;
    if (z.fills.some((f) => onFace(f.layer, p.top) && inPolygon(p, f.pts))) return net(z.net);
  }
  return null;
}

const faceOf = (layer: string): boolean | null => (layer === 'F.Cu' ? true : layer === 'B.Cu' ? false : null);

export function highlightFor(pcb: Pcb, pick: Pick3D, partHeight = 1.2): Highlight3D {
  if (pick.kind === 'part') {
    const b = pick.fp.bbox!;
    return { color: PICK_COLOR, segments: [], discs: [], boxes: [{ ...b, top: !isBottom(pick.fp), height: partHeight }] };
  }
  const segments = pcb.tracks.filter((t) => t.net === pick.net).map((t) => ({ a: t.start, b: t.end, width: t.width, top: faceOf(t.layer) }));
  const discs = [
    ...pcb.vias.filter((v) => v.net === pick.net).map((v) => ({ x: v.at.x, y: v.at.y, r: v.size / 2, top: null })),
    ...pcb.footprints.flatMap((f) =>
      f.pads
        .filter((pad) => pad.net === pick.net)
        .map((pad) => ({
          x: pad.at.x,
          y: pad.at.y,
          r: Math.max(Math.min(pad.size.x, pad.size.y) / 2, 0.2),
          top: pad.kind === 'thru_hole' ? null : !isBottom(f),
        })),
    ),
  ];
  return { color: PICK_COLOR, segments, discs, boxes: [] };
}

/** Summary for the card: track length, vias and the parts a net connects. */
export function netSummary(pcb: Pcb, net: number) {
  const tracks = pcb.tracks.filter((t) => t.net === net);
  const length = tracks.reduce((s, t) => s + Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y), 0);
  const vias = pcb.vias.filter((v) => v.net === net).length;
  const parts = pcb.footprints.filter((f) => f.pads.some((p) => p.net === net)).map((f) => f.reference);
  return { tracks: tracks.length, length, vias, parts: [...new Set(parts)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) };
}

/** The nets a part's pads are on, with the pads on each. */
export function partNets(fp: Footprint) {
  const m = new Map<number, { net: number; name: string; pads: string[] }>();
  for (const p of fp.pads) {
    if (p.net <= 0) continue;
    const e = m.get(p.net) ?? { net: p.net, name: p.netName || `Net ${p.net}`, pads: [] };
    e.pads.push(p.number);
    m.set(p.net, e);
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}
