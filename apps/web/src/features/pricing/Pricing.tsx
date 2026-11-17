import { useState } from 'react';
import { Link, Navigate, useSearch } from '@tanstack/react-router';
import { Check, Minus, Plus } from 'lucide-react';
import { DEFAULT_PLANS, FEATURE_LABELS, FREE_TRIAL_DAYS_DEFAULT, REFERRAL_BONUS_DAYS_DEFAULT, planFeatures, type BillingCycle, type Feature, type Plan, type PlanId } from '@jumper/shared';
import { SegmentedControl, buttonClass, cx } from '@jumper/ui';
import { PageContainer } from '../../shared/components/common';
import { useMe } from '../../shared/lib/queries';
import { isPaidPlan } from '../../shared/components/PlanBadge';

type Audience = 'personal' | 'organization';

/** What every plan gets: the product itself is never paywalled, only how much of it you use. */
const EVERY_PLAN = [
  'Unlimited public and private repositories',
  'Visual diffs of schematics and boards',
  'Pull requests with comments on parts, pads and tracks',
  'ERC and DRC on every push',
  'Renders, 3D, BOM pricing and fab packages',
  'Releases, issues and discussions',
];

const PLANS: Record<Audience, PlanId[]> = {
  personal: ['free', 'pro'],
  organization: ['free', 'team', 'enterprise'],
};

const mb = (v: number | null) => (v === null ? 'Unlimited' : v >= 1024 ? `${Math.round(v / 1024)} GB` : `${v} MB`);
const num = (v: number | null) => (v === null ? 'Unlimited' : v.toLocaleString('en-US'));

const dollars = (n: number) => `$${n % 1 === 0 ? n : n.toFixed(2)}`;

function price(plan: Plan, cycle: BillingCycle) {
  const cents = cycle === 'annual' ? plan.priceAnnualCents : plan.priceMonthlyCents;
  if (cents === null) return { amount: 'Custom', unit: 'Quoted for your team', note: null, was: null };
  if (cents === 0) return { amount: '$0', unit: `${FREE_TRIAL_DAYS_DEFAULT}-day trial, then pick a plan`, note: null, was: null };
  const perMonth = cycle === 'annual' ? cents / 12 / 100 : cents / 100;
  const monthly = (plan.priceMonthlyCents ?? 0) / 100;
  const saving = cycle === 'annual' && plan.priceMonthlyCents ? monthly * 12 - cents / 100 : 0;
  return {
    amount: dollars(perMonth),
    unit: cycle === 'annual' ? 'per seat / month, billed yearly' : 'per seat / month',
    note: saving > 0 ? `You save ${dollars(saving)} a year per seat` : `About ${dollars(Math.round((perMonth / 30) * 100) / 100)} a day`,
    was: cycle === 'annual' && monthly > perMonth ? dollars(monthly) : null,
  };
}

/** The free trial, told as what happens on which day: no surprises, and the next step is obvious. */
function TrialTimeline() {
  const steps = [
    { when: 'Day 1', title: 'Everything, free', body: `Create an account and push your boards. You get every feature and 2 GB of storage, no card needed.` },
    { when: `Day ${FREE_TRIAL_DAYS_DEFAULT}`, title: 'Your trial ends', body: 'Nothing is deleted. Your boards, history, reviews and fab files stay readable and downloadable.' },
    { when: 'Then', title: 'Pick a plan to keep pushing', body: `Pro keeps you going with 20 GB. Invite people to stretch the trial: each person who joins adds 1 GB for ${REFERRAL_BONUS_DAYS_DEFAULT} days.` },
  ];
  return (
    <section aria-labelledby="trial-h" className="mb-10 rounded-md border border-border bg-canvas p-6 md:p-8">
      <h2 id="trial-h" className="text-lg font-medium">How the free trial works</h2>
      <ol className="relative mt-6 grid gap-8 md:grid-cols-3 md:gap-6">
        <span aria-hidden className="absolute left-0 right-0 top-[9px] hidden h-0.5 bg-border md:block" />
        {steps.map((st, i) => (
          <li key={st.when} className="relative">
            <span aria-hidden className={cx('relative z-10 block h-5 w-5 rounded-full border-2', i === 2 ? 'border-select bg-accent-emphasis' : 'border-fg-muted bg-canvas')} />
            <p className="mt-4 font-mono text-[13px] text-fg-muted">{st.when}</p>
            <p className="mt-1 text-[16px] font-medium">{st.title}</p>
            <p className="mt-1.5 text-[14px] leading-relaxed text-fg-muted">{st.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

const FAQ = [
  { q: 'What happens when the 30-day trial ends?', a: 'Your repositories stay exactly as they are: readable, browsable and downloadable. Pushing new commits, files or outputs needs a paid plan. Pick one and you carry on where you left off.' },
  { q: 'Is any of my work deleted?', a: 'No. Nothing is removed when a trial ends or a plan changes. You can always export your repositories with git.' },
  { q: 'Can I get more free storage?', a: `Yes, for a while: every person who signs up through your invite link adds 1 GB to your storage for ${REFERRAL_BONUS_DAYS_DEFAULT} days.` },
  { q: 'Do you charge per repository or per board?', a: 'No. Repositories are unlimited. Plans differ in storage, check minutes and seats, and Business adds team controls like single sign-on and policies.' },
  { q: 'What counts as a seat?', a: 'An organization member, or a collaborator on a personal private repository. The owner counts as one.' },
  { q: 'Monthly or yearly?', a: 'Yearly billing costs ten months, so you get two months free. Monthly billing works too and you can switch.' },
  { q: 'How do I pay?', a: 'Online payment is opening soon. Until then the Jumper team switches your plan on and sends an invoice, so there is no card to enter.' },
];

export function PricingPage() {
  const { data: me } = useMe();
  const search = useSearch({ strict: false }) as { for?: Audience };
  const [audience, setAudience] = useState<Audience>(search.for ?? 'personal');
  const [cycle, setCycle] = useState<BillingCycle>('annual');
  const ids = PLANS[audience];
  const firstOrg = me?.orgs.find((o) => o.role === 'owner');

  const cta = (id: PlanId): { label: string; to: string; params?: Record<string, string>; search?: Record<string, string>; primary: boolean } => {
    if (!me) return { label: id === 'free' ? `Start your ${FREE_TRIAL_DAYS_DEFAULT}-day trial` : id === 'enterprise' ? 'Talk to us' : `Get ${DEFAULT_PLANS[id].name}`, to: '/signup', primary: id !== 'free' && id !== 'enterprise' };
    if (audience === 'personal') {
      return id === 'free' ? { label: 'See your trial', to: '/settings/$section', params: { section: 'usage' }, primary: false } : { label: 'Get Pro', to: '/settings/$section', params: { section: 'usage' }, primary: true };
    }
    if (!firstOrg) return { label: 'Create an organization', to: '/organizations/new', primary: id !== 'free' };
    return { label: id === 'enterprise' ? 'Talk to us' : id === 'free' ? 'Organization billing' : 'Upgrade organization', to: '/organizations/$org/settings/$section', params: { org: firstOrg.slug, section: 'billing' }, primary: id === 'team' };
  };

  // Someone already paying has no use for the sales page: send them to their plan instead.
  if (isPaidPlan(me?.plan)) return <Navigate to="/settings/$section" params={{ section: 'usage' }} replace />;

  // Comparison rows: limits, then the features that differ between plans.
  const all: PlanId[] = ['free', 'pro', 'team', 'enterprise'];
  const features = Object.keys(FEATURE_LABELS) as Feature[];

  return (
    <PageContainer className="max-w-[1280px] py-12 md:py-16">
      <header className="mb-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div>
          <h1 className="text-[clamp(2.5rem,1.6rem+2.6vw,4rem)] font-medium leading-[0.95]">Catch the respin before it ships.</h1>
          <p className="mt-4 max-w-xl text-[16px] leading-relaxed text-fg-muted">
            Every plan gets the whole product: visual diffs, review on the board, ERC and DRC on every push, and fab packages. Try it free for {FREE_TRIAL_DAYS_DEFAULT} days, then keep your boards moving from {dollars((DEFAULT_PLANS.pro.priceAnnualCents ?? 0) / 1200)} a month.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            size="md"
            value={audience}
            onChange={setAudience}
            ariaLabel="Plans for"
            options={[
              { value: 'personal', label: 'Personal' },
              { value: 'organization', label: 'Organization' },
            ]}
          />
          <SegmentedControl
            size="md"
            value={cycle}
            onChange={setCycle}
            ariaLabel="Billing period"
            options={[
              { value: 'monthly', label: 'Monthly' },
              { value: 'annual', label: 'Yearly · 2 months free' },
            ]}
          />
        </div>
      </header>

      <TrialTimeline />

      <div className={cx('grid border-y border-border md:border-x md:divide-x md:divide-border', ids.length === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3')}>
        {ids.map((id) => {
          const plan = DEFAULT_PLANS[id];
          const p = price(plan, cycle);
          const c = cta(id);
          const highlight = (audience === 'personal' && id === 'pro') || (audience === 'organization' && id === 'team');
          const extra = planFeatures(id);
          return (
            <section key={id} aria-labelledby={`plan-${id}`} className={cx('relative flex flex-col gap-6 border-b border-border p-6 last:border-b-0 md:border-b-0 md:p-8', highlight && 'bg-canvas')}>
              {highlight && <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-accent-emphasis" />}
              <div>
                <h2 id={`plan-${id}`} className="flex items-center gap-2 text-xl font-medium">
                  {plan.name}
                  {highlight && <span className="rounded-sm bg-accent-emphasis px-1.5 py-0.5 text-[11.5px] font-medium text-fg-on-accent">Recommended</span>}
                  {audience === 'organization' && id === 'free' && <span className="ml-2 text-sm font-normal text-fg-muted">for organizations</span>}
                </h2>
                <p className="mt-2 min-h-[3em] text-[14px] leading-relaxed text-fg-muted">{id === 'free' && audience === 'organization' ? 'For open-hardware groups and small teams getting started.' : plan.blurb}</p>
              </div>
              <div>
                <p className="flex items-baseline gap-2">
                  <span className="font-title text-[2.75rem] font-medium leading-none tracking-[-0.035em] tabular-nums">{p.amount}</span>
                  {p.was && <span className="text-lg text-fg-subtle line-through tabular-nums">{p.was}</span>}
                </p>
                <p className="mt-2 text-[13px] text-fg-muted">{p.unit}</p>
                {p.note && <p className="mt-1 text-[13px] font-medium text-success">{p.note}</p>}
              </div>
              <Link to={c.to} params={c.params as never} search={c.search as never} className={buttonClass(c.primary ? 'accent' : 'default', 'md', 'w-full')}>
                {c.label}
              </Link>
              <dl className="grid grid-cols-[1fr_auto] gap-y-2 border-t border-border pt-5 text-[14px]">
                <dt className="text-fg-muted">Storage</dt>
                <dd className="text-right tabular-nums">{id === 'free' ? `${mb(plan.limits.storageMb)} for ${FREE_TRIAL_DAYS_DEFAULT} days` : mb(plan.limits.storageMb)}</dd>
                <dt className="text-fg-muted">Check minutes</dt>
                <dd className="text-right tabular-nums">{plan.limits.checkMinutes === null ? 'Unlimited' : `${num(plan.limits.checkMinutes)} / month`}</dd>
                <dt className="text-fg-muted">Seats</dt>
                <dd className="text-right tabular-nums">{plan.limits.seats === null ? 'Unlimited' : `Up to ${num(plan.limits.seats)}`}</dd>
              </dl>
              {extra.length > 0 && (
                <ul className="flex flex-col gap-2 text-[14px]">
                  <li className="text-fg-muted">{id === 'enterprise' ? 'Everything in Business, and:' : 'Everything in Free, and:'}</li>
                  {(id === 'enterprise' ? extra.filter((f) => !planFeatures('team').includes(f)) : extra).map((f) => (
                    <li key={f} className="flex gap-2">
                      <Check size={16} aria-hidden className="mt-0.5 shrink-0 text-success" />
                      {FEATURE_LABELS[f]}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <section aria-labelledby="every-h" className="mt-12 grid gap-6 border-b border-border pb-12 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <h2 id="every-h" className="text-lg font-medium">In every plan</h2>
        <ul className="grid gap-x-8 gap-y-2.5 text-[15px] sm:grid-cols-2">
          {EVERY_PLAN.map((f) => (
            <li key={f} className="flex gap-2">
              <Check size={16} aria-hidden className="mt-1 shrink-0 text-success" />
              {f}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="value-h" className="mt-12 grid gap-6 rounded-md bg-fg p-8 text-canvas md:grid-cols-[minmax(0,2fr)_auto] md:items-center md:p-10">
        <div>
          <h2 id="value-h" className="font-title text-[clamp(1.6rem,1.2rem+1.2vw,2.25rem)] font-medium leading-tight tracking-[-0.03em]">
            One mistake caught in review can cost more than a year of Pro.
          </h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed opacity-80">
            A swapped footprint, a missed DRC error, a wrong value in the BOM: Jumper puts every change in front of your team as a board, before you order.
          </p>
        </div>
        <Link to={me ? '/settings/$section' : '/signup'} params={me ? ({ section: 'usage' } as never) : (undefined as never)} className={buttonClass('accent', 'md')}>
          {me ? 'Get Pro' : `Start your ${FREE_TRIAL_DAYS_DEFAULT}-day trial`}
        </Link>
      </section>

      <section aria-labelledby="compare-h" className="mt-12">
        <h2 id="compare-h" className="mb-5 text-lg font-medium">Compare plans</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-3 pr-4 font-medium text-fg-muted">
                  <span className="sr-only">Feature</span>
                </th>
                {all.map((id) => (
                  <th key={id} scope="col" className="px-3 py-3 font-medium">
                    {DEFAULT_PLANS[id].name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['Storage', (p: Plan) => (p.id === 'free' ? `${mb(p.limits.storageMb)}, first ${FREE_TRIAL_DAYS_DEFAULT} days` : mb(p.limits.storageMb))],
                  ['Check minutes per month', (p: Plan) => num(p.limits.checkMinutes)],
                  ['Seats', (p: Plan) => num(p.limits.seats)],
                ] as const
              ).map(([label, f]) => (
                <tr key={label} className="border-b border-border-muted">
                  <th scope="row" className="py-3 pr-4 font-normal text-fg-muted">
                    {label}
                  </th>
                  {all.map((id) => (
                    <td key={id} className="px-3 py-3 tabular-nums">
                      {f(DEFAULT_PLANS[id])}
                    </td>
                  ))}
                </tr>
              ))}
              {features.map((feat) => (
                <tr key={feat} className="border-b border-border-muted">
                  <th scope="row" className="py-3 pr-4 font-normal text-fg-muted">
                    {FEATURE_LABELS[feat]}
                  </th>
                  {all.map((id) => (
                    <td key={id} className="px-3 py-3">
                      {planFeatures(id).includes(feat) ? <Check size={16} aria-label="Included" className="text-success" /> : <Minus size={16} aria-label="Not included" className="text-fg-subtle" />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-6 max-w-2xl text-[13px] leading-relaxed text-fg-muted">
          The Free plan is a {FREE_TRIAL_DAYS_DEFAULT}-day storage trial: afterwards your work stays readable, and pushing new data needs a paid plan. Inviting people adds storage for {REFERRAL_BONUS_DAYS_DEFAULT} days per person who joins. Prices are in US dollars, per seat. A seat is an organization member, or a collaborator on a personal private repository. Online payment is not open yet: paid plans are switched on for you by the Jumper team and invoiced.
        </p>
      </section>
      <section aria-labelledby="faq-h" className="mt-16 grid gap-8 border-t border-border pt-12 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <h2 id="faq-h" className="text-lg font-medium">Questions</h2>
        <div className="divide-y divide-border-muted border-y border-border">
          {FAQ.map((f) => (
            <details key={f.q} className="group py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-medium">
                {f.q}
                <Plus size={16} aria-hidden className="shrink-0 text-fg-subtle transition-transform group-open:rotate-45" />
              </summary>
              <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-fg-muted">{f.a}</p>
            </details>
          ))}
        </div>
      </section>
    </PageContainer>
  );
}
