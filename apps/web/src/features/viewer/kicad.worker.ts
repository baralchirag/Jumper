/// <reference lib="webworker" />
// Parses and diffs KiCad files with the Rust/WASM core off the main thread.
import { loadKicadCore, type KindHint } from '@jumper/kicad-core/web';

type Req = { id: number; op?: 'parse'; text: string; kind: KindHint } | { id: number; op: 'diff'; before: string; after: string; kind: KindHint };

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  try {
    const core = await loadKicadCore();
    const result = req.op === 'diff' ? core.diff(req.before, req.after, req.kind) : core.parse(req.text, req.kind);
    (self as unknown as Worker).postMessage({ id: req.id, ok: true, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
