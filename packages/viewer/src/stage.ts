import { Application, Container, Graphics } from 'pixi.js';
import type { BBox, Pt } from '@pcbhub/kicad-core/types';

export interface ViewState {
  /** World point at the centre of the canvas (mm). */
  cx: number;
  cy: number;
  /** Pixels per mm. */
  zoom: number;
}

export type MarkerKind = 'added' | 'removed' | 'modified' | 'error' | 'warning' | 'comment' | 'selection' | 'conflict';

export interface Marker {
  id: string;
  kind: MarkerKind;
  /** Box marker (diff changes) ... */
  bbox?: BBox | null;
  /** ... or point marker (DRC/ERC violations, comment pins). */
  at?: Pt;
  label?: string;
}

const MARKER_COLORS: Record<MarkerKind, number> = {
  added: 0x2ea043,
  removed: 0xe5534b,
  modified: 0xe0a030,
  error: 0xff3b30,
  warning: 0xffb000,
  comment: 0xf08a4b,
  selection: 0xff9a3c,
  conflict: 0xff3b30,
};

export interface StageOptions {
  background: number;
  /** Mirror horizontally (PCB bottom view). */
  flipped?: boolean;
  onViewChange?: (v: ViewState) => void;
  onClick?: (world: Pt, ev: PointerEvent) => void;
  onHover?: (world: Pt | null) => void;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2000;

/**
 * Pixi application with a world container in millimetres, pan/zoom input,
 * fit/focus helpers and a screen-space marker overlay.
 */
export class Stage {
  readonly app: Application;
  readonly world = new Container();
  readonly content = new Container();
  private readonly overlay = new Graphics();
  private markers: Marker[] = [];
  private flipped: boolean;
  private resizeObserver: ResizeObserver | null = null;
  private readonly cleanup: (() => void)[] = [];
  private destroyed = false;
  private suppressEmit = false;

  private constructor(
    readonly el: HTMLElement,
    private readonly opts: StageOptions,
  ) {
    this.app = new Application();
    this.flipped = Boolean(opts.flipped);
  }

  static async create(el: HTMLElement, opts: StageOptions): Promise<Stage> {
    const s = new Stage(el, opts);
    await s.app.init({
      background: opts.background,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      resizeTo: el,
      preference: 'webgl',
    });
    s.app.canvas.style.display = 'block';
    s.app.canvas.style.touchAction = 'none';
    el.appendChild(s.app.canvas);
    s.world.addChild(s.content);
    s.app.stage.addChild(s.world, s.overlay);
    s.bindInput();
    s.resizeObserver = new ResizeObserver(() => s.redrawOverlay());
    s.resizeObserver.observe(el);
    return s;
  }

  get width(): number {
    return this.el.clientWidth;
  }

  get height(): number {
    return this.el.clientHeight;
  }

  get zoom(): number {
    return Math.abs(this.world.scale.y);
  }

  setFlipped(flipped: boolean): void {
    const v = this.getView();
    this.flipped = flipped;
    this.setView(v);
  }

  isFlipped(): boolean {
    return this.flipped;
  }

  screenToWorld(sx: number, sy: number): Pt {
    return { x: (sx - this.world.x) / this.world.scale.x, y: (sy - this.world.y) / this.world.scale.y };
  }

  worldToScreen(p: Pt): Pt {
    return { x: p.x * this.world.scale.x + this.world.x, y: p.y * this.world.scale.y + this.world.y };
  }

  getView(): ViewState {
    const c = this.screenToWorld(this.width / 2, this.height / 2);
    return { cx: c.x, cy: c.y, zoom: this.zoom };
  }

  setView(v: ViewState, emit = false): void {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom));
    this.world.scale.set(this.flipped ? -z : z, z);
    this.world.position.set(this.width / 2 - v.cx * this.world.scale.x, this.height / 2 - v.cy * z);
    this.redrawOverlay();
    if (emit) this.emitView();
  }

  /** Apply a view coming from a synced peer without echoing it back. */
  syncView(v: ViewState): void {
    this.suppressEmit = true;
    this.setView(v);
    this.suppressEmit = false;
  }

  fit(bbox: BBox | null, padding = 0.08): void {
    if (!bbox || !Number.isFinite(bbox.minX)) return;
    const w = Math.max(bbox.maxX - bbox.minX, 1);
    const h = Math.max(bbox.maxY - bbox.minY, 1);
    const zoom = Math.min(this.width / (w * (1 + padding * 2)), this.height / (h * (1 + padding * 2)));
    this.setView({ cx: (bbox.minX + bbox.maxX) / 2, cy: (bbox.minY + bbox.maxY) / 2, zoom }, true);
  }

  /** Zoom to an object, keeping some context around it. */
  focus(bbox: BBox, minSpan = 8): void {
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const span = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, minSpan) * 2.5;
    this.fit({ minX: cx - span / 2, minY: cy - span / 2, maxX: cx + span / 2, maxY: cy + span / 2 }, 0);
  }

  zoomBy(factor: number, sx = this.width / 2, sy = this.height / 2): void {
    const before = this.screenToWorld(sx, sy);
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    this.world.scale.set(this.flipped ? -z : z, z);
    this.world.position.set(sx - before.x * this.world.scale.x, sy - before.y * z);
    this.redrawOverlay();
    this.emitView();
  }

  setMarkers(markers: Marker[]): void {
    this.markers = markers;
    this.redrawOverlay();
  }

  private emitView(): void {
    if (!this.suppressEmit) this.opts.onViewChange?.(this.getView());
  }

  /** Markers are drawn in screen space so they stay legible at any zoom. */
  redrawOverlay(): void {
    if (this.destroyed) return;
    const g = this.overlay;
    g.clear();
    for (const m of this.markers) {
      const color = MARKER_COLORS[m.kind];
      if (m.bbox) {
        const a = this.worldToScreen({ x: m.bbox.minX, y: m.bbox.minY });
        const b = this.worldToScreen({ x: m.bbox.maxX, y: m.bbox.maxY });
        const x = Math.min(a.x, b.x) - 3;
        const y = Math.min(a.y, b.y) - 3;
        const w = Math.max(Math.abs(b.x - a.x) + 6, 8);
        const h = Math.max(Math.abs(b.y - a.y) + 6, 8);
        g.rect(x, y, w, h).fill({ color, alpha: m.kind === 'selection' ? 0.08 : 0.12 }).stroke({ color, width: m.kind === 'selection' ? 2 : 1.5, alpha: 0.95 });
      } else if (m.at) {
        const p = this.worldToScreen(m.at);
        if (m.kind === 'comment') {
          g.circle(p.x, p.y - 10, 7).fill({ color }).stroke({ color: 0xffffff, width: 1.5 });
          g.moveTo(p.x, p.y - 3).lineTo(p.x, p.y).stroke({ color, width: 2 });
        } else {
          g.circle(p.x, p.y, 7).fill({ color, alpha: 0.25 }).stroke({ color, width: 2 });
          g.circle(p.x, p.y, 2).fill({ color });
        }
      }
    }
  }

  private bindInput(): void {
    const c = this.app.canvas;
    let dragging = false;
    let moved = 0;
    let last = { x: 0, y: 0 };

    const local = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      dragging = true;
      moved = 0;
      last = local(e);
      c.setPointerCapture(e.pointerId);
      c.style.cursor = 'grabbing';
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      if (!dragging) {
        this.opts.onHover?.(this.screenToWorld(p.x, p.y));
        return;
      }
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      last = p;
      this.world.position.set(this.world.x + dx, this.world.y + dy);
      this.redrawOverlay();
      this.emitView();
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      c.style.cursor = '';
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      if (moved < 4 && e.button === 0) {
        const p = local(e);
        this.opts.onClick?.(this.screenToWorld(p.x, p.y), e);
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      this.zoomBy(factor, p.x, p.y);
    };
    const onLeave = () => this.opts.onHover?.(null);
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);
    c.addEventListener('pointerleave', onLeave);
    c.addEventListener('wheel', onWheel, { passive: false });
    this.cleanup.push(() => {
      c.removeEventListener('pointerdown', onDown);
      c.removeEventListener('pointermove', onMove);
      c.removeEventListener('pointerup', onUp);
      c.removeEventListener('pointercancel', onUp);
      c.removeEventListener('pointerleave', onLeave);
      c.removeEventListener('wheel', onWheel);
    });
  }

  clearContent(): void {
    for (const child of this.content.removeChildren()) child.destroy({ children: true });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    for (const fn of this.cleanup) fn();
    this.app.destroy({ removeView: true }, { children: true, texture: true });
  }
}
