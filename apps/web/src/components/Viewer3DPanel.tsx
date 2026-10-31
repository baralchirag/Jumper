import { useEffect, useRef, useState } from 'react';
import { Viewer3D, type View3D } from '@pcbhub/viewer';
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { Button, SegmentedControl, Spinner } from '@pcbhub/ui';

/** 3D board view from the kicad-cli GLB/STEP exports. */
export function Viewer3DPanel({ glbUrl, stepUrl, height = 600 }: { glbUrl?: string | null; stepUrl?: string | null; height?: number | string }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer3D | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [source, setSource] = useState<'glb' | 'step'>(glbUrl ? 'glb' : 'step');
  const [ortho, setOrtho] = useState(false);

  useEffect(() => {
    const v = new Viewer3D(host.current!, { occtWasmUrl });
    viewer.current = v;
    return () => {
      v.destroy();
      viewer.current = null;
    };
  }, []);

  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    setState('loading');
    const url = source === 'glb' ? glbUrl : stepUrl;
    if (!url) return;
    const run = source === 'glb' ? v.loadGlb(url) : fetch(url).then((r) => r.arrayBuffer()).then((b) => v.loadStep(b));
    run.then(
      () => setState('ready'),
      (e: Error) => {
        setError(e.message);
        setState('error');
      },
    );
  }, [source, glbUrl, stepUrl]);

  const views: View3D[] = ['top', 'bottom', 'front', 'iso'];
  return (
    <div className="flex flex-col overflow-hidden" style={{ height }}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-canvas-subtle px-2 py-1.5">
        {views.map((v) => (
          <Button key={v} size="sm" variant="invisible" onClick={() => viewer.current?.setView(v)} className="capitalize">
            {v}
          </Button>
        ))}
        <SegmentedControl
          size="sm"
          value={ortho ? 'ortho' : 'persp'}
          onChange={(v) => {
            setOrtho(v === 'ortho');
            viewer.current?.setProjection(v === 'ortho');
          }}
          options={[
            { value: 'persp', label: 'Perspective' },
            { value: 'ortho', label: 'Orthographic' },
          ]}
        />
        {glbUrl && stepUrl && (
          <SegmentedControl
            size="sm"
            value={source}
            onChange={setSource}
            options={[
              { value: 'glb', label: 'GLB' },
              { value: 'step', label: 'STEP (OpenCascade)' },
            ]}
          />
        )}
      </div>
      <div className="relative min-h-0 flex-1" style={{ background: 'linear-gradient(#d4d6d3, #6f7370)' }}>
        <div ref={host} className="absolute inset-0" />
        {state === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white">
            <Spinner /> Loading 3D model…
          </div>
        )}
        {state === 'error' && <div className="absolute inset-0 flex items-center justify-center p-6 text-sm text-danger">{error}</div>}
      </div>
    </div>
  );
}
