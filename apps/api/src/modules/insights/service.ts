// Team insights: how quickly pull requests are reviewed and merged, which checks fail, who reviews, and what is waiting.
// Covers the repositories of one owner that the caller can read, over the last N weeks (weeks start on Monday, UTC).
import { and, checkRuns, eq, gte, inArray, namespaces, pullRequests, repositories, reviews, users, type Namespace, type User } from '@jumper/db';
import type { InsightsReport } from '@jumper/shared';
import type { Ctx } from '../../context';
import { accessesFor } from '../repos/access';
import { toUserSummary } from '../repos/serialize';

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Monday 00:00 UTC of the week holding `d`. */
export function weekStart(d: Date): Date {
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  return new Date(t - dow * DAY);
}

/** The Mondays starting each of the last `n` weeks, oldest first; the current week is the last. */
export function weekStarts(now: Date, n: number): Date[] {
  const last = weekStart(now).getTime();
  return Array.from({ length: n }, (_, i) => new Date(last - (n - 1 - i) * WEEK));
}

/** Index of the week holding `d`, or -1 when it falls outside. */
export function bucketOf(weeks: Date[], d: Date): number {
  const first = weeks[0]!.getTime();
  const i = Math.floor((d.getTime() - first) / WEEK);
  return i >= 0 && i < weeks.length ? i : -1;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  const v = s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  return Math.round(v * 10) / 10;
}

const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

export async function buildInsights(ctx: Ctx, viewer: User, ns: Namespace, nWeeks: number, now = new Date()): Promise<InsightsReport> {
  const weeks = weekStarts(now, nWeeks);
  const since = weeks[0]!;
  const empty = (): number[] => weeks.map(() => 0);

  const all = await ctx.db.select({ repo: repositories, ns: namespaces }).from(repositories).innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId)).where(eq(repositories.namespaceId, ns.id));
  const access = await accessesFor(ctx, viewer, all);
  const repos = all.filter((_, i) => access[i]!.permission !== 'none').map((r) => r.repo);
  const repoName = new Map(repos.map((r) => [r.id, r.name]));
  const report: InsightsReport = {
    owner: ns.slug,
    weeks: weeks.map((w) => w.toISOString().slice(0, 10)),
    pulls: { opened: empty(), merged: empty(), hoursToFirstReview: weeks.map(() => null), hoursToMerge: weeks.map(() => null), medianHoursToFirstReview: null, medianHoursToMerge: null },
    open: [],
    checks: { series: [], worst: [], failureRate: null },
    reviewers: [],
  };
  if (!repos.length) return report;
  const repoIds = repos.map((r) => r.id);

  // Pull requests touched in the period, plus every one still open (however old) for the waiting list.
  const prs = await ctx.db.select({ pr: pullRequests, author: users }).from(pullRequests).innerJoin(users, eq(users.id, pullRequests.authorId)).where(inArray(pullRequests.repoId, repoIds));
  const relevant = prs.filter(({ pr }) => pr.state === 'open' || pr.createdAt >= since || (pr.mergedAt && pr.mergedAt >= since));
  const prIds = relevant.map(({ pr }) => pr.id);
  const revs = prIds.length
    ? await ctx.db.select({ r: reviews, author: users }).from(reviews).innerJoin(users, eq(users.id, reviews.authorId)).where(inArray(reviews.pullId, prIds))
    : [];
  const byPull = new Map<string, typeof revs>();
  for (const x of revs) byPull.set(x.r.pullId, [...(byPull.get(x.r.pullId) ?? []), x]);

  const toReview: number[][] = weeks.map(() => []);
  const toMerge: number[][] = weeks.map(() => []);
  for (const { pr, author } of relevant) {
    // A review by the author of the pull request does not count as a first review.
    const others = (byPull.get(pr.id) ?? []).filter((x) => x.r.authorId !== pr.authorId).sort((a, b) => a.r.createdAt.getTime() - b.r.createdAt.getTime());
    const opened = bucketOf(weeks, pr.createdAt);
    if (opened >= 0) {
      report.pulls.opened[opened]!++;
      if (others[0]) toReview[opened]!.push(hours(pr.createdAt, others[0].r.createdAt));
    }
    if (pr.state === 'merged' && pr.mergedAt) {
      const merged = bucketOf(weeks, pr.mergedAt);
      if (merged >= 0) {
        report.pulls.merged[merged]!++;
        toMerge[merged]!.push(hours(pr.createdAt, pr.mergedAt));
      }
    }
    if (pr.state === 'open') {
      report.open.push({
        repo: repoName.get(pr.repoId)!,
        number: pr.number,
        title: pr.title,
        author: toUserSummary(author),
        ageDays: Math.floor((now.getTime() - pr.createdAt.getTime()) / DAY),
        approvals: new Set(others.filter((x) => x.r.state === 'approved').map((x) => x.r.authorId)).size,
        draft: pr.draft,
        waitingForReview: !pr.draft && others.length === 0,
      });
    }
  }
  report.pulls.hoursToFirstReview = toReview.map(median);
  report.pulls.hoursToMerge = toMerge.map(median);
  report.pulls.medianHoursToFirstReview = median(toReview.flat());
  report.pulls.medianHoursToMerge = median(toMerge.flat());
  // Oldest first: what has waited longest needs attention first.
  report.open.sort((a, b) => b.ageDays - a.ageDays);
  report.open = report.open.slice(0, 25);

  // Reviewers: reviews written in the period on these repositories, not counting reviews of one's own work.
  const authorOf = new Map(relevant.map(({ pr }) => [pr.id, pr.authorId]));
  const people = new Map<string, InsightsReport['reviewers'][number]>();
  for (const { r, author } of revs) {
    if (r.createdAt < since || authorOf.get(r.pullId) === r.authorId) continue;
    const p = people.get(r.authorId) ?? { user: toUserSummary(author), reviews: 0, approvals: 0 };
    p.reviews++;
    if (r.state === 'approved') p.approvals++;
    people.set(r.authorId, p);
  }
  report.reviewers = [...people.values()].sort((a, b) => b.reviews - a.reviews).slice(0, 20);

  // Checks: completed runs in the period.
  const runs = await ctx.db
    .select({ repoId: checkRuns.repoId, name: checkRuns.name, conclusion: checkRuns.conclusion, completedAt: checkRuns.completedAt })
    .from(checkRuns)
    .where(and(inArray(checkRuns.repoId, repoIds), eq(checkRuns.status, 'completed'), gte(checkRuns.completedAt, since)));
  const series = new Map<string, { name: string; runs: number[]; failures: number[] }>();
  const perRepo = new Map<string, { failures: number; runs: number }>();
  let total = 0;
  let failed = 0;
  for (const run of runs) {
    if (!run.completedAt || run.conclusion === 'skipped' || run.conclusion === 'cancelled') continue;
    const w = bucketOf(weeks, run.completedAt);
    if (w < 0) continue;
    const bad = run.conclusion === 'failure' || run.conclusion === 'timed_out';
    const s = series.get(run.name) ?? { name: run.name, runs: empty(), failures: empty() };
    s.runs[w]!++;
    if (bad) s.failures[w]!++;
    series.set(run.name, s);
    const r = perRepo.get(run.repoId) ?? { failures: 0, runs: 0 };
    r.runs++;
    if (bad) r.failures++;
    perRepo.set(run.repoId, r);
    total++;
    if (bad) failed++;
  }
  report.checks.series = [...series.values()].sort((a, b) => a.name.localeCompare(b.name));
  report.checks.worst = [...perRepo.entries()]
    .filter(([, v]) => v.failures > 0)
    .map(([id, v]) => ({ repo: repoName.get(id)!, ...v }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 10);
  report.checks.failureRate = total ? Math.round((failed / total) * 1000) / 1000 : null;
  return report;
}
