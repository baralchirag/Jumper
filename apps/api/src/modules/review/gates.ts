import { and, approvalRules, checklistItems, desc, eq, fileLocks, gt, isNull, reviews, sql, users, type PullRequest, type Repository } from '@jumper/db';
import type { OrgPolicy } from '@jumper/shared';
import type { Ctx } from '../../context';
import type { GitRepo } from '../git/repo';
import { EMPTY_TREE } from '../git/repo';
import { matchesGlob } from '../_shared/glob';
import { getRepoConfig } from '../_shared/repo-config';

/**
 * Extra merge blockers contributed by the review features: path-based approval rules, the required
 * checklist and whole-file locks held by someone other than the pull request's author.
 */
export async function reviewBlockers(ctx: Ctx, repo: Repository, git: GitRepo, pr: PullRequest, baseSha: string | null, headSha: string | null, orgRules: OrgPolicy['signoffRules'] = []): Promise<string[]> {
  if (!headSha) return [];
  const [rules, cfg] = await Promise.all([
    ctx.db.select().from(approvalRules).where(eq(approvalRules.repoId, repo.id)),
    getRepoConfig(ctx, repo.id),
  ]);
  const blockers: string[] = [];

  const mergeBase = baseSha ? await git.mergeBase(baseSha, headSha).catch(() => null) : null;
  const changed = (await git.diff(mergeBase ?? EMPTY_TREE, headSha).catch(() => [])).flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]);

  // Sign-off rules from the owner's policy work like the repository's own, with approvers named by username.
  const inherited: { name: string; pathPattern: string; requiredApprovals: number; approverIds: string[] }[] = [];
  const names = [...new Set(orgRules.flatMap((r) => r.approvers.map((a) => a.toLowerCase())))];
  const people = names.length ? await ctx.db.select({ id: users.id, username: users.username }).from(users).where(sql`lower(${users.username}) in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`) : [];
  for (const r of orgRules) {
    inherited.push({ name: `${r.name} (organization rule)`, pathPattern: r.pathPattern, requiredApprovals: r.requiredApprovals, approverIds: r.approvers.map((a) => people.find((p) => p.username.toLowerCase() === a.toLowerCase())?.id ?? '').filter(Boolean) });
  }
  const allRules = [...rules, ...inherited];

  if (allRules.length) {
    const all = await ctx.db.select().from(reviews).where(eq(reviews.pullId, pr.id)).orderBy(desc(reviews.createdAt));
    const latest = new Map<string, (typeof all)[number]>();
    for (const rv of all) {
      if (rv.authorId === pr.authorId || rv.state === 'commented') continue;
      if (!latest.has(rv.authorId)) latest.set(rv.authorId, rv);
    }
    const approvers = [...latest.values()].filter((r) => r.state === 'approved').map((r) => r.authorId);
    for (const rule of allRules) {
      if (!changed.some((p) => matchesGlob(rule.pathPattern, p))) continue;
      const eligible = rule.approverIds.length ? approvers.filter((a) => rule.approverIds.includes(a)) : approvers;
      if (eligible.length < rule.requiredApprovals) blockers.push(`${rule.name}: ${rule.requiredApprovals - eligible.length} more sign-off(s) required for ${rule.pathPattern}`);
    }
  }

  if (cfg.requireChecklist) {
    const open = await ctx.db.select({ id: checklistItems.id }).from(checklistItems).where(and(eq(checklistItems.pullId, pr.id), isNull(checklistItems.doneAt)));
    if (open.length) blockers.push(`${open.length} review checklist item(s) not completed`);
  }

  const locks = await ctx.db.select().from(fileLocks).where(and(eq(fileLocks.repoId, repo.id), gt(fileLocks.expiresAt, new Date())));
  for (const l of locks) {
    // Region locks are advisory (the file-level diff cannot say which region changed); whole-file locks block.
    if (l.region || l.lockedBy === pr.authorId) continue;
    if (changed.includes(l.path)) blockers.push(`${l.path} is locked by another user`);
  }
  return blockers;
}
