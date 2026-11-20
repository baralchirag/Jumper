import { and, artifacts, auditLog, emailVerifications, eq, lt, notInArray, notifications, passwordResets, releases, repositories, sessions, sql, webhookDeliveries } from '@jumper/db';
import type { Ctx } from '../../context';
import { GitRepo } from '../git/repo';
import { retentionSettings } from '../instance/settings';
import { heldRepoIds } from '../legal/holds';
import { repoDiskPath } from '../repos/access';

export interface HousekeepingResult {
  sessions: number;
  passwordResets: number;
  emailVerifications: number;
  auditLog: number;
  notifications: number;
  webhookDeliveries: number;
  outputs: number;
  /** True when a legal hold kept the audit log and held repositories' outputs from being cleaned. */
  held: boolean;
}

const DAY = 24 * 3600 * 1000;

/**
 * Delete data we have promised not to keep (see the privacy policy): expired sessions and one-time tokens, and records
 * older than the retention settings. Anything under legal hold is left alone. Idempotent; safe to run at any time.
 */
export async function housekeeping(ctx: Ctx, now = new Date()): Promise<HousekeepingResult> {
  const keep = await retentionSettings(ctx);
  const held = await heldRepoIds(ctx);
  const anyHold = held.size > 0 || (await ctx.db.execute(sql`select 1 from legal_holds where released_at is null limit 1`) as unknown as unknown[]).length > 0;
  const before = (days: number) => new Date(now.getTime() - days * DAY);
  // One-time tokens are kept a day past expiry so "this link has expired" can still be told apart from "invalid".
  const tokenCutoff = before(1);
  const [s, r, v] = await Promise.all([
    ctx.db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id }),
    ctx.db.delete(passwordResets).where(lt(passwordResets.expiresAt, tokenCutoff)).returning({ id: passwordResets.id }),
    ctx.db.delete(emailVerifications).where(lt(emailVerifications.expiresAt, tokenCutoff)).returning({ id: emailVerifications.id }),
  ]);
  // The audit log is evidence: while any hold is in force, none of it is deleted.
  const a = keep.auditDays === null || anyHold ? [] : await ctx.db.delete(auditLog).where(lt(auditLog.createdAt, before(keep.auditDays))).returning({ id: auditLog.id });
  const n = keep.notificationDays === null ? [] : await ctx.db.delete(notifications).where(lt(notifications.createdAt, before(keep.notificationDays))).returning({ id: notifications.id });
  const w = keep.webhookDeliveryDays === null ? [] : await ctx.db.delete(webhookDeliveries).where(lt(webhookDeliveries.createdAt, before(keep.webhookDeliveryDays))).returning({ id: webhookDeliveries.id });
  const outputs = keep.outputDays === null ? 0 : await pruneOutputs(ctx, before(keep.outputDays), held);
  return { sessions: s.length, passwordResets: r.length, emailVerifications: v.length, auditLog: a.length, notifications: n.length, webhookDeliveries: w.length, outputs, held: anyHold };
}

/**
 * Remove generated outputs of old commits that nothing points at any more: not the tip of a branch, not a tag (annotated
 * tags peeled to their commit) and not a release. Release files are stored separately and are never touched.
 *
 * Works one repository at a time, visiting every repository with old outputs on each run. (An earlier version took the
 * first 5,000 old commits across all repositories; once that many were kept tips, it never got past them.)
 */
async function pruneOutputs(ctx: Ctx, cutoff: Date, held: Set<string>): Promise<number> {
  const candidates = await ctx.db.selectDistinct({ repoId: artifacts.repoId }).from(artifacts).where(lt(artifacts.createdAt, cutoff));
  let removed = 0;
  for (const { repoId } of candidates) {
    if (held.has(repoId)) continue;
    const exists = (await ctx.db.select({ id: repositories.id }).from(repositories).where(eq(repositories.id, repoId)).limit(1)).length;
    if (!exists) continue;
    // If the repository cannot be read, keep everything rather than guess.
    const kept = await new GitRepo(repoDiskPath(ctx, repoId)).pointedCommits().catch(() => null);
    if (!kept) continue;
    for (const r of await ctx.db.select({ sha: releases.sha }).from(releases).where(eq(releases.repoId, repoId))) kept.add(r.sha);
    const rows = await ctx.db
      .delete(artifacts)
      .where(and(eq(artifacts.repoId, repoId), lt(artifacts.createdAt, cutoff), kept.size ? notInArray(artifacts.sha, [...kept]) : undefined))
      .returning({ key: artifacts.storageKey });
    for (const row of rows) await ctx.storage.deletePrefix(row.key).catch(() => {});
    removed += rows.length;
  }
  return removed;
}
