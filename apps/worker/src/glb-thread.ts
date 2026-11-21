import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { optimizeKicadGlb } from './glb';

/**
 * Runs optimizeKicadGlb on a worker thread. On a large board the simplify and meshopt passes keep the CPU busy for
 * minutes; on the main thread that starves BullMQ's lock renewal, the job is handed back and restarted forever.
 */
export function optimizeKicadGlbOffThread(input: Uint8Array): Promise<Uint8Array> {
  // This same file: built (dist/glb-thread.js), or from source under `tsx watch`, where the thread has to load tsx's
  // loader itself before it can import TypeScript.
  const fromSource = import.meta.url.endsWith('.ts');
  const self = new URL(fromSource ? './glb-thread.ts' : './glb-thread.js', import.meta.url);
  const boot = `import(${JSON.stringify(import.meta.resolve('tsx/esm/api'))}).then((t) => t.tsImport(${JSON.stringify(self.href)}, ${JSON.stringify(self.href)}))`;
  return new Promise((resolve, reject) => {
    const w = fromSource ? new Worker(boot, { eval: true, workerData: input }) : new Worker(self, { workerData: input });
    w.once('message', (m: { ok: true; out: Uint8Array } | { ok: false; error: string }) => (m.ok ? resolve(m.out) : reject(new Error(m.error))));
    w.once('error', reject);
    w.once('exit', (code) => code !== 0 && reject(new Error(`GLB thread exited with ${code}`)));
  });
}

if (!isMainThread && parentPort && workerData instanceof Uint8Array) {
  const port = parentPort;
  optimizeKicadGlb(workerData).then(
    (out) => port.postMessage({ ok: true, out }, [out.buffer as ArrayBuffer]),
    (e: unknown) => port.postMessage({ ok: false, error: (e as Error).message ?? String(e) }),
  );
}
