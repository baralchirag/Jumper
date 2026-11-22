// Per-account throttling of failed sign-ins and two-factor codes.
//
// The route rate limits are per IP address and switch off if Redis is unreachable, so on their own they stop neither
// a guessing attack spread across many addresses nor a two-factor brute force after a leaked password. This guard
// counts failures per account (keyed by what was typed, so unknown accounts behave exactly like real ones) in Redis,
// and falls back to process memory when Redis is unavailable, so it never fails open.
import type { Ctx } from '../../context';
import { HttpError } from '../../lib/errors';

/** Failures allowed before waiting kicks in, and the longest wait. */
const FREE_ATTEMPTS = 5;
const MAX_LOCK_S = 15 * 60;
/** Failures are forgotten after this long without another one. */
const WINDOW_S = 60 * 60;

const memory = new Map<string, { n: number; until: number; seen: number }>();

function lockSeconds(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  // 30 s after the 5th failure, doubling each time, at most 15 minutes.
  return Math.min(MAX_LOCK_S, 30 * 2 ** (failures - FREE_ATTEMPTS));
}

const redisKey = (key: string) => `jumper-guard:${key}`;
// The rate-limit connection has no offline queue, so a Redis outage fails fast into the in-memory fallback.

async function read(ctx: Ctx, key: string): Promise<{ n: number; until: number }> {
  try {
    const v = await ctx.rateLimitRedis.hgetall(redisKey(key));
    if (v && v.n) return { n: Number(v.n), until: Number(v.until ?? 0) };
    return { n: 0, until: 0 };
  } catch {
    const m = memory.get(key);
    if (!m || Date.now() - m.seen > WINDOW_S * 1000) return { n: 0, until: 0 };
    return m;
  }
}

/** Throws 429 while the account is locked out. Call before checking the password or code. */
export async function assertNotLocked(ctx: Ctx, key: string): Promise<void> {
  const { until } = await read(ctx, key);
  const wait = Math.ceil((until - Date.now()) / 1000);
  if (wait > 0) {
    const mins = Math.ceil(wait / 60);
    throw new HttpError(429, 'too_many_attempts', `Too many failed attempts. Try again in ${wait < 60 ? `${wait} seconds` : `${mins} minute${mins === 1 ? '' : 's'}`}, or reset your password.`);
  }
}

/** Record a failure; from the fifth one on, the account has to wait before the next try. */
export async function recordFailure(ctx: Ctx, key: string): Promise<void> {
  try {
    const k = redisKey(key);
    const n = await ctx.rateLimitRedis.hincrby(k, 'n', 1);
    const lock = lockSeconds(n);
    if (lock) await ctx.rateLimitRedis.hset(k, 'until', String(Date.now() + lock * 1000));
    await ctx.rateLimitRedis.expire(k, WINDOW_S);
  } catch {
    const m = memory.get(key);
    const fresh = !m || Date.now() - m.seen > WINDOW_S * 1000;
    const n = fresh ? 1 : m!.n + 1;
    const lock = lockSeconds(n);
    memory.set(key, { n, until: lock ? Date.now() + lock * 1000 : 0, seen: Date.now() });
    if (memory.size > 50_000) memory.delete(memory.keys().next().value!);
  }
}

export async function clearFailures(ctx: Ctx, key: string): Promise<void> {
  memory.delete(key);
  await ctx.rateLimitRedis.del(redisKey(key)).catch(() => {});
}

export const loginKey = (login: string) => `login:${login.trim().toLowerCase()}`;
export const twoFactorKey = (userId: string) => `2fa:${userId}`;
export const accountKey = (userId: string) => `account:${userId}`;

/** Tests only: forget in-memory failures (the fallback used when Redis is unavailable). */
export function resetGuardMemory(): void {
  memory.clear();
}
