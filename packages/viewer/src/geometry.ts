import type { BBox, Pt } from '@pcbhub/kicad-core/types';

export const DEG = Math.PI / 180;

/** KiCad rotation (CCW on screen, y-down) of a local point around the origin. */
export function rotate(p: Pt, deg: number): Pt {
  if (!deg) return p;
  const s = Math.sin(deg * DEG);
  const c = Math.cos(deg * DEG);
  return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c };
}

/** Sample an arc through three points. Falls back to a line when collinear. */
export function arcPoints(start: Pt, mid: Pt, end: Pt, segmentsPerCircle = 64): Pt[] {
  const ax = start.x, ay = start.y, bx = mid.x, by = mid.y, cx = end.x, cy = end.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return [start, end];
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const am = Math.atan2(by - uy, bx - ux);
  const a1 = Math.atan2(cy - uy, cx - ux);
  const norm = (a: number) => {
    let x = a % (2 * Math.PI);
    if (x < 0) x += 2 * Math.PI;
    return x;
  };
  // Sweep from a0 to a1 passing through am.
  let sweep = norm(a1 - a0);
  if (norm(am - a0) > sweep) sweep -= 2 * Math.PI;
  const n = Math.max(4, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * segmentsPerCircle));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push({ x: ux + r * Math.cos(a), y: uy + r * Math.sin(a) });
  }
  return pts;
}

export function flatten(pts: Pt[]): number[] {
  const out = new Array<number>(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    out[i * 2] = pts[i]!.x;
    out[i * 2 + 1] = pts[i]!.y;
  }
  return out;
}

/** Rounded rectangle / stadium / rect outline centred at the origin. */
export function padOutline(shape: string, w: number, h: number, rratio: number): Pt[] {
  const hw = w / 2;
  const hh = h / 2;
  let r = 0;
  if (shape === 'roundrect') r = Math.min(hw, hh) * Math.min(0.5, rratio) * 2;
  if (shape === 'oval') r = Math.min(hw, hh);
  if (r <= 1e-9) {
    return [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh },
    ];
  }
  const pts: Pt[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 6; i++) {
      const a = (a0 + (90 * i) / 6) * DEG;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  };
  corner(hw - r, hh - r, 0);
  corner(-hw + r, hh - r, 90);
  corner(-hw + r, -hh + r, 180);
  corner(hw - r, -hh + r, 270);
  return pts;
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function bboxOf(pts: Pt[], pad = 0): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function inBBox(p: Pt, b: BBox, pad = 0): boolean {
  return p.x >= b.minX - pad && p.x <= b.maxX + pad && p.y >= b.minY - pad && p.y <= b.maxY + pad;
}

export function unionBBox(a: BBox | null, b: BBox | null): BBox | null {
  if (!a) return b;
  if (!b) return a;
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}
