import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CircleCheck, CircleX } from 'lucide-react';
import { Flash, Label, PageSpinner } from '@jumper/ui';
import { ErrorView } from '../../shared/components/common';
import { api, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';

interface Stats {
  copperLayers: number;
  widthMm: number | null;
  heightMm: number | null;
  footprints: number;
  smdPads: number;
  thruHolePads: number;
  tracks: number;
  vias: number;
  nets: number;
  zones: number;
  minTrackWidthMm: number | null;
  minViaDiameterMm: number | null;
  minViaDrillMm: number | null;
  minHoleDrillMm: number | null;
  minAnnularRingMm: number | null;
  totalTrackLengthMm: number;
  boardThicknessMm: number | null;
  componentDensity: number | null;
}
interface Report {
  profile: string;
  name: string;
  ok: boolean;
  issues: { rule: string; severity: 'error' | 'warning'; message: string }[];
}

const mm = (v: number | null) => (v === null ? '–' : `${+v.toFixed(3)} mm`);

export function FabPanel({ owner, repo, sha, path }: { owner: string; repo: string; sha: string; path: string }) {
  const q = useQuery({
    queryKey: [...keys.repo(owner, repo), 'fab-check', sha, path],
    queryFn: () => api.get<{ stats: Stats; reports: Report[] }>(repoPath(owner, repo, '/fab-check'), { path, sha }),
    retry: false,
  });
  if (q.isLoading) return <PageSpinner label="Analysing board…" />;
  if (q.error) return <div className="p-4"><ErrorView error={q.error} title="Could not analyse this board." /></div>;
  const { stats, reports } = q.data!;
  const facts: [string, string][] = [
    ['Size', stats.widthMm && stats.heightMm ? `${stats.widthMm} × ${stats.heightMm} mm` : '–'],
    ['Copper layers', String(stats.copperLayers)],
    ['Thickness', mm(stats.boardThicknessMm)],
    ['Components', String(stats.footprints)],
    ['SMD / through-hole pads', `${stats.smdPads} / ${stats.thruHolePads}`],
    ['Nets', String(stats.nets)],
    ['Track segments', `${stats.tracks} (${(stats.totalTrackLengthMm / 1000).toFixed(2)} m)`],
    ['Vias', String(stats.vias)],
    ['Zones', String(stats.zones)],
    ['Narrowest track', mm(stats.minTrackWidthMm)],
    ['Smallest via (Ø / drill)', `${mm(stats.minViaDiameterMm)} / ${mm(stats.minViaDrillMm)}`],
    ['Smallest hole', mm(stats.minHoleDrillMm)],
    ['Smallest annular ring', mm(stats.minAnnularRingMm)],
    ['Component density', stats.componentDensity === null ? '–' : `${Math.round(stats.componentDensity * 100)}% of board area`],
  ];
  return (
    <div className="grid gap-6 p-4 lg:grid-cols-2">
      <section>
        <h3 className="mb-2 text-sm font-semibold">Board statistics</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-muted">{k}</dt>
              <dd className="font-mono tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Fab readiness</h3>
        <p className="text-xs text-fg-muted">Checked against each fab's standard-service limits. Clearance comes from DRC and is not measured here.</p>
        {reports.map((r) => (
          <div key={r.profile} className="rounded-md border border-border">
            <div className="flex items-center gap-2 border-b border-border-muted px-3 py-2 text-sm font-medium">
              {r.ok ? <CircleCheck size={15} className="text-success" /> : <CircleX size={15} className="text-danger" />}
              {r.name}
              <Label tone={r.ok ? 'success' : 'danger'} className="ml-auto">
                {r.ok ? 'compatible' : 'issues'}
              </Label>
            </div>
            {r.issues.length === 0 ? (
              <p className="px-3 py-2 text-sm text-fg-muted">Everything checked is within limits.</p>
            ) : (
              <ul className="divide-y divide-border-muted">
                {r.issues.map((i, k) => (
                  <li key={k} className="flex items-start gap-2 px-3 py-1.5 text-[13px]">
                    {i.severity === 'error' ? <CircleX size={14} className="mt-0.5 shrink-0 text-danger" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-attention" />}
                    {i.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <Flash>Limits are approximate. Confirm with the fab's current capability page before ordering.</Flash>
      </section>
    </div>
  );
}
