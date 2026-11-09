import type { Redis } from 'ioredis';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) Jumper BOM pricing';

export class SupplierError extends Error {}

export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'user-agent': UA, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new SupplierError(`${new URL(url).host} responded ${res.status}`);
  return (await res.json()) as T;
}

/** Redis-backed cache; lookups proceed uncached when Redis is unavailable. */
export class PriceCache {
  constructor(
    private readonly redis: Redis | null,
    private readonly ttlSeconds = 12 * 3600,
  ) {}

  async wrap<T>(key: string, fn: () => Promise<T>, bypass = false): Promise<T> {
    const k = `pricing:v1:${key}`;
    if (this.redis && !bypass) {
      const hit = await this.redis.get(k).catch(() => null);
      if (hit) return JSON.parse(hit) as T;
    }
    const value = await fn();
    if (this.redis) await this.redis.set(k, JSON.stringify(value), 'EX', this.ttlSeconds).catch(() => {});
    return value;
  }
}

/** Run tasks with bounded concurrency. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
