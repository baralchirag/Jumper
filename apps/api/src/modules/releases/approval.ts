// Release approval and the release record.
//
// When an owner names release approvers, a release stays a draft until enough of them have approved the exact commit
// it points at. Publishing then writes a record of who made the release, what was checked and who approved it. Records
// are signed with the instance's secret and each carries the digest of the record before it, so an edited or removed
// record is detectable. They are kept even if the release (or the repository) is deleted later.
import { createHash } from 'node:crypto';
import { and, checkRuns, desc, eq, gt, inArray, lt, pullRequests, releaseAssets, releaseRecords, releaseSignoffs, releases, reviews, sql, users, type Release, type User } from '@jumper/db';
import type { ReleaseApprovalState, ReleaseRecord, SignedReleaseRecord } from '@jumper/shared';
import type { Ctx } from '../../context';
import { hmacHex } from '../../lib/secrets';
import { usersById } from '../_shared/people';
import { hasFeature } from '../license/license';
import { effectivePolicy } from '../policy/service';
import type { RepoCtx } from '../repos/access';
import { toUserSummary } from '../repos/serialize';

export interface Requirement {
  required: number;
  approvers: User[];
}

/** Who has to approve releases of this repository, or null when no approval is required. */
export async function requirementFor(ctx: Ctx, r: Pick<RepoCtx, 'ns'>): Promise<Requirement | null> {
  const policy = await effectivePolicy(ctx, r.ns);
  if (policy.releaseApprovals < 1 || !policy.releaseApprovers.length) return null;
  if (!(await hasFeature(ctx, r.ns, 'release_approval'))) return null;
  const names = policy.releaseApprovers.map((n) => n.toLowerCase());
  const approvers = await ctx.db.select().from(users).where(and(sql`lower(${users.username}) in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`, eq(users.disabled, false)));
  return { required: policy.releaseApprovals, approvers };
}

type Signoff = typeof releaseSignoffs.$inferSelect;

/** The decision that counts for each person: their latest one on the commit the release points at now. */
function standing(release: Release, signoffs: Signoff[], req: Requirement): Map<string, Signoff> {
  const out = new Map<string, Signoff>();
  for (const s of [...signoffs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    if (s.sha !== release.sha || out.has(s.userId)) continue;
    // The person who made the release cannot be the one who approves it.
    if (s.userId === release.createdBy) continue;
    if (!req.approvers.some((a) => a.id === s.userId)) continue;
    out.set(s.userId, s);
  }
  return out;
}

export function isApproved(release: Release, signoffs: Signoff[], req: Requirement): boolean {
  const s = [...standing(release, signoffs, req).values()];
  return !s.some((x) => x.decision === 'rejected') && s.filter((x) => x.decision === 'approved').length >= req.required;
}

export async function signoffsFor(ctx: Ctx, releaseIds: string[]): Promise<Map<string, Signoff[]>> {
  const out = new Map<string, Signoff[]>();
  if (!releaseIds.length) return out;
  for (const s of await ctx.db.select().from(releaseSignoffs).where(inArray(releaseSignoffs.releaseId, releaseIds)).orderBy(releaseSignoffs.createdAt)) {
    out.set(s.releaseId, [...(out.get(s.releaseId) ?? []), s]);
  }
  return out;
}

export async function approvalStates(ctx: Ctx, r: RepoCtx, rows: Release[], viewer: User | null): Promise<Map<string, ReleaseApprovalState>> {
  const out = new Map<string, ReleaseApprovalState>();
  const req = await requirementFor(ctx, r);
  if (!req || !rows.length) return out;
  const all = await signoffsFor(ctx, rows.map((x) => x.id));
  const people = await usersById(ctx, [...all.values()].flat().map((s) => s.userId));
  for (const x of rows) {
    const signoffs = all.get(x.id) ?? [];
    out.set(x.id, {
      required: req.required,
      approvers: req.approvers.map(toUserSummary),
      decisions: signoffs.flatMap((s) => {
        const u = people.get(s.userId);
        return u ? [{ user: toUserSummary(u), decision: s.decision, comment: s.comment, sha: s.sha, at: s.createdAt.toISOString() }] : [];
      }),
      // A release that is already published was approved under the rules in force at the time.
      approved: !x.draft || isApproved(x, signoffs, req),
      canSign: Boolean(viewer && x.draft && viewer.id !== x.createdBy && req.approvers.some((a) => a.id === viewer.id)),
    });
  }
  return out;
}

// ---------- records ----------

/** JSON with object keys sorted, so the same record always hashes to the same digest. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export const recordDigest = (record: ReleaseRecord): string => createHash('sha256').update(canonicalJson(record)).digest('hex');
export const recordSignature = (ctx: Ctx, digest: string): string => hmacHex(ctx.env, 'release-record', digest);

async function fileDigest(ctx: Ctx, key: string, size: number): Promise<string | null> {
  if (size > 512 * 1024 * 1024) return null;
  const obj = await ctx.storage.get(key).catch(() => null);
  if (!obj) return null;
  const hash = createHash('sha256');
  for await (const chunk of obj.body) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Write the record for a release that has just been published. Does nothing without the release-records feature. */
export async function writeReleaseRecord(ctx: Ctx, r: RepoCtx, release: Release): Promise<string | null> {
  if (!(await hasFeature(ctx, r.ns, 'release_records'))) return null;
  const req = await requirementFor(ctx, r);
  const previous = (
    await ctx.db
      .select()
      .from(releases)
      .where(and(eq(releases.repoId, r.repo.id), eq(releases.draft, false), lt(releases.publishedAt, release.publishedAt ?? new Date())))
      .orderBy(desc(releases.publishedAt))
      .limit(1)
  )[0];
  const [runs, merged, signoffs, assets, last] = await Promise.all([
    ctx.db.select().from(checkRuns).where(and(eq(checkRuns.repoId, r.repo.id), eq(checkRuns.sha, release.sha))).orderBy(checkRuns.name, checkRuns.projectPath),
    ctx.db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, r.repo.id), eq(pullRequests.state, 'merged'), previous?.publishedAt ? gt(pullRequests.mergedAt, previous.publishedAt) : undefined))
      .orderBy(pullRequests.number)
      .limit(500),
    ctx.db.select().from(releaseSignoffs).where(eq(releaseSignoffs.releaseId, release.id)).orderBy(releaseSignoffs.createdAt),
    ctx.db.select().from(releaseAssets).where(eq(releaseAssets.releaseId, release.id)).orderBy(releaseAssets.name),
    ctx.db.select({ digest: releaseRecords.digest }).from(releaseRecords).where(eq(releaseRecords.repoId, r.repo.id)).orderBy(desc(releaseRecords.createdAt)).limit(1),
  ]);
  const approvals = merged.length ? await ctx.db.select().from(reviews).where(and(inArray(reviews.pullId, merged.map((p) => p.id)), eq(reviews.state, 'approved'))) : [];
  const people = await usersById(ctx, [release.createdBy, ...merged.flatMap((p) => [p.authorId, p.mergedById]), ...approvals.map((a) => a.authorId), ...signoffs.map((s) => s.userId)]);
  const name = (id: string | null | undefined) => (id ? (people.get(id)?.username ?? 'ghost') : null);

  const record: ReleaseRecord = {
    version: 1,
    repository: `${r.ns.slug}/${r.repo.name}`,
    tag: release.tag,
    name: release.name || release.tag,
    sha: release.sha,
    createdBy: name(release.createdBy),
    createdAt: release.createdAt.toISOString(),
    publishedAt: release.publishedAt?.toISOString() ?? null,
    checks: runs.map((c) => ({ name: c.name, project: c.projectPath, conclusion: c.conclusion, completedAt: c.completedAt?.toISOString() ?? null })),
    changes: merged.map((p) => ({
      number: p.number,
      title: p.title,
      author: name(p.authorId) ?? 'ghost',
      mergedBy: name(p.mergedById),
      mergedAt: p.mergedAt?.toISOString() ?? null,
      approvedBy: [...new Set(approvals.filter((a) => a.pullId === p.id).map((a) => name(a.authorId) ?? 'ghost'))].sort(),
    })),
    signoffs: signoffs.map((s) => ({ user: name(s.userId) ?? 'ghost', name: people.get(s.userId)?.name ?? null, decision: s.decision, comment: s.comment, sha: s.sha, at: s.createdAt.toISOString() })),
    required: { approvals: req?.required ?? 0, approvers: (req?.approvers ?? []).map((a) => a.username).sort() },
    files: await Promise.all(assets.map(async (a) => ({ name: a.name, kind: a.kind, size: a.size, sha256: await fileDigest(ctx, a.storageKey, a.size) }))),
    previousDigest: last[0]?.digest ?? null,
  };
  const digest = recordDigest(record);
  await ctx.db.insert(releaseRecords).values({ repoId: r.repo.id, repoName: record.repository, tag: release.tag, record: record as unknown as Record<string, unknown>, digest, signature: recordSignature(ctx, digest) });
  await ctx.db.update(releases).set({ recordDigest: digest }).where(eq(releases.id, release.id));
  return digest;
}

export interface VerifiedRecord extends SignedReleaseRecord {
  createdAt: string;
  /** The stored record still matches its digest and this instance's signature. */
  intact: boolean;
  /** The record it names as its predecessor exists and is the one written just before it. */
  chained: boolean;
}

/** Every record of a repository, oldest first, each checked against its digest, signature and predecessor. */
export async function verifiedRecords(ctx: Ctx, repoId: string): Promise<VerifiedRecord[]> {
  const rows = await ctx.db.select().from(releaseRecords).where(eq(releaseRecords.repoId, repoId)).orderBy(releaseRecords.createdAt);
  return rows.map((row, i) => {
    const record = row.record as unknown as ReleaseRecord;
    const digest = recordDigest(record);
    return {
      record,
      digest: row.digest,
      signature: row.signature,
      createdAt: row.createdAt.toISOString(),
      intact: digest === row.digest && recordSignature(ctx, row.digest) === row.signature,
      chained: (record.previousDigest ?? null) === (i === 0 ? null : rows[i - 1]!.digest),
    };
  });
}
