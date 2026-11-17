import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import type { InvoiceInfo } from '@jumper/shared';
import { Button, Label, PageSpinner } from '@jumper/ui';
import { ErrorView, PageContainer } from '../../shared/components/common';
import { api } from '../../shared/lib/api';
import { money } from './Governance';

/** One invoice, laid out to print or save as PDF from the browser. */
export function InvoicePage() {
  const { owner = '', id = '' } = useParams({ strict: false }) as { owner?: string; id?: string };
  const q = useQuery({ queryKey: ['invoice', owner, id], queryFn: () => api.get<InvoiceInfo>(`/owners/${encodeURIComponent(owner)}/invoices/${id}`) });
  if (q.isLoading) return <PageSpinner />;
  if (q.error || !q.data) return <ErrorView error={q.error} />;
  const i = q.data;
  const date = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '');
  return (
    <PageContainer className="max-w-3xl py-10 print:max-w-none print:p-0">
      <div className="mb-6 flex items-center justify-between print:hidden">
        <Label tone={i.status === 'paid' ? 'success' : i.status === 'open' ? 'attention' : 'default'}>{i.status}</Label>
        <Button size="sm" leadingIcon={<Printer size={14} />} onClick={() => window.print()}>Print or save as PDF</Button>
      </div>
      <article className="rounded-md border border-border bg-canvas p-8 print:border-0 print:p-0">
        <header className="mb-8 flex flex-wrap justify-between gap-6">
          <div>
            <h1 className="headline text-[length:var(--t-l)]">Invoice</h1>
            <p className="mt-1 font-mono text-sm text-fg-muted">{i.number}</p>
          </div>
          <div className="text-right text-[13px]">
            <p className="font-medium">{i.from.name ?? 'Jumper'}</p>
            {i.from.email && <p className="text-fg-muted">{i.from.email}</p>}
          </div>
        </header>
        <div className="mb-8 grid gap-6 text-[13px] sm:grid-cols-2">
          <div>
            <p className="label-mono mb-1">Bill to</p>
            <p className="font-medium">{i.billTo.company || i.owner}</p>
            {i.billTo.address && <p className="whitespace-pre-line text-fg-muted">{i.billTo.address}</p>}
            {i.billTo.taxId && <p className="text-fg-muted">Tax ID {i.billTo.taxId}</p>}
            {i.billTo.email && <p className="text-fg-muted">{i.billTo.email}</p>}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 sm:justify-self-end">
            <dt className="text-fg-muted">Issued</dt>
            <dd>{date(i.issuedAt)}</dd>
            <dt className="text-fg-muted">Due</dt>
            <dd>{date(i.dueAt)}</dd>
            <dt className="text-fg-muted">Period</dt>
            <dd>{i.periodStart} to {i.periodEnd}</dd>
            {i.billTo.poNumber && (
              <>
                <dt className="text-fg-muted">PO</dt>
                <dd>{i.billTo.poNumber}</dd>
              </>
            )}
            {i.paidAt && (
              <>
                <dt className="text-fg-muted">Paid</dt>
                <dd>{date(i.paidAt)}</dd>
              </>
            )}
          </dl>
        </div>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-xs text-fg-subtle">
              <th className="py-2 font-normal">Description</th>
              <th className="py-2 text-right font-normal">Qty</th>
              <th className="py-2 text-right font-normal">Unit</th>
              <th className="py-2 text-right font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {i.lines.map((l, n) => (
              <tr key={n} className="border-b border-border-muted">
                <td className="py-2">{l.description}</td>
                <td className="py-2 text-right tabular-nums">{l.quantity}</td>
                <td className="py-2 text-right tabular-nums">{money(l.unitCents)}</td>
                <td className="py-2 text-right tabular-nums">{money(l.totalCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="tabular-nums">
            <tr>
              <td colSpan={3} className="pt-3 text-right text-fg-muted">Subtotal</td>
              <td className="pt-3 text-right">{money(i.subtotalCents)}</td>
            </tr>
            {i.taxPercent > 0 && (
              <tr>
                <td colSpan={3} className="text-right text-fg-muted">Tax ({i.taxPercent}%)</td>
                <td className="text-right">{money(i.taxCents)}</td>
              </tr>
            )}
            <tr className="font-medium">
              <td colSpan={3} className="pt-2 text-right">Total ({i.currency})</td>
              <td className="pt-2 text-right text-base">{money(i.totalCents)}</td>
            </tr>
          </tfoot>
        </table>
        {i.notes && <p className="mt-8 whitespace-pre-line text-[13px] text-fg-muted">{i.notes}</p>}
      </article>
    </PageContainer>
  );
}
