import { Container, Graphics, Text } from 'pixi.js';
import type { BBox, Footprint, Graphic, Pad, Pcb, PcbText, Pt, Track } from '@jumper/kicad-core/types';
import { HOLE_COLOR, HIGHLIGHT_COLOR, PCB_BACKGROUND, PCB_LAYER_ALPHA, VIA_COLOR, copperOrder, pcbDrawOrder, pcbLayerColor } from './colors';
import { arcPoints, bboxOf, distToSegment, flatten, inBBox, padOutline, pointInPolygon, rotate } from './geometry';
import { Stage, type Marker, type ViewState } from './stage';
import { area, outlineLoops } from './outline';

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
  /** Colour of drill holes in monochrome drawings (the canvas colour, so holes read as holes). */
  holeColor?: number;
  /** Per-layer colours instead of KiCad's (the review drawing's softer palette). */
  palette?: (layer: string) => number;
  /** Via colour when a palette is set. */
  viaColor?: number;
  /** Opacity of zone fills relative to the layer (default 0.55): the review drawing keeps pours faint. */
  zoneAlpha?: number;
  /** Colour of pads on copper layers instead of the layer's (gold on the vivid drawing, like ENIG). */
  padColor?: number;
  /** Fill the board outline with this colour under everything (the soldermask). */
  boardFill?: number;
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
  const color = (layer: string) => mono ?? opts.palette?.(layer) ?? pcbLayerColor(layer);
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

  if (opts.boardFill !== undefined) {
    const edge = [...pcb.graphics, ...footGraphics].filter((g) => g.layer === 'Edge.Cuts');
    const loops = outlineLoops(edge).sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
    if (loops.length) {
      const fill = new Graphics();
      fill.poly(flatten(loops[0]!), true).fill({ color: opts.boardFill, alpha: baseAlpha });
      for (const hole of loops.slice(1)) fill.poly(flatten(hole), true).cut();
      root.addChild(fill);
    }
  }

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
        for (const f of fills) if (f.pts.length > 2) g.poly(flatten(f.pts), true).fill({ color: col, alpha: alpha * (opts.zoneAlpha ?? 0.55) });
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

    const padCol = isCopper && opts.padColor !== undefined && mono === null ? opts.padColor : col;
    for (const pad of pads) {
      if (!padOnLayer(pad, layer)) continue;
      if (pad.shape === 'circle' && pad.kind !== 'custom') {
        g.circle(pad.at.x, pad.at.y, pad.size.x / 2).fill({ color: padCol, alpha });
      } else {
        g.poly(flatten(padPolygon(pad)), true).fill({ color: padCol, alpha });
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
  for (const v of pcb.vias) vg.circle(v.at.x, v.at.y, v.size / 2).fill({ color: mono ?? opts.viaColor ?? VIA_COLOR, alpha: baseAlpha });
  const holes = new Graphics();
  const holeColor = opts.holeColor ?? (mono ? PCB_BACKGROUND : HOLE_COLOR);
  for (const v of pcb.vias) holes.circle(v.at.x, v.at.y, v.drill / 2).fill({ color: holeColor, alpha: baseAlpha });
  for (const p of pads) {
    if (!p.drill || p.drill.width <= 0) continue;
    const c = { x: p.at.x + rotate(p.drill.offset, p.rotation).x, y: p.at.y + rotate(p.drill.offset, p.rotation).y };
    if (p.drill.oval && p.drill.height !== p.drill.width) {
      const pts = padOutline('oval', p.drill.width, p.drill.height, 0.5).map((q) => {
        const r = rotate(q, p.rotation);
        return { x: r.x + c.x, y: r.y + c.y };
      });
      holes.poly(flatten(pts), true).fill({ color: opts.holeColor ?? HOLE_COLOR, alpha: baseAlpha });
    } else {
      holes.circle(c.x, c.y, p.drill.width / 2).fill({ color: opts.holeColor ?? HOLE_COLOR, alpha: baseAlpha });
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

export type DiffOp = 'added' | 'removed' | 'modified';

/**
 * Review drawing: the board in one quiet tone, and only what changed in colour. Objects are matched by KiCad UUID
 * (footprints, tracks, vias, zones), as the diff reports them.
 */
export interface DiffPaint {
  /** Object UUID → what happened to it. Removed ids are looked up in `removedFrom`. */
  ops: Map<string, DiffOp>;
  theme: 'light' | 'dark';
  /** The other revision, for drawing objects that this one no longer has. */
  removedFrom?: Pcb | null;
  /**
   * How the unchanged board is drawn. Unset: the review drawing (KiCad's layer roles, softened). A look draws the
   * board in full colour for showing the product (the homepage); changes stay in solid colour over it.
   */
  look?: LookName;
}

/** One look, per site theme. `mask` fills the outline (soldermask); `pad` overrides copper pad colour. */
export interface Look {
  background: number;
  mask: number | null;
  palette: (layer: string) => number;
  pad: number | null;
  via: number;
  hole: number;
  alpha: number;
  zoneAlpha: number;
  /** Draw only what is seen from the top (the back's copper and silk hidden). */
  topOnly: boolean;
  added: number;
  removed: number;
  modified: number;
  highlight: number;
}

const byLayer = (m: { front: number; back: number; inner: number; silk: number; backSilk: number; edge: number; mask?: number; other: number }) => (layer: string) => {
  if (layer === 'F.Cu') return m.front;
  if (layer === 'B.Cu') return m.back;
  if (/^In\d+\.Cu$/.test(layer)) return m.inner;
  if (layer === 'F.SilkS') return m.silk;
  if (layer === 'B.SilkS') return m.backSilk;
  if (layer === 'Edge.Cuts') return m.edge;
  if (layer.endsWith('.Mask') && m.mask !== undefined) return m.mask;
  return layer.endsWith('.Mask') ? pcbLayerColor(layer) : m.other;
};

export const LOOKS = {
  /** The board as KiCad renders it: matte green soldermask, ENIG pads, white silk (sampled from kicad-cli's render). */
  board: {
    light: {
      background: 0xeceeea, mask: 0x2c5240, pad: 0xd9bd48, via: 0xc4ab52, hole: 0x0f1411, alpha: 1, zoneAlpha: 0.55, topOnly: true,
      palette: byLayer({ front: 0x3b6a50, back: 0x335c46, inner: 0x335c46, silk: 0xf2f2ea, backSilk: 0xf2f2ea, edge: 0x1a3024, mask: 0xd9bd48, other: 0x7f9a88 }),
      added: 0x5be37d, removed: 0xff5a5f, modified: 0xff8f3a, highlight: 0xffffff,
    },
    dark: {
      background: 0x101311, mask: 0x2c5240, pad: 0xd9bd48, via: 0xc4ab52, hole: 0x080a09, alpha: 1, zoneAlpha: 0.55, topOnly: true,
      palette: byLayer({ front: 0x3b6a50, back: 0x335c46, inner: 0x335c46, silk: 0xf2f2ea, backSilk: 0xf2f2ea, edge: 0x6f8f7c, mask: 0xd9bd48, other: 0x7f9a88 }),
      added: 0x5be37d, removed: 0xff5a5f, modified: 0xff8f3a, highlight: 0xffffff,
    },
  },
  /** KiCad's own PCB editor colours on its navy canvas. */
  kicad: {
    light: {
      background: PCB_BACKGROUND, mask: null, pad: null, via: VIA_COLOR, hole: HOLE_COLOR, alpha: 0.9, zoneAlpha: 0.45, topOnly: false,
      palette: byLayer({ front: 0xc83434, back: 0x4d7fc4, inner: 0x7fc87f, silk: 0xf2eda1, backSilk: 0xe8b2a7, edge: 0xd0d2cd, other: 0x9a9a9a }),
      added: 0x45f08a, removed: 0xff5fa2, modified: 0x3fd8ff, highlight: 0xffffff,
    },
    dark: {
      background: PCB_BACKGROUND, mask: null, pad: null, via: VIA_COLOR, hole: HOLE_COLOR, alpha: 0.9, zoneAlpha: 0.45, topOnly: false,
      palette: byLayer({ front: 0xc83434, back: 0x4d7fc4, inner: 0x7fc87f, silk: 0xf2eda1, backSilk: 0xe8b2a7, edge: 0xd0d2cd, other: 0x9a9a9a }),
      added: 0x45f08a, removed: 0xff5fa2, modified: 0x3fd8ff, highlight: 0xffffff,
    },
  },
  /** A technical drawing: KiCad's layer roles at full strength, crisp, on paper or graphite. */
  paper: {
    light: {
      background: 0xf7f6f2, mask: null, pad: null, via: 0x8f8a7a, hole: 0xf7f6f2, alpha: 1, zoneAlpha: 0.22, topOnly: false,
      palette: byLayer({ front: 0xd27a5c, back: 0x7f9fd6, inner: 0xa99ccf, silk: 0x4a4d52, backSilk: 0x8d9bb0, edge: 0x2b2d30, other: 0xb4b7b3 }),
      added: 0x1a9e45, removed: 0xd7263d, modified: 0xe39b00, highlight: 0x121314,
    },
    dark: {
      background: 0x16181b, mask: null, pad: null, via: 0x8a8166, hole: 0x16181b, alpha: 1, zoneAlpha: 0.22, topOnly: false,
      palette: byLayer({ front: 0xb7654a, back: 0x4f72ad, inner: 0x6e62a0, silk: 0xc9ccd1, backSilk: 0x6c7d95, edge: 0xd0d2d6, other: 0x55595e }),
      added: 0x3fb950, removed: 0xf85149, modified: 0xffc21a, highlight: 0xffffff,
    },
  },
} satisfies Record<string, Record<'light' | 'dark', Look>>;

export type LookName = keyof typeof LOOKS;

export const DIFF_THEMES = {
  light: {
    background: 0xf6f6f3,
    base: 0x8d918d,
    baseAlpha: 0.62,
    added: 0x1f883d,
    removed: 0xcf222e,
    modified: 0xe0a800,
    highlight: 0x121314,
    via: 0xa89a70,
    layers: { front: 0xcf8566, back: 0x6a8fd0, inner: [0x9a8cc6, 0x6fb0aa, 0xb59bbd, 0x88aa77], silk: 0x8f938f, backSilk: 0x9fb0c8, edge: 0x5c5f5c, other: 0xb4b7b3 },
  },
  dark: {
    background: 0x151617,
    base: 0x6f7378,
    baseAlpha: 0.6,
    added: 0x3fb950,
    removed: 0xf85149,
    modified: 0xffd60a,
    highlight: 0xffffff,
    via: 0x8a8166,
    layers: { front: 0xa8644c, back: 0x44679e, inner: [0x6e62a0, 0x4a8780, 0x8a6f92, 0x627e52], silk: 0x8a8e93, backSilk: 0x6c7d95, edge: 0xb9bdc2, other: 0x55595e },
  },
} as const;

type DiffTheme = (typeof DIFF_THEMES)['light' | 'dark'];

/** The review drawing's palette: KiCad's layer roles, softened so the change in full colour stands out. */
function diffPalette(theme: DiffTheme): (layer: string) => number {
  const L = theme.layers;
  return (layer) => {
    if (layer === 'F.Cu') return L.front;
    if (layer === 'B.Cu') return L.back;
    const inner = /^In(\d+)\.Cu$/.exec(layer);
    if (inner) return L.inner[(Number(inner[1]) - 1) % L.inner.length]!;
    if (layer === 'F.SilkS') return L.silk;
    if (layer === 'B.SilkS') return L.backSilk;
    if (layer === 'Edge.Cuts') return L.edge;
    return L.other;
  };
}

/** The parts of a board whose UUIDs are in `ids`, as a board of their own. */
function subsetPcb(pcb: Pcb, ids: Set<string>): Pcb {
  return {
    ...pcb,
    footprints: pcb.footprints.filter((f) => ids.has(f.uuid)),
    tracks: pcb.tracks.filter((t) => ids.has(t.uuid)),
    vias: pcb.vias.filter((v) => ids.has(v.uuid)),
    zones: pcb.zones.filter((z) => ids.has(z.uuid)),
    graphics: pcb.graphics.filter((g) => g.uuid !== null && ids.has(g.uuid)),
    texts: [],
  };
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
  private diff: DiffPaint | null = null;
  private paint: PcbScene[] = [];
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

  /**
   * Load (or replace) the board. `ghost` is drawn underneath in grey for overlay diffs; `diff` switches to the review
   * drawing (quiet board, changes in colour).
   */
  load(pcb: Pcb, opts: { ghost?: Pcb | null; monochrome?: number | null; keepView?: boolean; diff?: DiffPaint | null } = {}): void {
    const view = opts.keepView && this.pcb ? this.stage.getView() : null;
    this.stage.clearContent();
    this.pcb = pcb;
    this.monochrome = opts.monochrome ?? null;
    this.diff = opts.diff ?? null;
    this.ghost = null;
    this.paint = [];
    const vivid: Look | null = this.diff?.look ? LOOKS[this.diff.look][this.diff.theme] : null;
    const theme = this.diff ? DIFF_THEMES[this.diff.theme] : null;
    this.stage.setBackground(vivid ? vivid.background : theme ? theme.background : PCB_BACKGROUND);
    if (opts.ghost) {
      this.ghost = buildPcbScene(opts.ghost, { monochrome: theme?.base ?? 0x8a8f8c, alpha: theme ? theme.baseAlpha * 0.6 : 0.55, text: false, holeColor: theme?.background }).root;
      this.stage.content.addChild(this.ghost);
    }
    this.scene = vivid
      ? buildPcbScene(pcb, { palette: vivid.palette, viaColor: vivid.via, alpha: vivid.alpha, holeColor: vivid.hole, zoneAlpha: vivid.zoneAlpha, padColor: vivid.pad ?? undefined, boardFill: vivid.mask ?? undefined })
      : theme
        ? buildPcbScene(pcb, { palette: diffPalette(theme), viaColor: theme.via, alpha: theme.baseAlpha, holeColor: theme.background, zoneAlpha: 0.22 })
        : buildPcbScene(pcb, { monochrome: this.monochrome, alpha: opts.ghost ? 0.85 : 1 });
    this.stage.content.addChild(this.scene.root);
    if (this.diff && theme) {
      const byOp = (op: DiffOp) => new Set([...this.diff!.ops].filter(([, o]) => o === op).map(([id]) => id));
      const draw = (source: Pcb | null | undefined, op: DiffOp) => {
        const ids = byOp(op);
        if (!source || !ids.size) return;
        const color = vivid ? vivid[op] : theme[op];
        const holeColor = vivid ? vivid.hole : theme.background;
        const sc = buildPcbScene(subsetPcb(source, ids), { monochrome: color, alpha: 1, text: false, holeColor });
        this.paint.push(sc);
        this.stage.content.addChild(sc.root);
      };
      draw(this.diff.removedFrom, 'removed');
      draw(pcb, 'modified');
      draw(pcb, 'added');
    }
    this.stage.markerColors = vivid ? { selection: vivid.highlight, added: vivid.added, removed: vivid.removed, modified: vivid.modified } : {};
    this.highlight = new Graphics();
    this.stage.content.addChild(this.highlight);
    this.hits = buildHitIndex(pcb);
    for (const l of this.scene.layerNames) {
      // The review drawing starts on the outer layers: inner pours stacked under them turn the board to mud.
      // A top-only look shows the board as seen from above: the back's copper and silk stay hidden.
      if (!this.visible.has(l)) this.visible.set(l, !/(CrtYd|Fab|Paste|Adhes|Margin|User\.\d+)$/.test(l) && !(theme && /^In\d+\.Cu$/.test(l)) && !(vivid?.topOnly && /^B\./.test(l)) && !(vivid && vivid.mask === null && /\.Mask$/.test(l)));
      this.scene.layers.get(l)!.visible = this.visible.get(l)!;
    }
    for (const sc of this.paint) for (const [l, c] of sc.layers) c.visible = this.visible.get(l) ?? !/(CrtYd|Fab|Paste|Adhes|Margin|User\.\d+)$/.test(l);
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
    for (const sc of this.paint) {
      const p = sc.layers.get(name);
      if (p) p.visible = visible;
    }
  }

  setFlipped(flipped: boolean): void {
    if (flipped === this.stage.isFlipped()) return;
    this.stage.setFlipped(flipped);
    if (this.pcb) this.load(this.pcb, { keepView: true, monochrome: this.monochrome, diff: this.diff });
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
    if (sel?.kind === 'footprint' && sel.reference) this.highlightPart(sel.reference);
    else this.highlightNet(sel?.net ?? null);
    this.refreshMarkers();
  }

  /** Light up one part (its pads and outline), dimming the rest of the board. */
  highlightPart(reference: string): void {
    this.highlightedNet = null;
    const fp = this.pcb?.footprints.find((f) => f.reference === reference);
    const vivid: Look | null = this.diff?.look ? LOOKS[this.diff.look][this.diff.theme] : null;
    const theme = this.diff ? DIFF_THEMES[this.diff.theme] : null;
    const color = vivid?.highlight ?? theme?.highlight ?? HIGHLIGHT_COLOR;
    this.clearHighlight();
    this.dim(fp ? (vivid ? 0.6 : theme ? 0.35 : 0.45) : 1);
    if (!fp) return;
    const g = this.highlight;
    for (const pad of fp.pads) {
      if (pad.shape === 'circle') g.circle(pad.at.x, pad.at.y, pad.size.x / 2).fill({ color, alpha: 0.9 });
      else g.poly(flatten(padPolygon(pad)), true).fill({ color, alpha: 0.9 });
    }
    for (const gr of fp.graphics) {
      if (!/\.(SilkS|Fab)$/.test(gr.layer) || gr.layer.startsWith('B.') !== fp.layer.startsWith('B.')) continue;
      const path = graphicPaths(gr);
      if (!path || path.pts.length < 2) continue;
      g.moveTo(path.pts[0]!.x, path.pts[0]!.y);
      for (let i = 1; i < path.pts.length; i++) g.lineTo(path.pts[i]!.x, path.pts[i]!.y);
      if (path.closed) g.closePath();
      g.stroke({ color, width: Math.max(gr.width, 0.12), alpha: 0.95, cap: 'round', join: 'round' });
    }
  }

  private clearHighlight(): void {
    this.highlight.clear();
  }

  private dim(alpha: number): void {
    if (!this.scene) return;
    for (const [, c] of this.scene.layers) c.alpha = alpha;
    this.scene.vias.alpha = alpha;
  }

  /** Brighten every copper item on a net, dimming the rest of the board. */
  highlightNet(net: string | null): void {
    this.highlightedNet = net;
    const g = this.highlight;
    this.clearHighlight();
    const vivid: Look | null = this.diff?.look ? LOOKS[this.diff.look][this.diff.theme] : null;
    const theme = this.diff ? DIFF_THEMES[this.diff.theme] : null;
    this.dim(net ? (vivid ? 0.6 : theme ? 0.35 : 0.45) : 1);
    if (!net || !this.pcb) return;
    if (vivid) return this.solidNet(net, vivid.highlight);
    const id = this.pcb.nets.find((n) => n.name === net)?.id;
    for (const t of this.pcb.tracks) {
      if (t.net !== id || this.visible.get(t.layer) === false) continue;
      const pts = trackPoints(t);
      g.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
      if (theme) {
        // On paper the net is drawn in ink, on graphite in white: it has to win over the soft palette.
        g.stroke({ color: theme.highlight, width: t.width, alpha: 0.9, cap: 'round', join: 'round' });
        continue;
      }
      g.stroke({ color: pcbLayerColor(t.layer), width: t.width, cap: 'round', join: 'round' });
      g.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
      g.stroke({ color: HIGHLIGHT_COLOR, width: t.width, alpha: 0.35, cap: 'round', join: 'round' });
    }
    for (const z of this.pcb.zones) {
      if (z.netName !== net) continue;
      for (const f of z.fills) if (this.visible.get(f.layer) !== false && f.pts.length > 2) g.poly(flatten(f.pts), true).fill({ color: theme?.highlight ?? HIGHLIGHT_COLOR, alpha: theme ? 0.12 : 0.18 });
    }
    for (const fp of this.pcb.footprints) {
      for (const pad of fp.pads) {
        if (pad.netName !== net && pad.net !== id) continue;
        const hc = theme?.highlight ?? HIGHLIGHT_COLOR;
        if (pad.shape === 'circle') g.circle(pad.at.x, pad.at.y, pad.size.x / 2).fill({ color: hc, alpha: 0.75 });
        else g.poly(flatten(padPolygon(pad)), true).fill({ color: hc, alpha: 0.75 });
      }
    }
    for (const v of this.pcb.vias) if (v.net === id) g.circle(v.at.x, v.at.y, v.size / 2).fill({ color: theme?.highlight ?? HIGHLIGHT_COLOR, alpha: 0.9 });
  }

  /** The vivid drawing's net highlight: every copper item on the net in one solid colour, back-side copper fainter. */
  private solidNet(net: string, color: number): void {
    const pcb = this.pcb!;
    const g = this.highlight;
    const id = pcb.nets.find((n) => n.name === net)?.id;
    for (const t of pcb.tracks) {
      if (t.net !== id) continue;
      const shown = this.visible.get(t.layer) !== false;
      const pts = trackPoints(t);
      g.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
      g.stroke({ color, width: Math.max(t.width, 0.2), alpha: shown ? 1 : 0.55, cap: 'round', join: 'round' });
    }
    for (const z of pcb.zones) {
      if (z.netName !== net) continue;
      for (const f of z.fills) if (this.visible.get(f.layer) !== false && f.pts.length > 2) g.poly(flatten(f.pts), true).fill({ color, alpha: 0.12 });
    }
    for (const fp of pcb.footprints) {
      for (const pad of fp.pads) {
        if (pad.netName !== net && pad.net !== id) continue;
        if (pad.shape === 'circle') g.circle(pad.at.x, pad.at.y, pad.size.x / 2).fill({ color });
        else g.poly(flatten(padPolygon(pad)), true).fill({ color });
      }
    }
    for (const v of pcb.vias) if (v.net === id) g.circle(v.at.x, v.at.y, v.size / 2).fill({ color });
  }

  get highlighted(): string | null {
    return this.highlightedNet;
  }

  /** Find a footprint by reference designator (cross-probing). */
  findReference(ref: string): Footprint | null {
    const fp = this.pcb?.footprints.find((f) => f.reference.toLowerCase() === ref.toLowerCase()) ?? null;
    if (fp?.bbox) {
      this.selection = { kind: 'footprint', id: fp.uuid, label: `${fp.reference} · ${fp.value}`, net: null, reference: fp.reference, layer: fp.layer, bbox: fp.bbox, at: fp.at };
      this.highlightPart(fp.reference);
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
    // With a look, a pour's fill is the selection; a box around a whole ground plane says nothing.
    const boxed = this.selection && !(this.diff?.look && this.selection.kind === 'zone');
    const sel: Marker[] = boxed ? [{ id: 'selection', kind: 'selection', bbox: this.selection!.bbox }] : [];
    this.stage.setMarkers([...this.extraMarkers, ...sel]);
  }

  focus(bbox: BBox): void {
    this.stage.focus(bbox);
  }

  destroy(): void {
    this.stage.destroy();
  }
}
