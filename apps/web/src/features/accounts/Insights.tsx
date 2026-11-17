import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { InsightsReport } from '@jumper/shared';
import { Avatar, Box, BoxRow, Label, PageSpinner, Select, cx } from '@jumper/ui';
import { ErrorView, PageContainer, PageHeader, UnavailableNotice, isUnavailable } from '../../shared/components/common';
import { api } from '../../shared/lib/api';

const hrs = (h: number | null) => (h === null ? '–' : h < 48 ? `${h} h` : `${Math.round(h / 24)} d`);

/** Small bar chart: one bar per week, values labelled on hover; the latest week is emphasised. */
function Bars({ values, label, format = String }: { values: (number | null)[]; label: string; format?: (n: number) => string }) {
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  return (
    <div>
      <div className="flex h-20 items-end gap-[3px]" role="img" aria-label={`${label}: ${values.map((v) => (v === null ? 'none' : format(v))).join(', ')}`}>
        {values.map((v, i) => (
          <div key={i} className="group relative flex h-full flex-1 items-end">
            <div className={cx('w-full rounded-t-[2px]', i === values.length - 1 ? 'bg-accent-emphasis' : 'bg-accent-muted')} style={{ height: v ? `${Math.max(4, (v / max) * 100)}%` : '1px' }} />
            <span className="pointer-events-none absolute -top-5 left-1/2 hidden -translate-x-1/2 whitespace-nowrap font-mono text-[11px] text-fg group-hover:block">{v === null ? '–' : format(v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border p-4">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="mt-1 text-2xl font-medium tabular-nums tracking-tight">{value}</p>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

/** Review speed, check failures and who reviews, for one organization. */
export function InsightsPage() {
  const { org = '' } = useParams({ strict: false }) as { org?: string };
  const [weeks, setWeeks] = useState(12);
  const q = useQuery({ queryKey: ['insights', org, weeks], queryFn: () => api.get<InsightsReport>(`/owners/${encodeURIComponent(org)}/insights`, { weeks }), retry: false });
  const header = (
    <PageHeader
      title="Insights"
      action={
        <Select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} className="h-8 w-36 text-[13px]" aria-label="Period">
          <option value={4}>Last 4 weeks</option>
          <option value={12}>Last 12 weeks</option>
          <option value={26}>Last 26 weeks</option>
          <option value={52}>Last year</option>
        </Select>
      }
    >
      How quickly pull requests in <Link to="/$owner" params={{ owner: org }} className="link">{org}</Link> get reviewed and merged, which checks fail, and what is waiting.
    </PageHeader>
  );
  if (q.isLoading) return <PageSpinner />;
  if (q.error) {
    if (!isUnavailable(q.error)) return <ErrorView error={q.error} />;
    return (
      <PageContainer className="max-w-5xl py-10">
        {header}
        <UnavailableNotice error={q.error} />
      </PageContainer>
    );
  }
  const r = q.data!;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const runs = r.checks.series.reduce((a, s) => a + sum(s.runs), 0);
  return (
    <PageContainer className="max-w-5xl py-10">
      {header}
      <div className="mb-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Pull requests opened" value={String(sum(r.pulls.opened))}><Bars values={r.pulls.opened} label="Opened per week" /></Stat>
        <Stat label="Merged" value={String(sum(r.pulls.merged))}><Bars values={r.pulls.merged} label="Merged per week" /></Stat>
        <Stat label="Median time to first review" value={hrs(r.pulls.medianHoursToFirstReview)}><Bars values={r.pulls.hoursToFirstReview} label="Hours to first review per week" format={(n) => hrs(n)} /></Stat>
        <Stat label="Median time to merge" value={hrs(r.pulls.medianHoursToMerge)}><Bars values={r.pulls.hoursToMerge} label="Hours to merge per week" format={(n) => hrs(n)} /></Stat>
      </div>
      <p className="-mt-8 mb-10 text-xs text-fg-subtle">Weeks start on Monday (UTC), from {r.weeks[0]}. Reviews by a pull request's own author do not count.</p>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <section>
          <h2 className="mb-3 text-[15px] font-medium">Open pull requests</h2>
          {r.open.length === 0 ? (
            <p className="text-[13px] text-fg-muted">Nothing open.</p>
          ) : (
            <Box>
              {r.open.map((p) => (
                <BoxRow key={`${p.repo}#${p.number}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                  <Link to="/$owner/$repo/pull/$number" params={{ owner: r.owner, repo: p.repo, number: String(p.number) }} search={{}} className="link min-w-0 flex-1 truncate">
                    <span className="font-mono text-fg-muted">{p.repo}#{p.number}</span> {p.title}
                  </Link>
                  {p.draft ? <Label>Draft</Label> : p.waitingForReview ? <Label tone="attention">Needs review</Label> : <span className="text-xs text-fg-muted">{p.approvals} approval{p.approvals === 1 ? '' : 's'}</span>}
                  <span className="w-14 text-right text-xs tabular-nums text-fg-subtle">{p.ageDays} d</span>
                </BoxRow>
              ))}
            </Box>
          )}

          <h2 className="mb-3 mt-10 text-[15px] font-medium">Checks</h2>
          <p className="mb-3 text-[13px] text-fg-muted">
            {runs} runs, {r.checks.failureRate === null ? 'none failed' : `${Math.round(r.checks.failureRate * 1000) / 10}% failed`}.
          </p>
          {r.checks.series.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-fg-subtle">
                    <th className="px-3 py-2 font-normal">Check</th>
                    <th className="px-3 py-2 text-right font-normal">Runs</th>
                    <th className="px-3 py-2 text-right font-normal">Failed</th>
                    <th className="w-40 px-3 py-2 font-normal">Failures per week</th>
                  </tr>
                </thead>
                <tbody>
                  {r.checks.series.map((s) => (
                    <tr key={s.name} className="border-b border-border-muted last:border-0">
                      <td className="px-3 py-2 font-mono text-xs">{s.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{sum(s.runs)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{sum(s.failures)}</td>
                      <td className="px-3 py-1">
                        <div className="flex h-5 items-end gap-px">
                          {s.failures.map((f, i) => (
                            <div key={i} className="flex-1 bg-danger/70" style={{ height: f ? `${Math.max(15, (f / Math.max(1, ...s.failures)) * 100)}%` : '1px', opacity: f ? 1 : 0.3 }} />
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="space-y-10">
          <section>
            <h2 className="mb-3 text-[15px] font-medium">Reviewers</h2>
            {r.reviewers.length === 0 ? (
              <p className="text-[13px] text-fg-muted">No reviews in this period.</p>
            ) : (
              <ul className="space-y-2">
                {r.reviewers.map((p) => (
                  <li key={p.user.id} className="flex items-center gap-2 text-[13px]">
                    <Avatar name={p.user.username} src={p.user.avatarUrl} size={20} />
                    <span className="min-w-0 flex-1 truncate">{p.user.username}</span>
                    <span className="tabular-nums text-fg-muted">{p.reviews} reviews</span>
                    <span className="w-20 text-right tabular-nums text-fg-subtle">{p.approvals} approved</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {r.checks.worst.length > 0 && (
            <section>
              <h2 className="mb-3 text-[15px] font-medium">Most failed checks by repository</h2>
              <ul className="space-y-1.5 text-[13px]">
                {r.checks.worst.map((w) => (
                  <li key={w.repo} className="flex justify-between gap-3">
                    <Link to="/$owner/$repo/checks" params={{ owner: r.owner, repo: w.repo }} search={{}} className="link truncate font-mono text-xs">{w.repo}</Link>
                    <span className="tabular-nums text-fg-muted">{w.failures} of {w.runs}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </PageContainer>
  );
}
