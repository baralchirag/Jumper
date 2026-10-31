import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { BomChange, BomLine, Conflict, DiffResult, KindHint } from '@pcbhub/kicad-core/types';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const TIMEOUT_MS = 60_000;

/** Small pool of worker threads running the KiCad WASM core. */
export class KicadPool {
  private workers: { worker: Worker; busy: number }[] = [];
  private pending = new Map<number, Pending>();
  private seq = 0;

  constructor(size = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))) {
    for (let i = 0; i < size; i++) this.spawn();
  }

  private spawn(): void {
    // In dev (tsx) the source is .ts; after bundling it is emitted as .js next to index.js.
    const isTs = import.meta.url.endsWith('.ts');
    const url = new URL(isTs ? './kicad-thread.ts' : './kicad-thread.js', import.meta.url);
    // Source workers need the tsx loader (inherited under `tsx`, explicit under vitest).
    const hasLoader = process.execArgv.some((a) => a.includes('tsx'));
    const worker = new Worker(url, isTs && !hasLoader ? { execArgv: [...process.execArgv, '--import', 'tsx'] } : {});
    const slot = { worker, busy: 0 };
    worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      slot.busy--;
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });
    worker.on('error', () => this.replace(slot));
    worker.on('exit', () => this.replace(slot));
    worker.unref();
    this.workers.push(slot);
  }

  private replace(slot: { worker: Worker; busy: number }): void {
    const i = this.workers.indexOf(slot);
    if (i === -1) return;
    this.workers.splice(i, 1);
    this.spawn();
  }

  private call<T>(op: string, args: unknown[]): Promise<T> {
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
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      slot.worker.postMessage({ id, op, args });
    });
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
