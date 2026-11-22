import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PLANS,
  PLAN_IDS,
  type PlanId,
  type ReferralInfo,
  type UsageReport,
} from '@jumper/shared';
import { Link } from '@tanstack/react-router';
import { Gift, Sparkles } from 'lucide-react';
import { Flash, PageSpinner, Select, buttonClass, cx } from '@jumper/ui';
import { formatBytes } from '../../shared/components/common';
import { isPaidPlan } from '../../shared/components/PlanBadge';
import { api, errorMessage } from '../../shared/lib/api';
import { useMe } from '../../shared/lib/queries';
import { useState } from 'react';

const MB = 1024 * 1024;
const DEFAULT_FREE_MB = DEFAULT_PLANS.free.limits.storageMb ?? 2048;

function Meter({
  label,
  used,
  max,
  format,
  detail,
}: {
  label: string;
  used: number;
  max: number | null;
  format: (n: number) => string;
  detail?: string;
}) {
  const pct = max === null || max === 0 ? 0 : Math.min(100, (used / max) * 100);
  const tone =
    max !== null && used >= max
      ? 'bg-danger-emphasis'
      : pct >= 80
        ? 'bg-attention'
        : 'bg-accent-emphasis';
  return (
    <div className="py-4">
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium">{label}</span>
        <span className="font-mono text-[13px] tabular-nums text-fg-muted">
          {format(used)}{' '}
          <span className="text-fg-subtle">/ {max === null ? 'unlimited' : format(max)}</span>
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-muted"
        role="meter"
        aria-label={label}
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={max ?? undefined}
      >
        {max !== null && (
          <div
            className={cx('h-full rounded-full transition-[width] duration-500', tone)}
            style={{ width: `${Math.max(pct, used > 0 ? 1 : 0)}%` }}
          />
        )}
      </div>
      {detail && <p className="mt-1.5 text-xs text-fg-subtle">{detail}</p>}
    </div>
  );
}

/** Storage, check minutes and seats against the owner's plan. Administrators can change the plan here. */
export function UsagePanel({ owner }: { owner: string }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['usage', owner.toLowerCase()],
    queryFn: () => api.get<UsageReport>(`/usage/${encodeURIComponent(owner)}`),
  });
  const mine = Boolean(me && me.username.toLowerCase() === owner.toLowerCase());
  // People already paying never see the pricing page, so no upsell links either.
  const viewerPaid = isPaidPlan(me?.plan);
  const referrals = useQuery({
    queryKey: ['referrals'],
    queryFn: () => api.get<ReferralInfo>('/user/referrals'),
    enabled: mine,
  });
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <Flash tone="danger">{errorMessage(q.error)}</Flash>;
  const r = q.data!;
  const { usage, plan } = r;
  const storageMax = plan.limits.storageMb === null ? null : plan.limits.storageMb * MB;
  const over =
    r.enforced &&
    ((storageMax !== null && usage.storageBytes >= storageMax) ||
      (plan.limits.checkMinutes !== null && usage.checkMinutes >= plan.limits.checkMinutes));

  const setPlan = async (id: PlanId) => {
    setError(null);
    try {
      const next = await api.put<UsageReport>(
        `/admin/namespaces/${encodeURIComponent(owner)}/plan`,
        { plan: id },
      );
      qc.setQueryData(['usage', owner.toLowerCase()], next);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-md border border-border bg-canvas p-4">
        <div>
          <p className="label-mono mb-1">Current plan</p>
          <p className="text-lg font-medium tracking-tight">{plan.name}</p>
          <p className="mt-0.5 max-w-md text-[13px] text-fg-muted">{plan.blurb}</p>
        </div>
        {me?.isAdmin ? (
          <label className="flex items-center gap-2 text-[13px] text-fg-muted">
            Plan
            <Select
              value={plan.id}
              onChange={(e) => void setPlan(e.target.value as PlanId)}
              className="h-8 w-36"
              aria-label="Plan"
            >
              {PLAN_IDS.map((id) => (
                <option key={id} value={id}>
                  {id[0]!.toUpperCase() + id.slice(1)}
                </option>
              ))}
            </Select>
          </label>
        ) : (
          !isPaidPlan(plan.id) && (
            <p className="max-w-[16rem] text-right text-xs text-fg-subtle">
              Paid plans are switched on by the Jumper team. Online payment is coming.
            </p>
          )
        )}
      </div>
      {error && <Flash tone="danger">{error}</Flash>}
      {r.trial && (
        <Flash tone={r.trial.active ? 'info' : 'warning'}>
          {r.trial.active ? (
            <>
              Free storage trial: {formatBytes(DEFAULT_FREE_MB * MB)} until{' '}
              {new Date(r.trial.endsAt).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}{' '}
              (
              {Math.max(
                0,
                Math.ceil((new Date(r.trial.endsAt).getTime() - Date.now()) / 86_400_000),
              )}{' '}
              days left). After that, pushing new data needs a paid plan; nothing is deleted.
            </>
          ) : (
            <>
              The free storage trial ended on{' '}
              {new Date(r.trial.endsAt).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
              . Your repositories stay readable; choose a plan to keep pushing.
            </>
          )}{' '}
          {!viewerPaid && (
            <Link
              to="/pricing"
              search={{ for: r.kind === 'org' ? 'organization' : 'personal' }}
              className="link"
            >
              See plans
            </Link>
          )}
        </Flash>
      )}
      {!r.enforced && (
        <p className="text-[13px] text-fg-muted">
          Limits are not enforced on this instance. Usage is shown for information.
        </p>
      )}
      {over && (
        <Flash tone="warning">
          You have reached a limit. Pushes that add data or checks are paused until usage goes down,
          the month resets, or the plan changes. Nothing is deleted.
        </Flash>
      )}

      <div className="divide-y divide-border-muted rounded-md border border-border px-4">
        <Meter
          label="Storage"
          used={usage.storageBytes}
          max={storageMax}
          format={formatBytes}
          detail={`Repositories ${formatBytes(usage.storage.repositories)} · generated outputs ${formatBytes(usage.storage.outputs)} · large files ${formatBytes(usage.storage.largeFiles)}${r.referralBonusMb ? ` · includes ${formatBytes(r.referralBonusMb * MB)} from invites${r.referralBonusExpiresAt ? `, the first of which runs out ${new Date(r.referralBonusExpiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}` : ''}`}
        />
        <Meter
          label="Check minutes this month"
          used={usage.checkMinutes}
          max={plan.limits.checkMinutes}
          format={(n) => `${n.toLocaleString()} min`}
          detail={`Since ${r.periodStart}. Resets ${r.periodEnd} (UTC). Billed per commit, from the first check starting to the last finishing.`}
        />
        <Meter
          label="Seats"
          used={usage.seats}
          max={plan.limits.seats}
          format={(n) => n.toLocaleString()}
          detail={
            r.kind === 'org'
              ? 'Organization members.'
              : 'You, plus collaborators on your private repositories.'
          }
        />
      </div>

      {(!viewerPaid ||
        Boolean(mine && referrals.data && referrals.data.bonusPerReferralMb > 0)) && (
        <section
          aria-labelledby="more-storage-h"
          className="rounded-md border border-border bg-canvas p-4"
        >
          <h3 id="more-storage-h" className="text-sm font-medium">
            Get more storage and minutes
          </h3>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {mine && referrals.data && referrals.data.bonusPerReferralMb > 0 && (
              <div className="flex flex-col gap-2">
                <p className="flex items-center gap-2 text-[13px] font-medium">
                  <Gift size={14} aria-hidden /> Invite people
                </p>
                <p className="text-[13px] leading-relaxed text-fg-muted">
                  Each person who joins through your link adds{' '}
                  {formatBytes(referrals.data.bonusPerReferralMb * MB)} for{' '}
                  {referrals.data.bonusDays} days, up to{' '}
                  {formatBytes(referrals.data.maxBonusMb * MB)} at a time. Running now:{' '}
                  {formatBytes(referrals.data.bonusMb * MB)}.
                </p>
                <Link
                  to="/settings/$section"
                  params={{ section: 'referrals' }}
                  className={buttonClass('default', 'sm', 'mt-auto w-fit')}
                >
                  Get your invite link
                </Link>
              </div>
            )}
            {!viewerPaid && (
              <div className="flex flex-col gap-2">
                <p className="flex items-center gap-2 text-[13px] font-medium">
                  <Sparkles size={14} aria-hidden /> Change plan
                </p>
                <p className="text-[13px] leading-relaxed text-fg-muted">
                  {r.kind === 'org'
                    ? 'Business gives an organization 100 GB, 10,000 check minutes and up to 50 seats, plus single sign-on and policies.'
                    : 'Pro gives you 20 GB and 3,000 check minutes a month for private client work.'}
                </p>
                <Link
                  to="/checkout"
                  search={r.kind === 'org' ? { plan: 'team', owner } : { plan: 'pro' }}
                  className={buttonClass('accent', 'sm', 'mt-auto w-fit')}
                >
                  {r.kind === 'org' ? 'Get Business' : 'Get Pro'}
                </Link>
              </div>
            )}
          </div>
        </section>
      )}

      {r.repositories.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">By repository</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead>
                <tr className="border-b border-border-muted text-left text-xs text-fg-subtle">
                  <th className="py-2 pr-4 font-normal">Repository</th>
                  <th className="py-2 pr-4 text-right font-normal">Git</th>
                  <th className="py-2 pr-4 text-right font-normal">Outputs & large files</th>
                  <th className="py-2 text-right font-normal">Minutes</th>
                </tr>
              </thead>
              <tbody>
                {r.repositories.map((repo) => (
                  <tr key={repo.name} className="border-b border-border-muted last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs">
                      {r.owner}/{repo.name}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono tabular-nums text-fg-muted">
                      {formatBytes(repo.sizeBytes)}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono tabular-nums text-fg-muted">
                      {formatBytes(repo.outputsBytes)}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums text-fg-muted">
                      {repo.checkMinutes}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
