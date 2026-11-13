// Licence keys for self-hosted instances and the entitlement check every paid feature goes through.
//
// A key is `JMP1.<payload>.<signature>`: base64url JSON signed with Ed25519. Verification needs only the public key
// below, so it works with no network. The key names the host it may run on, the number of active accounts and an
// expiry date; fourteen days after expiry the paid features switch off (nothing is deleted).
import { createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { eq, instanceSettings, sql, users, type Namespace } from '@jumper/db';
import { BUSINESS_FEATURES, FEATURES, FEATURE_LABELS, isPlanId, planFeatures, type Entitlements, type Feature, type LicensePayload, type LicenseStatus } from '@jumper/shared';
import type { Ctx } from '../../context';
import { HttpError } from '../../lib/errors';

/** Public half of the key Jumper licences are signed with (the private half never ships). */
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA8ZkDZ6IUdJlaSVmzolZ9RtQIhBMFP7AvZsU8jhwiJK8=
-----END PUBLIC KEY-----`;

export const LICENSE_PREFIX = 'JMP1';
export const GRACE_DAYS = 14;
const DAY = 24 * 3600 * 1000;

export function parseLicense(key: string, publicKeyPem: string = PUBLIC_KEY): LicensePayload | null {
  const [prefix, body, sig] = key.trim().split('.');
  if (prefix !== LICENSE_PREFIX || !body || !sig) return null;
  try {
    const ok = verify(null, Buffer.from(body), createPublicKey(publicKeyPem), Buffer.from(sig, 'base64url'));
    if (!ok) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LicensePayload;
    if (typeof p.domain !== 'string' || typeof p.seats !== 'number' || !Number.isFinite(Date.parse(p.expires)) || (p.tier !== 'business' && p.tier !== 'enterprise')) return null;
    return p;
  } catch {
    return null;
  }
}

/** `example.com` matches itself; `*.example.com` also matches any sub-domain. */
export function domainMatches(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = host.trim().toLowerCase();
  if (p === h) return true;
  return p.startsWith('*.') && (h === p.slice(2) || h.endsWith(p.slice(1)));
}

export function licenseFeatures(p: LicensePayload): Feature[] {
  const base: Feature[] = p.tier === 'enterprise' ? [...FEATURES] : [...BUSINESS_FEATURES];
  return [...new Set([...base, ...(p.features ?? []).filter((f) => (FEATURES as readonly string[]).includes(f))])];
}

/** Judge a key without touching the database. */
export function evaluateLicense(key: string | null, host: string, seatsUsed: number, now = new Date(), publicKeyPem?: string): LicenseStatus {
  if (!key) return { state: 'missing', message: 'No licence key is installed.', license: null, seatsUsed, daysLeft: null, features: [] };
  const license = parseLicense(key, publicKeyPem);
  if (!license) return { state: 'invalid', message: 'The licence key is not valid: it was not issued for Jumper, or it has been altered.', license: null, seatsUsed, daysLeft: null, features: [] };
  const daysLeft = Math.ceil((Date.parse(license.expires) - now.getTime()) / DAY);
  if (!domainMatches(license.domain, host)) {
    return { state: 'wrong_domain', message: `This licence is for ${license.domain}, but the instance is served from ${host}.`, license, seatsUsed, daysLeft, features: [] };
  }
  if (daysLeft <= -GRACE_DAYS) return { state: 'expired', message: `The licence expired on ${license.expires.slice(0, 10)}. Paid features are off until a new key is installed.`, license, seatsUsed, daysLeft, features: [] };
  const features = licenseFeatures(license);
  if (daysLeft <= 0) {
    return { state: 'grace', message: `The licence expired on ${license.expires.slice(0, 10)}. Paid features switch off in ${GRACE_DAYS + daysLeft} day(s).`, license, seatsUsed, daysLeft, features };
  }
  const over = seatsUsed > license.seats ? ` ${seatsUsed} accounts are active but the licence covers ${license.seats}: new accounts cannot be created.` : '';
  return { state: 'valid', message: `Licensed to ${license.licensee} until ${license.expires.slice(0, 10)}.${over}`, license, seatsUsed, daysLeft, features };
}

const SETTING = 'license';
let cache: { at: number; status: LicenseStatus; ctx: Ctx } | null = null;

export function clearLicenseCache(): void {
  cache = null;
}

/** The key in force: LICENSE_KEY, then LICENSE_FILE, then the one pasted in Admin. */
export async function installedKey(ctx: Ctx): Promise<{ key: string | null; source: 'env' | 'file' | 'admin' | null }> {
  if (ctx.env.LICENSE_KEY) return { key: ctx.env.LICENSE_KEY, source: 'env' };
  if (existsSync(ctx.env.licenseFile)) {
    const key = readFileSync(ctx.env.licenseFile, 'utf8').trim();
    if (key) return { key, source: 'file' };
  }
  const row = (await ctx.db.select().from(instanceSettings).where(eq(instanceSettings.key, SETTING)).limit(1))[0];
  const key = typeof row?.value === 'string' ? row.value : null;
  return { key, source: key ? 'admin' : null };
}

export async function activeAccounts(ctx: Ctx): Promise<number> {
  const [r] = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.disabled, false))) as [{ n: number }];
  return r.n;
}

export async function licenseStatus(ctx: Ctx, fresh = false): Promise<LicenseStatus> {
  if (!fresh && cache && cache.ctx === ctx && Date.now() - cache.at < 60_000) return cache.status;
  const [{ key }, seats] = await Promise.all([installedKey(ctx), activeAccounts(ctx)]);
  const testKey = ctx.env.NODE_ENV !== 'production' ? ctx.env.LICENSE_PUBLIC_KEY : undefined;
  const status = evaluateLicense(key, new URL(ctx.env.PUBLIC_URL).hostname, seats, new Date(), testKey);
  cache = { at: Date.now(), status, ctx };
  return status;
}

export async function saveLicense(ctx: Ctx, key: string | null): Promise<void> {
  if (key === null) await ctx.db.delete(instanceSettings).where(eq(instanceSettings.key, SETTING));
  else await ctx.db.insert(instanceSettings).values({ key: SETTING, value: key }).onConflictDoUpdate({ target: instanceSettings.key, set: { value: key, updatedAt: new Date() } });
  clearLicenseCache();
}

/**
 * What an owner may use. On a hosted instance that enforces plans this follows the owner's plan; on a self-hosted one
 * it follows the licence. `ns` is null for instance-wide features (SCIM, retention, legal hold), which on a hosted
 * instance belong to the operator.
 */
export async function entitlementsFor(ctx: Ctx, ns: Pick<Namespace, 'plan'> | null): Promise<Entitlements> {
  if (ctx.env.PLANS_ENFORCED) {
    if (!ns) return { source: 'plan', features: [...FEATURES], reason: null };
    const plan = isPlanId(ns.plan) ? ns.plan : 'free';
    const features = planFeatures(plan);
    return { source: 'plan', features, reason: features.length === FEATURES.length ? null : `The ${ctx.env.plans[plan].name} plan does not include this.` };
  }
  const status = await licenseStatus(ctx);
  if (status.features.length) return { source: 'license', features: status.features, reason: status.state === 'grace' ? status.message : null };
  if (!ctx.env.licenseEnforced) return { source: 'development', features: [...FEATURES], reason: null };
  return { source: 'none', features: [], reason: status.state === 'missing' ? 'This needs a Jumper licence. Install a key in Admin, Licence.' : status.message };
}

export async function hasFeature(ctx: Ctx, ns: Pick<Namespace, 'plan'> | null, feature: Feature): Promise<boolean> {
  return (await entitlementsFor(ctx, ns)).features.includes(feature);
}

/** 402 with a message the interface shows as an upgrade notice. */
export async function requireFeature(ctx: Ctx, ns: Pick<Namespace, 'plan'> | null, feature: Feature): Promise<void> {
  const e = await entitlementsFor(ctx, ns);
  if (e.features.includes(feature)) return;
  const needs = (BUSINESS_FEATURES as readonly string[]).includes(feature) ? 'Business' : 'Enterprise';
  throw new HttpError(402, 'feature_unavailable', `${FEATURE_LABELS[feature]} is part of ${needs}. ${e.reason ?? ''}`.trim(), { feature, needs: needs.toLowerCase(), source: e.source });
}

/** Refuse a new account when the licence's seats are used up. Only applies to licensed self-hosted instances. */
export async function assertLicenseSeat(ctx: Ctx): Promise<void> {
  if (ctx.env.PLANS_ENFORCED) return;
  const status = await licenseStatus(ctx, true);
  if (!status.license || status.state === 'invalid' || status.state === 'wrong_domain') return;
  if (status.seatsUsed >= status.license.seats) {
    throw new HttpError(403, 'license_seats', `All ${status.license.seats} accounts on this instance's licence are in use. Ask an administrator to disable an account or extend the licence.`, { seats: status.license.seats, used: status.seatsUsed });
  }
}
