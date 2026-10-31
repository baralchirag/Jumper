// Worker thread: runs the WASM KiCad core off the main event loop.
import { parentPort } from 'node:worker_threads';
import { kicadCore } from '@pcbhub/kicad-core/node';

type Request =
  | { id: number; op: 'diff'; args: [string, string, string] }
  | { id: number; op: 'conflicts'; args: [string, string, string, string] }
  | { id: number; op: 'bom'; args: [string[]] }
  | { id: number; op: 'bomDiff'; args: [string[], string[]] };

const core = kicadCore();

parentPort!.on('message', (msg: Request) => {
  try {
    let result: unknown;
    switch (msg.op) {
      case 'diff':
        result = core.diff(msg.args[0], msg.args[1], msg.args[2] as 'pcb' | 'sch' | 'auto');
        break;
      case 'conflicts':
        result = core.conflicts(msg.args[0], msg.args[1], msg.args[2], msg.args[3] as 'pcb' | 'sch' | 'auto');
        break;
      case 'bom':
        result = core.bom(msg.args[0]);
        break;
      case 'bomDiff':
        result = core.bomDiff(msg.args[0], msg.args[1]);
        break;
    }
    parentPort!.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
