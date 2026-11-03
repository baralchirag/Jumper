// Plans and usage limits. Plans are assigned to a namespace (a user or an organization) by an administrator;
// payments are not wired in yet. Limits are only enforced when the operator sets PLANS_ENFORCED=true.
// The Free plan's storage is a trial (FREE_TRIAL_DAYS, 30 by default); invite bonuses expire (REFERRAL_BONUS_DAYS).

/** Defaults the server uses unless configured otherwise; the pricing page quotes these. */
export const FREE_TRIAL_DAYS_DEFAULT = 30;
export const REFERRAL_BONUS_DAYS_DEFAULT = 15;

export const PLAN_IDS = ['free', 'pro', 'team', 'enterprise'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  /** Repositories, generated outputs and large files together, in MB. null = unlimited. */
  storageMb: number | null;
  /** Check (CI) minutes per calendar month (UTC). null = unlimited. */
  checkMinutes: number | null;
  /** People with access: organization members, or collaborators on a user's private repositories (plus the owner). */
  seats: number | null;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Shown on the usage page; prices are informational until billing exists. */
  blurb: string;
  limits: PlanLimits;
  /** List price in US cents per seat per month; null = quoted individually. Invoices are raised by an administrator. */
  priceMonthlyCents: number | null;
  /** Per seat per year when billed annually (two months free). */
  priceAnnualCents: number | null;
}

export const BILLING_CYCLES = ['monthly', 'annual'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

/** Price for `seats` seats over one billing period, in cents; null when the plan is quoted individually. */
export function planPriceCents(plan: Plan, cycle: BillingCycle, seats: number): number | null {
  const unit = cycle === 'annual' ? plan.priceAnnualCents : plan.priceMonthlyCents;
  return unit === null ? null : unit * Math.max(1, seats);
}

export const DEFAULT_PLANS: Record<PlanId, Plan> = {
  free: { id: 'free', name: 'Free', blurb: 'Try everything with 2 GB of storage for your first 30 days.', limits: { storageMb: 2048, checkMinutes: 500, seats: 5 }, priceMonthlyCents: 0, priceAnnualCents: 0 },
  pro: { id: 'pro', name: 'Pro', blurb: 'For professional designers with private client work.', limits: { storageMb: 20_480, checkMinutes: 3000, seats: 10 }, priceMonthlyCents: 1200, priceAnnualCents: 12_000 },
  team: { id: 'team', name: 'Business', blurb: 'For hardware teams: single sign-on, roles, organization policies and release approval.', limits: { storageMb: 102_400, checkMinutes: 10_000, seats: 50 }, priceMonthlyCents: 2900, priceAnnualCents: 29_000 },
  enterprise: { id: 'enterprise', name: 'Enterprise', blurb: 'For regulated and large teams: SAML, SCIM, legal hold, export control and compliance reports.', limits: { storageMb: null, checkMinutes: null, seats: null }, priceMonthlyCents: null, priceAnnualCents: null },
};

export function isPlanId(v: unknown): v is PlanId {
  return typeof v === 'string' && (PLAN_IDS as readonly string[]).includes(v);
}

/**
 * Plans with operator overrides applied. `overrides` is the parsed PLAN_LIMITS env var, e.g.
 * `{"free":{"storageMb":5120},"pro":{"checkMinutes":null}}`. Unknown plans and keys are ignored.
 */
export function resolvePlans(overrides: unknown): Record<PlanId, Plan> {
  const out = structuredClone(DEFAULT_PLANS);
  if (!overrides || typeof overrides !== 'object') return out;
  for (const [id, raw] of Object.entries(overrides as Record<string, unknown>)) {
    if (!isPlanId(id) || !raw || typeof raw !== 'object') continue;
    for (const key of ['storageMb', 'checkMinutes', 'seats'] as const) {
      const v = (raw as Record<string, unknown>)[key];
      if (v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)) out[id].limits[key] = v;
    }
  }
  return out;
}

export interface UsageNumbers {
  /** Bytes: git repositories, generated outputs, large files. */
  storageBytes: number;
  storage: { repositories: number; outputs: number; largeFiles: number };
  /** Check minutes used this calendar month (UTC), rounded up per run. */
  checkMinutes: number;
  seats: number;
}

export interface UsageReport {
  owner: string;
  kind: 'user' | 'org';
  plan: Plan;
  /** Storage added to the plan by referrals (already included in plan.limits.storageMb). */
  referralBonusMb?: number;
  /** When the earliest invite bonus still counting runs out (ISO), if any. */
  referralBonusExpiresAt?: string | null;
  /** Free plan only: the end of the storage trial (ISO), and whether it is still running. */
  trial?: { endsAt: string; active: boolean; afterTrialMb: number } | null;
  enforced: boolean;
  usage: UsageNumbers;
  /** First day of the current billing month (UTC), ISO date. */
  periodStart: string;
  /** First day of next month, when check minutes reset. */
  periodEnd: string;
  /** Largest repositories, for "what is using my storage". */
  repositories: { name: string; sizeBytes: number; outputsBytes: number; checkMinutes: number }[];
}

export type LimitKind = 'storage' | 'checkMinutes' | 'seats';

/** Whether `usage` has reached a plan limit. Unlimited limits never block. */
export function overLimit(kind: LimitKind, usage: UsageNumbers, limits: PlanLimits, adding = 0): boolean {
  if (kind === 'storage') return limits.storageMb !== null && usage.storageBytes + adding > limits.storageMb * 1024 * 1024;
  if (kind === 'checkMinutes') return limits.checkMinutes !== null && usage.checkMinutes + adding > limits.checkMinutes;
  return limits.seats !== null && usage.seats + adding > limits.seats;
}
