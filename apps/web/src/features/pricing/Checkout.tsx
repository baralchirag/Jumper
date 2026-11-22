import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Lock } from 'lucide-react';
import { DEFAULT_PLANS, type BillingCycle, type BillingInfo, type CardPlanId } from '@jumper/shared';
import { Button, Flash, FormField, Input, PageSpinner, Spinner, buttonClass } from '@jumper/ui';
import { PageContainer } from '../../shared/components/common';
import { ApiError, api, errorMessage } from '../../shared/lib/api';
import { keys, useMe } from '../../shared/lib/queries';

const enc = encodeURIComponent;
const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** "Acme Hardware Ltd" → "acme-hardware-ltd" (a suggestion; the field stays editable). */
const toSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39);

function Summary({ plan, cycle }: { plan: CardPlanId; cycle: BillingCycle }) {
  const p = DEFAULT_PLANS[plan];
  const unit = (cycle === 'annual' ? p.priceAnnualCents : p.priceMonthlyCents) ?? 0;
  return (
    <div className="rounded-md border border-border bg-canvas p-5">
      <p className="text-sm text-fg-muted">Jumper {p.name}</p>
      <p className="mt-1 font-title text-[2.25rem] font-medium leading-none tracking-[-0.03em] tabular-nums">
        {dollars(unit)}
        <span className="ml-1.5 font-sans text-[15px] font-normal tracking-normal text-fg-muted">per seat a {cycle === 'annual' ? 'year' : 'month'}</span>
      </p>
      <p className="mt-2 text-[13px] text-fg-muted">{p.blurb}</p>
      <ul className="mt-4 space-y-1.5 text-[13px]">
        <li className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-success" /> {p.limits.storageMb === null ? 'Unlimited' : `${p.limits.storageMb / 1024} GB`} storage, {p.limits.checkMinutes?.toLocaleString('en-US') ?? 'unlimited'} check minutes a month</li>
        <li className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-success" /> Up to {p.limits.seats ?? 'unlimited'} people</li>
        <li className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-success" /> Cancel any time; you keep it until the end of the period</li>
      </ul>
    </div>
  );
}

/**
 * One step from the pricing page to Stripe: signs you in if needed, picks the account to upgrade (your own for Pro;
 * your organization for Business, created on the spot if you have none), then opens Stripe's secure checkout.
 */
export function CheckoutPage() {
  const search = useSearch({ strict: false }) as { plan?: string; cycle?: string; owner?: string };
  const plan: CardPlanId = search.plan === 'team' ? 'team' : 'pro';
  const cycle: BillingCycle = search.cycle === 'monthly' ? 'monthly' : 'annual';
  const { data: me, isLoading } = useMe();
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<{ cardPayments: boolean }>('/plans'), staleTime: 5 * 60_000 });
  const [owner, setOwner] = useState<string | null>(search.owner ?? null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const started = useRef<string | null>(null);
  const [org, setOrg] = useState({ name: '', slug: '', touched: false });
  const [creating, setCreating] = useState(false);

  const owned = me?.orgs.filter((o) => o.role === 'owner') ?? [];
  // Pro is for your own account. Business goes to an organization: the only one you own, or the one you pick.
  const target = owner ?? (plan === 'pro' ? (me?.username ?? null) : owned.length === 1 ? owned[0]!.slug : null);

  const start = async (who: string) => {
    if (started.current === who) return;
    started.current = who;
    setError(null);
    try {
      const r = await api.post<{ url: string }>(`/owners/${enc(who)}/billing/checkout`, { plan, cycle, from: 'pricing' });
      window.location.assign(r.url);
    } catch (e) {
      started.current = null;
      if (e instanceof ApiError && e.status === 409) setConflict(who);
      else setError(errorMessage(e));
    }
  };

  useEffect(() => {
    if (me && target && plans.data?.cardPayments) void start(target);
    // start is stable enough for this one-shot effect
  }, [me, target, plans.data?.cardPayments]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || plans.isLoading) return <PageSpinner />;
  const here = `/checkout?plan=${plan}&cycle=${cycle}${search.owner ? `&owner=${enc(search.owner)}` : ''}`;
  if (!me) return <Navigate to="/signup" search={{ redirect: here }} replace />;

  const createOrg = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/orgs', { name: org.name.trim(), slug: org.slug });
      await qc.invalidateQueries({ queryKey: keys.me });
      setOwner(org.slug);
    } catch (err) {
      setError(errorMessage(err));
      setCreating(false);
    }
  };

  const billingLink = (who: string) =>
    who === me.username ? (
      <Link to="/settings/$section" params={{ section: 'usage' }} className={buttonClass('default')}>Open billing</Link>
    ) : (
      <Link to="/organizations/$org/settings/$section" params={{ org: who, section: 'billing' }} className={buttonClass('default')}>Open billing</Link>
    );

  let body: React.ReactNode;
  if (!plans.data?.cardPayments) {
    body = (
      <Flash tone="warning">
        Card payments aren't switched on for this site yet. Set <code className="font-mono">STRIPE_SECRET_KEY</code> and <code className="font-mono">STRIPE_WEBHOOK_SECRET</code> on the server, or contact us and we'll set up your plan by invoice.
      </Flash>
    );
  } else if (conflict) {
    body = (
      <div className="space-y-3">
        <Flash tone="info">{conflict === me.username ? 'You already pay by card.' : `${conflict} already pays by card.`} Change the plan from billing.</Flash>
        {billingLink(conflict)}
      </div>
    );
  } else if (target) {
    body = error ? (
      <div className="space-y-3">
        <Flash tone="danger">{error}</Flash>
        <Button variant="accent" onClick={() => void start(target)}>Try again</Button>
      </div>
    ) : (
      <p className="flex items-center gap-2 text-[15px] text-fg-muted">
        <Spinner size={16} /> Opening secure checkout{plan === 'team' ? ` for ${target}` : ''}…
      </p>
    );
  } else if (owned.length > 1) {
    body = (
      <div>
        <p className="mb-3 text-[15px]">Which organization is this for?</p>
        <div className="grid gap-2">
          {owned.map((o) => (
            <button key={o.slug} type="button" onClick={() => setOwner(o.slug)} className="flex items-center justify-between rounded-md border border-border bg-canvas px-4 py-3 text-left hover:border-fg">
              <span className="font-medium">{o.name}</span>
              <span className="font-mono text-xs text-fg-muted">{o.slug}</span>
            </button>
          ))}
        </div>
      </div>
    );
  } else {
    body = (
      <form onSubmit={createOrg} className="space-y-4">
        <p className="text-[15px]">Business is for a team, so it belongs to an organization. Name yours and we'll take you to payment.</p>
        {error && <Flash tone="danger">{error}</Flash>}
        <FormField label="Organization name" required>
          {(id) => (
            <Input
              id={id}
              autoFocus
              required
              placeholder="Acme Hardware"
              value={org.name}
              onChange={(e) => setOrg({ name: e.target.value, slug: org.touched ? org.slug : toSlug(e.target.value), touched: org.touched })}
            />
          )}
        </FormField>
        <FormField label="Address" hint={`jumper / ${org.slug || 'acme-hardware'}`}>
          {(id) => <Input id={id} required pattern="[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*" value={org.slug} onChange={(e) => setOrg({ ...org, slug: e.target.value, touched: true })} className="font-mono" />}
        </FormField>
        <Button type="submit" variant="accent" loading={creating} disabled={!org.name.trim() || !org.slug}>
          Create and continue to payment
        </Button>
      </form>
    );
  }

  return (
    <PageContainer className="max-w-3xl py-12 md:py-16">
      <Link to="/pricing" className="text-sm text-fg-muted no-underline hover:text-fg">← Plans</Link>
      <h1 className="headline mt-4 text-[length:var(--t-l)]">Get {DEFAULT_PLANS[plan].name}</h1>
      <div className="mt-8 grid gap-8 md:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0">{body}</div>
        <aside className="space-y-3">
          <Summary plan={plan} cycle={cycle} />
          <p className="flex items-start gap-2 text-xs text-fg-subtle">
            <Lock size={12} className="mt-0.5 shrink-0" /> Payment is handled by Stripe. Your card details never reach Jumper.
          </p>
        </aside>
      </div>
    </PageContainer>
  );
}

/** Where Stripe sends people after paying: waits for the plan to switch on, then says so. */
export function CheckoutDonePage() {
  const search = useSearch({ strict: false }) as { owner?: string; plan?: string };
  const { data: me } = useMe();
  const qc = useQueryClient();
  const owner = search.owner ?? me?.username ?? '';
  const [tries, setTries] = useState(0);
  const q = useQuery({
    queryKey: ['billing', owner],
    // Ask Stripe directly rather than wait for the webhook.
    queryFn: () => api.post<BillingInfo>(`/owners/${enc(owner)}/billing/sync`),
    enabled: Boolean(owner && me),
    refetchInterval: (query) => (query.state.data?.subscription || tries > 20 ? false : 1500),
  });
  const active = q.data?.subscription;
  useEffect(() => {
    if (q.dataUpdatedAt) setTries((t) => t + 1);
  }, [q.dataUpdatedAt]);
  useEffect(() => {
    if (!active) return;
    void qc.invalidateQueries({ queryKey: keys.me });
    void qc.invalidateQueries({ queryKey: ['usage'] });
  }, [active, qc]);

  const planName = DEFAULT_PLANS[active?.plan ?? (search.plan === 'team' ? 'team' : 'pro')].name;
  const isOrg = Boolean(me && owner.toLowerCase() !== me.username.toLowerCase());
  return (
    <PageContainer className="max-w-xl py-16 text-center md:py-24">
      {active ? (
        <>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success-subtle text-success">
            <Check size={24} />
          </div>
          <h1 className="headline mt-5 text-[length:var(--t-l)]">You're on {planName}</h1>
          <p className="mt-3 text-[15px] text-fg-muted">
            {isOrg ? `${owner} now has` : 'You now have'} {planName}. A receipt is on its way from Stripe.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-2">
            <Link to="/" className={buttonClass('accent', 'md')}>Back to your boards</Link>
            {isOrg ? (
              <Link to="/organizations/$org/settings/$section" params={{ org: owner, section: 'billing' }} className={buttonClass('default', 'md')}>Billing</Link>
            ) : (
              <Link to="/settings/$section" params={{ section: 'usage' }} className={buttonClass('default', 'md')}>Billing</Link>
            )}
          </div>
        </>
      ) : tries > 20 ? (
        <>
          <h1 className="headline text-[length:var(--t-l)]">Payment received</h1>
          <p className="mt-3 text-[15px] text-fg-muted">Your plan is taking longer than usual to switch on. It will appear within a few minutes; there's no need to pay again.</p>
          <Link to="/settings/$section" params={{ section: 'usage' }} className={buttonClass('default', 'md', 'mt-8')}>Open billing</Link>
        </>
      ) : (
        <>
          <Spinner size={28} className="mx-auto text-fg-muted" />
          <h1 className="headline mt-5 text-[length:var(--t-l)]">Payment received</h1>
          <p className="mt-3 text-[15px] text-fg-muted">Switching on {planName}…</p>
        </>
      )}
    </PageContainer>
  );
}
