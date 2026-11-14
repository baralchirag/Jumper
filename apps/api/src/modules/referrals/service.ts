// Referral program. Everyone has an invite link (/signup?ref=<username>). A person who signs up through it is
// recorded as referred by the inviter; each referred account that is active (and verified, where the instance asks
// for verification) adds bonus storage to the inviter's personal plan, up to a cap. No payments are involved.
import { and, eq, gt, isNotNull, namespaces, sql, users, type Namespace, type User } from '@jumper/db';
import type { Plan } from '@jumper/shared';
import type { Ctx } from '../../context';
import { planFor } from '../usage/service';

/** The inviter for a `ref` value, or null when it names nobody (or the person signing up themself). */
export async function resolveReferrer(ctx: Ctx, ref: string | undefined): Promise<User | null> {
  if (!ref) return null;
  const u = (await ctx.db.select().from(users).where(sql`lower(${users.username}) = lower(${ref.trim()})`).limit(1))[0];
  return u && !u.disabled ? u : null;
}

const DAY = 86_400_000;

/** Referred accounts that count towards the bonus (all time, for the invite page). */
export async function countedReferrals(ctx: Ctx, userId: string): Promise<number> {
  const [{ n }] = (await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.referredBy, userId), eq(users.disabled, false), ctx.env.emailVerificationRequired ? isNotNull(users.emailVerifiedAt) : undefined))) as [{ n: number }];
  return n;
}

/**
 * Invite bonuses still running: each counted referral adds REFERRAL_BONUS_MB for REFERRAL_BONUS_DAYS from the day the
 * person joined. Returns the bonus now (capped) and when the earliest running one ends.
 */
export async function activeReferralBonus(ctx: Ctx, ns: Pick<Namespace, 'kind' | 'userId'>, now = new Date()): Promise<{ mb: number; expiresAt: Date | null }> {
  if (ns.kind !== 'user' || !ns.userId || ctx.env.REFERRAL_BONUS_MB <= 0) return { mb: 0, expiresAt: null };
  const since = new Date(now.getTime() - ctx.env.REFERRAL_BONUS_DAYS * DAY);
  const rows = await ctx.db
    .select({ joined: users.createdAt })
    .from(users)
    .where(
      and(
        eq(users.referredBy, ns.userId),
        eq(users.disabled, false),
        ctx.env.emailVerificationRequired ? isNotNull(users.emailVerifiedAt) : undefined,
        gt(users.createdAt, since),
      ),
    );
  if (!rows.length) return { mb: 0, expiresAt: null };
  const first = Math.min(...rows.map((r) => r.joined.getTime()));
  return { mb: Math.min(rows.length * ctx.env.REFERRAL_BONUS_MB, ctx.env.REFERRAL_MAX_BONUS_MB), expiresAt: new Date(first + ctx.env.REFERRAL_BONUS_DAYS * DAY) };
}

export async function referralBonusMb(ctx: Ctx, ns: Pick<Namespace, 'kind' | 'userId'>): Promise<number> {
  return (await activeReferralBonus(ctx, ns)).mb;
}

/** The Free plan's storage trial for an owner: when it ends and whether it is still running. */
export function freeTrial(ctx: Ctx, ns: Pick<Namespace, 'plan' | 'createdAt'>, now = new Date()) {
  if (planFor(ctx, ns).id !== 'free') return null;
  const endsAt = new Date(ns.createdAt.getTime() + ctx.env.FREE_TRIAL_DAYS * DAY);
  return { endsAt, active: now < endsAt, afterTrialMb: ctx.env.FREE_STORAGE_AFTER_TRIAL_MB };
}

/**
 * The owner's plan as it applies today: the Free plan's storage drops to FREE_STORAGE_AFTER_TRIAL_MB once the trial is
 * over, and running invite bonuses are added. Use this wherever storage limits are enforced.
 */
export async function effectivePlan(ctx: Ctx, ns: Namespace): Promise<Plan> {
  const plan = planFor(ctx, ns);
  if (plan.limits.storageMb === null) return plan;
  const trial = freeTrial(ctx, ns);
  const base = trial && !trial.active ? Math.min(plan.limits.storageMb, trial.afterTrialMb) : plan.limits.storageMb;
  const bonus = await referralBonusMb(ctx, ns);
  return { ...plan, limits: { ...plan.limits, storageMb: base + bonus } };
}

export async function namespaceOfUser(ctx: Ctx, userId: string): Promise<Namespace | undefined> {
  return (await ctx.db.select().from(namespaces).where(eq(namespaces.userId, userId)).limit(1))[0];
}
