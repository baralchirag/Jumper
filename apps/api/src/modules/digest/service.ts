// Weekly digest email: one message a week summarising the repositories a person owns, belongs to through an
// organization, collaborates on or follows. Nothing is sent when nothing happened. Runs hourly and works through
// whoever is due (last digest more than ~a week ago), a batch at a time, so a large instance spreads the load.
import {
  and,
  bomAlerts,
  checkRuns,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  issues,
  lt,
  namespaces,
  or,
  orgMembers,
  pullRequests,
  releases,
  repoCollaborators,
  repoFollows,
  repositories,
  sql,
  users,
  type User,
} from '@jumper/db';
import type { Ctx } from '../../context';
import { mailEnabled, sendMail } from '../mail/mailer';
import { accessesFor } from '../repos/access';

const DAY = 86_400_000;
/** Slightly under a week so the hourly run does not drift later every week. */
const INTERVAL = 7 * DAY - 2 * 3_600_000;

export interface DigestRepo {
  /** owner/name */
  path: string;
  pullsOpened: { number: number; title: string }[];
  pullsMerged: { number: number; title: string }[];
  issuesOpened: { number: number; title: string }[];
  issuesClosed: number;
  releases: { tag: string; name: string }[];
  failedChecks: number;
  openAlerts: number;
}

export interface DigestContent {
  user: { username: string };
  since: Date;
  repos: DigestRepo[];
  /** Open pull requests by other people that nobody has reviewed yet, in repositories the user can write to. */
  waiting: { path: string; number: number; title: string; ageDays: number }[];
}

export function digestIsEmpty(c: DigestContent): boolean {
  return !c.waiting.length && c.repos.every((r) => !r.pullsOpened.length && !r.pullsMerged.length && !r.issuesOpened.length && !r.issuesClosed && !r.releases.length && !r.failedChecks && !r.openAlerts);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Plain-text body. Pure, so it can be tested without a database. */
export function renderDigest(c: DigestContent, baseUrl: string): { subject: string; text: string } {
  const base = baseUrl.replace(/\/$/, '');
  const active = c.repos.filter((r) => r.pullsOpened.length || r.pullsMerged.length || r.issuesOpened.length || r.issuesClosed || r.releases.length || r.failedChecks || r.openAlerts);
  const merged = active.reduce((n, r) => n + r.pullsMerged.length, 0);
  const rel = active.reduce((n, r) => n + r.releases.length, 0);
  const bits = [merged ? plural(merged, 'merge') : '', rel ? plural(rel, 'release') : '', c.waiting.length ? `${c.waiting.length} waiting for review` : ''].filter(Boolean);
  const subject = `Your week on Jumper${bits.length ? `: ${bits.join(', ')}` : ''}`;

  const lines: string[] = [`Hi ${c.user.username},`, '', `Here is what happened since ${c.since.toISOString().slice(0, 10)}.`, ''];
  if (c.waiting.length) {
    lines.push('Waiting for review', '------------------');
    for (const w of c.waiting) lines.push(`  ${w.path}#${w.number} ${w.title} (${plural(w.ageDays, 'day')} old)`, `    ${base}/${w.path}/pull/${w.number}`);
    lines.push('');
  }
  for (const r of active) {
    lines.push(r.path, '-'.repeat(r.path.length));
    for (const p of r.pullsMerged) lines.push(`  Merged #${p.number} ${p.title}`);
    for (const p of r.pullsOpened) lines.push(`  Opened #${p.number} ${p.title}`);
    for (const t of r.releases) lines.push(`  Released ${t.name || t.tag} (${base}/${r.path}/releases/tag/${encodeURIComponent(t.tag)})`);
    if (r.issuesOpened.length || r.issuesClosed) lines.push(`  Issues: ${r.issuesOpened.length} opened, ${r.issuesClosed} closed`);
    for (const i of r.issuesOpened.slice(0, 5)) lines.push(`    #${i.number} ${i.title}`);
    if (r.failedChecks) lines.push(`  ${plural(r.failedChecks, 'failed check')} on ${r.path} (${base}/${r.path}/checks)`);
    if (r.openAlerts) lines.push(`  ${plural(r.openAlerts, 'part')} out of stock or end of life (${base}/${r.path}/bom-alerts)`);
    lines.push('');
  }
  lines.push('--', `You get this because the weekly digest is on. Turn it off in Settings, Notifications: ${base}/settings/notifications`);
  return { subject, text: lines.join('\n') };
}

/** Repositories `user` owns, belongs to, collaborates on or follows, filtered to the ones they can still read. */
async function reposFor(ctx: Ctx, user: User) {
  const orgIds = (await ctx.db.select({ id: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, user.id))).map((r) => r.id);
  const collab = ctx.db.select({ id: repoCollaborators.repoId }).from(repoCollaborators).where(eq(repoCollaborators.userId, user.id));
  const follow = ctx.db.select({ id: repoFollows.repoId }).from(repoFollows).where(eq(repoFollows.userId, user.id));
  const rows = await ctx.db
    .select({ repo: repositories, ns: namespaces })
    .from(repositories)
    .innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId))
    .where(
      or(
        eq(namespaces.userId, user.id),
        orgIds.length ? inArray(namespaces.orgId, orgIds) : undefined,
        inArray(repositories.id, collab),
        inArray(repositories.id, follow),
      ),
    )
    .limit(200);
  const access = await accessesFor(ctx, user, rows);
  return rows.map((r, i) => ({ ...r, permission: access[i]!.permission })).filter((r) => r.permission !== 'none');
}

export async function collectDigest(ctx: Ctx, user: User, since: Date): Promise<DigestContent> {
  const repos = await reposFor(ctx, user);
  const content: DigestContent = { user: { username: user.username }, since, repos: [], waiting: [] };
  if (!repos.length) return content;
  const ids = repos.map((r) => r.repo.id);
  const [prs, iss, rels, checks, alerts] = await Promise.all([
    ctx.db.select().from(pullRequests).where(and(inArray(pullRequests.repoId, ids), or(gte(pullRequests.createdAt, since), gte(pullRequests.mergedAt, since), eq(pullRequests.state, 'open')))),
    ctx.db.select().from(issues).where(and(inArray(issues.repoId, ids), eq(issues.kind, 'issue'), or(gte(issues.createdAt, since), gte(issues.closedAt, since)))),
    ctx.db.select().from(releases).where(and(inArray(releases.repoId, ids), eq(releases.draft, false), isNotNull(releases.publishedAt), gte(releases.publishedAt, since))),
    ctx.db
      .select({ repoId: checkRuns.repoId, n: sql<number>`count(*)::int` })
      .from(checkRuns)
      .where(and(inArray(checkRuns.repoId, ids), gte(checkRuns.completedAt, since), inArray(checkRuns.conclusion, ['failure', 'timed_out'])))
      .groupBy(checkRuns.repoId),
    ctx.db.select({ repoId: bomAlerts.repoId, n: sql<number>`count(*)::int` }).from(bomAlerts).where(and(inArray(bomAlerts.repoId, ids), isNull(bomAlerts.resolvedAt))).groupBy(bomAlerts.repoId),
  ]);
  const reviewed = new Set(
    prs.length
      ? (
          (await ctx.db.execute(
            sql`select distinct r.pull_id from reviews r join pull_requests p on p.id = r.pull_id where r.author_id <> p.author_id and r.pull_id in (${sql.join(prs.map((p) => sql`${p.id}`), sql`, `)})`,
          )) as unknown as { pull_id: string }[]
        ).map((r) => r.pull_id)
      : [],
  );
  const now = Date.now();
  for (const { repo, ns, permission } of repos) {
    const path = `${ns.slug}/${repo.name}`;
    const mine = (x: { repoId: string }) => x.repoId === repo.id;
    content.repos.push({
      path,
      pullsOpened: prs.filter((p) => mine(p) && p.createdAt >= since).map((p) => ({ number: p.number, title: p.title })),
      pullsMerged: prs.filter((p) => mine(p) && p.state === 'merged' && p.mergedAt && p.mergedAt >= since).map((p) => ({ number: p.number, title: p.title })),
      issuesOpened: iss.filter((i) => mine(i) && i.createdAt >= since).map((i) => ({ number: i.number, title: i.title })),
      issuesClosed: iss.filter((i) => mine(i) && i.closedAt && i.closedAt >= since).length,
      releases: rels.filter(mine).map((r) => ({ tag: r.tag, name: r.name })),
      failedChecks: checks.find(mine)?.n ?? 0,
      openAlerts: alerts.find(mine)?.n ?? 0,
    });
    if (permission === 'write' || permission === 'admin') {
      for (const p of prs) {
        if (!mine(p) || p.state !== 'open' || p.draft || p.authorId === user.id || reviewed.has(p.id)) continue;
        content.waiting.push({ path, number: p.number, title: p.title, ageDays: Math.floor((now - p.createdAt.getTime()) / DAY) });
      }
    }
  }
  content.waiting.sort((a, b) => b.ageDays - a.ageDays);
  content.waiting = content.waiting.slice(0, 10);
  return content;
}

/** Scheduled: send digests to whoever is due. Everyone due is marked done, whether or not they had anything to read. */
export async function sendDueDigests(ctx: Ctx, now = new Date(), limit = 50): Promise<{ due: number; sent: number }> {
  if (!ctx.env.DIGEST_ENABLED || !mailEnabled(ctx.env)) return { due: 0, sent: 0 };
  const cutoff = new Date(now.getTime() - INTERVAL);
  const due = await ctx.db
    .select()
    .from(users)
    .where(and(eq(users.digestEmail, true), eq(users.disabled, false), ctx.env.emailVerificationRequired ? isNotNull(users.emailVerifiedAt) : undefined, or(isNull(users.lastDigestAt), lt(users.lastDigestAt, cutoff))))
    .orderBy(sql`${users.lastDigestAt} asc nulls first`)
    .limit(limit);
  let sent = 0;
  for (const user of due) {
    // First digest covers the last week, later ones everything since the previous one.
    const since = user.lastDigestAt && user.lastDigestAt > new Date(now.getTime() - 14 * DAY) ? user.lastDigestAt : new Date(now.getTime() - 7 * DAY);
    try {
      const content = await collectDigest(ctx, user, since);
      if (!digestIsEmpty(content)) {
        const { subject, text } = renderDigest(content, ctx.env.PUBLIC_URL);
        if ((await sendMail(ctx.env, { to: user.email, subject, text })).sent) sent++;
      }
    } finally {
      await ctx.db.update(users).set({ lastDigestAt: now }).where(eq(users.id, user.id));
    }
  }
  return { due: due.length, sent };
}
