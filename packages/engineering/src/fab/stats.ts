import type { BBox, Pcb } from '@jumper/kicad-core/types';

export interface BoardStats {
  copperLayers: number;
  widthMm: number | null;
  heightMm: number | null;
  footprints: number;
  smdPads: number;
  thruHolePads: number;
  tracks: number;
  vias: number;
  nets: number;
  zones: number;
  minTrackWidthMm: number | null;
  minViaDiameterMm: number | null;
  minViaDrillMm: number | null;
  minHoleDrillMm: number | null;
  minAnnularRingMm: number | null;
  totalTrackLengthMm: number;
  boardThicknessMm: number | null;
  /** Fraction of the board area covered by footprint courtyards/bboxes (rough density indicator). */
  componentDensity: number | null;
  /** Pads/mm² of board area. */
  padDensity: number | null;
}

const min = (xs: number[]): number | null => (xs.length ? Math.min(...xs) : null);
const bboxSize = (b: BBox | null) => (b ? { w: b.maxX - b.minX, h: b.maxY - b.minY } : null);

function edgeBBox(pcb: Pcb): BBox | null {
  let b: BBox | null = null;
  const grow = (x: number, y: number) => {
    b = b ? { minX: Math.min(b.minX, x), minY: Math.min(b.minY, y), maxX: Math.max(b.maxX, x), maxY: Math.max(b.maxY, y) } : { minX: x, minY: y, maxX: x, maxY: y };
  };
  for (const g of pcb.graphics) {
    if (g.layer !== 'Edge.Cuts') continue;
    switch (g.type) {
      case 'line':
      case 'rect':
        grow(g.start.x, g.start.y);
        grow(g.end.x, g.end.y);
        break;
      case 'arc':
        grow(g.start.x, g.start.y);
        grow(g.mid.x, g.mid.y);
        grow(g.end.x, g.end.y);
        break;
      case 'circle': {
        const r = Math.hypot(g.end.x - g.center.x, g.end.y - g.center.y);
        grow(g.center.x - r, g.center.y - r);
        grow(g.center.x + r, g.center.y + r);
        break;
      }
      case 'poly':
      case 'curve':
        g.pts.forEach((p) => grow(p.x, p.y));
        break;
    }
  }
  return b;
}

function trackLength(t: Pcb['tracks'][number]): number {
  if (!t.mid) return Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
  // Arc through three points: length = r * angle.
  const [a, b, c] = [t.start, t.mid, t.end];
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return Math.hypot(c.x - a.x, c.y - a.y);
  const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
  const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
  const r = Math.hypot(a.x - ux, a.y - uy);
  const ang = (p: { x: number; y: number }) => Math.atan2(p.y - uy, p.x - ux);
  const sweep = (from: number, to: number, ccw: boolean) => {
    let s = ccw ? to - from : from - to;
    while (s < 0) s += 2 * Math.PI;
    return s;
  };
  const ccw = sweep(ang(a), ang(b), true) < sweep(ang(a), ang(c), true);
  return r * sweep(ang(a), ang(c), ccw);
}

export function computeBoardStats(pcb: Pcb): BoardStats {
  const copper = pcb.layers.filter((l) => /\.Cu$/.test(l.name)).length;
  const size = bboxSize(edgeBBox(pcb) ?? pcb.bbox);
  const pads = pcb.footprints.flatMap((f) => f.pads);
  const holes = pads.filter((p) => p.drill && p.drill.width > 0);
  const ringsPads = holes
    .filter((p) => p.kind === 'thru_hole')
    .map((p) => (Math.min(p.size.x, p.size.y) - Math.min(p.drill!.width, p.drill!.oval ? p.drill!.height : p.drill!.width)) / 2);
  const ringsVias = pcb.vias.map((v) => (v.size - v.drill) / 2);
  const area = size ? size.w * size.h : null;
  const fpArea = pcb.footprints.reduce((s, f) => s + (f.bbox ? (f.bbox.maxX - f.bbox.minX) * (f.bbox.maxY - f.bbox.minY) : 0), 0);
  return {
    copperLayers: copper,
    widthMm: size ? round(size.w) : null,
    heightMm: size ? round(size.h) : null,
    footprints: pcb.footprints.length,
    smdPads: pads.filter((p) => p.kind === 'smd').length,
    thruHolePads: pads.filter((p) => p.kind === 'thru_hole').length,
    tracks: pcb.tracks.length,
    vias: pcb.vias.length,
    nets: pcb.nets.filter((n) => n.name !== '').length,
    zones: pcb.zones.filter((z) => !z.keepout).length,
    minTrackWidthMm: min(pcb.tracks.map((t) => t.width)),
    minViaDiameterMm: min(pcb.vias.map((v) => v.size)),
    minViaDrillMm: min(pcb.vias.map((v) => v.drill)),
    minHoleDrillMm: min([...pcb.vias.map((v) => v.drill), ...holes.map((p) => Math.min(p.drill!.width, p.drill!.oval ? p.drill!.height : p.drill!.width))]),
    minAnnularRingMm: min([...ringsPads, ...ringsVias]),
    totalTrackLengthMm: round(pcb.tracks.reduce((s, t) => s + trackLength(t), 0)),
    boardThicknessMm: pcb.thickness,
    componentDensity: area ? round(fpArea / area, 3) : null,
    padDensity: area ? round(pads.length / area, 4) : null,
  };
}

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
