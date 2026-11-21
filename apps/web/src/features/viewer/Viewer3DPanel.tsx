import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, FlipVertical2, Mouse, RotateCw, X } from 'lucide-react';
import type { Pcb } from '@jumper/kicad-core/types';
import { MASK_COLORS, Viewer3D, buildBoard3D, kicadGlbFrame, liveBoardFrame, partFinish, type MaskColor, type View3D } from '@jumper/viewer';
import { highlightFor, netName, netSummary, partNets, resolvePick, type Pick3D } from './pick3d';
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import type { ArtifactInfo } from '@jumper/shared';
import { Button, SegmentedControl, Select, Spinner, cx } from '@jumper/ui';
import { fitHeight } from './layout';

export type Source3D = 'board' | 'glb' | 'step' | 'renders';
type Source = Source3D;

const SOURCE_LABEL: Record<Source, string> = {
  board: 'Live board',
  glb: 'KiCad 3D',
  step: 'STEP',
  renders: 'Ray-traced images',
};

function RenderGallery({ renders }: { renders: ArtifactInfo[] }) {
  const sorted = [...renders].sort((a, b) => Number(a.meta.order ?? 0) - Number(b.meta.order ?? 0));
  const [active, setActive] = useState(sorted[0]?.id);
  const current = sorted.find((r) => r.id === active) ?? sorted[0];
  if (!current) return null;
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[#d4d6d3]">
        <img src={current.url} alt={String(current.meta.view ?? current.name)} className="max-h-full max-w-full object-contain" />
      </div>
      <div className="flex gap-2 overflow-x-auto border-t border-border bg-canvas-subtle p-2">
        {sorted.map((r) => (
          <button key={r.id} onClick={() => setActive(r.id)} className={cx('shrink-0 overflow-hidden rounded border-2', r.id === current.id ? 'border-select' : 'border-transparent')}>
            <img src={r.url} alt={r.name} className="h-16 w-24 object-cover" />
            <div className="bg-canvas px-1 text-[11.5px] capitalize text-fg-muted">{String(r.meta.view ?? r.name).replace('-', ' ')}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 3D board view. "Live board" is generated in the browser from the parsed
 * .kicad_pcb (always available); GLB/STEP/renders come from kicad-cli.
 */
export function Viewer3DPanel({
  pcb,
  glbUrl,
  stepUrl,
  renders = [],
  height = 600,
  minimal = false,
  onReady,
  initialSource,
}: {
  pcb?: Pcb | null;
  glbUrl?: string | null;
  stepUrl?: string | null;
  renders?: ArtifactInfo[];
  height?: number | string;
  /** No toolbar or hints, slow turntable until touched (the homepage). */
  minimal?: boolean;
  /** Called once the model is on screen. */
  onReady?: () => void;
  /** Which view to open on, when it is available. */
  initialSource?: Source;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer3D | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const available: Source[] = [...(glbUrl ? ['glb' as const] : []), ...(pcb ? ['board' as const] : []), ...(stepUrl ? ['step' as const] : []), ...(renders.length ? ['renders' as const] : [])];
  const [source, setSource] = useState<Source>(initialSource && available.includes(initialSource) ? initialSource : (available[0] ?? 'board'));
  const [ortho, setOrtho] = useState(false);
  const [spin, setSpin] = useState(false);
  const [mask, setMask] = useState<MaskColor>('green');
  const [bodies, setBodies] = useState(true);
  const [hint, setHint] = useState(true);
  const byRef = useMemo(() => new Map((pcb?.footprints ?? []).map((f) => [f.reference, f])), [pcb]);
  const [pick, setPick] = useState<{ sel: Pick3D; height: number } | null>(null);
  const thickness = pcb?.thickness && pcb.thickness > 0 ? pcb.thickness : 1.6;

  useEffect(() => {
    const v = new Viewer3D(host.current!, { occtWasmUrl });
    v.onAutoRotateChange = setSpin;
    viewer.current = v;
    return () => {
      v.destroy();
      viewer.current = null;
    };
  }, []);

  useEffect(() => {
    const v = viewer.current;
    if (!v || source === 'renders') return;
    setState('loading');
    let cancelled = false;
    const run =
      source === 'board'
        ? new Promise<void>((resolve, reject) => {
            // Let the spinner paint before the (synchronous) build.
            setTimeout(() => {
              try {
                if (!pcb) throw new Error('Board not loaded');
                v.loadObject(buildBoard3D(pcb, { mask, components: true }), true);
                v.setVisible('components', bodies);
                resolve();
              } catch (e) {
                reject(e as Error);
              }
            }, 0);
          })
        : source === 'glb'
          ? // Always kicad-cli's export (the worker's, or the homepage's re-compressed copy). The parsed board tells
            // which part each uncoloured model belongs to.
            v.loadGlb(glbUrl!, true, (ref) => {
              const fp = byRef.get(ref);
              return fp ? partFinish(fp) : null;
            })
          : fetch(stepUrl!)
              .then((r) => {
                if (!r.ok) throw new Error(`Could not download STEP (${r.status})`);
                return r.arrayBuffer();
              })
              .then((b) => v.loadStep(b));
    setPick(null);
    run.then(
      () => {
        if (cancelled) return;
        // Picking needs the parsed board to say what is under a click; STEP files have no frame we know.
        v.setFrame(pcb && source !== 'step' ? (source === 'glb' ? kicadGlbFrame(thickness) : liveBoardFrame(thickness)) : null);
        setState('ready');
        onReady?.();
        if (minimal && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          v.setAutoRotate(true);
          setSpin(true);
        }
      },
      (e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setState('error');
      },
    );
    return () => {
      cancelled = true;
    };
    // Mask colour rebuilds the live board only.
  }, [source, glbUrl, stepUrl, pcb, source === 'board' ? mask : null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => viewer.current?.setVisible('components', bodies), [bodies]);

  // A click selects the part or net under it; empty space clears.
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    v.onPick = pcb
      ? (hit) => {
          const sel = hit ? resolvePick(pcb, hit) : null;
          setPick(sel ? { sel, height: sel.kind === 'part' ? Math.max(hit!.lift + 0.25, 0.8) : 0 } : null);
        }
      : null;
  }, [pcb]);

  useEffect(() => {
    const v = viewer.current;
    if (!v || !pcb) return;
    v.setHighlight(pick ? highlightFor(pcb, pick.sel, pick.height) : null);
  }, [pick, pcb, state]);

  useEffect(() => {
    if (!pick) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPick(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pick]);

  const selectPart = (ref: string) => {
    const fp = byRef.get(ref);
    if (!fp?.bbox) return;
    setPick({ sel: { kind: 'part', fp }, height: 1.2 });
    viewer.current?.centreOn((fp.bbox.minX + fp.bbox.maxX) / 2, (fp.bbox.minY + fp.bbox.maxY) / 2, !fp.layer.startsWith('B'));
  };
  const selectNet = (net: number) => pcb && setPick({ sel: { kind: 'net', net, name: netName(pcb, net) }, height: 0 });

  const views: View3D[] = ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'];
  const save = () => {
    const a = document.createElement('a');
    a.href = viewer.current!.screenshot();
    a.download = 'board-3d.png';
    a.click();
  };
  const is3d = source !== 'renders';

  return (
    <div className="flex flex-col overflow-hidden" style={{ height: fitHeight(height) }}>
      <div className={cx('flex flex-wrap items-center gap-2 border-b border-border bg-canvas-subtle px-2 py-1.5', minimal && 'hidden')}>
        {available.length > 1 && (
          <SegmentedControl size="sm" value={source} onChange={setSource} ariaLabel="3D source" options={available.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))} />
        )}
        {is3d && (
          <>
            <Select
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) viewer.current?.setView(e.target.value as View3D);
                e.target.value = '';
              }}
              className="h-7 w-28 text-xs"
              aria-label="Jump to a view"
            >
              <option value="" disabled>
                View…
              </option>
              {views.map((v) => (
                <option key={v} value={v}>
                  {v === 'iso' ? 'Angled' : v[0]!.toUpperCase() + v.slice(1)}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="invisible" leadingIcon={<FlipVertical2 size={14} />} onClick={() => viewer.current?.flip()} title="Turn the board over">
              Flip
            </Button>
            <Button
              size="sm"
              variant={spin ? 'primary' : 'invisible'}
              leadingIcon={<RotateCw size={14} />}
              onClick={() => {
                viewer.current?.setAutoRotate(!spin);
                setSpin(!spin);
              }}
              title="Turntable"
            >
              Spin
            </Button>
            <SegmentedControl
              size="sm"
              value={ortho ? 'ortho' : 'persp'}
              onChange={(v) => {
                setOrtho(v === 'ortho');
                viewer.current?.setProjection(v === 'ortho');
              }}
              options={[
                { value: 'persp', label: 'Persp' },
                { value: 'ortho', label: 'Ortho' },
              ]}
            />
            {source === 'board' && (
              <>
                <Select value={mask} onChange={(e) => setMask(e.target.value as MaskColor)} className="h-7 w-28 text-xs" aria-label="Soldermask colour">
                  {Object.keys(MASK_COLORS).map((c) => (
                    <option key={c} value={c}>
                      {c[0]!.toUpperCase() + c.slice(1)}
                    </option>
                  ))}
                </Select>
                <label className="flex items-center gap-1 text-xs text-fg-muted">
                  <input type="checkbox" checked={bodies} onChange={(e) => setBodies(e.target.checked)} /> Parts
                </label>
              </>
            )}
            <Button size="sm" variant="invisible" leadingIcon={<Camera size={14} />} onClick={save} className="ml-auto" title="Save PNG">
              PNG
            </Button>
          </>
        )}
      </div>
      <div className="relative min-h-0 flex-1" style={{ background: minimal ? 'transparent' : 'linear-gradient(#d4d6d3, #6f7370)' }}>
        <div ref={host} className={cx('absolute inset-0 cursor-grab active:cursor-grabbing', !is3d && 'invisible')} />
        {is3d && pick && pcb && !minimal && <PickCard pcb={pcb} pick={pick.sel} onClose={() => setPick(null)} onPart={selectPart} onNet={selectNet} />}
        {source === 'renders' && (
          <div className="absolute inset-0">
            <RenderGallery renders={renders} />
          </div>
        )}
        {is3d && state === 'loading' && !minimal && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white">
            <Spinner /> {source === 'step' ? 'Tessellating STEP with OpenCascade…' : 'Loading 3D model…'}
          </div>
        )}
        {is3d && state === 'error' && <div className="absolute inset-0 flex items-center justify-center p-6 text-sm text-danger">{error}</div>}
        {is3d && state === 'ready' && hint && !minimal && (
          <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-md bg-black/60 px-2.5 py-1.5 text-xs text-white">
            <Mouse size={14} />
            <span>
              {pcb && source !== 'step' && (
                <>
                  <b>Click</b> a part or track ·{' '}
                </>
              )}
              <b>Drag</b> rotate · <b>Right-drag</b> pan · <b>Scroll</b> zoom · <b>Flip</b> to see the back
            </span>
            <button onClick={() => setHint(false)} className="ml-1 text-white/70 hover:text-white" aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {is3d && source === 'board' && state === 'ready' && !minimal && (
          <div className="absolute right-3 top-3 max-w-[60%] rounded bg-black/55 px-2 py-1 text-xs text-white/90" title="Built in your browser from the .kicad_pcb file. Part shapes are boxes drawn from the courtyards.">
            {glbUrl ? 'Quick preview · switch to KiCad 3D for real part models' : 'Quick preview from your board file · real part models appear when the exports finish'}
          </div>
        )}
      </div>
    </div>
  );
}

/** What was clicked: a part with its nets, or a net with its length and the parts it joins. Chips select further. */
function PickCard({ pcb, pick, onClose, onPart, onNet }: { pcb: Pcb; pick: Pick3D; onClose: () => void; onPart: (ref: string) => void; onNet: (net: number) => void }) {
  const chip = 'rounded border border-white/15 bg-white/10 px-1.5 py-0.5 font-mono text-[11.5px] text-white hover:border-[#2f9bff] hover:bg-[#2f9bff]/25';
  return (
    <div className="absolute left-3 top-3 w-[min(19rem,calc(100%-1.5rem))] rounded-lg border border-white/10 bg-[#0d1117]/90 p-3 text-xs text-white/80 shadow-lg backdrop-blur">
      <button type="button" onClick={onClose} className="absolute right-2 top-2 rounded p-0.5 text-white/60 hover:bg-white/10 hover:text-white" aria-label="Clear selection" title="Clear (Esc)">
        <X size={14} />
      </button>
      {pick.kind === 'part' ? (
        <>
          <div className="flex items-baseline gap-2 pr-6">
            <span className="font-mono text-base font-semibold text-white">{pick.fp.reference}</span>
            <span className="truncate text-sm text-white/90">{pick.fp.value}</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-white/55" title={pick.fp.libId}>
            {pick.fp.libId.split(':').pop()}
          </div>
          <div className="mt-1 text-white/55">
            {pick.fp.layer.startsWith('B') ? 'Bottom' : 'Top'} · {pick.fp.pads.length} pads · {pick.fp.rotation}°
          </div>
          {partNets(pick.fp).length > 0 && (
            <div className="mt-2.5">
              <div className="mb-1 text-[11px] uppercase tracking-wider text-white/45">Nets</div>
              <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                {partNets(pick.fp).map((n) => (
                  <button key={n.net} type="button" className={chip} onClick={() => onNet(n.net)} title={`Pads ${n.pads.join(', ')}`}>
                    {n.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <NetBody pcb={pcb} net={pick.net} name={pick.name} chip={chip} onPart={onPart} />
      )}
    </div>
  );
}

function NetBody({ pcb, net, name, chip, onPart }: { pcb: Pcb; net: number; name: string; chip: string; onPart: (ref: string) => void }) {
  const s = useMemo(() => netSummary(pcb, net), [pcb, net]);
  return (
    <>
      <div className="pr-6 font-mono text-base font-semibold text-white">{name}</div>
      <div className="mt-1 text-white/55">
        {s.tracks} segments · {s.length.toFixed(1)} mm{s.vias ? ` · ${s.vias} vias` : ''}
      </div>
      {s.parts.length > 0 && (
        <div className="mt-2.5">
          <div className="mb-1 text-[11px] uppercase tracking-wider text-white/45">Connects {s.parts.length} parts</div>
          <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
            {s.parts.map((r) => (
              <button key={r} type="button" className={chip} onClick={() => onPart(r)}>
                {r}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
