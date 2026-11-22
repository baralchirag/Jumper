import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreditCard, ExternalLink } from 'lucide-react';
import { CARD_PLANS, DEFAULT_PLANS, type BillingCycle, type BillingInfo, type CardPlanId } from '@jumper/shared';
import { Box, BoxHeader, Button, Flash, Label, SegmentedControl, cx } from '@jumper/ui';
import { api, errorMessage } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';

const enc = encodeURIComponent;
const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '');

/** What a Stripe status means to the person paying. */
function statusLine(b: BillingInfo): { text: string; tone: 'success' | 'attention' | 'danger' | 'default' } {
  const s = b.subscription!;
  if (s.cancelAtPeriodEnd) return { text: `Ends on ${day(s.periodEnd)}. You keep ${DEFAULT_PLANS[s.plan].name} until then.`, tone: 'attention' };
  switch (s.status) {
    case 'active':
    case 'trialing':
      return { text: `Renews on ${day(s.periodEnd)}.`, tone: 'success' };
    case 'past_due':
      return { text: 'Your last payment failed. Stripe is retrying it; update your card to keep your plan.', tone: 'danger' };
    case 'unpaid':
      return { text: 'Payment failed and the plan has been paused. Update your card to restore it.', tone: 'danger' };
    case 'incomplete':
      return { text: 'Waiting for the first payment to finish.', tone: 'attention' };
    default:
      return { text: `Status: ${s.status}`, tone: 'default' };
  }
}

/**
 * Card payments: choose a plan and pay with Stripe Checkout, or manage the subscription (change plan, cancel, card and
 * receipts in Stripe's portal). Shown on the Billing panel when the server has Stripe keys.
 */
export function CardBilling({ owner, billing: b, queryKey, isOrg }: { owner: string; billing: BillingInfo; queryKey: unknown[]; isOrg: boolean }) {
  const qc = useQueryClient();
  const sub = b.subscription;
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const wanted = params.get('plan');
  const [plan, setPlan] = useState<CardPlanId>(sub && (CARD_PLANS as readonly string[]).includes(sub.plan) ? (sub.plan as CardPlanId) : wanted === 'team' || (isOrg && wanted !== 'pro') ? 'team' : 'pro');
  const [cycle, setCycle] = useState<BillingCycle>(sub?.cycle ?? (params.get('cycle') === 'monthly' ? 'monthly' : 'annual'));
  const [returned] = useState(() => params.get('checkout'));
  const [error, setError] = useState<string | null>(null);

  // Back from Stripe: the webhook usually lands within seconds. Re-read until the subscription shows (or ~30 s pass).
  useEffect(() => {
    if (returned !== 'success' || sub) return;
    let n = 0;
    const t = setInterval(() => {
      n++;
      void qc.invalidateQueries({ queryKey });
      if (n >= 15) clearInterval(t);
    }, 2000);
    return () => clearInterval(t);
  }, [returned, sub, qc, queryKey]);
  // The plan shows in the header and usage panels too: refresh them once the subscription lands or changes.
  const subKey = sub ? `${sub.plan}:${sub.status}:${sub.cancelAtPeriodEnd}` : 'none';
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: keys.me });
    void qc.invalidateQueries({ queryKey: ['usage'] });
  }, [subKey, qc]);
  useEffect(() => {
    if (!returned) return;
    // Clean the URL so a reload doesn't show the message again.
    const u = new URL(window.location.href);
    u.searchParams.delete('checkout');
    window.history.replaceState(null, '', u.toString());
  }, [returned]);

  const go = useMutation({
    mutationFn: async (kind: 'checkout' | 'portal') => {
      const r = await api.post<{ url: string }>(`/owners/${enc(owner)}/billing/${kind}`, kind === 'checkout' ? { plan, cycle } : undefined);
      window.location.assign(r.url);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const update = useMutation({
    mutationFn: (action: 'change' | 'cancel' | 'resume') =>
      action === 'change'
        ? api.put<BillingInfo>(`/owners/${enc(owner)}/billing/subscription`, { plan, cycle })
        : api.post<BillingInfo>(`/owners/${enc(owner)}/billing/subscription/${action}`),
    onSuccess: (d) => {
      setError(null);
      qc.setQueryData(queryKey, d);
      void qc.invalidateQueries({ queryKey: ['usage'] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const unit = (p: CardPlanId, c: BillingCycle) => (c === 'annual' ? DEFAULT_PLANS[p].priceAnnualCents : DEFAULT_PLANS[p].priceMonthlyCents) ?? 0;
  const seats = Math.max(1, b.seats);
  const total = unit(plan, cycle) * seats;
  const changed = sub ? plan !== sub.plan || cycle !== sub.cycle : true;
  const busy = go.isPending || update.isPending;
  const status = sub ? statusLine(b) : null;

  return (
    <Box>
      <BoxHeader className="flex-col items-start gap-0.5">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <CreditCard size={15} aria-hidden /> {sub ? 'Card subscription' : 'Pay by card'}
        </h3>
        <p className="text-[13px] text-fg-muted">
          {sub ? 'Billed through Stripe. Seats follow the people with access, prorated.' : 'Choose a plan and pay securely with Stripe. Cancel any time; you keep the plan until the end of the period you paid for.'}
        </p>
      </BoxHeader>
      <div className="space-y-4 p-5">
        {returned === 'success' && !sub && <Flash tone="success">Payment received. Your plan switches on in a few seconds.</Flash>}
        {returned === 'success' && sub && <Flash tone="success">You're on {DEFAULT_PLANS[sub.plan].name}. Thank you.</Flash>}
        {returned === 'cancelled' && !sub && <Flash tone="info">Checkout was cancelled. Nothing was charged.</Flash>}
        {error && <Flash tone="danger">{error}</Flash>}

        {status && (
          <p className={cx('text-[13px]', status.tone === 'danger' ? 'text-danger' : status.tone === 'attention' ? 'text-attention' : 'text-fg-muted')}>
            <Label tone={status.tone === 'success' ? 'success' : status.tone === 'danger' ? 'danger' : 'attention'} className="mr-2">
              {sub!.cancelAtPeriodEnd ? 'Ending' : sub!.status === 'active' || sub!.status === 'trialing' ? 'Active' : sub!.status === 'past_due' ? 'Payment failed' : sub!.status}
            </Label>
            {status.text}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            size="sm"
            value={cycle}
            onChange={setCycle}
            ariaLabel="Billing cycle"
            options={[
              { value: 'monthly', label: 'Monthly' },
              { value: 'annual', label: 'Annual · 2 months free' },
            ]}
          />
        </div>
        <div role="radiogroup" aria-label="Plan" className="grid gap-2 sm:grid-cols-2">
          {CARD_PLANS.map((p) => {
            const on = plan === p;
            const limit = DEFAULT_PLANS[p].limits.seats;
            const tooSmall = limit !== null && seats > limit;
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={tooSmall}
                onClick={() => setPlan(p)}
                className={cx(
                  'flex flex-col items-start gap-0.5 rounded-md border px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-emphasis disabled:cursor-not-allowed disabled:opacity-50',
                  on ? 'border-fg bg-canvas ring-1 ring-fg' : 'border-border bg-canvas hover:border-fg-subtle',
                )}
              >
                <span className="flex w-full items-center gap-2 text-sm font-medium">
                  {DEFAULT_PLANS[p].name}
                  {sub?.plan === p && <Label className="ml-auto">Current</Label>}
                </span>
                <span className="text-[13px] tabular-nums">
                  {money(unit(p, cycle))} <span className="text-fg-muted">/ seat / {cycle === 'annual' ? 'year' : 'month'}</span>
                </span>
                <span className="text-xs text-fg-muted">{tooSmall ? `Up to ${limit} seats; you have ${seats}.` : DEFAULT_PLANS[p].blurb}</span>
              </button>
            );
          })}
        </div>
        <p className="text-[13px] text-fg-muted">
          {seats} {seats === 1 ? 'seat' : 'seats'} × {money(unit(plan, cycle))} = <b className="font-medium text-fg tabular-nums">{money(total)}</b> per {cycle === 'annual' ? 'year' : 'month'}, plus tax where it applies.
          {sub && changed && ' The difference is prorated on your next invoice.'}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {!sub && (
            <Button variant="accent" loading={go.isPending} disabled={busy} onClick={() => go.mutate('checkout')}>
              Continue to payment
            </Button>
          )}
          {sub && (
            <Button variant="primary" loading={update.isPending && update.variables === 'change'} disabled={busy || !changed} onClick={() => update.mutate('change')}>
              {changed ? `Switch to ${DEFAULT_PLANS[plan].name}, ${cycle}` : 'Current plan'}
            </Button>
          )}
          {b.subscription || b.invoices.some((i) => i.source === 'stripe') ? (
            <Button variant="default" leadingIcon={<ExternalLink size={14} />} loading={go.isPending && go.variables === 'portal'} disabled={busy} onClick={() => go.mutate('portal')}>
              Card, receipts and tax details
            </Button>
          ) : null}
          {sub &&
            (sub.cancelAtPeriodEnd ? (
              <Button variant="invisible" disabled={busy} onClick={() => update.mutate('resume')}>
                Keep my subscription
              </Button>
            ) : (
              <Button
                variant="invisible"
                className="ml-auto text-danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Cancel ${DEFAULT_PLANS[sub.plan].name}? You keep it until ${day(sub.periodEnd)}, then move to Free. Nothing is deleted.`)) update.mutate('cancel');
                }}
              >
                Cancel subscription
              </Button>
            ))}
        </div>
        {!sub && <p className="text-xs text-fg-subtle">Need Enterprise, or to pay by bank transfer against an invoice? Contact us and we'll set it up.</p>}
      </div>
    </Box>
  );
}
