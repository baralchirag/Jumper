import { and, eq, monthStart, namespaceUsage, namespaces, orgMembers, repoCollaborators, repositories, repositoryUsage, sql, type Namespace } from '@jumper/db';
import { isPlanId, overLimit, type Plan, type UsageNumbers, type UsageReport } from '@jumper/shared';
import { HttpError } from '../../lib/errors';
import type { Ctx } from '../../context';
import { activeReferralBonus, effectivePlan, freeTrial } from '../referrals/service';

const MB = 1024 * 1024;

export function planFor(ctx: Ctx, ns: Pick<Namespace, 'plan'>): Plan {
  return ctx.env.plans[isPlanId(ns.plan) ? ns.plan : 'free'];
}

export async function usageFor(ctx: Ctx, namespaceId: string): Promise<UsageNumbers> {
  const u = await namespaceUsage(ctx.db, namespaceId);
  return {
    storageBytes: u.repositoriesBytes + u.outputsBytes + u.largeFilesBytes,
    storage: { repositories: u.repositoriesBytes, outputs: u.outputsBytes, largeFiles: u.largeFilesBytes },
    checkMinutes: u.checkMinutes,
    seats: u.seats,
  };
}

export async function usageReport(ctx: Ctx, ns: Namespace): Promise<UsageReport> {
  const [usage, repos] = await Promise.all([usageFor(ctx, ns.id), repositoryUsage(ctx.db, ns.id)]);
  const start = monthStart();
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return {
    owner: ns.slug,
    kind: ns.kind,
    plan: await effectivePlan(ctx, ns),
    ...(await activeReferralBonus(ctx, ns).then((b) => ({ referralBonusMb: b.mb, referralBonusExpiresAt: b.expiresAt?.toISOString() ?? null }))),
    trial: ((t) => (t ? { endsAt: t.endsAt.toISOString(), active: t.active, afterTrialMb: t.afterTrialMb } : null))(freeTrial(ctx, ns)),
    enforced: ctx.env.PLANS_ENFORCED,
    usage,
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
    repositories: repos.map((r) => ({ name: r.name, sizeBytes: r.sizeBytes, outputsBytes: r.outputsBytes, checkMinutes: r.checkMinutes })),
  };
}

const planLimit = (message: string, details: Record<string, unknown>) => new HttpError(403, 'plan_limit', message, details);

async function namespaceById(ctx: Ctx, id: string): Promise<Namespace | undefined> {
  return (await ctx.db.select().from(namespaces).where(eq(namespaces.id, id)).limit(1))[0];
}

/**
 * The refusal shown by git when a push would exceed storage, or null when the push may proceed. Only applies when
 * limits are enforced; pushes that only delete refs are always allowed by the hook.
 */
export async function pushRefusal(ctx: Ctx, namespaceId: string): Promise<string | null> {
  if (!ctx.env.PLANS_ENFORCED) return null;
  const ns = await namespaceById(ctx, namespaceId);
  if (!ns) return null;
  const plan = await effectivePlan(ctx, ns);
  const usage = await usageFor(ctx, ns.id);
  if (!overLimit('storage', usage, plan.limits)) return null;
  const used = Math.round(usage.storageBytes / MB);
  const trial = freeTrial(ctx, ns);
  if (trial && !trial.active) return `The free storage trial for ${ns.slug} ended on ${trial.endsAt.toISOString().slice(0, 10)}. Choose a plan to keep pushing (${used} MB stored, nothing has been deleted). See Settings → Usage and plan, or /pricing.`;
  return `${ns.slug} is over its storage limit (${used} MB of ${plan.limits.storageMb} MB on the ${plan.name} plan). Delete large files or old repositories, or choose a bigger plan. See Settings → Usage and plan.`;
}

/** Throws when adding `userId` to an organization would exceed the plan's seats. */
export async function assertOrgSeat(ctx: Ctx, orgNamespace: Namespace, userId: string): Promise<void> {
  if (!ctx.env.PLANS_ENFORCED || !orgNamespace.orgId) return;
  const already = await ctx.db.select({ u: orgMembers.userId }).from(orgMembers).where(and(eq(orgMembers.orgId, orgNamespace.orgId), eq(orgMembers.userId, userId))).limit(1);
  if (already.length) return;
  await assertSeat(ctx, orgNamespace);
}

/** Throws when giving `userId` access to a private repository of a user namespace would exceed the plan's seats. */
export async function assertCollaboratorSeat(ctx: Ctx, repo: { namespaceId: string; visibility: string }, userId: string): Promise<void> {
  if (!ctx.env.PLANS_ENFORCED || repo.visibility !== 'private') return;
  const ns = await namespaceById(ctx, repo.namespaceId);
  // Organizations pay per member; collaborators on their repositories do not take extra seats.
  if (!ns || ns.kind !== 'user' || ns.userId === userId) return;
  const [{ n }] = (await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(repoCollaborators)
    .innerJoin(repositories, eq(repositories.id, repoCollaborators.repoId))
    .where(and(eq(repositories.namespaceId, ns.id), eq(repositories.visibility, 'private'), eq(repoCollaborators.userId, userId)))) as [{ n: number }];
  if (n > 0) return;
  await assertSeat(ctx, ns);
}

async function assertSeat(ctx: Ctx, ns: Namespace): Promise<void> {
  const plan = planFor(ctx, ns);
  const usage = await usageFor(ctx, ns.id);
  if (overLimit('seats', usage, plan.limits, 1)) {
    throw planLimit(`${ns.slug} has used all ${plan.limits.seats} seats on the ${plan.name} plan. Remove someone first, or ask an administrator for a bigger plan.`, {
      limit: 'seats',
      plan: plan.id,
      used: usage.seats,
      max: plan.limits.seats,
    });
  }
}
