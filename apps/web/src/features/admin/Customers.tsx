import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Search } from 'lucide-react';
import { DEFAULT_PLANS, type AdminCustomerDetail, type AdminCustomerRow, type AdminCustomers, type InvoiceInfo } from '@jumper/shared';
import { Avatar, Input, Label, PageSpinner, RelativeTime, SegmentedControl, cx } from '@jumper/ui';
import { ErrorView, formatBytes } from '../../shared/components/common';
import { api } from '../../shared/lib/api';
import { AdminLayout } from './Admin';

const money = (cents: number | null | undefined) => (cents === null || cents === undefined ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const enc = encodeURIComponent;

const METHOD: Record<AdminCustomerRow['method'], string> = { card: 'Card (Stripe)', invoice: 'Invoice', assigned: 'Assigned, not billed' };

/** What the subscription state means, in a word. */
function State({ r }: { r: AdminCustomerRow }) {
  if (r.cancelAtPeriodEnd) return <Label tone="attention">Cancelling</Label>;
  if (r.status === 'past_due') return <Label tone="danger">Payment failed</Label>;
  if (r.status === 'unpaid') return <Label tone="danger">Unpaid</Label>;
  if (r.status === 'canceled') return <Label>Ended</Label>;
  if (r.status === 'incomplete') return <Label tone="attention">Incomplete</Label>;
  if (r.plan === 'free') return <Label>Free</Label>;
  if (r.openCents > 0) return <Label tone="attention">Invoice due</Label>;
  return <Label tone="success">Active</Label>;
}

function Kpi({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="border-b border-r border-border-muted px-4 py-3">
      <span className="block text-xs text-fg-muted">{label}</span>
      <span className="mt-1 block font-mono text-xl tabular-nums tracking-tight">{value}</span>
      {hint && <span className="block text-[11px] text-fg-subtle">{hint}</span>}
    </div>
  );
}

/** Everyone who pays (or has been on a paid plan): plan, method, dates, money. */
export function AdminCustomersPage() {
  const q = useQuery({ queryKey: ['admin', 'customers'], queryFn: () => api.get<AdminCustomers>('/admin/customers') });
  const [filter, setFilter] = useState('');
  const [show, setShow] = useState<'paying' | 'all'>('paying');
  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    return (q.data?.rows ?? []).filter((r) => (show === 'all' || r.mrrCents > 0 || r.status === 'past_due') && (!f || `${r.owner} ${r.name ?? ''} ${r.contactEmails.join(' ')}`.toLowerCase().includes(f)));
  }, [q.data, filter, show]);

  return (
    <AdminLayout section="customers" wide>
      {q.isLoading ? (
        <PageSpinner />
      ) : q.error ? (
        <ErrorView error={q.error} />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 border-l border-t border-border-muted sm:grid-cols-4 lg:grid-cols-7">
            <Kpi label="Paying accounts" value={q.data!.totals.paying} />
            <Kpi label="Monthly recurring" value={money(q.data!.totals.mrrCents)} hint="at list price" />
            <Kpi label="Yearly recurring" value={money(q.data!.totals.arrCents)} />
            <Kpi label="Collected, all time" value={money(q.data!.totals.collectedCents)} hint="paid invoices" />
            <Kpi label="Outstanding" value={money(q.data!.totals.openCents)} hint="open invoices" />
            <Kpi label="Payment failed" value={q.data!.totals.pastDue} />
            <Kpi label="Cancelling" value={q.data!.totals.cancelling} />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="relative">
              <span className="sr-only">Search customers</span>
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name, account or email" className="h-8 w-72 pl-8 text-[13px]" />
            </label>
            <SegmentedControl
              size="sm"
              value={show}
              onChange={setShow}
              ariaLabel="Which customers"
              options={[
                { value: 'paying', label: 'Paying now' },
                { value: 'all', label: 'Everyone billed' },
              ]}
            />
            <span className="ml-auto text-xs text-fg-subtle">{rows.length} shown</span>
          </div>

          {rows.length === 0 ? (
            <p className="border-y border-border py-12 text-center text-[13px] text-fg-muted">{show === 'paying' ? 'Nobody is paying yet.' : 'No billed accounts yet.'}</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border bg-canvas">
              <table className="w-full min-w-[1100px] text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-fg-subtle">
                    <th className="px-4 py-2 font-normal">Customer</th>
                    <th className="px-3 py-2 font-normal">Plan</th>
                    <th className="px-3 py-2 font-normal">Paying by</th>
                    <th className="px-3 py-2 font-normal">State</th>
                    <th className="px-3 py-2 font-normal">Since</th>
                    <th className="px-3 py-2 font-normal">Paid through</th>
                    <th className="px-3 py-2 text-right font-normal">Seats</th>
                    <th className="px-3 py-2 text-right font-normal">Monthly</th>
                    <th className="px-3 py-2 text-right font-normal">Paid in total</th>
                    <th className="px-4 py-2 font-normal">Last payment</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.owner} className="border-b border-border-muted last:border-0 hover:bg-canvas-subtle">
                      <td className="px-4 py-2.5">
                        <Link to="/admin/customers/$owner" params={{ owner: r.owner }} className="flex items-center gap-2.5 no-underline">
                          <Avatar name={r.owner} src={r.avatarUrl} size={26} square={r.kind === 'org'} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-fg hover:text-accent">{r.name ?? r.owner}</span>
                            <span className="block truncate text-xs text-fg-muted">
                              {r.owner}
                              {r.kind === 'org' ? ' · organization' : ''} · {r.contactEmails[0] ?? 'no email'}
                            </span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-3 py-2.5">
                        {DEFAULT_PLANS[r.plan].name} <span className="text-xs text-fg-subtle">{r.plan !== 'free' ? r.cycle : ''}</span>
                      </td>
                      <td className="px-3 py-2.5 text-fg-muted">{METHOD[r.method]}</td>
                      <td className="px-3 py-2.5"><State r={r} /></td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-fg-muted">{day(r.startedAt)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-fg-muted">{day(r.paidThrough)}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">{r.seats}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">{money(r.mrrCents)}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">{money(r.totalPaidCents)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">
                        {r.lastPaymentAt ? (
                          <>
                            {money(r.lastPaymentCents)} · <RelativeTime date={r.lastPaymentAt} />
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-fg-subtle">Monthly figures are at list price for the seats in use (annual plans divided by 12). Totals come from paid invoices: Stripe's for card customers, administrator-raised ones for invoice customers.</p>
        </div>
      )}
    </AdminLayout>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border-muted py-2 text-[13px] last:border-0">
      <dt className="shrink-0 text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-canvas">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {action && <span className="ml-auto">{action}</span>}
      </header>
      <div className="px-4 py-2">{children}</div>
    </section>
  );
}

const ACTION: Record<string, string> = {
  'billing.checkout': 'Started checkout',
  'billing.plan.change': 'Changed plan',
  'billing.cancel': 'Cancelled (at period end)',
  'billing.resume': 'Kept subscription',
  'billing.update': 'Updated billing details',
  'admin.plan.set': 'Plan set by administrator',
  'admin.invoice.create': 'Invoice raised',
  'admin.invoice.paid': 'Invoice marked paid',
  'admin.invoice.open': 'Invoice issued',
  'admin.invoice.void': 'Invoice voided',
};

function invoiceLink(i: InvoiceInfo, owner: string) {
  return i.source === 'stripe' && i.hostedUrl ? (
    <a href={i.hostedUrl} target="_blank" rel="noreferrer" className="link font-mono">{i.number}</a>
  ) : (
    <Link to="/billing/$owner/invoices/$id" params={{ owner, id: i.id }} className="link font-mono">{i.number}</Link>
  );
}

/** One customer: who they are, what they pay, every invoice, who holds seats, and the billing history. */
export function AdminCustomerPage() {
  const { owner } = useParams({ strict: false }) as { owner: string };
  const q = useQuery({ queryKey: ['admin', 'customer', owner], queryFn: () => api.get<AdminCustomerDetail>(`/admin/customers/${enc(owner)}`) });
  const c = q.data;
  return (
    <AdminLayout section="customers" wide>
      <Link to="/admin/customers" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-fg-muted no-underline hover:text-fg">
        <ArrowLeft size={13} /> Customers
      </Link>
      {q.isLoading ? (
        <PageSpinner />
      ) : q.error || !c ? (
        <ErrorView error={q.error} />
      ) : (
        <div className="space-y-6">
          <header className="flex flex-wrap items-center gap-4">
            <Avatar name={c.owner} src={c.avatarUrl} size={48} square={c.kind === 'org'} />
            <div className="min-w-0">
              <h1 className="text-xl font-medium tracking-tight">{c.name ?? c.owner}</h1>
              <p className="text-[13px] text-fg-muted">
                <Link to="/$owner" params={{ owner: c.owner }} className="link">{c.owner}</Link> · {c.kind === 'org' ? 'Organization' : 'Personal account'} · joined {day(c.createdAt)}
              </p>
            </div>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <State r={c} />
              {c.stripeDashboardUrl && (
                <a href={c.stripeDashboardUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-sm border border-border px-2.5 py-1 text-[13px] no-underline hover:border-fg">
                  Open in Stripe <ExternalLink size={12} />
                </a>
              )}
            </span>
          </header>

          <div className="grid grid-cols-2 border-l border-t border-border-muted sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label="Plan" value={`${DEFAULT_PLANS[c.plan].name}`} hint={c.plan !== 'free' ? `${c.cycle}, ${METHOD[c.method].toLowerCase()}` : undefined} />
            <Kpi label="Monthly" value={money(c.mrrCents)} hint="list price" />
            <Kpi label="Paid in total" value={money(c.totalPaidCents)} hint={`${c.invoicesPaid} paid invoice${c.invoicesPaid === 1 ? '' : 's'}`} />
            <Kpi label="Customer since" value={day(c.startedAt)} />
            <Kpi label={c.cancelAtPeriodEnd ? 'Ends on' : 'Paid through'} value={day(c.paidThrough)} />
            <Kpi label="Outstanding" value={money(c.openCents)} />
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Panel title={c.kind === 'org' ? 'Organization' : 'Profile'}>
              <dl>
                {c.kind === 'user' ? (
                  <>
                    <Field label="Username">{c.profile.username}</Field>
                    <Field label="Email">
                      <a href={`mailto:${c.profile.email}`} className="link">{c.profile.email}</a> {c.profile.emailVerified ? <Label tone="success">verified</Label> : <Label>unverified</Label>}
                    </Field>
                    {c.profile.company && <Field label="Company">{c.profile.company}</Field>}
                    {c.profile.location && <Field label="Location">{c.profile.location}</Field>}
                    {c.profile.website && <Field label="Website"><a href={c.profile.website} target="_blank" rel="noreferrer" className="link">{c.profile.website}</a></Field>}
                    <Field label="Two-factor">{c.profile.twoFactor ? 'On' : 'Off'}</Field>
                    <Field label="Last sign-in">{c.profile.lastSignInAt ? <RelativeTime date={c.profile.lastSignInAt} /> : '—'}</Field>
                    {c.profile.disabled && <Field label="Account"><Label tone="danger">Suspended</Label></Field>}
                    {c.profile.bio && <p className="py-2 text-[13px] text-fg-muted">{c.profile.bio}</p>}
                  </>
                ) : (
                  <>
                    <Field label="Owners">{c.contactEmails.map((e) => <a key={e} href={`mailto:${e}`} className="link block">{e}</a>)}</Field>
                    <Field label="Members">{c.members.length}</Field>
                    {c.profile.description && <p className="py-2 text-[13px] text-fg-muted">{c.profile.description}</p>}
                  </>
                )}
                <Field label="Repositories">{c.repositories}</Field>
                <Field label="Storage used">{formatBytes(c.storageBytes)}</Field>
                <Field label="Check minutes this month">{c.checkMinutes}</Field>
              </dl>
            </Panel>

            <Panel title="Subscription">
              <dl>
                <Field label="Plan">{DEFAULT_PLANS[c.plan].name}, {c.cycle}</Field>
                <Field label="Paying by">{METHOD[c.method]}</Field>
                <Field label="Status">{c.status ?? (c.plan === 'free' ? 'none' : 'manual')}</Field>
                <Field label="Started">{day(c.startedAt)}</Field>
                <Field label={c.cancelAtPeriodEnd ? 'Ends' : 'Renews / paid through'}>{day(c.paidThrough)}</Field>
                <Field label="Seats billed">{c.seats}</Field>
                <Field label="Monthly at list price">{money(c.mrrCents)}</Field>
                {c.stripeCustomerId && <Field label="Stripe customer"><span className="font-mono text-xs">{c.stripeCustomerId}</span></Field>}
                {c.stripeSubscriptionId && <Field label="Stripe subscription"><span className="font-mono text-xs">{c.stripeSubscriptionId}</span></Field>}
              </dl>
            </Panel>

            <Panel title="Billing details">
              <dl>
                <Field label="Invoice email">{c.billingProfile.email || '—'}</Field>
                <Field label="Billed to">{c.billingProfile.company || '—'}</Field>
                <Field label="Address"><span className="whitespace-pre-line">{c.billingProfile.address || '—'}</span></Field>
                <Field label="Tax ID"><span className="font-mono">{c.billingProfile.taxId || '—'}</span></Field>
                <Field label="PO number"><span className="font-mono">{c.billingProfile.poNumber || '—'}</span></Field>
              </dl>
            </Panel>
          </div>

          <Panel title={`Invoices (${c.invoices.length})`}>
            {c.invoices.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-fg-muted">No invoices yet.</p>
            ) : (
              <div className="-mx-4 overflow-x-auto">
                <table className="w-full min-w-[700px] text-[13px]">
                  <thead>
                    <tr className="border-b border-border-muted text-left text-xs text-fg-subtle">
                      <th className="px-4 py-2 font-normal">Invoice</th>
                      <th className="px-3 py-2 font-normal">Source</th>
                      <th className="px-3 py-2 font-normal">Period</th>
                      <th className="px-3 py-2 font-normal">Status</th>
                      <th className="px-3 py-2 font-normal">Paid on</th>
                      <th className="px-4 py-2 text-right font-normal">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.invoices.map((i) => (
                      <tr key={i.id} className="border-b border-border-muted last:border-0">
                        <td className="px-4 py-2">
                          {invoiceLink(i, c.owner)}
                          {i.pdfUrl && <a href={i.pdfUrl} target="_blank" rel="noreferrer" className="ml-2 text-xs text-fg-muted hover:text-fg">PDF</a>}
                        </td>
                        <td className="px-3 py-2 text-fg-muted">{i.source === 'stripe' ? 'Stripe' : 'Manual'}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-fg-muted">{day(i.periodStart)} – {day(i.periodEnd)}</td>
                        <td className="px-3 py-2"><Label tone={i.status === 'paid' ? 'success' : i.status === 'open' ? 'attention' : 'default'}>{i.status}</Label></td>
                        <td className="whitespace-nowrap px-3 py-2 text-fg-muted">{day(i.paidAt)}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">{money(i.totalCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title={`People with seats (${c.members.length})`}>
              {c.members.length === 0 ? (
                <p className="py-4 text-[13px] text-fg-muted">Nobody.</p>
              ) : (
                <ul>
                  {c.members.map((m) => (
                    <li key={m.username} className="flex items-center gap-2.5 border-b border-border-muted py-2 text-[13px] last:border-0">
                      <Avatar name={m.username} size={22} />
                      <Link to="/$owner" params={{ owner: m.username }} className="font-medium no-underline hover:text-accent">{m.name ?? m.username}</Link>
                      <span className="truncate text-xs text-fg-muted">{m.email}</span>
                      <Label className="ml-auto">{m.role}</Label>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Billing history">
              {c.events.length === 0 ? (
                <p className="py-4 text-[13px] text-fg-muted">No billing events recorded.</p>
              ) : (
                <ul>
                  {c.events.map((e, i) => (
                    <li key={i} className={cx('flex items-baseline gap-3 border-b border-border-muted py-2 text-[13px] last:border-0')}>
                      <span className="w-28 shrink-0 text-xs text-fg-subtle"><RelativeTime date={e.at} /></span>
                      <span className="min-w-0 flex-1">
                        {ACTION[e.action] ?? e.action}
                        {typeof e.detail.plan === 'string' && <span className="text-fg-muted"> · {String(e.detail.plan)}{typeof e.detail.cycle === 'string' ? `, ${String(e.detail.cycle)}` : ''}</span>}
                        {typeof e.detail.to === 'string' && <span className="text-fg-muted"> · to {String(e.detail.to)}</span>}
                        {typeof e.detail.number === 'string' && <span className="font-mono text-xs text-fg-muted"> · {String(e.detail.number)}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-fg-subtle">{e.actor ?? 'system'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
