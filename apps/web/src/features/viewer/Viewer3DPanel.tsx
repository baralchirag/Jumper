import { useEffect, useRef, useState } from 'react';
import { Camera, FlipVertical2, Mouse, RotateCw } from 'lucide-react';
import type { Pcb } from '@jumper/kicad-core/types';
import { MASK_COLORS, Viewer3D, buildBoard3D, type MaskColor, type View3D } from '@jumper/viewer';
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import type { ArtifactInfo } from '@jumper/shared';
import { Button, SegmentedControl, Select, Spinner, cx } from '@jumper/ui';
import { fitHeight } from './layout';

type Source = 'board' | 'glb' | 'step' | 'renders';

const SOURCE_LABEL: Record<Source, string> = {
  board: 'Live board',
  glb: 'KiCad 3D (GLB)',
  step: 'STEP · OpenCascade',
  renders: 'Ray-traced',
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
}: {
  pcb?: Pcb | null;
  glbUrl?: string | null;
  stepUrl?: string | null;
  renders?: ArtifactInfo[];
  height?: number | string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer3D | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const available: Source[] = [...(glbUrl ? ['glb' as const] : []), ...(pcb ? ['board' as const] : []), ...(stepUrl ? ['step' as const] : []), ...(renders.length ? ['renders' as const] : [])];
  const [source, setSource] = useState<Source>(available[0] ?? 'board');
  const [ortho, setOrtho] = useState(false);
  const [spin, setSpin] = useState(false);
  const [mask, setMask] = useState<MaskColor>('green');
  const [bodies, setBodies] = useState(true);
  const [hint, setHint] = useState(true);

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
          ? v.loadGlb(glbUrl!)
          : fetch(stepUrl!)
              .then((r) => {
                if (!r.ok) throw new Error(`Could not download STEP (${r.status})`);
                return r.arrayBuffer();
              })
              .then((b) => v.loadStep(b));
    run.then(
      () => !cancelled && setState('ready'),
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
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-canvas-subtle px-2 py-1.5">
        {available.length > 1 && (
          <SegmentedControl size="sm" value={source} onChange={setSource} ariaLabel="3D source" options={available.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))} />
        )}
        {is3d && (
          <>
            <span className="flex flex-wrap items-center">
              {views.map((v) => (
                <Button key={v} size="sm" variant="invisible" onClick={() => viewer.current?.setView(v)} className="capitalize">
                  {v === 'iso' ? 'Iso' : v}
                </Button>
              ))}
            </span>
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
                <Select value={mask} onChange={(e) => setMask(e.target.value as MaskColor)} className="h-7 w-24 text-xs" aria-label="Soldermask colour">
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
      <div className="relative min-h-0 flex-1" style={{ background: 'linear-gradient(#d4d6d3, #6f7370)' }}>
        <div ref={host} className={cx('absolute inset-0 cursor-grab active:cursor-grabbing', !is3d && 'invisible')} />
        {source === 'renders' && (
          <div className="absolute inset-0">
            <RenderGallery renders={renders} />
          </div>
        )}
        {is3d && state === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white">
            <Spinner /> {source === 'step' ? 'Tessellating STEP with OpenCascade…' : 'Loading 3D model…'}
          </div>
        )}
        {is3d && state === 'error' && <div className="absolute inset-0 flex items-center justify-center p-6 text-sm text-danger">{error}</div>}
        {is3d && state === 'ready' && hint && (
          <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-md bg-black/60 px-2.5 py-1.5 text-xs text-white">
            <Mouse size={14} />
            <span>
              <b>Drag</b> rotate · <b>Right-drag</b> pan · <b>Scroll</b> zoom · <b>Flip</b> to see the back
            </span>
            <button onClick={() => setHint(false)} className="ml-1 text-white/70 hover:text-white" aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {is3d && source === 'board' && state === 'ready' && (
          <div className="absolute right-3 top-3 rounded bg-black/50 px-2 py-1 text-xs text-white/90" title="Component bodies are approximated from courtyards. The KiCad 3D (GLB) source uses real 3D models once the Exports check finishes.">
            Approximate parts · real models in KiCad 3D
          </div>
        )}
      </div>
    </div>
  );
}
