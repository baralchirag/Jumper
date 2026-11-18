import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Download, ExternalLink, FileText, RefreshCw, Search } from 'lucide-react';
import { SUPPLIERS, type BomPricingResponse, type PricedLine, type PricedOffer, type Supplier } from '@jumper/shared';
import { Button, Flash, Input, Label, SegmentedControl, Spinner, cx } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';

const usd = (n: number, digits = 2) => `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 4) })}`;
const unit = (n: number) => (n < 0.1 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));

const SEARCH_URL: Record<Supplier, (q: string) => string> = {
  LCSC: (q) => `https://www.lcsc.com/search?q=${encodeURIComponent(q)}`,
  JLCPCB: (q) => `https://jlcpcb.com/parts/componentSearch?searchTxt=${encodeURIComponent(q)}`,
  Mouser: (q) => `https://www.mouser.com/c/?q=${encodeURIComponent(q)}`,
  DigiKey: (q) => `https://www.digikey.com/en/products/result?keywords=${encodeURIComponent(q)}`,
};

const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function pricedCsv(data: BomPricingResponse, choice: (l: PricedLine) => PricedOffer | null): string {
  const head = ['References', 'Value', 'Footprint', 'Qty needed', 'Supplier', 'SKU', 'MPN', 'Manufacturer', 'Buy qty', 'Unit price (USD)', 'Extended (USD)', 'Stock', 'Match', 'Datasheet', 'URL'];
  const rows = data.lines
    .filter((l) => !l.dnp && !l.skipped)
    .map((l) => {
      const o = choice(l);
      return [
        l.references.join(' '),
        l.value,
        l.footprint,
        String(l.needed),
        o?.supplier ?? '',
        o?.sku ?? '',
        o?.mpn ?? '',
        o?.manufacturer ?? '',
        o ? String(o.buyQty) : '',
        o ? String(o.unitPrice) : '',
        o ? String(o.extended) : '',
        o ? String(o.stock) : '',
        o?.match ?? 'not found',
        l.datasheet ?? '',
        o?.url ?? '',
      ];
    });
  return [head, ...rows].map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

/** JLCPCB assembly BOM using the matched LCSC codes. */
function jlcCsv(data: BomPricingResponse): string {
  const rows = data.lines
    .filter((l) => !l.dnp && !l.skipped)
    .map((l) => [l.value, l.references.join(','), l.footprint.slice(l.footprint.indexOf(':') + 1), (l.offers.JLCPCB ?? l.offers.LCSC)?.sku ?? '']);
  return [['Comment', 'Designator', 'Footprint', 'LCSC Part #'], ...rows].map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

function OfferCell({ offer, best, line }: { offer: PricedOffer | undefined; best: boolean; line: PricedLine }) {
  if (!offer) return <td className="px-2 py-1.5 text-center text-xs text-fg-subtle">—</td>;
  return (
    <td className={cx('px-2 py-1.5 text-xs align-top', best && 'bg-success-subtle', !offer.inStock && 'opacity-70')}>
      <div className="flex items-baseline justify-between gap-2 tabular-nums">
        <span className={cx('font-semibold', best && 'text-success')}>{usd(offer.extended)}</span>
        <span className="text-fg-muted">{unit(offer.unitPrice)}</span>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
        <a href={offer.url ?? undefined} target="_blank" rel="noreferrer" className="link truncate font-mono" title={`${offer.mpn} · ${offer.manufacturer}\n${offer.description}`}>
          {offer.sku}
        </a>
        <span className={cx('tabular-nums', !offer.inStock && 'text-danger')} title="In stock">
          {compact(offer.stock)}
        </span>
      </div>
      {(offer.buyQty > line.needed || offer.library || offer.match === 'parametric') && (
        <div className="mt-0.5 flex flex-wrap gap-1 text-[11.5px]">
          {offer.buyQty > line.needed && <span className="text-attention" title="Minimum order / reel multiple">buy {offer.buyQty}</span>}
          {offer.library === 'basic' && <span className="text-success" title="JLCPCB basic part: no extended-part setup fee">basic</span>}
          {offer.library === 'extended' && <span className="text-fg-subtle" title="JLCPCB extended part: one-off setup fee per unique part">ext</span>}
        </div>
      )}
    </td>
  );
}

export function BomPricing({ owner, repo, sha, path, filename }: { owner: string; repo: string; sha: string; path: string; filename: string }) {
  const [boardsInput, setBoardsInput] = useState('1');
  const [boards, setBoards] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<'all' | 'missing'>('all');

  useEffect(() => {
    const n = Number.parseInt(boardsInput, 10);
    if (!Number.isFinite(n) || n < 1) return;
    const t = setTimeout(() => setBoards(Math.min(n, 100_000)), 500);
    return () => clearTimeout(t);
  }, [boardsInput]);

  const q = useQuery({
    queryKey: [...keys.repo(owner, repo), 'bom-pricing', sha, path, boards, refresh],
    queryFn: () => api.get<BomPricingResponse>(repoPath(owner, repo, '/bom/pricing'), { ref: sha, path, boards, refresh: refresh ? 'true' : undefined }),
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const data = q.data;
  const enabled = useMemo(() => (data?.suppliers ?? []).filter((s) => s.enabled).map((s) => s.supplier), [data]);
  const lines = useMemo(() => {
    const all = data?.lines ?? [];
    return view === 'missing' ? all.filter((l) => !l.dnp && !l.skipped && !l.best) : all;
  }, [data, view]);

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-fg-muted">
        <Spinner /> Fetching prices and stock from {SUPPLIERS.slice(0, 2).join(' and ')}…
      </div>
    );
  }
  if (q.error) return <Flash tone="warning" className="m-3">Supplier pricing unavailable: {errorMessage(q.error)}</Flash>;
  if (!data) return null;

  const missing = data.lines.filter((l) => !l.dnp && !l.skipped && !l.best).length;
  const cheapest = [...data.suppliers].filter((s) => s.enabled && s.covered === data.sourceable).sort((a, b) => a.total - b.total)[0];

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 border-b border-border bg-canvas-subtle px-3 py-3">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Boards
          <Input type="number" min={1} max={100000} value={boardsInput} onChange={(e) => setBoardsInput(e.target.value)} className="h-8 w-24 tabular-nums" />
        </label>
        <div className="flex flex-wrap gap-2">
          <div className="rounded-md border border-success bg-success-subtle px-3 py-1.5">
            <div className="text-xs font-semibold text-success">Best mix</div>
            <div className="text-sm font-semibold tabular-nums">{usd(data.bestMix.total)}</div>
            <div className="text-xs text-fg-muted">
              {data.bestMix.covered}/{data.sourceable} lines · {usd(data.bestMix.total / boards)}/board
            </div>
          </div>
          {data.suppliers.map((s) => (
            <div key={s.supplier} className={cx('rounded-md border border-border bg-canvas px-3 py-1.5', !s.enabled && 'opacity-60')} title={s.error ?? undefined}>
              <div className="flex items-center gap-1 text-xs font-semibold text-fg-muted">
                {s.supplier}
                {cheapest?.supplier === s.supplier && <Label tone="success" className="!px-1 !py-0 !text-[11px]">cheapest</Label>}
                {s.enabled && s.error && <AlertTriangle size={11} className="text-attention" />}
              </div>
              {s.enabled ? (
                <>
                  <div className="text-sm font-semibold tabular-nums">{usd(s.total)}</div>
                  <div className={cx('text-xs', s.covered < data.sourceable ? 'text-attention' : 'text-fg-muted')}>
                    {s.covered}/{data.sourceable} lines
                  </div>
                </>
              ) : (
                <div className="max-w-40 text-xs text-fg-muted">{s.error}</div>
              )}
            </div>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {q.isFetching && <Spinner size={14} />}
          <SegmentedControl
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: 'all', label: 'All' },
              { value: 'missing', label: `Unmatched ${missing}` },
            ]}
          />
          <Button size="sm" variant="invisible" leadingIcon={<RefreshCw size={14} />} onClick={() => setRefresh((n) => n + 1)} title="Bypass the 12 h price cache">
            Refresh
          </Button>
          <Button size="sm" leadingIcon={<Download size={14} />} onClick={() => download(filename.replace(/\.csv$/, `-priced-x${boards}.csv`), pricedCsv(data, (l) => (l.best ? l.offers[l.best]! : null)))}>
            Priced CSV
          </Button>
          <Button size="sm" leadingIcon={<Download size={14} />} onClick={() => download(filename.replace(/\.csv$/, '-jlcpcb.csv'), jlcCsv(data))} title="Comment, Designator, Footprint, LCSC Part #">
            JLCPCB BOM
          </Button>
        </div>
      </div>

      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-canvas-subtle text-left text-xs text-fg-muted">
            <tr>
              <th className="px-3 py-2 font-semibold">References</th>
              <th className="px-2 py-2 text-right font-semibold">Need</th>
              <th className="px-2 py-2 font-semibold">Part</th>
              <th className="px-2 py-2 font-semibold" aria-label="Datasheet" />
              {enabled.map((s) => (
                <th key={s} className="min-w-36 px-2 py-2 font-semibold">
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const muted = l.dnp || l.skipped;
              const term = l.query.mpn ?? l.query.sku ?? l.query.keyword ?? l.value;
              const anyOffer = Object.values(l.offers)[0];
              return (
                <tr key={l.references.join(',')} className={cx('border-t border-border-muted align-top', muted && 'text-fg-subtle')}>
                  <td className="max-w-56 px-3 py-1.5 font-mono text-xs">
                    {l.references.join(', ')}
                    {l.dnp && <Label tone="danger" className="ml-1">DNP</Label>}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{l.needed}</td>
                  <td className="max-w-72 px-2 py-1.5">
                    <div className="truncate" title={l.value}>
                      {l.value}
                    </div>
                    <div className="truncate font-mono text-xs text-fg-muted" title={l.footprint}>
                      {l.footprint.slice(l.footprint.indexOf(':') + 1)}
                    </div>
                    {anyOffer && (
                      <div className="truncate text-xs text-fg-muted" title={anyOffer.description}>
                        {anyOffer.mpn} · {anyOffer.manufacturer}
                        {anyOffer.match === 'parametric' && (
                          <span className="ml-1 text-attention" title={`Matched by value and package ("${l.query.keyword}"). Add an MPN or LCSC field to the symbol to pin the exact part.`}>
                            suggested
                          </span>
                        )}
                      </div>
                    )}
                    {l.skipped && <div className="text-xs">not a purchasable part</div>}
                    {!muted && !l.best && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-attention">
                        <Search size={11} /> no in-stock match:
                        {SUPPLIERS.map((s) => (
                          <a key={s} href={SEARCH_URL[s](term)} target="_blank" rel="noreferrer" className="link">
                            {s}
                          </a>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-1 py-1.5">
                    {l.datasheet && (
                      <a href={l.datasheet} target="_blank" rel="noreferrer" className="text-fg-muted hover:text-accent" title="Datasheet">
                        <FileText size={14} />
                      </a>
                    )}
                  </td>
                  {enabled.map((s) => (
                    <OfferCell key={s} offer={l.offers[s]} best={l.best === s} line={l} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2 text-xs text-fg-muted">
        <span>
          Prices in USD for {boards} board{boards === 1 ? '' : 's'}, including minimum order quantities. Cached for 12 h · fetched{' '}
          {new Date(data.fetchedAt).toLocaleTimeString()}.
        </span>
        <span>
          <span className="text-attention">suggested</span> = matched by value + footprint; add <code>MPN</code> or <code>LCSC</code> fields to pin parts.
        </span>
        <a href="https://jlcpcb.com/parts" target="_blank" rel="noreferrer" className="link ml-auto inline-flex items-center gap-1">
          JLCPCB parts library <ExternalLink size={10} />
        </a>
      </div>
    </div>
  );
}
