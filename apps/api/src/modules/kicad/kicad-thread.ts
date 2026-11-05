// Worker thread: runs the WASM KiCad core off the main event loop.
import { parentPort } from 'node:worker_threads';
import { kicadCore } from '@jumper/kicad-core/node';
import { runOp, type KicadOp } from './kicad-ops';

const core = kicadCore();

parentPort!.on('message', (msg: KicadOp & { id: number }) => {
  try {
    parentPort!.postMessage({ id: msg.id, ok: true, result: runOp(core, msg) });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
