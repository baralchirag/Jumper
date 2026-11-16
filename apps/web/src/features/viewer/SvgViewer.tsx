import { useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import type { ArtifactInfo } from '@jumper/shared';
import { IconButton, SegmentedControl, cx } from '@jumper/ui';
import { pcbLayerColor } from '@jumper/viewer';
import { fitHeight } from './layout';

/**
 * Pan/zoom viewer for SVGs rendered by kicad-cli (pixel-exact KiCad output).
 * Board layers are stacked with per-layer toggles; schematic sheets are paged.
 */
export function SvgViewer({ artifacts, kind, height = 600 }: { artifacts: ArtifactInfo[]; kind: 'pcb' | 'sch'; height?: number | string }) {
  const sorted = useMemo(() => [...artifacts].sort((a, b) => Number(a.meta.order ?? 0) - Number(b.meta.order ?? 0)), [artifacts]);
  const [visible, setVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sorted.map((a) => [a.id, !/(CrtYd|Fab|Paste|User)/.test(String(a.meta.layer ?? ''))])),
  );
  const [sheet, setSheet] = useState(sorted[0]?.id ?? '');
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const box = useRef<HTMLDivElement>(null);
  // Every pointer on the canvas: one pans, two pinch-zoom (touch screens).
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; mx: number; my: number } | null>(null);
  const lastTap = useRef(0);
  const [layersOpen, setLayersOpen] = useState(false);

  useEffect(() => {
    setView({ x: 0, y: 0, k: 1 });
  }, [sheet]);

  const zoomAt = (factor: number, cx: number, cy: number) =>
    setView((v) => {
      const k = Math.min(64, Math.max(0.2, v.k * factor));
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const shown = kind === 'pcb' ? sorted.filter((a) => visible[a.id]) : sorted.filter((a) => a.id === sheet);
  const center = () => {
    const r = box.current!.getBoundingClientRect();
    return [r.width / 2, r.height / 2] as const;
  };

  return (
    <div className="flex flex-col overflow-hidden" style={{ height: fitHeight(height) }}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-canvas-subtle px-2 py-1.5">
        <IconButton label="Reset view" size="sm" icon={<Maximize2 size={14} />} onClick={() => setView({ x: 0, y: 0, k: 1 })} />
        <IconButton label="Zoom in" size="sm" icon={<ZoomIn size={14} />} onClick={() => zoomAt(1.4, ...center())} />
        <IconButton label="Zoom out" size="sm" icon={<ZoomOut size={14} />} onClick={() => zoomAt(1 / 1.4, ...center())} />
        {kind === 'sch' && sorted.length > 1 && (
          <SegmentedControl
            size="sm"
            value={sheet}
            onChange={setSheet}
            options={sorted.map((a) => ({ value: a.id, label: String(a.meta.sheet ?? a.name) }))}
          />
        )}
        {kind === 'pcb' && (
          <IconButton label={layersOpen ? 'Hide layers' : 'Show layers'} size="sm" icon={<Layers size={14} />} onClick={() => setLayersOpen((o) => !o)} className="sm:hidden" aria-pressed={layersOpen} />
        )}
        <span className="ml-auto hidden text-xs text-fg-muted sm:inline">Rendered by kicad-cli</span>
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={box}
          className={cx('relative min-w-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing', kind === 'pcb' ? 'bg-[#001023]' : 'bg-[#f5f4ef]')}
          style={{ touchAction: 'none' }}
          onPointerDown={(e) => {
            const r = box.current!.getBoundingClientRect();
            pointers.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            if (pointers.current.size === 2) {
              const [a, b] = [...pointers.current.values()];
              pinch.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), mx: (a!.x + b!.x) / 2, my: (a!.y + b!.y) / 2 };
            } else if (e.pointerType !== 'mouse' && pointers.current.size === 1) {
              // Double-tap to zoom in.
              if (e.timeStamp - lastTap.current < 300) zoomAt(2, e.clientX - r.left, e.clientY - r.top);
              lastTap.current = e.timeStamp;
            }
          }}
          onPointerMove={(e) => {
            const prev = pointers.current.get(e.pointerId);
            if (!prev) return;
            const r = box.current!.getBoundingClientRect();
            const p = { x: e.clientX - r.left, y: e.clientY - r.top };
            pointers.current.set(e.pointerId, p);
            if (pinch.current && pointers.current.size === 2) {
              const [a, b] = [...pointers.current.values()];
              const next = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), mx: (a!.x + b!.x) / 2, my: (a!.y + b!.y) / 2 };
              const last = pinch.current;
              pinch.current = next;
              setView((v) => {
                const k = Math.min(64, Math.max(0.2, v.k * (last.dist > 0 ? next.dist / last.dist : 1)));
                const f = k / v.k;
                return { k, x: next.mx - (last.mx - v.x) * f, y: next.my - (last.my - v.y) * f };
              });
              return;
            }
            if (pointers.current.size === 1) setView((v) => ({ ...v, x: v.x + p.x - prev.x, y: v.y + p.y - prev.y }));
          }}
          onPointerUp={(e) => {
            pointers.current.delete(e.pointerId);
            if (pointers.current.size < 2) pinch.current = null;
          }}
          onPointerCancel={(e) => {
            pointers.current.delete(e.pointerId);
            if (pointers.current.size < 2) pinch.current = null;
          }}
        >
          <div className="absolute inset-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            {shown.map((a) => (
              <img
                key={a.id}
                src={a.url}
                alt={a.name}
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
                style={kind === 'pcb' ? { mixBlendMode: 'screen' } : undefined}
              />
            ))}
          </div>
        </div>
        {kind === 'pcb' && (
          <div
            className={cx(
              'w-48 shrink-0 overflow-auto border-l border-border bg-canvas p-2 text-xs',
              // Phones: a panel over the drawing, opened from the toolbar, so the board gets the full width.
              layersOpen ? 'absolute inset-y-0 right-0 z-10 shadow-lg sm:static sm:shadow-none' : 'hidden sm:block',
            )}
          >
            {sorted.map((a) => {
              const layer = String(a.meta.layer ?? a.name);
              return (
                <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-neutral-muted">
                  <input type="checkbox" checked={Boolean(visible[a.id])} onChange={(e) => setVisible((s) => ({ ...s, [a.id]: e.target.checked }))} />
                  <span className="h-3 w-3 rounded-sm" style={{ background: `#${pcbLayerColor(layer).toString(16).padStart(6, '0')}` }} />
                  <span className="font-mono">{layer}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
