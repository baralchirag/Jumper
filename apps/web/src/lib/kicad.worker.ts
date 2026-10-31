/// <reference lib="webworker" />
// Parses KiCad files with the Rust/WASM core off the main thread.
import { loadKicadCore, type KindHint } from '@pcbhub/kicad-core/web';

interface Req {
  id: number;
  text: string;
  kind: KindHint;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, text, kind } = e.data;
  try {
    const core = await loadKicadCore();
    const result = core.parse(text, kind);
    (self as unknown as Worker).postMessage({ id, ok: true, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
