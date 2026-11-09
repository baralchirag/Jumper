// Scheduled stock and end-of-life alerts. For repositories that switch them on, the BOM on the default branch is priced
// against the suppliers once a day; parts that have run out, cannot cover a build, or are being discontinued raise an
// alert. A problem that is still there on the next check does not alert again, and one that has gone is resolved.
import { and, bomAlerts, bomWatches, eq, isNull, lt, namespaces, or, repositories, sql, type BomAlert, type Namespace, type Repository } from '@jumper/db';
import { SUPPLIERS, type BomAlertInfo, type BomAlertKind, type BomWatchInfo, type Lifecycle, type PricedLine, type Supplier } from '@jumper/shared';
import type { Ctx } from '../../context';
import { priceBom } from '../bom/pricing';
import { collectSheets } from '../code/semantic';
import { followers, notify } from '../notifications/service';
import { gitFor } from '../repos/access';

export interface Finding {
  key: string;
  kind: BomAlertKind;
  references: string[];
  value: string;
  mpn: string | null;
  detail: string;
  supplier: Supplier | null;
  lifecycle: Lifecycle | null;
}

const LIFECYCLE_TEXT: Record<Lifecycle, string> = { active: 'active', nrnd: 'not recommended for new designs', eol: 'end of life (last-time buy)', obsolete: 'obsolete' };
const RANK: Record<Lifecycle, number> = { active: 0, nrnd: 1, eol: 2, obsolete: 3 };

/** What is wrong with each priced BOM line, if anything. Pure: the suppliers have already been asked. */
export function findProblems(lines: PricedLine[], project = ''): Finding[] {
  const out: Finding[] = [];
  for (const l of lines) {
    if (l.dnp || l.skipped) continue;
    const offers = SUPPLIERS.map((s) => l.offers[s]).filter((o) => o !== undefined);
    const named = l.query.sku ?? l.query.mpn;
    const id = (named ?? `${l.value}|${l.footprint}`).toLowerCase();
    const base = { references: l.references, value: l.value, mpn: l.query.mpn ?? offers[0]?.mpn ?? null };
    const add = (kind: BomAlertKind, detail: string, supplier: Supplier | null = null, lifecycle: Lifecycle | null = null) => out.push({ key: `${kind}:${project}:${id}`, kind, ...base, detail, supplier, lifecycle });

    if (!offers.length) {
      // A generic "10k 0603" that no search matched is noise; a named part nobody lists is worth knowing about.
      if (named) add('not_found', `No supplier lists ${named}`);
      continue;
    }
    // Lifecycle is only trusted when the supplier matched the exact part, not a look-alike found by description.
    const worst = offers.filter((o) => o.match !== 'parametric' && o.lifecycle && RANK[o.lifecycle] > 0).sort((a, b) => RANK[b.lifecycle!] - RANK[a.lifecycle!])[0];
    if (worst) add('eol', `${worst.supplier} lists ${worst.mpn || base.value} as ${LIFECYCLE_TEXT[worst.lifecycle!]}`, worst.supplier, worst.lifecycle!);

    if (offers.every((o) => o.stock <= 0)) add('out_of_stock', `0 in stock at ${offers.map((o) => o.supplier).join(', ')}`);
    else if (!offers.some((o) => o.inStock)) {
      const most = offers.reduce((a, b) => (b.stock > a.stock ? b : a));
      add('low_stock', `${l.needed} needed, ${most.stock} in stock at ${most.supplier}`, most.supplier);
    }
  }
  return out;
}

export function alertsAvailable(ctx: Ctx): boolean {
  return ctx.env.PRICING_ENABLED && ctx.env.STOCK_ALERTS_ENABLED && !ctx.env.AIR_GAPPED;
}

const toInfo = (a: BomAlert): BomAlertInfo => ({
  id: a.id,
  kind: a.kind as BomAlertKind,
  references: a.references,
  value: a.value,
  mpn: a.mpn,
  detail: a.detail,
  supplier: a.supplier as Supplier | null,
  lifecycle: a.lifecycle as Lifecycle | null,
  project: a.project,
  sha: a.sha,
  firstSeenAt: a.firstSeenAt.toISOString(),
  resolvedAt: a.resolvedAt?.toISOString() ?? null,
});

export async function watchInfo(ctx: Ctx, repoId: string): Promise<BomWatchInfo> {
  const watch = (await ctx.db.select().from(bomWatches).where(eq(bomWatches.repoId, repoId)).limit(1))[0];
  const alerts = await ctx.db.select().from(bomAlerts).where(and(eq(bomAlerts.repoId, repoId), isNull(bomAlerts.resolvedAt))).orderBy(bomAlerts.kind, bomAlerts.firstSeenAt);
  return { enabled: watch?.enabled ?? false, boards: watch?.boards ?? 10, lastCheckedAt: watch?.lastCheckedAt?.toISOString() ?? null, lastError: watch?.lastError ?? null, available: alertsAvailable(ctx), alerts: alerts.map(toInfo) };
}

const KIND_TITLE: Record<BomAlertKind, string> = { out_of_stock: 'out of stock', low_stock: 'short on stock', eol: 'being discontinued', not_found: 'not found at any supplier' };

/** Price the default branch's BOM and reconcile the alerts. Returns how many new problems were found. */
export async function checkRepoStock(ctx: Ctx, repo: Repository, ns: Namespace, price: typeof priceBom = priceBom): Promise<{ found: number; opened: number; resolved: number }> {
  const watch = (await ctx.db.select().from(bomWatches).where(eq(bomWatches.repoId, repo.id)).limit(1))[0];
  const boards = watch?.boards ?? 10;
  const git = gitFor(ctx, repo.id);
  const fail = async (message: string) => {
    await ctx.db.update(bomWatches).set({ lastCheckedAt: new Date(), lastError: message }).where(eq(bomWatches.repoId, repo.id));
    return { found: 0, opened: 0, resolved: 0 };
  };
  const sha = await git.resolveBranch(repo.defaultBranch);
  if (!sha) return fail('The repository has no commits on its default branch yet.');
  const files = await git.lsFiles(sha);
  const roots = files.filter((f) => f.endsWith('.kicad_pro')).map((f) => f.replace(/\.kicad_pro$/, '.kicad_sch')).filter((f) => files.includes(f)).slice(0, 8);
  if (!roots.length) return fail('No KiCad project with a schematic was found on the default branch.');

  const findings: Finding[] = [];
  const errors: string[] = [];
  const config = { mouserApiKey: ctx.env.MOUSER_API_KEY, digikeyClientId: ctx.env.DIGIKEY_CLIENT_ID, digikeyClientSecret: ctx.env.DIGIKEY_CLIENT_SECRET };
  for (const root of roots) {
    try {
      const lines = await ctx.kicad.bom(await collectSheets(ctx, git, sha, root));
      const priced = await price(lines, boards, { redis: ctx.redis, config });
      // When no supplier answered at all, say so instead of reporting every part as missing.
      const answered = priced.suppliers.some((s) => s.enabled && !s.error);
      if (!answered) errors.push(`${root}: the suppliers could not be reached`);
      else findings.push(...findProblems(priced.lines, roots.length > 1 ? root : ''));
    } catch (e) {
      errors.push(`${root}: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  if (errors.length === roots.length) return fail(errors.join('; '));

  const open = await ctx.db.select().from(bomAlerts).where(and(eq(bomAlerts.repoId, repo.id), isNull(bomAlerts.resolvedAt)));
  const openKeys = new Set(open.map((a) => a.key));
  const foundKeys = new Set(findings.map((f) => f.key));
  const fresh = findings.filter((f, i) => !openKeys.has(f.key) && findings.findIndex((x) => x.key === f.key) === i);
  const now = new Date();
  if (fresh.length) {
    await ctx.db
      .insert(bomAlerts)
      .values(fresh.map((f) => ({ repoId: repo.id, key: f.key, kind: f.kind, project: f.key.split(':')[1] ?? '', sha, references: f.references, value: f.value, mpn: f.mpn, detail: f.detail, supplier: f.supplier, lifecycle: f.lifecycle })))
      .onConflictDoNothing();
  }
  const still = open.filter((a) => foundKeys.has(a.key));
  if (still.length) await ctx.db.update(bomAlerts).set({ lastSeenAt: now, sha }).where(and(eq(bomAlerts.repoId, repo.id), isNull(bomAlerts.resolvedAt), sql`${bomAlerts.key} in (${sql.join(still.map((a) => sql`${a.key}`), sql`, `)})`));
  // Only resolve what a project that was actually priced no longer reports.
  const gone = errors.length ? [] : open.filter((a) => !foundKeys.has(a.key));
  if (gone.length) await ctx.db.update(bomAlerts).set({ resolvedAt: now }).where(and(eq(bomAlerts.repoId, repo.id), isNull(bomAlerts.resolvedAt), sql`${bomAlerts.key} in (${sql.join(gone.map((a) => sql`${a.key}`), sql`, `)})`));
  await ctx.db.update(bomWatches).set({ lastCheckedAt: now, lastError: errors.length ? errors.join('; ') : null }).where(eq(bomWatches.repoId, repo.id));

  if (fresh.length) {
    const first = fresh[0]!;
    const title = fresh.length === 1 ? `${first.references.slice(0, 3).join(', ')} (${first.mpn ?? first.value}) is ${KIND_TITLE[first.kind]} in ${repo.name}` : `${fresh.length} parts in ${repo.name} need attention: ${[...new Set(fresh.map((f) => KIND_TITLE[f.kind]))].join(', ')}`;
    const recipients = [...new Set([...(watch?.createdBy ? [watch.createdBy] : []), ...(await followers(ctx, repo.id))])];
    await notify(ctx, { repo, ns, actorId: null, kind: 'stock', title, url: `/${ns.slug}/${repo.name}/bom-alerts`, recipients }).catch(() => 0);
  }
  return { found: findings.length, opened: fresh.length, resolved: gone.length };
}

/** Scheduled: check watched repositories that have not been checked in the last day, a few per run. */
export async function checkDueStock(ctx: Ctx, now = new Date(), limit = 10): Promise<{ checked: number; opened: number }> {
  if (!alertsAvailable(ctx)) return { checked: 0, opened: 0 };
  const due = await ctx.db
    .select({ repo: repositories, ns: namespaces })
    .from(bomWatches)
    .innerJoin(repositories, eq(repositories.id, bomWatches.repoId))
    .innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId))
    .where(and(eq(bomWatches.enabled, true), or(isNull(bomWatches.lastCheckedAt), lt(bomWatches.lastCheckedAt, new Date(now.getTime() - 23 * 3600_000)))))
    .orderBy(sql`${bomWatches.lastCheckedAt} asc nulls first`)
    .limit(limit);
  let opened = 0;
  for (const { repo, ns } of due) opened += (await checkRepoStock(ctx, repo, ns).catch(() => ({ opened: 0 }))).opened;
  return { checked: due.length, opened };
}
