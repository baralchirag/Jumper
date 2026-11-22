// "Use once" markers for signed, bearer-style payloads (SAML responses): the first use claims the marker and any replay
// within `ttlS` is refused. Redis when available, process memory as a fallback, so a Redis outage never fails open.
import { createHash } from 'node:crypto';
import type { Ctx } from '../context';

const memory = new Map<string, number>();

/** True the first time `value` is seen within `ttlS` seconds, false for any replay. */
export async function claimOnce(ctx: Ctx, scope: string, value: string, ttlS: number): Promise<boolean> {
  const key = `jumper-once:${scope}:${createHash('sha256').update(value).digest('hex')}`;
  try {
    return (await ctx.rateLimitRedis.set(key, '1', 'EX', ttlS, 'NX')) === 'OK';
  } catch {
    const now = Date.now();
    for (const [k, exp] of memory) if (exp < now) memory.delete(k);
    if ((memory.get(key) ?? 0) > now) return false;
    memory.set(key, now + ttlS * 1000);
    return true;
  }
}
