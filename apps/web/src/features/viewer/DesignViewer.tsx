import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { FlipHorizontal2, Layers, Maximize, Maximize2, Search, ZoomIn, ZoomOut } from 'lucide-react';
import type { BBox, ParsedDesign, Pt } from '@jumper/kicad-core/types';
import { PcbViewer, SchematicViewer, type DiffPaint, type LayerInfo, type Marker, type PcbSelection, type SchSelection, type ViewState } from '@jumper/viewer';
import { IconButton, Spinner, cx } from '@jumper/ui';
import { fitHeight, useCoarsePointer, useFullscreen } from './layout';

export type DesignSelection = (PcbSelection | SchSelection) & { kind: string };

export interface DesignViewerHandle {
  focus(bbox: BBox): void;
  findReference(ref: string): boolean;
  syncView(v: ViewState): void;
  getView(): ViewState | null;
  fit(): void;
  /** Canvas pixel (relative to the canvas' top-left) to board millimetres. */
  screenToWorld(x: number, y: number): Pt | null;
}

export interface DesignViewerProps {
  design: ParsedDesign;
  ghost?: ParsedDesign | null;
  monochrome?: number | null;
  /** Review drawing for boards: the board in one quiet tone, changes in colour. */
  diff?: DiffPaint | null;
  markers?: Marker[];
  height?: number | string;
  onSelect?: (sel: DesignSelection | null) => void;
  onViewChange?: (v: ViewState) => void;
  onOpenSheet?: (file: string) => void;
  toolbar?: ReactNode;
  selectionAction?: (sel: DesignSelection) => ReactNode;
  className?: string;
  /** Hide the toolbar entirely (used for stacked swipe views). */
  bare?: boolean;
}

type AnyViewer = PcbViewer | SchematicViewer;

const LAYER_PRESETS: Record<string, (l: LayerInfo) => boolean> = {
  Front: (l) => l.name.startsWith('F.') || l.name === 'Edge.Cuts',
  Back: (l) => l.name.startsWith('B.') || l.name === 'Edge.Cuts',
  Copper: (l) => l.kind === 'copper' || l.name === 'Edge.Cuts',
  Default: (l) => !/(CrtYd|Fab|Paste|Adhes|Margin)$/.test(l.name),
  All: () => true,
};

export const DesignViewer = forwardRef<DesignViewerHandle, DesignViewerProps>(function DesignViewer(props, ref) {
  const { design, ghost, monochrome, diff, markers, height = 600, toolbar, selectionAction, className, bare } = props;
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<AnyViewer | null>(null);
  const [ready, setReady] = useState<AnyViewer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<DesignSelection | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [showLayers, setShowLayers] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [query, setQuery] = useState('');
  const loadedOnce = useRef(false);
  const cbs = useRef(props);
  cbs.current = props;

  // Create the viewer for the design kind.
  useEffect(() => {
    let disposed = false;
    const el = host.current!;
    setReady(null);
    loadedOnce.current = false;
    const onSelect = (s: PcbSelection | SchSelection | null) => {
      setSelection(s as DesignSelection | null);
      cbs.current.onSelect?.(s as DesignSelection | null);
    };
    const create =
      design.kind === 'pcb'
        ? PcbViewer.create(el, {
            onSelect,
            onViewChange: (v) => cbs.current.onViewChange?.(v),
            onHover: (_s, p) => setHover(p),
          })
        : SchematicViewer.create(el, {
            onSelect,
            onViewChange: (v) => cbs.current.onViewChange?.(v),
            onOpenSheet: (f) => cbs.current.onOpenSheet?.(f),
          });
    create
      .then((v) => {
        if (disposed) return v.destroy();
        viewerRef.current = v;
        setReady(v);
      })
      .catch((e: Error) => setError(e.message || 'WebGL is not available in this browser'));
    return () => {
      disposed = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, [design.kind]);

  // (Re)load the model; keep the camera after the first load.
  useEffect(() => {
    const v = ready;
    if (!v) return;
    try {
      if (v instanceof PcbViewer && design.kind === 'pcb') {
        v.load(design.model, { ghost: ghost?.kind === 'pcb' ? ghost.model : null, monochrome, diff, keepView: loadedOnce.current });
        setLayers(v.layers());
      } else if (v instanceof SchematicViewer && design.kind === 'schematic') {
        v.load(design.model, { ghost: ghost?.kind === 'schematic' ? ghost.model : null, monochrome, keepView: loadedOnce.current });
      }
      loadedOnce.current = true;
      setSelection(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [ready, design, ghost, monochrome, diff]);

  useEffect(() => {
    ready?.setMarkers(markers ?? []);
  }, [ready, markers]);

  useImperativeHandle(
    ref,
    () => ({
      focus: (b) => viewerRef.current?.focus(b),
      findReference: (r) => Boolean(viewerRef.current?.findReference(r)),
      syncView: (v) => viewerRef.current?.stage.syncView(v),
      getView: () => viewerRef.current?.stage.getView() ?? null,
      fit: () => viewerRef.current?.fit(),
      screenToWorld: (x, y) => viewerRef.current?.stage.screenToWorld(x, y) ?? null,
    }),
    [],
  );

  const references = useMemo(() => {
    const refs = design.kind === 'pcb' ? design.model.footprints.map((f) => f.reference) : design.model.symbols.map((s) => s.reference);
    return [...new Set(refs.filter((r) => r && !r.startsWith('#')))].sort();
  }, [design]);

  const find = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) viewerRef.current?.findReference(query.trim());
  };

  const setLayer = (name: string, visible: boolean) => {
    const v = viewerRef.current;
    if (!(v instanceof PcbViewer)) return;
    v.setLayerVisible(name, visible);
    setLayers(v.layers());
  };

  const applyPreset = (fn: (l: LayerInfo) => boolean) => {
    const v = viewerRef.current;
    if (!(v instanceof PcbViewer)) return;
    for (const l of v.layers()) v.setLayerVisible(l.name, fn(l));
    setLayers(v.layers());
  };

  const flip = () => {
    const v = viewerRef.current;
    if (!(v instanceof PcbViewer)) return;
    v.setFlipped(!flipped);
    setFlipped(!flipped);
  };

  const coarse = useCoarsePointer();
  const fullscreen = useFullscreen(() => frame.current);
  const listId = useMemo(() => `refs-${Math.random().toString(36).slice(2)}`, []);

  return (
    <div
      ref={frame}
      className={cx('flex flex-col overflow-hidden bg-canvas', fullscreen.expanded && 'fixed inset-0 z-50', className)}
      style={{ height: fullscreen.expanded ? '100svh' : fitHeight(height) }}
    >
      {!bare && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border bg-canvas-subtle px-2 py-1.5">
          <IconButton label="Fit to view" size="sm" icon={<Maximize2 size={14} />} onClick={() => viewerRef.current?.fit()} />
          <IconButton label="Zoom in" size="sm" icon={<ZoomIn size={14} />} onClick={() => viewerRef.current?.stage.zoomBy(1.4)} />
          <IconButton label="Zoom out" size="sm" icon={<ZoomOut size={14} />} onClick={() => viewerRef.current?.stage.zoomBy(1 / 1.4)} />
          {design.kind === 'pcb' && (
            <>
              <IconButton label={flipped ? 'View from top' : 'View from bottom'} size="sm" variant={flipped ? 'default' : 'invisible'} icon={<FlipHorizontal2 size={14} />} onClick={flip} />
              <IconButton label="Layers" size="sm" variant={showLayers ? 'default' : 'invisible'} icon={<Layers size={14} />} onClick={() => setShowLayers((s) => !s)} />
            </>
          )}
          <form onSubmit={find} className="relative ml-1">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <input
              list={listId}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find reference…"
              aria-label="Find component by reference"
              className="h-7 w-40 rounded-md border border-border bg-canvas pl-6 pr-2 text-xs focus:border-select focus:outline-none"
            />
            <datalist id={listId}>
              {references.slice(0, 2000).map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </form>
          <div className="ml-auto flex items-center gap-1">
            {toolbar}
            <IconButton label={fullscreen.expanded ? 'Exit full screen' : 'Full screen'} size="sm" icon={<Maximize size={14} />} onClick={fullscreen.toggle} />
          </div>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0" />
        {!ready && !error && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/70">
            <Spinner /> Preparing viewer…
          </div>
        )}
        {error && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-danger">{error}</div>}
        {showLayers && design.kind === 'pcb' && (
          <div className="absolute right-2 top-2 max-h-[calc(100%-1rem)] w-56 overflow-auto rounded-md border border-border bg-canvas-overlay p-2 text-xs shadow-overlay">
            <div className="mb-2 flex flex-wrap gap-1">
              {Object.entries(LAYER_PRESETS).map(([name, fn]) => (
                <button key={name} onClick={() => applyPreset(fn)} className="rounded border border-border px-1.5 py-0.5 hover:bg-neutral-muted">
                  {name}
                </button>
              ))}
            </div>
            {layers.map((l) => (
              <label key={l.name} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-neutral-muted">
                <input type="checkbox" checked={l.visible} onChange={(e) => setLayer(l.name, e.target.checked)} />
                <span className="h-3 w-3 rounded-sm border border-black/20" style={{ background: l.color }} />
                <span className="font-mono">{l.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      {!bare && (
        <div className="flex h-7 items-center gap-3 border-t border-border bg-canvas-subtle px-3 font-mono text-xs text-fg-muted">
          {hover && (
            <span>
              X {hover.x.toFixed(3)} Y {hover.y.toFixed(3)} mm
            </span>
          )}
          {selection ? (
            <span className="truncate text-fg">
              {selection.label}
              {'net' in selection && selection.net ? <span className="text-accent"> · net {selection.net}</span> : null}
            </span>
          ) : (
            <span className="truncate">
              {coarse ? 'Tap' : 'Click'} an object to inspect it{design.kind === 'pcb' ? ' and highlight its net' : ''}
              {coarse ? ' · pinch to zoom' : ''}
            </span>
          )}
          {selection && selectionAction && <span className="ml-auto font-sans">{selectionAction(selection)}</span>}
        </div>
      )}
    </div>
  );
});
