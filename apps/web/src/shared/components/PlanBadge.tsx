import { DEFAULT_PLANS, type PlanId } from '@jumper/shared';
import { cx } from '@jumper/ui';

/** True for any plan someone pays for. */
export const isPaidPlan = (plan: PlanId | null | undefined): boolean =>
  Boolean(plan && plan !== 'free');

/** Small tag shown next to a name when the account is on a paid plan. Renders nothing on Free. */
export function PlanBadge({
  plan,
  className,
}: {
  plan: PlanId | null | undefined;
  className?: string;
}) {
  if (!plan || !isPaidPlan(plan)) return null;
  const name = DEFAULT_PLANS[plan].name;
  return (
    <span
      title={`${name} plan`}
      className={cx(
        'inline-flex shrink-0 select-none items-center rounded-sm border border-accent-muted bg-accent-subtle px-1.5 align-middle font-mono text-[10.5px] font-semibold uppercase leading-[16px] tracking-[0.06em] text-accent',
        className,
      )}
    >
      {name}
    </span>
  );
}
