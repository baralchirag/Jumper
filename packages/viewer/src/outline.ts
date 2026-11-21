import type { Graphic, Pt } from '@jumper/kicad-core/types';
import { arcPoints } from './geometry';

// ---------- Board outline (KiCad mm, y down), shared by the 2D and 3D views ----------

export function graphicPoints(g: Graphic): { pts: Pt[]; closed: boolean } | null {
  switch (g.type) {
    case 'line':
      return { pts: [g.start, g.end], closed: false };
    case 'arc':
      return { pts: arcPoints(g.start, g.mid, g.end, 72), closed: false };
    case 'rect':
      return { pts: [g.start, { x: g.end.x, y: g.start.y }, g.end, { x: g.start.x, y: g.end.y }], closed: true };
    case 'circle': {
      const r = Math.hypot(g.end.x - g.center.x, g.end.y - g.center.y);
      return { pts: circlePts(g.center, r, 72), closed: true };
    }
    case 'poly':
      return { pts: g.pts, closed: true };
    case 'curve':
      return { pts: g.pts, closed: false };
  }
}

export function circlePts(c: Pt, r: number, n = 32): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) pts.push({ x: c.x + r * Math.cos((i / n) * Math.PI * 2), y: c.y + r * Math.sin((i / n) * Math.PI * 2) });
  return pts;
}

const near = (a: Pt, b: Pt, tol = 0.02) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

export function area(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j]!.x + pts[i]!.x) * (pts[j]!.y - pts[i]!.y);
  return a / 2;
}

/** Chain Edge.Cuts segments into closed loops. */
export function outlineLoops(graphics: Graphic[]): Pt[][] {
  const loops: Pt[][] = [];
  const open: Pt[][] = [];
  for (const g of graphics) {
    const p = graphicPoints(g);
    if (!p || p.pts.length < 2) continue;
    (p.closed ? loops : open).push([...p.pts]);
  }
  while (open.length) {
    let chain = open.pop()!;
    let grown = true;
    while (grown && !near(chain[0]!, chain[chain.length - 1]!)) {
      grown = false;
      for (let i = 0; i < open.length; i++) {
        const s = open[i]!;
        const head = chain[0]!;
        const tail = chain[chain.length - 1]!;
        if (near(tail, s[0]!)) chain = [...chain, ...s.slice(1)];
        else if (near(tail, s[s.length - 1]!)) chain = [...chain, ...s.slice(0, -1).reverse()];
        else if (near(head, s[s.length - 1]!)) chain = [...s.slice(0, -1), ...chain];
        else if (near(head, s[0]!)) chain = [...s.slice(1).reverse(), ...chain];
        else continue;
        open.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (chain.length >= 3 && near(chain[0]!, chain[chain.length - 1]!)) loops.push(chain.slice(0, -1));
  }
  return loops.filter((l) => l.length >= 3 && Math.abs(area(l)) > 1e-3);
}
