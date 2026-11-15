// Procedural 3D board built from the parsed .kicad_pcb, so every revision can be
// viewed in 3D without waiting for kicad-cli exports.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Path,
  Shape,
  ShapeUtils,
  Vector2,
  type Material,
} from 'three';
import type { Footprint, Graphic, Pad, Pcb, Pt } from '@jumper/kicad-core/types';
import { arcPoints, padOutline, rotate } from './geometry';

export const MASK_COLORS = {
  green: 0x0f5a2a,
  black: 0x141414,
  blue: 0x123a7a,
  red: 0x8a1414,
  purple: 0x4b1d6b,
  white: 0xe8e8e2,
  yellow: 0xc9a70c,
} as const;
export type MaskColor = keyof typeof MASK_COLORS;

export interface Board3DOptions {
  mask?: MaskColor;
  /** Approximate component bodies from courtyards. */
  components?: boolean;
}

const COPPER_GOLD = 0xd8b04a;
const FR4_EDGE = 0xb9a97a;
const SILK_ON = { white: 0xf2f2f2, black: 0x111111 };
const EPS = 0.012;

// ---------- 2D helpers (KiCad mm, y down) ----------

function graphicPoints(g: Graphic): { pts: Pt[]; closed: boolean } | null {
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

function circlePts(c: Pt, r: number, n = 32): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) pts.push({ x: c.x + r * Math.cos((i / n) * Math.PI * 2), y: c.y + r * Math.sin((i / n) * Math.PI * 2) });
  return pts;
}

const near = (a: Pt, b: Pt, tol = 0.02) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

function area(pts: Pt[]): number {
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

function padShape(pad: Pad): Pt[] {
  if (pad.shape === 'custom' && pad.polygons.length) return pad.polygons[0]!;
  const shape = pad.shape === 'circle' ? 'oval' : pad.shape;
  return padOutline(shape, pad.size.x, pad.size.y, pad.roundrectRratio).map((p) => {
    const r = rotate(p, pad.rotation);
    return { x: r.x + pad.at.x, y: r.y + pad.at.y };
  });
}

function drillShape(pad: Pad): Pt[] | null {
  if (!pad.drill || pad.drill.width <= 0) return null;
  const off = rotate(pad.drill.offset, pad.rotation);
  const c = { x: pad.at.x + off.x, y: pad.at.y + off.y };
  if (pad.drill.oval && pad.drill.height !== pad.drill.width) {
    return padOutline('oval', pad.drill.width, pad.drill.height, 0.5).map((q) => {
      const r = rotate(q, pad.rotation);
      return { x: r.x + c.x, y: r.y + c.y };
    });
  }
  return circlePts(c, pad.drill.width / 2, 24);
}

function padOn(pad: Pad, side: 'F' | 'B', layer: 'Cu' | 'Mask'): boolean {
  return pad.layers.some((l) => l === `${side}.${layer}` || l === `*.${layer}` || (layer === 'Cu' && l === 'F&B.Cu'));
}

// ---------- mesh builders (three: x = kx, y = -ky, z up = top side) ----------

/** Accumulates flat triangles at a fixed z into one geometry. */
class FlatBatch {
  private pos: number[] = [];
  constructor(private readonly z: number) {}

  polygon(pts: Pt[], holes: Pt[][] = []): void {
    if (pts.length < 3) return;
    const contour = pts.map((p) => new Vector2(p.x, -p.y));
    const hs = holes.map((h) => h.map((p) => new Vector2(p.x, -p.y)));
    let tris: number[][];
    try {
      tris = ShapeUtils.triangulateShape(contour, hs);
    } catch {
      return;
    }
    const all = [...contour, ...hs.flat()];
    for (const t of tris) for (const i of t) this.pos.push(all[i]!.x, all[i]!.y, this.z);
  }

  /** Stroke with square segments plus round joints. */
  stroke(pts: Pt[], width: number, closed = false): void {
    if (width <= 0) return;
    const hw = width / 2;
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = (-dy / len) * hw;
      const ny = (dx / len) * hw;
      const q = [
        { x: a.x + nx, y: a.y + ny },
        { x: b.x + nx, y: b.y + ny },
        { x: b.x - nx, y: b.y - ny },
        { x: a.x - nx, y: a.y - ny },
      ];
      this.quad(q);
    }
    if (pts.length <= 64) for (const p of pts) this.polygon(circlePts(p, hw, 10));
  }

  private quad(q: Pt[]): void {
    const z = this.z;
    const v = q.map((p) => [p.x, -p.y, z]);
    this.pos.push(...v[0]!, ...v[1]!, ...v[2]!, ...v[0]!, ...v[2]!, ...v[3]!);
  }

  mesh(material: Material): Mesh | null {
    if (!this.pos.length) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.computeVertexNormals();
    return new Mesh(g, material);
  }
}

function toShape(outer: Pt[], holes: Pt[][]): Shape {
  const ccw = (pts: Pt[], wantCcw: boolean) => {
    // Mirroring y flips orientation; normalise after the flip.
    const v = pts.map((p) => new Vector2(p.x, -p.y));
    return ShapeUtils.isClockWise(v) === wantCcw ? v.reverse() : v;
  };
  const shape = new Shape(ccw(outer, true));
  for (const h of holes) shape.holes.push(new Path(ccw(h, false)));
  return shape;
}

function bodyHeight(fp: Footprint): number {
  const name = fp.libId.toLowerCase();
  const ref = fp.reference.replace(/\d.*$/, '').toUpperCase();
  const chip = name.match(/_(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)_/);
  if (chip) return { '01005': 0.15, '0201': 0.25, '0402': 0.35, '0603': 0.45, '0805': 0.6, '1206': 0.65, '1210': 0.7, '1812': 0.9, '2010': 0.7, '2512': 0.7 }[chip[1]!] ?? 0.5;
  if (/esp32|wroom|wrover|module/.test(name)) return 3.2;
  if (/sot-?23|sot-?323|sot-?363|sc-?70|sod-?(123|323|523)/.test(name)) return 1.05;
  if (/soic|sop|ssop|msop|tssop/.test(name)) return 1.55;
  if (/qfn|dfn|son|lga|bga/.test(name)) return 0.85;
  if (/qfp/.test(name)) return 1.5;
  if (/d_sma|d_smb|d_smc|sma|smb|smc/.test(name)) return 2.2;
  if (/usb_c|usb-c|type-c/.test(name)) return 3.2;
  if (/usb/.test(name)) return 3.5;
  if (/microsd|sd_card|tf-?01/.test(name)) return 1.9;
  if (/pinheader|pin_header|header/.test(name)) return 8.5;
  if (/pinsocket|socket/.test(name)) return 8.5;
  if (/jst|ph_|xh_|conn/.test(name) || ref === 'J') return 4.5;
  if (/sw_|button|switch|ts-?1088|pts645/.test(name) || ref === 'SW') return 3.5;
  if (/crystal|xtal/.test(name)) return 1.0;
  if (/cp_elec|electrolytic/.test(name)) return 6.5;
  if (/inductor|l_/.test(name)) return 2.0;
  if (ref === 'BT') return 5;
  return 1.2;
}

function bodyColor(fp: Footprint): number {
  const name = fp.libId.toLowerCase();
  const ref = fp.reference.replace(/\d.*$/, '').toUpperCase();
  if (ref === 'C' && /_(0201|0402|0603|0805|1206|1210)_/.test(name)) return 0xb48a5a;
  if (ref === 'LED' || /led/.test(name)) return 0xf0f0e6;
  if (/usb|microsd|sd_card|shield/.test(name)) return 0xbfc3c7;
  if (/esp32|module/.test(name)) return 0xa9adb1;
  if (/pinheader|pinsocket|header|socket/.test(name)) return 0x1a1a1a;
  if (/jst|ph_|xh_/.test(name)) return 0xece4cf;
  if (ref === 'SW') return 0x2b2b2b;
  return 0x202124;
}

const SKIP_BODY = /mountinghole|testpoint|fiducial|logo|nettie|solderjumper|jumper:|symbol:/i;

/** Body footprint from the courtyard (falls back to pads/bbox). */
function bodyRect(fp: Footprint, side: 'F' | 'B'): { cx: number; cy: number; w: number; h: number } | null {
  const crt = fp.graphics.filter((g) => g.layer === `${side}.CrtYd` || g.layer === `${side}.Fab`);
  const pts = crt.flatMap((g) => graphicPoints(g)?.pts ?? []);
  const src = pts.length ? pts : fp.pads.flatMap(padShape);
  if (!src.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of src) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  // Courtyards include clearance; Fab outlines are the body itself.
  const inset = pts.length && crt.every((g) => g.layer.endsWith('CrtYd')) ? 0.3 : 0;
  const w = maxX - minX - inset * 2;
  const h = maxY - minY - inset * 2;
  if (w <= 0.05 || h <= 0.05) return null;
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w, h };
}

export function buildBoard3D(pcb: Pcb, opts: Board3DOptions = {}): Group {
  const t = pcb.thickness && pcb.thickness > 0 ? pcb.thickness : 1.6;
  const maskColor = MASK_COLORS[opts.mask ?? 'green'];
  const silkColor = opts.mask === 'white' || opts.mask === 'yellow' ? SILK_ON.black : SILK_ON.white;
  const group = new Group();
  group.name = 'board';

  const edge = [...pcb.graphics.filter((g) => g.layer === 'Edge.Cuts'), ...pcb.footprints.flatMap((f) => f.graphics.filter((g) => g.layer === 'Edge.Cuts'))];
  let loops = outlineLoops(edge);
  if (!loops.length) {
    const b = pcb.bbox ?? { minX: 0, minY: 0, maxX: 50, maxY: 50 };
    loops = [[{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }]];
  }
  loops.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
  const outer = loops[0]!;
  const cutouts = loops.slice(1);

  const pads = pcb.footprints.flatMap((f) => f.pads);
  const drills = pads.map(drillShape).filter((d): d is Pt[] => Boolean(d));
  const viaHoles = pcb.vias.filter((v) => v.drill > 0).map((v) => circlePts(v.at, v.drill / 2, 12));
  // Very dense boards: keep the larger holes in the substrate, draw the rest as dark discs.
  const substrateHoles = drills.length + viaHoles.length > 4000 ? drills : [...drills, ...viaHoles];

  // Substrate with soldermask-coloured faces and FR4 edges.
  const maskMat = new MeshStandardMaterial({ color: maskColor, roughness: 0.45, metalness: 0.05 });
  const edgeMat = new MeshStandardMaterial({ color: FR4_EDGE, roughness: 0.9 });
  const body = new ExtrudeGeometry(toShape(outer, [...cutouts, ...substrateHoles]), { depth: t, bevelEnabled: false, curveSegments: 8 });
  body.translate(0, 0, -t / 2);
  group.add(new Mesh(body, [maskMat, edgeMat]));

  const top = t / 2;
  const bot = -t / 2;
  const tint = (c: number, f: number) => new Color(c).lerp(new Color(0xffffff), f).getHex();
  const copperUnderMask = new MeshStandardMaterial({ color: tint(maskColor, opts.mask === 'black' ? 0.12 : 0.18), roughness: 0.4, metalness: 0.1, side: DoubleSide });
  const gold = new MeshStandardMaterial({ color: COPPER_GOLD, roughness: 0.25, metalness: 0.85, side: DoubleSide });
  const silk = new MeshStandardMaterial({ color: silkColor, roughness: 0.8, side: DoubleSide });
  const hole = new MeshStandardMaterial({ color: 0x0a0a0a, roughness: 1, side: DoubleSide });

  for (const side of ['F', 'B'] as const) {
    const sign = side === 'F' ? 1 : -1;
    const z = side === 'F' ? top : bot;
    const cu = new FlatBatch(z + sign * EPS);
    for (const zone of pcb.zones) for (const f of zone.fills) if (f.layer === `${side}.Cu`) cu.polygon(f.pts);
    for (const tr of pcb.tracks) if (tr.layer === `${side}.Cu`) cu.stroke(tr.mid ? arcPoints(tr.start, tr.mid, tr.end, 24) : [tr.start, tr.end], tr.width);
    // Tented vias stay under the mask; their annular rings show through like copper.
    for (const v of pcb.vias) if (v.drill > 0) cu.polygon(circlePts(v.at, v.size / 2, 16), [circlePts(v.at, v.drill / 2, 12)]);
    const cuMesh = cu.mesh(copperUnderMask);
    if (cuMesh) group.add(cuMesh);

    const exposed = new FlatBatch(z + sign * EPS * 2);
    for (const p of pads) if (padOn(p, side, 'Cu') && (padOn(p, side, 'Mask') || p.kind === 'thru_hole')) {
      const d = drillShape(p);
      exposed.polygon(padShape(p), d ? [d] : []);
    }
    const goldMesh = exposed.mesh(gold);
    if (goldMesh) group.add(goldMesh);

    const sk = new FlatBatch(z + sign * EPS * 3);
    const silkGraphics = [...pcb.graphics, ...pcb.footprints.flatMap((f) => f.graphics)].filter((g) => g.layer === `${side}.SilkS`);
    for (const g of silkGraphics) {
      const p = graphicPoints(g);
      if (!p) continue;
      if (g.fill && p.closed) sk.polygon(p.pts);
      else sk.stroke(p.pts, Math.max(g.width, 0.1), p.closed);
    }
    const silkMesh = sk.mesh(silk);
    if (silkMesh) group.add(silkMesh);

    if (substrateHoles.length !== drills.length + viaHoles.length) {
      const dots = new FlatBatch(z + sign * EPS * 4);
      for (const h of viaHoles) dots.polygon(h);
      const m = dots.mesh(hole);
      if (m) group.add(m);
    }
  }

  // Plated barrels for through-hole pads.
  const barrel = new MeshStandardMaterial({ color: COPPER_GOLD, roughness: 0.3, metalness: 0.8, side: DoubleSide });
  for (const p of pads) {
    if (p.kind !== 'thru_hole' || !p.drill || p.drill.oval) continue;
    const off = rotate(p.drill.offset, p.rotation);
    const cyl = new CylinderGeometry(p.drill.width / 2, p.drill.width / 2, t, 16, 1, true);
    cyl.rotateX(Math.PI / 2);
    const m = new Mesh(cyl, barrel);
    m.position.set(p.at.x + off.x, -(p.at.y + off.y), 0);
    group.add(m);
  }

  if (opts.components !== false) {
    const bodies = new Group();
    bodies.name = 'components';
    const mats = new Map<number, MeshStandardMaterial>();
    const mat = (c: number) => {
      let m = mats.get(c);
      if (!m) mats.set(c, (m = new MeshStandardMaterial({ color: c, roughness: 0.55, metalness: c === 0xbfc3c7 || c === 0xa9adb1 ? 0.7 : 0.05 })));
      return m;
    };
    for (const fp of pcb.footprints) {
      if (SKIP_BODY.test(fp.libId) || fp.attrs.includes('board_only') || !fp.pads.length) continue;
      const side = fp.layer.startsWith('B') ? 'B' : 'F';
      const r = bodyRect(fp, side);
      if (!r) continue;
      const h = bodyHeight(fp);
      const box = new Mesh(new BoxGeometry(r.w, r.h, h), mat(bodyColor(fp)));
      box.position.set(r.cx, -r.cy, side === 'F' ? top + h / 2 + 0.02 : bot - h / 2 - 0.02);
      box.userData = { reference: fp.reference, value: fp.value };
      bodies.add(box);
    }
    group.add(bodies);
  }
  return group;
}
