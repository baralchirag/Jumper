// What version is running, whether the database matches it, and (unless switched off) whether a newer one exists.
// The update check is a single GET of a small JSON document; nothing about this instance is sent with it.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { sql } from '@jumper/db';
import { migrationsFolder } from '@jumper/db';
import type { VersionInfo } from '@jumper/shared';
import type { Ctx } from '../../context';
import { getSetting, setSetting } from './settings';

/** Bumped with each release; `scripts/release` keeps it in step with the git tag. */
export const VERSION = '0.5.0';

const latestSchema = z.object({ version: z.string().max(40), url: z.string().max(500).nullable(), notes: z.string().max(4000).nullable(), checkedAt: z.string() });

/** Compare dotted versions numerically; a pre-release suffix sorts before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function expectedMigrations(): number {
  try {
    const journal = JSON.parse(readFileSync(`${migrationsFolder()}/meta/_journal.json`, 'utf8')) as { entries: unknown[] };
    return journal.entries.length;
  } catch {
    return 0;
  }
}

async function appliedMigrations(ctx: Ctx): Promise<number> {
  try {
    const rows = (await ctx.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as { n: number }[];
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

export function updateCheckState(ctx: Ctx): VersionInfo['updateCheck'] {
  if (ctx.env.AIR_GAPPED) return 'air_gapped';
  // There is no built-in address to ask: the check only runs against a URL the operator has set.
  return ctx.env.UPDATE_CHECK && ctx.env.UPDATE_CHECK_URL ? 'on' : 'disabled';
}

/** Scheduled daily. Never throws: an unreachable update server is not an error worth a retry. */
export async function checkForUpdate(ctx: Ctx, fetcher: typeof fetch = fetch): Promise<{ checked: boolean; latest?: string }> {
  if (updateCheckState(ctx) !== 'on') return { checked: false };
  try {
    const res = await fetcher(ctx.env.UPDATE_CHECK_URL!, { headers: { accept: 'application/json', 'user-agent': 'jumper-update-check' }, signal: AbortSignal.timeout(10_000), redirect: 'follow' });
    if (!res.ok) return { checked: false };
    const body = z.object({ version: z.string().max(40), url: z.string().max(500).optional(), notes: z.string().optional() }).safeParse(await res.json());
    if (!body.success) return { checked: false };
    await setSetting(ctx, 'latest_version', { version: body.data.version.replace(/^v/, ''), url: body.data.url ?? null, notes: body.data.notes?.slice(0, 4000) ?? null, checkedAt: new Date().toISOString() });
    return { checked: true, latest: body.data.version };
  } catch {
    return { checked: false };
  }
}

export async function versionInfo(ctx: Ctx): Promise<VersionInfo> {
  const state = updateCheckState(ctx);
  const latest = state === 'on' ? await getSetting(ctx, 'latest_version', latestSchema.nullable(), null) : null;
  return {
    version: VERSION,
    migrations: { applied: await appliedMigrations(ctx), expected: expectedMigrations() },
    latest,
    updateAvailable: latest ? compareVersions(latest.version, VERSION) > 0 : false,
    updateCheck: state,
    airGapped: ctx.env.AIR_GAPPED,
    node: process.version,
  };
}
