import type { DiffResult, KindHint, ParsedDesign } from '@jumper/kicad-core/types';
import { fetchRaw } from '../../shared/lib/api';

let worker: Worker | null = null;
let seq = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./kicad.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result!);
      else p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Parser crashed'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

export function parseDesign(text: string, kind: KindHint = 'auto'): Promise<ParsedDesign> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, text, kind });
  });
}

/** Semantic diff of two revisions of one KiCad file, computed in the browser (the same core the server uses). */
export function diffDesigns(before: string, after: string, kind: KindHint = 'auto'): Promise<DiffResult> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, op: 'diff', before, after, kind });
  });
}

// Small LRU of parsed designs keyed by owner/repo/sha/path (immutable for a sha).
const cache = new Map<string, Promise<ParsedDesign>>();
const MAX_CACHE = 12;

export function loadDesign(owner: string, repo: string, sha: string, path: string): Promise<ParsedDesign> {
  const key = `${owner}/${repo}@${sha}:${path}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const kind: KindHint = path.endsWith('.kicad_pcb') ? 'pcb' : path.endsWith('.kicad_sch') ? 'sch' : 'auto';
  const p = fetchRaw(owner, repo, sha, path).then((text) => parseDesign(text, kind));
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  return p;
}
