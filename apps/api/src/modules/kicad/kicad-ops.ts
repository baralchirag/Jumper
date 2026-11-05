import type { KicadCore } from '@jumper/kicad-core/types';

export type KicadOp =
  | { op: 'diff'; args: [string, string, string] }
  | { op: 'conflicts'; args: [string, string, string, string] }
  | { op: 'parse'; args: [string, string] }
  | { op: 'bom'; args: [string[]] }
  | { op: 'bomDiff'; args: [string[], string[]] };

type Kind = 'pcb' | 'sch' | 'auto';

/** The single dispatch table shared by the worker thread and the in-process mode. */
export function runOp(core: KicadCore, msg: KicadOp): unknown {
  switch (msg.op) {
    case 'diff':
      return core.diff(msg.args[0], msg.args[1], msg.args[2] as Kind);
    case 'conflicts':
      return core.conflicts(msg.args[0], msg.args[1], msg.args[2], msg.args[3] as Kind);
    case 'parse':
      return core.parse(msg.args[0], msg.args[1] as Kind);
    case 'bom':
      return core.bom(msg.args[0]);
    case 'bomDiff':
      return core.bomDiff(msg.args[0], msg.args[1]);
  }
}
