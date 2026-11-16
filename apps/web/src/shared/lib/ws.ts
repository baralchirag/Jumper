import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PlatformEvent } from '@jumper/shared';
import { keys } from './queries';

type Listener = (e: PlatformEvent) => void;

let socket: WebSocket | null = null;
const topics = new Map<string, number>();
const listeners = new Set<Listener>();
let retry = 0;

function connect(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/api/ws`);
  socket.onopen = () => {
    retry = 0;
    for (const t of topics.keys()) socket!.send(JSON.stringify({ subscribe: t }));
  };
  socket.onmessage = (m) => {
    try {
      const ev = JSON.parse(m.data as string) as PlatformEvent;
      for (const l of listeners) l(ev);
    } catch {
      /* ignore malformed */
    }
  };
  socket.onclose = () => {
    socket = null;
    if (topics.size) setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
  };
}

function subscribe(topic: string): () => void {
  topics.set(topic, (topics.get(topic) ?? 0) + 1);
  if (socket?.readyState === WebSocket.OPEN && topics.get(topic) === 1) socket.send(JSON.stringify({ subscribe: topic }));
  connect();
  return () => {
    const n = (topics.get(topic) ?? 1) - 1;
    if (n <= 0) {
      topics.delete(topic);
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ unsubscribe: topic }));
    } else topics.set(topic, n);
  };
}

/** Live-refresh repository queries from server events. */
export function useRepoEvents(owner: string, repo: string, repoId: string | undefined): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!repoId) return;
    const unsubscribe = subscribe(`repo:${repoId}`);
    const base = keys.repo(owner, repo);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pendingKinds = new Set<string>();
    const flush = () => {
      timer = null;
      for (const kind of pendingKinds) {
        if (kind === 'check') {
          void qc.invalidateQueries({ queryKey: [...base, 'checks'] });
          void qc.invalidateQueries({ queryKey: [...base, 'artifacts'] });
          void qc.invalidateQueries({ queryKey: [...base, 'pull'] });
        } else {
          void qc.invalidateQueries({ queryKey: base });
        }
      }
      pendingKinds.clear();
    };
    const onEvent: Listener = (e) => {
      if (e.repoId !== repoId) return;
      pendingKinds.add(e.type);
      timer ??= setTimeout(flush, 400);
    };
    listeners.add(onEvent);
    return () => {
      listeners.delete(onEvent);
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [owner, repo, repoId, qc]);
}
