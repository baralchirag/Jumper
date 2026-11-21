import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { kicadCore } from '@jumper/kicad-core/node';
import type { BomChange, BomLine, Conflict, DiffResult, KindHint, ParsedDesign } from '@jumper/kicad-core/types';
import { runOp, type KicadOp } from './kicad-ops';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  slot: Slot;
}

interface Slot {
  worker: Worker;
  busy: number;
}

const TIMEOUT_MS = 60_000;

/** Small pool of worker threads running the KiCad WASM core. */
export class KicadPool {
  private workers: Slot[] = [];
  private pending = new Map<number, Pending>();
  private seq = 0;

  /** `inline` runs the core on the calling thread (tests, or hosts where worker threads cannot load TypeScript). */
  constructor(size = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))), private readonly inline = false) {
    if (!inline) for (let i = 0; i < size; i++) this.spawn();
  }

  private spawn(): void {
    // In dev (tsx) the source is .ts; after bundling it is emitted as .js next to index.js.
    const isTs = import.meta.url.endsWith('.ts');
    const url = new URL(isTs ? './kicad-thread.ts' : './kicad-thread.js', import.meta.url);
    // A worker does not reliably inherit tsx's resolver (extensionless imports fail inside it), so source workers
    // register tsx through its API before importing the thread module.
    const worker = isTs
      ? new Worker(`import(${JSON.stringify(import.meta.resolve('tsx/esm/api'))}).then((m) => { m.register(); return import(${JSON.stringify(url.href)}); })`, { eval: true })
      : new Worker(url);
    const slot: Slot = { worker, busy: 0 };
    worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      slot.busy--;
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });
    // A crashed worker fails its requests at once (with the reason) instead of leaving them to time out.
    worker.on('error', (e: unknown) => this.replace(slot, e instanceof Error ? e : new Error(String(e))));
    worker.on('exit', (code) => this.replace(slot, new Error(`kicad-core worker exited (${code})`)));
    worker.unref();
    this.workers.push(slot);
  }

  private replace(slot: Slot, reason: Error): void {
    for (const [id, p] of this.pending) {
      if (p.slot !== slot) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(`kicad-core failed: ${reason.message}`));
    }
    const i = this.workers.indexOf(slot);
    if (i === -1) return;
    this.workers.splice(i, 1);
    this.spawn();
  }

  private call<T>(op: string, args: unknown[]): Promise<T> {
    if (this.inline) {
      try {
        return Promise.resolve(runOp(kicadCore(), { op, args } as KicadOp) as T);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
    const slot = this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
    const id = ++this.seq;
    slot.busy++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        slot.busy--;
        reject(new Error('kicad-core timed out'));
        void slot.worker.terminate();
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, slot });
      slot.worker.postMessage({ id, op, args });
    });
  }

  parse(text: string, kind: KindHint = 'auto') {
    return this.call<ParsedDesign>('parse', [text, kind]);
  }
  diff(before: string, after: string, kind: KindHint = 'auto') {
    return this.call<DiffResult>('diff', [before, after, kind]);
  }
  conflicts(base: string, ours: string, theirs: string, kind: KindHint = 'auto') {
    return this.call<Conflict[]>('conflicts', [base, ours, theirs, kind]);
  }
  bom(sheets: string[]) {
    return this.call<BomLine[]>('bom', [sheets]);
  }
  bomDiff(before: string[], after: string[]) {
    return this.call<BomChange[]>('bomDiff', [before, after]);
  }

  async close(): Promise<void> {
    const ws = this.workers;
    this.workers = [];
    await Promise.all(ws.map((w) => w.worker.terminate()));
  }
}
