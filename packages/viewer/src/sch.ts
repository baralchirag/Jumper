import { Container, Graphics, Text } from 'pixi.js';
import type { BBox, Label, LibSymbol, Pt, SchGraphic, SchSymbol, Schematic } from '@pcbhub/kicad-core/types';
import { SCH } from './colors';
import { arcPoints, bboxOf, distToSegment, flatten, inBBox, unionBBox, DEG } from './geometry';
import { Stage, type Marker, type ViewState } from './stage';

export interface SchSelection {
  kind: 'symbol' | 'wire' | 'label' | 'sheet' | 'junction';
  id: string;
  label: string;
  reference: string | null;
  net: string | null;
  bbox: BBox;
  at: Pt;
  /** For sheets: the referenced sub-sheet file. */
  file?: string;
}

interface HitItem extends SchSelection {
  priority: number;
  test: (p: Pt) => boolean;
}

const PAPER: Record<string, [number, number]> = {
  A5: [210, 148],
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
  A: [279.4, 215.9],
  B: [431.8, 279.4],
  C: [558.8, 431.8],
  D: [863.6, 558.8],
  E: [1117.6, 863.6],
  USLetter: [279.4, 215.9],
  USLegal: [355.6, 215.9],
  USLedger: [431.8, 279.4],
};

const FONT = 'Arial, Helvetica, sans-serif';
const DEFAULT_LINE = 0.1524;
const MAX_TEXTS = 12000;

export function paperSize(paper: string | null): [number, number] | null {
  return paper ? (PAPER[paper] ?? null) : null;
}

type Xform = (p: Pt) => Pt;

/** Library (y-up) → sheet transform for a placed symbol: rotate, flip y, mirror, translate. */
export function symbolTransform(sym: SchSymbol): Xform {
  const a = sym.rotation * DEG;
  const c = Math.round(Math.cos(a) * 1e9) / 1e9;
  const s = Math.round(Math.sin(a) * 1e9) / 1e9;
  return (p) => {
    const rx = p.x * c - p.y * s;
    const ry = p.x * s + p.y * c;
    let x = rx;
    let y = -ry;
    if (sym.mirror === 'x') y = -y;
    if (sym.mirror === 'y') x = -x;
    return { x: x + sym.at.x, y: y + sym.at.y };
  };
}

class TextBatch {
  count = 0;
  constructor(readonly container: Container) {}

  add(str: string, at: Pt, size: number, color: number, opts: { rotation?: number; ax?: number; ay?: number; bold?: boolean } = {}): void {
    if (!str || this.count >= MAX_TEXTS) return;
    this.count++;
    const fontSize = 40;
    const t = new Text({ text: str, style: { fontFamily: FONT, fontSize, fill: color, fontWeight: opts.bold ? '700' : '400' }, resolution: 1 });
    t.anchor.set(opts.ax ?? 0.5, opts.ay ?? 0.5);
    t.scale.set(size / 0.72 / fontSize);
    t.position.set(at.x, at.y);
    t.rotation = -((opts.rotation ?? 0) * Math.PI) / 180;
    this.container.addChild(t);
  }
}

function justify(j: string[]): { ax: number; ay: number } {
  return {
    ax: j.includes('left') ? 0 : j.includes('right') ? 1 : 0.5,
    ay: j.includes('top') ? 0 : j.includes('bottom') ? 1 : 0.5,
  };
}

/** Keep text readable (KiCad never draws it upside down). */
function readable(rot: number): number {
  let r = ((rot % 360) + 360) % 360;
  if (r > 90 && r <= 270) r -= 180;
  return r;
}

function cubic(p: Pt[]): Pt[] {
  if (p.length !== 4) return p;
  const out: Pt[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const u = 1 - t;
    out.push({
      x: u * u * u * p[0]!.x + 3 * u * u * t * p[1]!.x + 3 * u * t * t * p[2]!.x + t * t * t * p[3]!.x,
      y: u * u * u * p[0]!.y + 3 * u * u * t * p[1]!.y + 3 * u * t * t * p[2]!.y + t * t * t * p[3]!.y,
    });
  }
  return out;
}

function stroke(g: Graphics, pts: Pt[], width: number, color: number, closed = false, alpha = 1): void {
  if (pts.length < 2) return;
  g.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
  if (closed) g.closePath();
  g.stroke({ color, width: width > 0 ? width : DEFAULT_LINE, alpha, cap: 'round', join: 'round' });
}

function drawGraphic(g: Graphics, gr: SchGraphic, xf: Xform, color: number, fillColor: number, texts: TextBatch | null, collect: Pt[], alpha: number): void {
  const fill = gr.fill === 'background' ? fillColor : gr.fill === 'outline' || gr.fill === 'color' ? color : null;
  switch (gr.type) {
    case 'rect': {
      const pts = [gr.start, { x: gr.end.x, y: gr.start.y }, gr.end, { x: gr.start.x, y: gr.end.y }].map(xf);
      collect.push(...pts);
      if (fill !== null) g.poly(flatten(pts), true).fill({ color: fill, alpha });
      stroke(g, pts, gr.width, color, true, alpha);
      break;
    }
    case 'circle': {
      const c = xf(gr.center);
      collect.push({ x: c.x - gr.radius, y: c.y - gr.radius }, { x: c.x + gr.radius, y: c.y + gr.radius });
      if (fill !== null) g.circle(c.x, c.y, gr.radius).fill({ color: fill, alpha });
      g.circle(c.x, c.y, gr.radius).stroke({ color, width: gr.width > 0 ? gr.width : DEFAULT_LINE, alpha });
      break;
    }
    case 'arc': {
      const pts = arcPoints(xf(gr.start), xf(gr.mid), xf(gr.end));
      collect.push(...pts);
      if (fill !== null && pts.length > 2) g.poly(flatten(pts), true).fill({ color: fill, alpha });
      stroke(g, pts, gr.width, color, false, alpha);
      break;
    }
    case 'polyline':
    case 'bezier': {
      const raw = gr.type === 'bezier' ? cubic(gr.pts) : gr.pts;
      const pts = raw.map(xf);
      collect.push(...pts);
      if (fill !== null && pts.length > 2) g.poly(flatten(pts), true).fill({ color: fill, alpha });
      stroke(g, pts, gr.width, color, false, alpha);
      break;
    }
    case 'text': {
      const at = xf(gr.at);
      collect.push(at);
      texts?.add(gr.text, at, gr.size, color, { rotation: readable(gr.rotation) });
      break;
    }
  }
}

function libUnits(lib: LibSymbol, sym: SchSymbol) {
  return lib.units.filter((u) => (u.unit === 0 || u.unit === sym.unit) && (u.style === 0 || u.style === sym.bodyStyle));
}

function drawSymbol(g: Graphics, texts: TextBatch | null, sch: Schematic, sym: SchSymbol, colors: SchColors, alpha: number): BBox | null {
  const lib = sch.libSymbols.find((l) => l.id === (sym.libName ?? sym.libId));
  const xf = symbolTransform(sym);
  const collect: Pt[] = [];
  if (lib) {
    const units = libUnits(lib, sym);
    for (const u of units) for (const gr of u.graphics) drawGraphic(g, gr, xf, colors.body, colors.bodyFill, texts, collect, alpha);
    for (const u of units) {
      for (const pin of u.pins) {
        if (pin.hidden) continue;
        const dir = { x: Math.cos(pin.angle * DEG), y: Math.sin(pin.angle * DEG) };
        const start = xf(pin.at);
        const end = xf({ x: pin.at.x + dir.x * pin.length, y: pin.at.y + dir.y * pin.length });
        collect.push(start, end);
        const inverted = pin.style.includes('inverted');
        const r = 0.4;
        const d = { x: (end.x - start.x) / (pin.length || 1), y: (end.y - start.y) / (pin.length || 1) };
        const lineEnd = inverted ? { x: end.x - d.x * r * 2, y: end.y - d.y * r * 2 } : end;
        stroke(g, [start, lineEnd], DEFAULT_LINE, colors.pin, false, alpha);
        if (inverted) g.circle(end.x - d.x * r, end.y - d.y * r, r).stroke({ color: colors.pin, width: DEFAULT_LINE, alpha });
        if (pin.style.includes('clock')) {
          const n = { x: -d.y, y: d.x };
          stroke(g, [{ x: end.x + n.x * 0.5, y: end.y + n.y * 0.5 }, { x: end.x + d.x * 0.6, y: end.y + d.y * 0.6 }, { x: end.x - n.x * 0.5, y: end.y - n.y * 0.5 }], DEFAULT_LINE, colors.pin, false, alpha);
        }
        if (!texts) continue;
        const horizontal = Math.abs(d.x) >= Math.abs(d.y);
        const rot = horizontal ? 0 : 90;
        const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
        const name = pin.name && pin.name !== '~' ? pin.name : '';
        if (!lib.pinNumbersHidden && pin.number) {
          const off = horizontal ? { x: 0, y: -0.25 } : { x: -0.25, y: 0 };
          texts.add(pin.number, { x: mid.x + off.x, y: mid.y + off.y }, 1.0, colors.pinNumber, { rotation: rot, ax: 0.5, ay: 1 });
        }
        if (!lib.pinNamesHidden && name) {
          if (lib.pinNamesOffset > 0) {
            const p = { x: end.x + d.x * lib.pinNamesOffset, y: end.y + d.y * lib.pinNamesOffset };
            const towardPositive = horizontal ? d.x > 0 : d.y < 0;
            texts.add(name, p, 1.1, colors.pinName, { rotation: rot, ax: towardPositive ? 0 : 1, ay: 0.5 });
          } else {
            const off = horizontal ? { x: 0, y: 0.25 } : { x: 0.25, y: 0 };
            texts.add(name, { x: mid.x + off.x, y: mid.y + off.y }, 1.1, colors.pinName, { rotation: rot, ax: 0.5, ay: 0 });
          }
        }
      }
    }
  } else {
    // Missing library: draw a placeholder box so the part is still visible.
    const pts = [
      { x: sym.at.x - 2.54, y: sym.at.y - 2.54 },
      { x: sym.at.x + 2.54, y: sym.at.y - 2.54 },
      { x: sym.at.x + 2.54, y: sym.at.y + 2.54 },
      { x: sym.at.x - 2.54, y: sym.at.y + 2.54 },
    ];
    collect.push(...pts);
    stroke(g, pts, DEFAULT_LINE, colors.body, true, alpha);
    texts?.add('?', sym.at, 2, colors.body);
  }

  if (texts) {
    for (const prop of sym.properties) {
      if (prop.hidden || !prop.value || prop.value === '~') continue;
      if (prop.key === 'Footprint' || prop.key === 'Datasheet' || prop.key === 'Description') continue;
      const c = prop.key === 'Reference' ? colors.reference : prop.key === 'Value' ? colors.value : colors.field;
      const { ax, ay } = justify(prop.justify);
      texts.add(prop.value, prop.at, prop.size, c, { rotation: readable(prop.rotation), ax, ay });
    }
  }
  const bbox = collect.length ? bboxOf(collect, 0.3) : null;
  if (sym.dnp && bbox) {
    stroke(g, [{ x: bbox.minX, y: bbox.minY }, { x: bbox.maxX, y: bbox.maxY }], 0.35, SCH.dnp, false, alpha);
    stroke(g, [{ x: bbox.maxX, y: bbox.minY }, { x: bbox.minX, y: bbox.maxY }], 0.35, SCH.dnp, false, alpha);
  }
  return bbox;
}

function labelGeometry(l: Label): { outline: Pt[] | null; textAt: Pt; rot: number; ax: number } {
  const len = Math.max(l.text.length, 1) * l.size * 0.62 + l.size * 0.6;
  const h = l.size * 1.4;
  const r = ((l.rotation % 360) + 360) % 360;
  const dir = { x: Math.cos(r * DEG), y: -Math.sin(r * DEG) };
  const nrm = { x: -dir.y, y: dir.x };
  const P = (along: number, across: number): Pt => ({ x: l.at.x + dir.x * along + nrm.x * across, y: l.at.y + dir.y * along + nrm.y * across });
  const textRot = readable(r);
  const flipped = textRot !== r;
  if (l.kind === 'local') {
    return { outline: null, textAt: P(0.25, 0), rot: textRot, ax: flipped ? 1 : 0 };
  }
  const point = l.kind === 'global' ? h / 2 : h / 2;
  const outline = l.kind === 'netclass'
    ? null
    : [P(0, 0), P(point, -h / 2), P(point + len, -h / 2), P(point + len, h / 2), P(point, h / 2)];
  return { outline, textAt: P(point + l.size * 0.3, 0), rot: textRot, ax: flipped ? 1 : 0 };
}

export interface SchColors {
  wire: number;
  bus: number;
  junction: number;
  noConnect: number;
  body: number;
  bodyFill: number;
  pin: number;
  pinName: number;
  pinNumber: number;
  reference: number;
  value: number;
  field: number;
  label: number;
  globalLabel: number;
  hierLabel: number;
  sheet: number;
  sheetFill: number;
  sheetName: number;
  sheetFile: number;
  notes: number;
  page: number;
}

function monochromeColors(c: number): SchColors {
  const keys: (keyof SchColors)[] = ['wire', 'bus', 'junction', 'noConnect', 'body', 'pin', 'pinName', 'pinNumber', 'reference', 'value', 'field', 'label', 'globalLabel', 'hierLabel', 'sheet', 'sheetName', 'sheetFile', 'notes', 'page'];
  const out = Object.fromEntries(keys.map((k) => [k, c])) as unknown as SchColors;
  out.bodyFill = SCH.background;
  out.sheetFill = SCH.background;
  return out;
}

interface SchScene {
  root: Container;
  hits: HitItem[];
}

export function buildSchematicScene(sch: Schematic, opts: { monochrome?: number | null; alpha?: number; text?: boolean; page?: boolean } = {}): SchScene {
  const colors: SchColors = opts.monochrome != null ? monochromeColors(opts.monochrome) : { ...SCH };
  const alpha = opts.alpha ?? 1;
  const root = new Container();
  const g = new Graphics();
  const textLayer = new Container();
  const texts = opts.text === false ? null : new TextBatch(textLayer);
  const hits: HitItem[] = [];

  if (opts.page !== false) drawPage(g, texts, sch, colors);

  for (const sh of sch.sheets) {
    const pts = [sh.at, { x: sh.at.x + sh.size.x, y: sh.at.y }, { x: sh.at.x + sh.size.x, y: sh.at.y + sh.size.y }, { x: sh.at.x, y: sh.at.y + sh.size.y }];
    g.poly(flatten(pts), true).fill({ color: colors.sheetFill, alpha: 0.6 * alpha });
    stroke(g, pts, 0.3, colors.sheet, true, alpha);
    texts?.add(sh.name, { x: sh.at.x, y: sh.at.y - 0.6 }, 1.27, colors.sheetName, { ax: 0, ay: 1 });
    texts?.add(`File: ${sh.file}`, { x: sh.at.x, y: sh.at.y + sh.size.y + 0.6 }, 1.27, colors.sheetFile, { ax: 0, ay: 0 });
    for (const pin of sh.pins) {
      const inward = pin.rotation === 180 ? 1 : -1;
      const horizontal = pin.rotation === 0 || pin.rotation === 180;
      texts?.add(pin.name, { x: pin.at.x + (horizontal ? inward * 1.6 : 0), y: pin.at.y + (horizontal ? 0 : 1.6) }, 1.27, colors.hierLabel, {
        ax: horizontal ? (inward > 0 ? 0 : 1) : 0.5,
        rotation: horizontal ? 0 : 90,
      });
      g.poly(flatten([
        { x: pin.at.x, y: pin.at.y - 0.6 },
        { x: pin.at.x + inward * 1.2, y: pin.at.y - 0.6 },
        { x: pin.at.x + inward * 1.2, y: pin.at.y + 0.6 },
        { x: pin.at.x, y: pin.at.y + 0.6 },
      ]), true).stroke({ color: colors.hierLabel, width: DEFAULT_LINE, alpha });
    }
    const bbox = bboxOf(pts);
    hits.push({ kind: 'sheet', id: sh.uuid, label: `Sheet ${sh.name}`, reference: null, net: null, bbox, at: sh.at, file: sh.file, priority: 3, test: (p) => inBBox(p, bbox) });
  }

  for (const sym of sch.symbols) {
    const bbox = drawSymbol(g, texts, sch, sym, colors, alpha);
    if (bbox) {
      const power = sym.reference.startsWith('#');
      hits.push({
        kind: 'symbol',
        id: sym.uuid,
        label: power ? `Power ${sym.value}` : `${sym.reference} · ${sym.value}`,
        reference: power ? null : sym.reference,
        net: power ? sym.value : null,
        bbox,
        at: sym.at,
        priority: 1,
        test: (p) => inBBox(p, bbox),
      });
    }
  }

  for (const w of sch.wires) {
    const isBus = w.kind === 'bus';
    stroke(g, w.pts, isBus ? 0.3048 : DEFAULT_LINE, isBus ? colors.bus : colors.wire, false, alpha);
    const bbox = bboxOf(w.pts, 0.5);
    const pts = w.pts;
    hits.push({
      kind: 'wire',
      id: w.uuid,
      label: isBus ? 'Bus' : 'Wire',
      reference: null,
      net: null,
      bbox,
      at: pts[0]!,
      priority: 2,
      test: (p) => {
        for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1]!, pts[i]!) < 0.4) return true;
        return false;
      },
    });
  }
  for (const b of sch.busEntries) stroke(g, [b.at, { x: b.at.x + b.size.x, y: b.at.y + b.size.y }], DEFAULT_LINE, colors.wire, false, alpha);
  for (const j of sch.junctions) g.circle(j.at.x, j.at.y, j.diameter / 2).fill({ color: colors.junction, alpha });
  for (const nc of sch.noConnects) {
    const s = 0.635;
    stroke(g, [{ x: nc.at.x - s, y: nc.at.y - s }, { x: nc.at.x + s, y: nc.at.y + s }], DEFAULT_LINE, colors.noConnect, false, alpha);
    stroke(g, [{ x: nc.at.x + s, y: nc.at.y - s }, { x: nc.at.x - s, y: nc.at.y + s }], DEFAULT_LINE, colors.noConnect, false, alpha);
  }

  for (const l of sch.labels) {
    const color = l.kind === 'global' ? colors.globalLabel : l.kind === 'hierarchical' ? colors.hierLabel : colors.label;
    const geo = labelGeometry(l);
    if (geo.outline) stroke(g, geo.outline, DEFAULT_LINE, color, true, alpha);
    texts?.add(l.text, geo.textAt, l.size, color, { rotation: geo.rot, ax: geo.ax, ay: l.kind === 'local' ? 1 : 0.5 });
    const bbox = unionBBox(bboxOf([l.at], l.size), geo.outline ? bboxOf(geo.outline) : bboxOf([geo.textAt], l.size * Math.max(1, l.text.length * 0.4)))!;
    hits.push({ kind: 'label', id: l.uuid, label: `Net ${l.text}`, reference: null, net: l.text, bbox, at: l.at, priority: 0, test: (p) => inBBox(p, bbox) });
  }

  for (const t of sch.texts) {
    const { ax, ay } = justify(t.justify);
    texts?.add(t.text, t.at, t.size, colors.notes, { rotation: readable(t.rotation), ax, ay });
  }
  for (const gr of sch.graphics) drawGraphic(g, gr, (p) => p, colors.notes, colors.bodyFill, texts, [], alpha);

  root.addChild(g, textLayer);
  return { root, hits: hits.sort((a, b) => a.priority - b.priority) };
}

function drawPage(g: Graphics, texts: TextBatch | null, sch: Schematic, colors: SchColors): void {
  const size = paperSize(sch.paper);
  if (!size) return;
  const [w, h] = size;
  const m = 10;
  g.rect(0, 0, w, h).fill({ color: SCH.background });
  g.rect(m, m, w - 2 * m, h - 2 * m).stroke({ color: colors.page, width: 0.15 });
  g.rect(m - 2, m - 2, w - 2 * (m - 2), h - 2 * (m - 2)).stroke({ color: colors.page, width: 0.1 });
  // Title block (bottom right), modelled on KiCad's default drawing sheet.
  const tbW = 110;
  const tbH = 32;
  const x0 = w - m - tbW;
  const y0 = h - m - tbH;
  g.rect(x0, y0, tbW, tbH).stroke({ color: colors.page, width: 0.15 });
  for (const y of [y0 + 8, y0 + 16, y0 + 24]) g.moveTo(x0, y).lineTo(x0 + tbW, y).stroke({ color: colors.page, width: 0.1 });
  const tb = sch.titleBlock;
  if (texts) {
    texts.add(`Title: ${tb.title ?? ''}`, { x: x0 + 2, y: y0 + 20 }, 2, colors.page, { ax: 0, bold: true });
    texts.add(`Rev: ${tb.rev ?? ''}`, { x: x0 + 2, y: y0 + 28 }, 1.5, colors.page, { ax: 0 });
    texts.add(`Date: ${tb.date ?? ''}`, { x: x0 + 50, y: y0 + 28 }, 1.5, colors.page, { ax: 0 });
    texts.add(tb.company ?? '', { x: x0 + 2, y: y0 + 12 }, 1.5, colors.page, { ax: 0 });
    texts.add(`Size: ${sch.paper ?? ''}`, { x: x0 + 2, y: y0 + 4 }, 1.5, colors.page, { ax: 0 });
    texts.add(tb.comment1 ?? '', { x: x0 + 50, y: y0 + 4 }, 1.5, colors.page, { ax: 0 });
  }
}

export function schematicBounds(sch: Schematic): BBox | null {
  const size = paperSize(sch.paper);
  if (size) return { minX: 0, minY: 0, maxX: size[0], maxY: size[1] };
  return sch.bbox;
}

export interface SchematicViewerOptions {
  onSelect?: (sel: SchSelection | null) => void;
  onOpenSheet?: (file: string) => void;
  onViewChange?: (v: ViewState) => void;
}

export class SchematicViewer {
  private sch: Schematic | null = null;
  private hits: HitItem[] = [];
  private selection: SchSelection | null = null;
  private extraMarkers: Marker[] = [];
  private lastClick = 0;

  private constructor(
    readonly stage: Stage,
    private readonly opts: SchematicViewerOptions,
  ) {}

  static async create(el: HTMLElement, opts: SchematicViewerOptions = {}): Promise<SchematicViewer> {
    let viewer: SchematicViewer | null = null;
    const stage = await Stage.create(el, {
      background: 0xe8e7e2,
      onViewChange: opts.onViewChange,
      onClick: (p) => viewer?.handleClick(p),
    });
    viewer = new SchematicViewer(stage, opts);
    return viewer;
  }

  load(sch: Schematic, opts: { ghost?: Schematic | null; monochrome?: number | null; keepView?: boolean } = {}): void {
    const view = opts.keepView && this.sch ? this.stage.getView() : null;
    this.stage.clearContent();
    this.sch = sch;
    if (opts.ghost) {
      this.stage.content.addChild(buildSchematicScene(opts.ghost, { monochrome: 0xa0a29e, alpha: 0.6, text: false, page: true }).root);
    }
    const scene = buildSchematicScene(sch, { monochrome: opts.monochrome, page: !opts.ghost });
    this.stage.content.addChild(scene.root);
    this.hits = scene.hits;
    this.selection = null;
    this.refreshMarkers();
    if (view) this.stage.setView(view);
    else this.fit();
  }

  get model(): Schematic | null {
    return this.sch;
  }

  fit(): void {
    if (this.sch) this.stage.fit(schematicBounds(this.sch), 0.02);
  }

  hitTest(p: Pt): SchSelection | null {
    for (const h of this.hits) {
      if (inBBox(p, h.bbox) && h.test(p)) {
        const { priority: _p, test: _t, ...sel } = h;
        return sel;
      }
    }
    return null;
  }

  private handleClick(p: Pt): void {
    const sel = this.hitTest(p);
    const now = Date.now();
    if (sel?.kind === 'sheet' && sel.file && now - this.lastClick < 350 && this.selection?.id === sel.id) {
      this.opts.onOpenSheet?.(sel.file);
    }
    this.lastClick = now;
    this.select(sel);
    this.opts.onSelect?.(sel);
  }

  select(sel: SchSelection | null): void {
    this.selection = sel;
    this.refreshMarkers();
  }

  findReference(ref: string): SchSymbol | null {
    const sym = this.sch?.symbols.find((s) => s.reference.toLowerCase() === ref.toLowerCase()) ?? null;
    if (sym) {
      const hit = this.hits.find((h) => h.id === sym.uuid);
      if (hit) {
        this.select({ ...hit });
        this.stage.focus(hit.bbox, 20);
      }
    }
    return sym;
  }

  setMarkers(markers: Marker[]): void {
    this.extraMarkers = markers;
    this.refreshMarkers();
  }

  private refreshMarkers(): void {
    const sel: Marker[] = this.selection ? [{ id: 'selection', kind: 'selection', bbox: this.selection.bbox }] : [];
    this.stage.setMarkers([...this.extraMarkers, ...sel]);
  }

  focus(bbox: BBox): void {
    this.stage.focus(bbox, 20);
  }

  destroy(): void {
    this.stage.destroy();
  }
}
