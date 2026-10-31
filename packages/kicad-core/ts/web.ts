// Browser binding (ES module output of `wasm-pack --target web`).
// Intended to run inside a Web Worker so parsing never blocks the UI.
import init, * as raw from '../pkg-web/kicad_core.js';
import { wrapBindings, type KicadCore, type RawBindings } from './types';

export * from './types';

let ready: Promise<KicadCore> | null = null;

export function loadKicadCore(): Promise<KicadCore> {
  ready ??= init().then(() => wrapBindings(raw as unknown as RawBindings));
  return ready;
}
