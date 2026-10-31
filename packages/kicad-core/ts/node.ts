// Node binding (CommonJS output of `wasm-pack --target nodejs`).
import { createRequire } from 'node:module';
import { wrapBindings, type KicadCore, type RawBindings } from './types';

export * from './types';

const require = createRequire(import.meta.url);

let instance: KicadCore | null = null;

export function kicadCore(): KicadCore {
  if (!instance) {
    // Resolved through the package name so it also works after bundling.
    const raw = require('@pcbhub/kicad-core/pkg-node/kicad_core.js') as RawBindings;
    instance = wrapBindings(raw);
  }
  return instance;
}
