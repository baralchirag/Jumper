import { Container, Graphics, Text } from 'pixi.js';
import type { BBox, Footprint, Graphic, Pad, Pcb, PcbText, Pt, Track } from '@pcbhub/kicad-core/types';
import { HOLE_COLOR, HIGHLIGHT_COLOR, PCB_BACKGROUND, PCB_LAYER_ALPHA, VIA_COLOR, copperOrder, pcbDrawOrder, pcbLayerColor } from './colors';
import { arcPoints, bboxOf, distToSegment, flatten, inBBox, padOutline, pointInPolygon, rotate } from './geometry';
import { Stage, type Marker, type ViewState } from './stage';

export interface PcbSelection {
  kind: 'pad' | 'via' | 'track' | 'footprint' | 'zone' | 'graphic';
  id: string;
  label: string;
  net: string | null;
  reference: string | null;
  layer: string | null;
  bbox: BBox;
  at: Pt;
}

export interface LayerInfo {
  name: string;
  color: string;
  visible: boolean;
  kind: 'copper' | 'technical' | 'user' | 'edge';
}

interface HitItem extends PcbSelection {
  layers: string[];
  priority: number;
  test: (p: Pt) => boolean;
}

export interface PcbSceneOptions {
  /** Draw everything in one colour (diff ghost/overlay). */
  monochrome?: number | null;
  alpha?: number;
  text?: boolean;
}

const MAX_TEXTS = 6000;
const FONT = 'Arial, Helvetica, sans-serif';

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

function padOnLayer(pad: Pad, layer: string): boolean {
  for (const l of pad.layers) {
    if (l === layer) return true;
    if (l.startsWith('*.') && layer.endsWith(l.slice(1))) return true;
    if (l === 'F&B.Cu' && (layer === 'F.Cu' || layer === 'B.Cu')) return true;
  }
  return false;
}

function padPolygon(pad: Pad): Pt[] {
  if (pad.shape === 'custom' && pad.polygons.length) return pad.polygons[0]!;
  const shape = pad.shape === 'circle' ? 'oval' : pad.shape;
  return padOutline(shape, pad.size.x, pad.size.y, pad.roundrectRratio).map((p) => {
    const r = rotate(p, pad.rotation);
    return { x: r.x + pad.at.x, y: r.y + pad.at.y };
  });
}

function trackPoints(t: Track): Pt[] {
  return t.mid ? arcPoints(t.start, t.mid, t.end) : [t.start, t.end];
}

function graphicPaths(g: Graphic): { pts: Pt[]; closed: boolean } | null {
  switch (g.type) {
    case 'line':
      return { pts: [g.start, g.end], closed: false };
    case 'arc':
      return { pts: arcPoints(g.start, g.mid, g.end), closed: false };
    case 'rect':
      return {
        pts: [g.start, { x: g.end.x, y: g.start.y }, g.end, { x: g.start.x, y: g.end.y }],
        closed: true,
      };
    case 'circle': {
      const r = Math.hypot(g.end.x - g.center.x, g.end.y - g.center.y);
      const pts: Pt[] = [];
      for (let i = 0; i < 64; i++) pts.push({ x: g.center.x + r * Math.cos((i / 64) * 2 * Math.PI), y: g.center.y + r * Math.sin((i / 64) * 2 * Math.PI) });
      return { pts, closed: true };
    }
    case 'poly':
      return { pts: g.pts, closed: true };
    case 'curve':
      return { pts: g.pts, closed: false };
  }
}

function makeText(t: PcbText, color: number, alpha: number): Text {
  const fontSize = 48;
  const text = new Text({ text: t.text, style: { fontFamily: FONT, fontSize, fill: color }, resolution: 1 });
  const scale = t.size.y / 0.72 / fontSize;
  text.scale.set(t.mirror ? -scale : scale, scale);
  const ax = t.justify.includes('left') ? 0 : t.justify.includes('right') ? 1 : 0.5;
  const ay = t.justify.includes('top') ? 0 : t.justify.includes('bottom') ? 1 : 0.5;
  text.anchor.set(ax, ay);
  text.position.set(t.at.x, t.at.y);
  let rot = t.rotation % 360;
  // KiCad keeps PCB text readable: flip upside-down orientations.
  if (rot > 90 && rot <= 270) rot -= 180;
  text.rotation = (-rot * Math.PI) / 180;
  text.alpha = alpha;
  return text;
}

export interface PcbScene {
  root: Container;
  layers: Map<string, Container>;
  vias: Container;
  layerNames: string[];
}

export function buildPcbScene(pcb: Pcb, opts: PcbSceneOptions = {}): PcbScene {
  const mono = opts.monochrome ?? null;
  const baseAlpha = opts.alpha ?? 1;
  const color = (layer: string) => mono ?? pcbLayerColor(layer);
  const root = new Container();

  // Collect every layer actually used, plus the declared ones.
  const used = new Set<string>(pcb.layers.map((l) => l.name));
  const footGraphics: Graphic[] = [];
  const footTexts: PcbText[] = [];
  const pads: Pad[] = [];
  for (const fp of pcb.footprints) {
    for (const g of fp.graphics) footGraphics.push(g);
    for (const t of fp.texts) if (!t.hidden) footTexts.push(t);
    for (const p of fp.pads) pads.push(p);
  }
  for (const g of [...pcb.graphics, ...footGraphics]) used.add(g.layer);
  const layerNames = pcbDrawOrder([...used]);

  const layers = new Map<string, Container>();
  let textBudget = opts.text === false ? 0 : MAX_TEXTS;

  for (const layer of layerNames) {
    const c = new Container({ label: layer });
    const g = new Graphics();
    const col = color(layer);
    const alpha = (PCB_LAYER_ALPHA[layer] ?? 1) * baseAlpha;
    const isCopper = layer.endsWith('.Cu');

    // Zone fills under everything else on the layer.
    for (const z of pcb.zones) {
      if (!z.layers.includes(layer) && !z.layers.some((l) => l.startsWith('*') && layer.endsWith(l.slice(1)))) continue;
      const fills = z.fills.filter((f) => f.layer === layer);
      if (fills.length) {
        for (const f of fills) if (f.pts.length > 2) g.poly(flatten(f.pts), true).fill({ color: col, alpha: alpha * 0.55 });
      } else if (z.outline.length > 2) {
        g.poly(flatten(z.outline), true).stroke({ color: col, width: 0.1, alpha: alpha * (z.keepout ? 0.9 : 0.6) });
      }
    }

    if (isCopper) {
      const byWidth = new Map<number, Track[]>();
      for (const t of pcb.tracks) {
        if (t.layer !== layer) continue;
        const list = byWidth.get(t.width);
        if (list) list.push(t);
        else byWidth.set(t.width, [t]);
      }
      for (const [width, list] of byWidth) {
        for (const t of list) {
          const pts = trackPoints(t);
          g.moveTo(pts[0]!.x, pts[0]!.y);
          for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
        }
        g.stroke({ color: col, width, alpha, cap: 'round', join: 'round' });
      }
    }

    for (const pad of pads) {
      if (!padOnLayer(pad, layer)) continue;
      if (pad.shape === 'circle' && pad.kind !== 'custom') {
        g.circle(pad.at.x, pad.at.y, pad.size.x / 2).fill({ color: col, alpha });
      } else {
        g.poly(flatten(padPolygon(pad)), true).fill({ color: col, alpha });
      }
    }

    for (const gr of [...pcb.graphics, ...footGraphics]) {
      if (gr.layer !== layer) continue;
      const path = graphicPaths(gr);
      if (!path || path.pts.length < 2) continue;
      if (gr.fill && path.closed) {
        g.poly(flatten(path.pts), true).fill({ color: col, alpha });
      }
      const w = gr.width > 0 ? gr.width : gr.fill ? 0 : 0.05;
      if (w > 0) {
        g.moveTo(path.pts[0]!.x, path.pts[0]!.y);
        for (let i = 1; i < path.pts.length; i++) g.lineTo(path.pts[i]!.x, path.pts[i]!.y);
        if (path.closed) g.closePath();
        g.stroke({ color: col, width: w, alpha, cap: 'round', join: 'round' });
      }
    }
    c.addChild(g);

    if (textBudget > 0) {
      const texts = [...pcb.texts.filter((t) => !t.hidden), ...footTexts].filter((t) => t.layer === layer && t.text.trim());
      for (const t of texts) {
        if (textBudget-- <= 0) break;
        c.addChild(makeText(t, col, alpha));
      }
    }
    layers.set(layer, c);
    root.addChild(c);
  }

  // Vias and drill holes always render above copper.
  const vias = new Container({ label: 'vias' });
  const vg = new Graphics();
  for (const v of pcb.vias) vg.circle(v.at.x, v.at.y, v.size / 2).fill({ color: mono ?? VIA_COLOR, alpha: baseAlpha });
  const holes = new Graphics();
  for (const v of pcb.vias) holes.circle(v.at.x, v.at.y, v.drill / 2).fill({ color: mono ? PCB_BACKGROUND : HOLE_COLOR, alpha: baseAlpha });
  for (const p of pads) {
    if (!p.drill || p.drill.width <= 0) continue;
    const c = { x: p.at.x + rotate(p.drill.offset, p.rotation).x, y: p.at.y + rotate(p.drill.offset, p.rotation).y };
    if (p.drill.oval && p.drill.height !== p.drill.width) {
      const pts = padOutline('oval', p.drill.width, p.drill.height, 0.5).map((q) => {
        const r = rotate(q, p.rotation);
        return { x: r.x + c.x, y: r.y + c.y };
      });
      holes.poly(flatten(pts), true).fill({ color: HOLE_COLOR, alpha: baseAlpha });
    } else {
      holes.circle(c.x, c.y, p.drill.width / 2).fill({ color: HOLE_COLOR, alpha: baseAlpha });
    }
  }
  vias.addChild(vg, holes);
  root.addChild(vias);
  return { root, layers, vias, layerNames };
}

function buildHitIndex(pcb: Pcb): HitItem[] {
  const items: HitItem[] = [];
  const net = (id: number) => pcb.nets.find((n) => n.id === id)?.name || null;
  const netById = new Map(pcb.nets.map((n) => [n.id, n.name || null]));

  for (const fp of pcb.footprints) {
    for (const pad of fp.pads) {
      const poly = padPolygon(pad);
      const bbox = pad.shape === 'circle' ? bboxOf([pad.at], pad.size.x / 2) : bboxOf(poly);
      items.push({
        kind: 'pad',
        id: pad.uuid ?? `${fp.uuid}:${pad.number}`,
        label: `Pad ${fp.reference}.${pad.number}${pad.netName ? ` · ${pad.netName}` : ''}`,
        net: pad.netName || netById.get(pad.net) || null,
        reference: fp.reference,
        layer: pad.layers[0] ?? null,
        layers: pad.layers,
        bbox,
        at: pad.at,
        priority: 0,
        test: pad.shape === 'circle' ? (p) => Math.hypot(p.x - pad.at.x, p.y - pad.at.y) <= pad.size.x / 2 : (p) => pointInPolygon(p, poly),
      });
    }
  }
  for (const v of pcb.vias) {
    items.push({
      kind: 'via',
      id: v.uuid,
      label: `Via${net(v.net) ? ` · ${net(v.net)}` : ''}`,
      net: netById.get(v.net) ?? null,
      reference: null,
      layer: null,
      layers: ['*'],
      bbox: bboxOf([v.at], v.size / 2),
      at: v.at,
      priority: 1,
      test: (p) => Math.hypot(p.x - v.at.x, p.y - v.at.y) <= v.size / 2,
    });
  }
  for (const t of pcb.tracks) {
    const pts = trackPoints(t);
    items.push({
      kind: 'track',
      id: t.uuid,
      label: `Track ${t.layer}${net(t.net) ? ` · ${net(t.net)}` : ''} · ${t.width.toFixed(3)} mm`,
      net: netById.get(t.net) ?? null,
      reference: null,
      layer: t.layer,
      layers: [t.layer],
      bbox: bboxOf(pts, t.width / 2),
      at: { x: (t.start.x + t.end.x) / 2, y: (t.start.y + t.end.y) / 2 },
      priority: 2,
      test: (p) => {
        for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1]!, pts[i]!) <= t.width / 2) return true;
        return false;
      },
    });
  }
  for (const fp of pcb.footprints) {
    if (!fp.bbox) continue;
    const b = fp.bbox;
    items.push({
      kind: 'footprint',
      id: fp.uuid,
      label: `${fp.reference || '?'} · ${fp.value} · ${fp.libId}`,
      net: null,
      reference: fp.reference,
      layer: fp.layer,
      layers: [fp.layer],
      bbox: b,
      at: fp.at,
      priority: 3,
      test: (p) => inBBox(p, b),
    });
  }
  for (const z of pcb.zones) {
    if (z.outline.length < 3) continue;
    items.push({
      kind: 'zone',
      id: z.uuid,
      label: `${z.keepout ? 'Keepout' : 'Zone'}${z.netName ? ` · ${z.netName}` : ''} · ${z.layers.join(', ')}`,
      net: z.netName || null,
      reference: null,
      layer: z.layers[0] ?? null,
      layers: z.layers,
      bbox: bboxOf(z.outline),
      at: z.outline[0]!,
      priority: 4,
      test: (p) => pointInPolygon(p, z.outline),
    });
  }
  return items.sort((a, b) => a.priority - b.priority);
}

export interface PcbViewerOptions {
  onSelect?: (sel: PcbSelection | null) => void;
  onHover?: (sel: PcbSelection | null, world: Pt | null) => void;
  onViewChange?: (v: ViewState) => void;
  flipped?: boolean;
}

/** Interactive, KiCad-styled board viewer. */
export class PcbViewer {
  private pcb: Pcb | null = null;
  private scene: PcbScene | null = null;
  private ghost: Container | null = null;
  private hits: HitItem[] = [];
  private visible = new Map<string, boolean>();
  private highlight = new Graphics();
  private highlightedNet: string | null = null;
  private selection: PcbSelection | null = null;
  private monochrome: number | null = null;
  private extraMarkers: Marker[] = [];

  private constructor(
    readonly stage: Stage,
    private readonly opts: PcbViewerOptions,
  ) {}

  static async create(el: HTMLElement, opts: PcbViewerOptions = {}): Promise<PcbViewer> {
    let viewer: PcbViewer | null = null;
    const stage = await Stage.create(el, {
      background: PCB_BACKGROUND,
      flipped: opts.flipped,
      onViewChange: opts.onViewChange,
      onClick: (p) => viewer?.handleClick(p),
      onHover: (p) => {
        if (!viewer || !opts.onHover) return;
        opts.onHover(p ? viewer.hitTest(p) : null, p);
      },
    });
    viewer = new PcbViewer(stage, opts);
    return viewer;
  }

  /** Load (or replace) the board. `ghost` is drawn underneath in grey for overlay diffs. */
  load(pcb: Pcb, opts: { ghost?: Pcb | null; monochrome?: number | null; keepView?: boolean } = {}): void {
    const view = opts.keepView && this.pcb ? this.stage.getView() : null;
    this.stage.clearContent();
    this.pcb = pcb;
    this.monochrome = opts.monochrome ?? null;
    this.ghost = null;
    if (opts.ghost) {
      this.ghost = buildPcbScene(opts.ghost, { monochrome: 0x8a8f8c, alpha: 0.55, text: false }).root;
      this.stage.content.addChild(this.ghost);
    }
    this.scene = buildPcbScene(pcb, { monochrome: this.monochrome, alpha: opts.ghost ? 0.85 : 1 });
    this.stage.content.addChild(this.scene.root);
    this.highlight = new Graphics();
    this.stage.content.addChild(this.highlight);
    this.hits = buildHitIndex(pcb);
    for (const l of this.scene.layerNames) {
      if (!this.visible.has(l)) this.visible.set(l, !/(CrtYd|Fab|Paste|Adhes|Margin|User\.\d+)$/.test(l));
      this.scene.layers.get(l)!.visible = this.visible.get(l)!;
    }
    this.highlightedNet = null;
    this.selection = null;
    if (view) this.stage.setView(view);
    else this.fit();
  }

  get model(): Pcb | null {
    return this.pcb;
  }

  fit(): void {
    this.stage.fit(this.pcb?.bbox ?? null);
  }

  layers(): LayerInfo[] {
    if (!this.scene) return [];
    const copper = copperOrder(this.scene.layerNames);
    const rest = this.scene.layerNames.filter((l) => !copper.includes(l));
    return [...copper, ...rest.reverse()].map((name) => ({
      name,
      color: hex(pcbLayerColor(name)),
      visible: this.visible.get(name) ?? true,
      kind: name.endsWith('.Cu') ? 'copper' : name === 'Edge.Cuts' ? 'edge' : /^[FB]\./.test(name) ? 'technical' : 'user',
    }));
  }

  setLayerVisible(name: string, visible: boolean): void {
    this.visible.set(name, visible);
    const c = this.scene?.layers.get(name);
    if (c) c.visible = visible;
  }

  setFlipped(flipped: boolean): void {
    if (flipped === this.stage.isFlipped()) return;
    this.stage.setFlipped(flipped);
    if (this.pcb) this.load(this.pcb, { keepView: true, monochrome: this.monochrome });
  }

  private visibleLayer(layers: string[]): boolean {
    if (layers.includes('*')) return true;
    return layers.some((l) => (l.startsWith('*.') ? [...this.visible].some(([n, v]) => v && n.endsWith(l.slice(1))) : this.visible.get(l) !== false));
  }

  hitTest(p: Pt): PcbSelection | null {
    for (const it of this.hits) {
      if (!inBBox(p, it.bbox) || !this.visibleLayer(it.layers)) continue;
      if (it.test(p)) {
        const { layers: _l, priority: _p, test: _t, ...sel } = it;
        return sel;
      }
    }
    return null;
  }

  private handleClick(p: Pt): void {
    const sel = this.hitTest(p);
    this.select(sel);
    this.opts.onSelect?.(sel);
  }

  select(sel: PcbSelection | null): void {
    this.selection = sel;
    this.highlightNet(sel?.net ?? null);
    this.refreshMarkers();
  }

  /** Brighten every copper item on a net, dimming the rest of the board. */
  highlightNet(net: string | null): void {
    this.highlightedNet = net;
    const g = this.highlight;
    g.clear();
    const dim = net ? 0.45 : 1;
    if (this.scene) {
      for (const [, c] of this.scene.layers) c.alpha = dim;
      this.scene.vias.alpha = dim;
    }
    if (!net || !this.pcb) return;
    const id = this.pcb.nets.find((n) => n.name === net)?.id;
    for (const t of this.pcb.tracks) {
      if (t.net !== id || this.visible.get(t.layer) === false) continue;
      const pts = trackPoints(t);
      g.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
      g.stroke({ color: pcbLayerColor(t.layer), width: t.width, cap: 'round', join: 'round' });
      g.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
      g.stroke({ color: HIGHLIGHT_COLOR, width: t.width, alpha: 0.35, cap: 'round', join: 'round' });
    }
    for (const z of this.pcb.zones) {
      if (z.netName !== net) continue;
      for (const f of z.fills) if (this.visible.get(f.layer) !== false && f.pts.length > 2) g.poly(flatten(f.pts), true).fill({ color: HIGHLIGHT_COLOR, alpha: 0.18 });
    }
    for (const fp of this.pcb.footprints) {
      for (const pad of fp.pads) {
        if (pad.netName !== net && pad.net !== id) continue;
        if (pad.shape === 'circle') g.circle(pad.at.x, pad.at.y, pad.size.x / 2).fill({ color: HIGHLIGHT_COLOR, alpha: 0.75 });
        else g.poly(flatten(padPolygon(pad)), true).fill({ color: HIGHLIGHT_COLOR, alpha: 0.75 });
      }
    }
    for (const v of this.pcb.vias) if (v.net === id) g.circle(v.at.x, v.at.y, v.size / 2).fill({ color: HIGHLIGHT_COLOR, alpha: 0.9 });
  }

  get highlighted(): string | null {
    return this.highlightedNet;
  }

  /** Find a footprint by reference designator (cross-probing). */
  findReference(ref: string): Footprint | null {
    const fp = this.pcb?.footprints.find((f) => f.reference.toLowerCase() === ref.toLowerCase()) ?? null;
    if (fp?.bbox) {
      this.selection = { kind: 'footprint', id: fp.uuid, label: `${fp.reference} · ${fp.value}`, net: null, reference: fp.reference, layer: fp.layer, bbox: fp.bbox, at: fp.at };
      this.highlightNet(null);
      this.refreshMarkers();
      this.stage.focus(fp.bbox);
    }
    return fp;
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
    this.stage.focus(bbox);
  }

  destroy(): void {
    this.stage.destroy();
  }
}
