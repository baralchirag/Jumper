import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, PackageX, RefreshCw } from 'lucide-react';
import type { BomAlertInfo, BomAlertKind, BomWatchInfo, ComplianceReport, ComplianceStatus } from '@jumper/shared';
import { Box, BoxHeader, BoxRow, Button, Checkbox, EmptyState, Flash, Input, Label, PageSpinner, RelativeTime, type LabelTone } from '@jumper/ui';
import { PageContainer, UnavailableNotice, isUnavailable, shortSha } from '../../shared/components/common';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';
import { canWrite, useRepoInfo } from '../repo/context';

const KIND: Record<BomAlertKind, { label: string; tone: LabelTone }> = {
  out_of_stock: { label: 'Out of stock', tone: 'danger' },
  low_stock: { label: 'Low stock', tone: 'attention' },
  eol: { label: 'End of life', tone: 'danger' },
  not_found: { label: 'Not listed', tone: 'default' },
};

const STATUS: Record<ComplianceStatus, { label: string; tone: LabelTone }> = {
  compliant: { label: 'Compliant', tone: 'success' },
  exempt: { label: 'Exempt', tone: 'success' },
  non_compliant: { label: 'Not compliant', tone: 'danger' },
  unknown: { label: 'Unknown', tone: 'default' },
};

/** Parts health for a repository: supplier stock and end-of-life alerts, and the RoHS / REACH roll-up. */
export function PartsPage() {
  const info = useRepoInfo();
  if (info.isEmpty) return <EmptyState icon={<PackageX size={24} />} title="No parts yet">Push a KiCad project to watch its parts for stock and end-of-life problems.</EmptyState>;
  return (
    <PageContainer className="max-w-5xl py-8">
      <StockSection />
      <ComplianceSection />
    </PageContainer>
  );
}

function AlertRow({ a }: { a: BomAlertInfo }) {
  const k = KIND[a.kind];
  return (
    <BoxRow className="flex flex-wrap items-start gap-x-4 gap-y-1">
      <Label tone={a.resolvedAt ? 'default' : k.tone} className="mt-0.5 w-28 justify-center">{k.label}</Label>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-[13px] font-medium">{a.references.join(', ')}</span>
          <span className="text-[13px]">{a.mpn ?? a.value}</span>
          {a.project && <span className="font-mono text-xs text-fg-subtle">{a.project}</span>}
        </div>
        <p className="text-[13px] text-fg-muted">{a.detail}</p>
      </div>
      <span className="text-xs text-fg-subtle">
        {a.resolvedAt ? <>Resolved <RelativeTime date={a.resolvedAt} /></> : <>Since <RelativeTime date={a.firstSeenAt} /></>}
      </span>
    </BoxRow>
  );
}

function StockSection() {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const key = [...keys.repo(info.owner, info.name), 'bom-watch'];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<BomWatchInfo>(repoPath(info.owner, info.name, '/bom-watch')) });
  const [boards, setBoards] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { enabled: boolean; boards: number }) => api.put<BomWatchInfo>(repoPath(info.owner, info.name, '/bom-watch'), body),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const check = useMutation({
    mutationFn: () => api.post<BomWatchInfo>(repoPath(info.owner, info.name, '/bom-watch/check')),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <Flash tone="danger">{errorMessage(q.error)}</Flash>;
  const w = q.data!;
  const open = w.alerts.filter((a) => !a.resolvedAt);
  const resolved = w.alerts.filter((a) => a.resolvedAt);
  const writable = canWrite(info);
  const n = boards === '' ? w.boards : Number(boards);

  return (
    <section className="mb-12">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="headline text-[length:var(--t-m)]">Stock and end of life</h2>
          <p className="mt-1 text-[14px] text-fg-muted">
            The BOM on <span className="font-mono">{info.defaultBranch}</span> is checked against the suppliers once a day. Parts that run out, cannot cover a build, or are being discontinued raise an alert for the people who follow this repository.
          </p>
        </div>
        {writable && w.available && (
          <Button size="sm" leadingIcon={<RefreshCw size={14} />} loading={check.isPending} onClick={() => check.mutate()}>
            Check now
          </Button>
        )}
      </header>
      {error && <Flash tone="danger" className="mb-4">{error}</Flash>}
      {!w.available && <Flash className="mb-4">Supplier pricing is switched off on this instance, so stock cannot be checked.</Flash>}

      {writable && w.available && (
        <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-md border border-border p-4">
          <Checkbox checked={w.enabled} onChange={(e) => save.mutate({ enabled: e.target.checked, boards: n })} label="Watch this repository's parts" hint="Daily check, with an alert when something changes." />
          <label className="flex items-center gap-2 text-[13px] text-fg-muted">
            Boards per build
            <Input type="number" min={1} max={100000} value={boards === '' ? String(w.boards) : boards} onChange={(e) => setBoards(e.target.value)} onBlur={() => n !== w.boards && n >= 1 && save.mutate({ enabled: w.enabled, boards: n })} className="h-8 w-24" aria-label="Boards per build" />
          </label>
          <span className="text-xs text-fg-subtle">
            {w.lastCheckedAt ? <>Last checked <RelativeTime date={w.lastCheckedAt} /></> : 'Not checked yet'}
          </span>
        </div>
      )}
      {w.lastError && <Flash tone="warning" className="mb-4">Last check could not finish: {w.lastError}</Flash>}

      {open.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-fg-muted">{w.lastCheckedAt ? 'No problems found in the last check.' : 'Nothing checked yet.'}</p>
      ) : (
        <Box>
          <BoxHeader className="text-sm font-medium">{open.length} open {open.length === 1 ? 'alert' : 'alerts'}</BoxHeader>
          {open.map((a) => <AlertRow key={a.id} a={a} />)}
        </Box>
      )}
      {resolved.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[13px] text-fg-muted">{resolved.length} resolved</summary>
          <Box className="mt-2">{resolved.map((a) => <AlertRow key={a.id} a={a} />)}</Box>
        </details>
      )}
    </section>
  );
}

function ComplianceSection() {
  const info = useRepoInfo();
  const [suppliers, setSuppliers] = useState(false);
  const [run, setRun] = useState(false);
  const q = useQuery({
    queryKey: [...keys.repo(info.owner, info.name), 'compliance', suppliers],
    queryFn: () => api.get<ComplianceReport>(repoPath(info.owner, info.name, '/compliance'), { suppliers }),
    enabled: run,
    retry: false,
  });
  const csv = `/api${repoPath(info.owner, info.name, '/compliance')}?format=csv${suppliers ? '&suppliers=true' : ''}`;

  return (
    <section>
      <header className="mb-4 max-w-2xl">
        <h2 className="headline text-[length:var(--t-m)]">RoHS and REACH</h2>
        <p className="mt-1 text-[14px] text-fg-muted">
          A roll-up from the RoHS and REACH fields on your schematic symbols, optionally filled in from supplier data. Use it to see what still needs a declaration. It is not a certificate.
        </p>
      </header>
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <Checkbox checked={suppliers} onChange={(e) => setSuppliers(e.target.checked)} label="Ask suppliers about parts with no RoHS field" />
        <Button size="sm" onClick={() => (run ? void q.refetch() : setRun(true))} loading={q.isFetching}>
          {run ? 'Run again' : 'Build report'}
        </Button>
        {q.data && (
          <a href={csv} className="link inline-flex items-center gap-1 text-[13px]">
            <Download size={13} /> CSV
          </a>
        )}
      </div>
      {q.error && (isUnavailable(q.error) ? <UnavailableNotice error={q.error} /> : <Flash tone="danger">{errorMessage(q.error)}</Flash>)}
      {q.data && <ComplianceTable r={q.data} />}
    </section>
  );
}

function ComplianceTable({ r }: { r: ComplianceReport }) {
  const fitted = r.lines.filter((l) => !l.dnp);
  return (
    <div>
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        {(['rohs', 'reach'] as const).map((k) => (
          <div key={k} className="rounded-md border border-border p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">{k === 'rohs' ? 'RoHS' : 'REACH'}</span>
              <Label tone={STATUS[r[k]].tone}>{STATUS[r[k]].label}</Label>
            </div>
            <p className="font-mono text-xs text-fg-muted">
              {(Object.keys(STATUS) as ComplianceStatus[]).map((s) => `${STATUS[s].label.toLowerCase()} ${r.summary[k][s]}`).join(' · ')}
            </p>
          </div>
        ))}
      </div>
      <p className="mb-2 text-xs text-fg-subtle">
        {r.project} at <span className="font-mono">{shortSha(r.sha)}</span>
        {r.usedSuppliers && ', with supplier data'}
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-xs text-fg-subtle">
              <th className="px-3 py-2 font-normal">References</th>
              <th className="px-3 py-2 font-normal">Part</th>
              <th className="px-3 py-2 font-normal">RoHS</th>
              <th className="px-3 py-2 font-normal">REACH</th>
            </tr>
          </thead>
          <tbody>
            {fitted.map((l) => (
              <tr key={l.references.join(',')} className="border-b border-border-muted last:border-0">
                <td className="px-3 py-2 font-mono text-xs">{l.references.join(', ')}</td>
                <td className="px-3 py-2">
                  {l.mpn ?? l.value}
                  {l.manufacturer && <span className="ml-1 text-fg-muted">{l.manufacturer}</span>}
                </td>
                <td className="px-3 py-2">
                  <Label tone={STATUS[l.rohs].tone}>{STATUS[l.rohs].label}</Label>
                  {l.rohsSource && <span className="ml-2 text-xs text-fg-subtle">{l.rohsSource}</span>}
                </td>
                <td className="px-3 py-2">
                  <Label tone={STATUS[l.reach].tone}>{STATUS[l.reach].label}</Label>
                  {l.svhc && <span className="ml-2 text-xs text-danger">SVHC: {l.svhc}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
