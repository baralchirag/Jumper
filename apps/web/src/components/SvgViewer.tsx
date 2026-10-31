import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import type { ArtifactInfo } from '@pcbhub/shared';
import { IconButton, SegmentedControl, cx } from '@pcbhub/ui';
import { pcbLayerColor } from '@pcbhub/viewer';

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
  const drag = useRef<{ x: number; y: number } | null>(null);

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
    <div className="flex flex-col overflow-hidden" style={{ height }}>
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
        <span className="ml-auto text-xs text-fg-muted">Rendered by kicad-cli</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          ref={box}
          className={cx('relative min-w-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing', kind === 'pcb' ? 'bg-[#001023]' : 'bg-[#f5f4ef]')}
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, y: e.clientY };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const dx = e.clientX - drag.current.x;
            const dy = e.clientY - drag.current.y;
            drag.current = { x: e.clientX, y: e.clientY };
            setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
          }}
          onPointerUp={() => (drag.current = null)}
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
          <div className="w-48 shrink-0 overflow-auto border-l border-border bg-canvas p-2 text-xs">
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
