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
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Path,
  Shape,
  ShapeUtils,
  Vector2,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Footprint, Pad, Pcb, Pt } from '@jumper/kicad-core/types';
import { arcPoints, padOutline, rotate } from './geometry';
import { area, circlePts, graphicPoints, outlineLoops } from './outline';

export { outlineLoops };

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

const COPPER_GOLD = 0xe2bf6b; // ENIG finish
const FR4_EDGE = 0xcbbf94;
const SILK_ON = { white: 0xf4f4f0, black: 0x111111 };
const EPS = 0.012;

// ---------- 2D helpers (KiCad mm, y down) ----------

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

/** Footprint library id plus its 3D model file names: the model name is usually the most precise description. */
function partName(fp: Footprint): string {
  return [fp.libId, ...fp.models.map((m) => m.split('/').pop() ?? m)].join(' ').toLowerCase();
}

function bodyHeight(fp: Footprint): number {
  const name = partName(fp);
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

const SKIP_BODY = /mountinghole|testpoint|fiducial|logo|nettie|solderjumper|jumper:|symbol:/i;
const DEG = Math.PI / 180;

type PartKind = 'chip' | 'led' | 'ic' | 'header' | 'socket' | 'switch' | 'shell' | 'can' | 'crystal' | 'axial' | 'radial' | 'generic';

function partKind(fp: Footprint): PartKind {
  const name = partName(fp);
  const ref = fp.reference.replace(/\d.*$/, '').toUpperCase();
  const chip = /_(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)_/.test(name);
  if (/led/.test(name) || ref === 'LED') return 'led';
  if (chip) return 'chip';
  if (/pinheader|pin_header/.test(name)) return 'header';
  if (/pinsocket|socket/.test(name)) return 'socket';
  if (/usb|microsd|sd_card|shield|esp32|wroom|wrover|module/.test(name)) return 'shell';
  if (/cp_elec|electrolytic/.test(name)) return 'can';
  if (/crystal|xtal|oscillator/.test(name)) return 'crystal';
  if (/sw_|button|switch|ts-?1088|pts645|pts810|evqp/.test(name) || ref === 'SW') return 'switch';
  if (/soic|sop|ssop|msop|tssop|qfn|dfn|son|lga|bga|qfp|sot-?\d|sc-?70|sod-?\d|d_sm|to-?252|to-?263|wson|vson/.test(name)) return 'ic';
  // Through-hole two-lead parts: resistors and diodes lie between their leads, capacitors stand up as cans.
  const tht2 = fp.pads.length === 2 && fp.pads.every((p) => p.kind === 'thru_hole');
  if (tht2 && /axial|r_|resistor|do-?\d|d_do|diode/.test(name)) return 'axial';
  if (tht2 && (ref === 'R' || ref === 'D')) return 'axial';
  if (tht2 && (ref === 'C' || /radial|cp_|c_disc|c_rect/.test(name))) return 'radial';
  if (/dip|dil/.test(name) || ref === 'U' || ref === 'Q') return 'ic';
  return 'generic';
}

/** The surface a real part of this footprint mostly shows: used for 3D models that arrive without colours. */
export type PartFinish = { color: number; roughness: number; metalness: number };
export function partFinish(fp: Footprint): PartFinish {
  const kind = partKind(fp);
  const ref = fp.reference.replace(/\d.*$/, '').toUpperCase();
  const plastic = (color: number, roughness = 0.65): PartFinish => ({ color, roughness, metalness: 0 });
  const metal = (color: number, roughness = 0.3): PartFinish => ({ color, roughness, metalness: 0.9 });
  switch (kind) {
    case 'chip':
      return ref === 'C' ? plastic(0xa4855c, 0.72) : ref === 'L' || ref === 'FB' ? plastic(0x3a3a3c) : plastic(0x161617, 0.6);
    case 'led':
      return plastic(0xece9e1, 0.5);
    case 'shell':
    case 'crystal':
      return metal(0xc8ccd1, 0.26);
    case 'can':
      return metal(0xb9bdc2, 0.35);
    case 'axial':
      return ref === 'D' ? plastic(0x1d1d1f, 0.4) : plastic(0xd6c094, 0.6);
    case 'radial':
      return plastic(0x1e3a6b, 0.45);
    case 'header':
    case 'socket':
      return plastic(0x141414, 0.7);
    case 'switch':
      return plastic(0x2a2a2c, 0.6);
    case 'generic':
      return ref === 'J' || ref === 'P' || ref === 'CN' ? plastic(0xefe8d6, 0.78) : plastic(0x1d1d1f, 0.62);
    default:
      return plastic(0x1d1d1f, 0.62);
  }
}

/** Shared physically based materials for parts, created once per build. */
function partMaterials() {
  const std = (color: number, roughness: number, metalness = 0) => new MeshStandardMaterial({ color, roughness, metalness });
  return {
    tin: std(0xd9dbde, 0.3, 1),
    gold: std(0xe6bd62, 0.28, 1),
    epoxy: std(0x1c1c1e, 0.55),
    resistor: std(0x161617, 0.6),
    mlcc: std(0xa4855c, 0.72),
    ceramicWhite: std(0xece9e1, 0.6),
    plastic: std(0x141414, 0.7),
    nylon: std(0xefe8d6, 0.78),
    shell: std(0xc8ccd1, 0.24, 1),
    aluminium: std(0xb9bdc2, 0.35, 1),
    axial: std(0xd6c094, 0.6),
    sleeve: std(0x1e3a6b, 0.45),
    darkGrey: std(0x3a3c40, 0.6),
    led: new MeshPhysicalMaterial({ color: 0xfff3c4, roughness: 0.1, transmission: 0.6, thickness: 0.4, ior: 1.5 }),
  };
}
type PartMats = ReturnType<typeof partMaterials>;

/** Points expressed in the footprint's own (unrotated) frame, relative to its anchor. */
function toLocal(fp: Footprint, p: Pt): Pt {
  return rotate({ x: p.x - fp.at.x, y: p.y - fp.at.y }, -fp.rotation);
}

interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
function rectOf(pts: Pt[]): Rect | null {
  if (!pts.length) return null;
  const r = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pts) {
    r.minX = Math.min(r.minX, p.x);
    r.minY = Math.min(r.minY, p.y);
    r.maxX = Math.max(r.maxX, p.x);
    r.maxY = Math.max(r.maxY, p.y);
  }
  return r;
}

/** Body outline in the footprint frame: the Fab outline (the body itself), else the courtyard minus its clearance. */
function localBody(fp: Footprint, side: 'F' | 'B'): Rect | null {
  const pick = (layer: string) => fp.graphics.filter((g) => g.layer === `${side}.${layer}`).flatMap((g) => graphicPoints(g)?.pts ?? []);
  const fab = rectOf(pick('Fab').map((p) => toLocal(fp, p)));
  if (fab && fab.maxX - fab.minX > 0.1 && fab.maxY - fab.minY > 0.1) return fab;
  const crt = rectOf(pick('CrtYd').map((p) => toLocal(fp, p)));
  if (crt) return { minX: crt.minX + 0.3, minY: crt.minY + 0.3, maxX: crt.maxX - 0.3, maxY: crt.maxY - 0.3 };
  return rectOf(fp.pads.flatMap(padShape).map((p) => toLocal(fp, p)));
}

/** Collects boxes and cylinders per material in footprint-local space (x right, y up, z out of the board). */
class PartBuilder {
  private parts = new Map<Material, BufferGeometry[]>();

  box(m: Material, cx: number, cy: number, w: number, h: number, z0: number, z1: number, rot = 0): void {
    if (w <= 0 || h <= 0 || z1 <= z0) return;
    const g = new BoxGeometry(w, h, z1 - z0);
    if (rot) g.rotateZ(rot);
    g.translate(cx, cy, (z0 + z1) / 2);
    this.add(m, g);
  }

  cylinder(m: Material, cx: number, cy: number, r: number, z0: number, z1: number, segments = 28): void {
    const g = new CylinderGeometry(r, r, z1 - z0, segments);
    g.rotateX(Math.PI / 2);
    g.translate(cx, cy, (z0 + z1) / 2);
    this.add(m, g);
  }

  add(m: Material, g: BufferGeometry): void {
    g.deleteAttribute('uv');
    const list = this.parts.get(m);
    if (list) list.push(g);
    else this.parts.set(m, [g]);
  }

  build(): Group {
    const out = new Group();
    for (const [m, list] of this.parts) {
      const merged = list.length === 1 ? list[0]! : mergeGeometries(list, false);
      if (merged) out.add(new Mesh(merged, m));
      if (list.length > 1) for (const g of list) g.dispose();
    }
    return out;
  }
}

/** A component body shaped and finished like the real part, built from its footprint. */
function buildPart(fp: Footprint, side: 'F' | 'B', mats: PartMats, thickness: number): Group | null {
  const body = localBody(fp, side);
  if (!body) return null;
  const kind = partKind(fp);
  const h = bodyHeight(fp);
  const b = new PartBuilder();
  const w = body.maxX - body.minX;
  const d = body.maxY - body.minY;
  const cx = (body.minX + body.maxX) / 2;
  // Local y is KiCad's (down); three's is up.
  const cy = -(body.minY + body.maxY) / 2;
  const lift = 0.03;
  const pads = fp.pads.map((p) => ({ pad: p, at: toLocal(fp, p.at), rot: (p.rotation - fp.rotation) * DEG }));
  const inside = (q: Pt, m = 0) => q.x > body.minX + m && q.x < body.maxX - m && q.y > body.minY + m && q.y < body.maxY - m;

  switch (kind) {
    case 'chip':
    case 'led': {
      const long = w >= d;
      const len = long ? w : d;
      const cap = Math.min(len * 0.22, 0.5);
      const core = kind === 'led' ? mats.ceramicWhite : /^R/i.test(fp.reference) ? mats.resistor : /^C/i.test(fp.reference) ? mats.mlcc : mats.epoxy;
      b.box(core, cx, cy, w, d, lift, lift + h);
      for (const s of [-1, 1]) {
        const ox = long ? s * (len / 2 - cap / 2) : 0;
        const oy = long ? 0 : s * (len / 2 - cap / 2);
        b.box(mats.tin, cx + ox, cy + oy, long ? cap + 0.01 : w + 0.02, long ? d + 0.02 : cap + 0.01, lift - 0.01, lift + h + 0.01);
      }
      if (kind === 'led') b.box(mats.led, cx, cy, w * 0.6, d * 0.6, lift + h, lift + h + 0.12);
      break;
    }
    case 'ic': {
      b.box(mats.epoxy, cx, cy, w, d, lift + 0.05, lift + h);
      for (const { pad, at, rot } of pads) {
        if (pad.kind !== 'smd' || inside(at, 0.05)) continue;
        // Gull-wing or J lead: a tinned strip from the body edge over the pad.
        b.box(mats.tin, at.x, -at.y, pad.size.x * 0.75, pad.size.y * 0.75, 0, 0.16, rot);
      }
      // Pin-1 dimple.
      b.cylinder(mats.plastic, body.minX + Math.min(w, d) * 0.18, -body.minY - Math.min(w, d) * 0.18, Math.min(w, d) * 0.06, lift + h, lift + h + 0.005, 16);
      break;
    }
    case 'header':
    case 'socket': {
      const base = kind === 'header' ? 2.5 : h;
      b.box(kind === 'header' ? mats.plastic : mats.plastic, cx, cy, w, d, lift, lift + base);
      for (const { pad, at } of pads) {
        if (pad.kind !== 'thru_hole') continue;
        if (kind === 'header') b.box(mats.gold, at.x, -at.y, 0.64, 0.64, -thickness - 3, lift + base + 6);
        else b.box(mats.gold, at.x, -at.y, 0.6, 0.6, -thickness - 3, lift);
      }
      break;
    }
    case 'switch': {
      b.box(mats.tin, cx, cy, w, d, lift, lift + h * 0.45);
      b.box(mats.plastic, cx, cy, w * 0.92, d * 0.92, lift + 0.05, lift + h * 0.42);
      b.cylinder(mats.plastic, cx, cy, Math.min(w, d) * 0.28, lift + h * 0.45, lift + h);
      break;
    }
    case 'shell':
      b.box(mats.shell, cx, cy, w, d, lift, lift + h);
      break;
    case 'axial': {
      // Body along the line between the leads, about half their spacing long, lifted off the board.
      const [p0, p1] = [pads[0]!.at, pads[1]!.at];
      const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const ang = Math.atan2(-(p1.y - p0.y), p1.x - p0.x);
      const mx = (p0.x + p1.x) / 2;
      const my = -(p0.y + p1.y) / 2;
      const diode = /^D/i.test(fp.reference);
      const r = diode ? 0.9 : 1.15;
      const bodyLen = Math.min(len * 0.55, 6.5);
      const g = new CylinderGeometry(r, r, bodyLen, 24);
      g.rotateZ(Math.PI / 2 + ang);
      g.translate(mx, my, lift + r + 0.4);
      b.add(diode ? mats.epoxy : mats.axial, g);
      // Leads: down from the body ends to the holes.
      for (const q of [p0, p1]) b.box(mats.tin, q.x, -q.y, 0.5, 0.5, -thickness - 1.2, lift + r + 0.4);
      const lead = new CylinderGeometry(0.25, 0.25, len, 8);
      lead.rotateZ(Math.PI / 2 + ang);
      lead.translate(mx, my, lift + r + 0.4);
      b.add(mats.tin, lead);
      break;
    }
    case 'radial': {
      const r = Math.max(Math.min(w, d) / 2, 1.5);
      const hh = Math.max(h, r * 2.2);
      b.cylinder(mats.sleeve, cx, cy, r * 0.95, lift + 0.4, lift + hh, 40);
      b.cylinder(mats.aluminium, cx, cy, r * 0.8, lift + hh, lift + hh + 0.05, 40);
      break;
    }
    case 'can': {
      const r = Math.min(w, d) / 2;
      b.box(mats.plastic, cx, cy, w, d, lift, lift + 0.6);
      b.cylinder(mats.aluminium, cx, cy, r * 0.95, lift + 0.6, lift + h, 40);
      break;
    }
    case 'crystal':
      b.box(mats.ceramicWhite, cx, cy, w, d, lift, lift + h * 0.55);
      b.box(mats.shell, cx, cy, w * 0.9, d * 0.9, lift + h * 0.55, lift + h);
      break;
    default:
      b.box(/^J/i.test(fp.reference) ? mats.nylon : w * d > 150 ? mats.darkGrey : mats.epoxy, cx, cy, w, d, lift, lift + h);
  }

  // Through-hole leads poke out of the far side of the board, clipped and soldered.
  if (kind !== 'header' && kind !== 'socket' && kind !== 'axial') {
    for (const { pad, at } of pads) {
      if (pad.kind !== 'thru_hole' || !pad.drill) continue;
      const pin = Math.max(Math.min(pad.drill.width, pad.drill.height || pad.drill.width) * 0.6, 0.3);
      b.box(mats.tin, at.x, -at.y, pin, pin, -thickness - 1.2, lift);
    }
  }

  const g = b.build();
  g.rotation.z = fp.rotation * DEG;
  if (side === 'B') g.scale.z = -1;
  return g;
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
  // LPI soldermask is a thin glossy coat: a clearcoat over a satin base reads like the real thing.
  const maskMat = new MeshPhysicalMaterial({ color: maskColor, roughness: 0.55, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.25 });
  const edgeMat = new MeshStandardMaterial({ color: FR4_EDGE, roughness: 0.85 });
  const body = new ExtrudeGeometry(toShape(outer, [...cutouts, ...substrateHoles]), { depth: t, bevelEnabled: false, curveSegments: 8 });
  body.translate(0, 0, -t / 2);
  group.add(new Mesh(body, [maskMat, edgeMat]));

  const top = t / 2;
  const bot = -t / 2;
  const tint = (c: number, f: number) => new Color(c).lerp(new Color(0xffffff), f).getHex();
  const copperUnderMask = new MeshPhysicalMaterial({ color: tint(maskColor, opts.mask === 'black' ? 0.1 : 0.16), roughness: 0.5, clearcoat: 0.8, clearcoatRoughness: 0.25, side: DoubleSide });
  const gold = new MeshStandardMaterial({ color: COPPER_GOLD, roughness: 0.28, metalness: 1, side: DoubleSide });
  const silk = new MeshStandardMaterial({ color: silkColor, roughness: 0.9, side: DoubleSide });
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
  const barrel = new MeshStandardMaterial({ color: COPPER_GOLD, roughness: 0.3, metalness: 1, side: DoubleSide });
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
    const mats = partMaterials();
    // Like KiCad's own 3D view, a footprint without a 3D model gets no body (unfitted headers, pads-only parts).
    // A board with no model references at all was stripped or is very old, so every part gets an approximation.
    const anyModels = pcb.footprints.some((f) => f.models.length > 0);
    for (const fp of pcb.footprints) {
      if (SKIP_BODY.test(fp.libId) || fp.attrs.includes('board_only') || !fp.pads.length) continue;
      if (anyModels && !fp.models.length) continue;
      const side = fp.layer.startsWith('B') ? 'B' : 'F';
      const part = buildPart(fp, side, mats, t);
      if (!part) continue;
      part.position.set(fp.at.x, -fp.at.y, side === 'F' ? top : bot);
      part.userData = { reference: fp.reference, value: fp.value };
      bodies.add(part);
    }
    group.add(bodies);
  }
  return group;
}
