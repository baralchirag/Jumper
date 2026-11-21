import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, ExternalLink, FileText } from 'lucide-react';
import { SUPPLIERS, type BomPricingResponse, type PricedLine } from '@jumper/shared';
import { Flash, Input, SegmentedControl, Spinner, cx } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';
import { SEARCH_URL, download, jlcCsv, pricedCsv } from '../bom/BomPricing';

const money = (n: number) => (n < 0.1 ? `$${n.toFixed(4)}` : n < 10 ? `$${n.toFixed(3)}` : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const total = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Status = 'ok' | 'low' | 'out' | 'missing' | 'skip' | 'dnp';

/** One plain status per part, in the words a designer would use. */
function statusOf(l: PricedLine): { status: Status; text: string } {
  if (l.dnp) return { status: 'dnp', text: 'Not fitted' };
  if (l.skipped) return { status: 'skip', text: 'Not something you buy' };
  const best = l.best ? l.offers[l.best] : undefined;
  if (best) return best.stock < l.needed * 2 ? { status: 'low', text: `Low stock at ${l.best}` } : { status: 'ok', text: `In stock at ${l.best}` };
  if (Object.keys(l.offers).length) return { status: 'out', text: 'Out of stock' };
  return { status: 'missing', text: 'Not found' };
}

const DOT: Record<Status, string> = {
  ok: 'bg-success',
  low: 'bg-attention',
  out: 'bg-danger',
  missing: 'bg-danger',
  skip: 'bg-border',
  dnp: 'bg-border',
};

const needsWork = (s: Status) => s === 'low' || s === 'out' || s === 'missing';

/**
 * The parts on the board, one row per part, with what each costs and whether it can be bought. Prices and stock are
 * looked up from LCSC and JLCPCB (Mouser and DigiKey when the instance has their keys); nothing is ordered.
 */
export function PartsList({ owner, repo, sha, path }: { owner: string; repo: string; sha: string; path: string }) {
  const [boardsInput, setBoardsInput] = useState('10');
  const [boards, setBoards] = useState(10);
  const [view, setView] = useState<'all' | 'attention'>('all');

  useEffect(() => {
    const n = Number.parseInt(boardsInput, 10);
    if (!Number.isFinite(n) || n < 1) return;
    const t = setTimeout(() => setBoards(Math.min(n, 100_000)), 400);
    return () => clearTimeout(t);
  }, [boardsInput]);

  const q = useQuery({
    queryKey: [...keys.repo(owner, repo), 'bom-pricing', sha, path, boards, 0],
    queryFn: () => api.get<BomPricingResponse>(repoPath(owner, repo, '/bom/pricing'), { ref: sha, path, boards }),
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const rows = useMemo(() => (q.data?.lines ?? []).map((l) => ({ l, ...statusOf(l) })), [q.data]);
  const attention = rows.filter((r) => needsWork(r.status));
  const shown = view === 'attention' ? attention : rows;

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border p-6 text-sm text-fg-muted">
        <Spinner /> Looking up prices and stock…
      </div>
    );
  }
  if (q.error) return <Flash tone="warning">Could not look up parts: {errorMessage(q.error)}</Flash>;
  const d = q.data!;
  const fitted = d.lines.filter((l) => !l.dnp);
  const placed = fitted.reduce((n, l) => n + l.needed / d.boards, 0);
  const suppliers = d.suppliers.filter((s) => s.enabled).map((s) => s.supplier);
  const base = path.replace(/\.kicad_sch$/, '').split('/').pop();

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile label="Parts" value={String(fitted.length)} note={`${Math.round(placed)} placed on each board`} />
        <Tile label="Cost per board" value={d.bestMix.covered ? total(d.bestMix.total / d.boards) : '—'} note={`when building ${d.boards}, cheapest supplier for each part${d.bestMix.covered < d.sourceable ? `, ${d.sourceable - d.bestMix.covered} parts not priced` : ''}`} />
        <Tile label="Need attention" value={String(attention.length)} note={attention.length ? 'out of stock, low or not found' : 'every part can be bought'} tone={attention.length ? 'warn' : 'ok'} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[13px] text-fg-muted">
          Boards to build
          <Input type="number" min={1} max={100000} value={boardsInput} onChange={(e) => setBoardsInput(e.target.value)} className="h-8 w-20 tabular-nums" />
        </label>
        {q.isFetching && <Spinner size={14} />}
        <SegmentedControl
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'all', label: `All ${rows.length}` },
            { value: 'attention', label: `Need attention ${attention.length}` },
          ]}
        />
        <div className="ml-auto flex flex-wrap gap-x-4 gap-y-2 text-[13px]">
          <button type="button" className="link inline-flex items-center gap-1" onClick={() => download(`${base}-bom-x${d.boards}.csv`, pricedCsv(d, (l) => (l.best ? l.offers[l.best]! : null)))}>
            <Download size={13} /> Parts list (CSV)
          </button>
          <button type="button" className="link inline-flex items-center gap-1" onClick={() => download(`${base}-jlcpcb-bom.csv`, jlcCsv(d))} title="The BOM format JLCPCB's assembly service asks for">
            <Download size={13} /> For JLCPCB assembly
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-canvas">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-xs text-fg-subtle">
              <th className="px-4 py-2.5 font-normal">Part</th>
              <th className="px-3 py-2.5 font-normal">On the board</th>
              <th className="px-3 py-2.5 text-right font-normal">Each</th>
              <th className="px-3 py-2.5 text-right font-normal">For {d.boards}</th>
              <th className="px-4 py-2.5 font-normal">Availability</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ l, status, text }) => {
              const best = l.best ? l.offers[l.best] : undefined;
              const muted = status === 'skip' || status === 'dnp';
              const term = l.query.mpn ?? l.query.sku ?? l.query.keyword ?? l.value;
              const perBoard = l.needed / d.boards;
              return (
                <tr key={l.references.join(',')} className={cx('border-b border-border-muted align-top last:border-0', muted && 'text-fg-subtle')}>
                  <td className="max-w-80 px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{l.value}</span>
                      {l.datasheet && (
                        <a href={l.datasheet} target="_blank" rel="noreferrer" className="text-fg-subtle hover:text-accent" title="Datasheet">
                          <FileText size={13} />
                        </a>
                      )}
                    </div>
                    <div className="truncate text-xs text-fg-muted" title={l.footprint}>
                      {l.footprint.slice(l.footprint.indexOf(':') + 1)}
                      {best && <> · {best.manufacturer} {best.mpn}</>}
                    </div>
                  </td>
                  <td className="max-w-56 px-3 py-2.5">
                    <div className="truncate font-mono text-xs" title={l.references.join(', ')}>
                      {l.references.join(', ')}
                    </div>
                    <div className="text-xs text-fg-subtle">{perBoard} per board</div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{best ? money(best.unitPrice) : ''}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {best ? total(best.extended) : ''}
                    {best && best.buyQty > l.needed && <div className="text-xs text-fg-subtle">min. order {best.buyQty}</div>}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className={cx('h-2 w-2 shrink-0 rounded-full', DOT[status])} aria-hidden />
                      {best?.url ? (
                        <a href={best.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-accent">
                          {text} <ExternalLink size={11} />
                        </a>
                      ) : (
                        <span>{text}</span>
                      )}
                    </div>
                    {best?.match === 'parametric' && <div className="mt-0.5 text-xs text-fg-subtle" title="Add an MPN or LCSC field to the symbol in KiCad to choose the exact part.">A close match by value and size</div>}
                    {(status === 'missing' || status === 'out') && (
                      <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-fg-muted">
                        Search
                        {SUPPLIERS.map((s) => (
                          <a key={s} href={SEARCH_URL[s](term)} target="_blank" rel="noreferrer" className="link">
                            {s}
                          </a>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-fg-muted">
                  Nothing needs attention.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-fg-subtle">
        Prices and stock looked up from {suppliers.join(' and ')} in US dollars, at {new Date(d.fetchedAt).toLocaleTimeString()}, including minimum order quantities. Jumper only looks
        parts up; it does not order anything. To pin a part exactly, add an <span className="font-mono">MPN</span> or <span className="font-mono">LCSC</span> field to its symbol in KiCad.
      </p>
    </div>
  );
}

function Tile({ label, value, note, tone }: { label: string; value: string; note: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className="rounded-lg border border-border bg-canvas px-4 py-3">
      <div className="text-xs text-fg-muted">{label}</div>
      <div className={cx('mt-0.5 text-2xl font-semibold tabular-nums', tone === 'warn' && 'text-attention', tone === 'ok' && 'text-success')}>{value}</div>
      <div className="mt-0.5 text-xs text-fg-subtle">{note}</div>
    </div>
  );
}
