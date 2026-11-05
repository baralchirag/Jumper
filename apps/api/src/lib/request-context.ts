// Facts about the request being served, readable from anywhere below the route handler without threading them through
// every call. Access rules use it for the caller's address and how they signed in; outside a request (scheduled jobs,
// the SSH server unless it sets one) the store is empty and those rules are skipped.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestFacts {
  ip: string | null;
  method: 'session' | 'token' | 'basic' | 'ssh' | null;
  /** When the session was started, for organizations that limit session age. */
  sessionCreatedAt: Date | null;
  /** Single sign-on connection the session came through. */
  ssoConnectionId: string | null;
  /** Per-request memo for lookups repeated across many repositories (policies, memberships). */
  cache: Map<string, unknown>;
}

export const requestContext = new AsyncLocalStorage<RequestFacts>();

export function emptyFacts(over: Partial<RequestFacts> = {}): RequestFacts {
  return { ip: null, method: null, sessionCreatedAt: null, ssoConnectionId: null, cache: new Map(), ...over };
}

export const currentRequest = (): RequestFacts | undefined => requestContext.getStore();

/** Memoise `fn` for the rest of the request; outside a request it simply runs. */
export async function perRequest<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const store = requestContext.getStore();
  if (!store) return fn();
  if (store.cache.has(key)) return store.cache.get(key) as T;
  const p = fn();
  store.cache.set(key, p);
  return p;
}
