import { useState } from 'react';
import { Link, Navigate } from '@tanstack/react-router';
import { Check, Minus, Plus } from 'lucide-react';
import { DEFAULT_PLANS, FEATURE_LABELS, FREE_TRIAL_DAYS_DEFAULT, REFERRAL_BONUS_DAYS_DEFAULT, planFeatures, type BillingCycle, type Feature, type Plan, type PlanId } from '@jumper/shared';
import { SegmentedControl, buttonClass, cx } from '@jumper/ui';
import { PageContainer } from '../../shared/components/common';
import { useMe } from '../../shared/lib/queries';
import { isPaidPlan } from '../../shared/components/PlanBadge';

/** What every plan does. Plans differ only in how much you can store and run, and in team admin. */
const EVERY_PLAN = [
  'Pull from GitHub, GitLab or any git host',
  'Visual diffs of schematics and boards, in 2D and 3D',
  'ERC and DRC on every commit',
  'Comments on parts and board areas',
  'Parts list with prices and stock from LCSC and JLCPCB',
  'Fab packages for JLCPCB, PCBWay and OSH Park',
  'Read-only share links',
];

/** Who each plan is for, in one line. */
const FOR: Record<PlanId, string> = {
  free: 'Try Jumper on your own boards. No card needed.',
  pro: 'For a designer or a small team.',
  team: 'For hardware teams that need single sign-on, roles and an audit log.',
  enterprise: 'For companies with compliance needs: SAML, SCIM, legal hold, export control.',
};

const mb = (v: number | null) => (v === null ? 'Unlimited' : v >= 1024 ? `${Math.round(v / 1024)} GB` : `${v} MB`);
const num = (v: number | null) => (v === null ? 'Unlimited' : v.toLocaleString('en-US'));
const dollars = (n: number) => `$${n % 1 === 0 ? n : n.toFixed(2)}`;

function price(plan: Plan, cycle: BillingCycle): { amount: string; unit: string } {
  const cents = cycle === 'annual' ? plan.priceAnnualCents : plan.priceMonthlyCents;
  if (cents === null) return { amount: 'Custom', unit: 'Priced for your team' };
  if (cents === 0) return { amount: '$0', unit: `for ${FREE_TRIAL_DAYS_DEFAULT} days` };
  return cycle === 'annual' ? { amount: dollars(cents / 100), unit: 'per seat a year' } : { amount: dollars(cents / 100), unit: 'per seat a month' };
}

const FAQ = [
  {
    q: 'How does the trial work?',
    a: `Sign up and you get every feature and ${mb(DEFAULT_PLANS.free.limits.storageMb)} of storage for ${FREE_TRIAL_DAYS_DEFAULT} days, without a card. When it ends nothing is deleted: your boards, history, check results and fab files stay readable and downloadable. Pushing new commits needs a paid plan.`,
  },
  { q: 'What are check minutes?', a: 'The time Jumper spends running kicad-cli on your commits: ERC, DRC, renders, the 3D model and fab files. Commits on any branch count.' },
  { q: 'What counts as a seat?', a: 'A member of an organization, or a collaborator on one of your private repositories. You count as one.' },
  { q: 'Do you charge per repository or per board?', a: 'No. Repositories and boards are unlimited on every plan.' },
  { q: 'Can I get more trial storage?', a: `Yes. Each person who signs up with your invite link adds 1 GB for ${REFERRAL_BONUS_DAYS_DEFAULT} days.` },
  { q: 'Monthly or yearly?', a: 'Yearly costs the same as ten months. You can switch between them.' },
  { q: 'How do I pay?', a: 'Card payment isn’t open yet. Until it is, we switch your plan on by hand and send an invoice.' },
];

export function PricingPage() {
  const { data: me } = useMe();
  const [cycle, setCycle] = useState<BillingCycle>('annual');
  const firstOrg = me?.orgs.find((o) => o.role === 'owner');

  const cta = (id: PlanId): { label: string; to: string; params?: Record<string, string>; primary: boolean } => {
    if (!me) return { label: id === 'free' ? 'Start the trial' : id === 'enterprise' ? 'Contact us' : `Get ${DEFAULT_PLANS[id].name}`, to: '/signup', primary: id === 'pro' };
    if (id === 'free' || id === 'pro') return id === 'free' ? { label: 'See your trial', to: '/settings/$section', params: { section: 'usage' }, primary: false } : { label: 'Get Pro', to: '/settings/$section', params: { section: 'usage' }, primary: true };
    if (!firstOrg) return { label: 'Create an organization', to: '/organizations/new', primary: false };
    return { label: id === 'enterprise' ? 'Contact us' : 'Upgrade organization', to: '/organizations/$org/settings/$section', params: { org: firstOrg.slug, section: 'billing' }, primary: false };
  };

  // Someone already paying has no use for the sales page: send them to their plan instead.
  if (isPaidPlan(me?.plan)) return <Navigate to="/settings/$section" params={{ section: 'usage' }} replace />;

  const all: PlanId[] = ['free', 'pro', 'team', 'enterprise'];
  const features = Object.keys(FEATURE_LABELS) as Feature[];

  return (
    <PageContainer className="max-w-[1280px] py-12 md:py-16">
      <header className="mb-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div>
          <h1 className="text-[clamp(2.5rem,1.6rem+2.6vw,4rem)] font-medium leading-[0.95]">Pricing</h1>
          <p className="mt-4 max-w-xl text-[16px] leading-relaxed text-fg-muted">
            Every plan runs the same diffs and checks on your boards. Plans differ in storage, check minutes and seats. Business and Enterprise add admin for larger teams.
          </p>
        </div>
        <SegmentedControl
          size="md"
          value={cycle}
          onChange={setCycle}
          ariaLabel="Billing period"
          options={[
            { value: 'monthly', label: 'Monthly' },
            { value: 'annual', label: 'Yearly, 2 months free' },
          ]}
        />
      </header>

      <div className="grid border-l border-t border-border sm:grid-cols-2 lg:grid-cols-4">
        {all.map((id) => {
          const plan = DEFAULT_PLANS[id];
          const p = price(plan, cycle);
          const c = cta(id);
          const added = id === 'enterprise' ? planFeatures(id).filter((f) => !planFeatures('team').includes(f)) : planFeatures(id);
          return (
            <section key={id} aria-labelledby={`plan-${id}`} className={cx('relative flex flex-col border-b border-r border-border p-6', id === 'pro' && 'before:absolute before:inset-x-0 before:-top-px before:h-[3px] before:bg-accent-emphasis')}>
              <h2 id={`plan-${id}`} className="text-[19px] font-medium">
                {id === 'free' ? 'Free trial' : plan.name}
              </h2>
              <p className="mt-1.5 min-h-[2.8em] text-[14px] leading-snug text-fg-muted">{FOR[id]}</p>
              <p className="mt-6 font-title text-[2.5rem] font-medium leading-none tracking-[-0.035em] tabular-nums">{p.amount}</p>
              <p className="mt-2 min-h-[2.6em] text-[13px] leading-snug text-fg-muted">{p.unit}</p>
              <Link to={c.to} params={c.params as never} className={buttonClass(c.primary ? 'accent' : 'default', 'md', 'mt-4 w-full')}>
                {c.label}
              </Link>
              <dl className="mt-6 grid grid-cols-[1fr_auto] gap-y-2 text-[14px]">
                <dt className="text-fg-muted">Storage</dt>
                <dd className="text-right tabular-nums">{mb(plan.limits.storageMb)}</dd>
                <dt className="text-fg-muted">Check minutes</dt>
                <dd className="text-right tabular-nums">{plan.limits.checkMinutes === null ? 'Unlimited' : `${num(plan.limits.checkMinutes)} a month`}</dd>
                <dt className="text-fg-muted">Seats</dt>
                <dd className="text-right tabular-nums">{plan.limits.seats === null ? 'Unlimited' : `Up to ${num(plan.limits.seats)}`}</dd>
              </dl>
              {added.length > 0 && (
                <ul className="mt-6 flex flex-col gap-1.5 border-t border-border-muted pt-4 text-[14px]">
                  <li className="text-fg-muted">{id === 'enterprise' ? 'Everything in Business, plus' : 'Everything in Pro, plus'}</li>
                  {added.map((f) => (
                    <li key={f} className="flex gap-2">
                      <Check size={15} aria-hidden className="mt-0.5 shrink-0 text-fg-muted" />
                      {FEATURE_LABELS[f]}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <section aria-labelledby="every-h" className="mt-14 grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <h2 id="every-h" className="text-lg font-medium">In every plan, the trial included</h2>
        <ul className="grid gap-x-8 gap-y-2.5 text-[15px] sm:grid-cols-2">
          {EVERY_PLAN.map((f) => (
            <li key={f} className="flex gap-2">
              <Check size={16} aria-hidden className="mt-1 shrink-0 text-fg-muted" />
              {f}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="compare-h" className="mt-14 border-t border-border pt-10">
        <h2 id="compare-h" className="mb-5 text-lg font-medium">Compare plans</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-3 pr-4 font-medium text-fg-muted">
                  <span className="sr-only">Feature</span>
                </th>
                {all.map((id) => (
                  <th key={id} scope="col" className="w-[16%] px-3 py-3 font-medium">
                    {id === 'free' ? 'Free trial' : DEFAULT_PLANS[id].name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['Storage', (p: Plan) => mb(p.limits.storageMb)],
                  ['Check minutes a month', (p: Plan) => num(p.limits.checkMinutes)],
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
                      {planFeatures(id).includes(feat) ? <Check size={16} aria-label="Included" /> : <Minus size={16} aria-label="Not included" className="text-fg-subtle" />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-[13px] text-fg-muted">Prices in US dollars, per seat.</p>
      </section>

      <section aria-labelledby="faq-h" className="mt-14 grid gap-8 border-t border-border pt-10 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
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
