import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Crosshair, RefreshCw } from 'lucide-react';
import type { CheckRunInfo } from '@pcbhub/shared';
import { Box, BoxHeader, Button, EmptyState, Label, cx } from '@pcbhub/ui';
import { api, errorMessage, repoPath } from '../lib/api';
import { keys } from '../lib/queries';
import { CheckIcon, rollup, runState } from './CheckStatus';
import { shortSha } from './common';

function duration(r: CheckRunInfo): string | null {
  if (!r.startedAt || !r.completedAt) return null;
  const s = (new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000;
  return s < 60 ? `${s.toFixed(0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function RunRow({ run, owner, repo }: { run: CheckRunInfo; owner: string; repo: string }) {
  const [open, setOpen] = useState(false);
  const d = run.details;
  const annotations = d?.annotations ?? [];
  const file = typeof d?.file === 'string' ? d.file : null;
  const expandable = annotations.length > 0 || Boolean(d?.log) || Array.isArray(d?.failed) || Array.isArray(d?.failures);
  return (
    <div className="border-b border-border-muted last:border-b-0">
      <button
        className={cx('flex w-full items-center gap-3 px-4 py-2 text-left', expandable && 'hover:bg-canvas-subtle')}
        onClick={() => expandable && setOpen((o) => !o)}
        aria-expanded={open}
      >
        <CheckIcon state={runState(run)} />
        <span className="w-20 shrink-0 font-semibold">{run.name}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{run.status === 'completed' ? run.summary : run.status === 'queued' ? 'Queued' : 'Running…'}</span>
        {d?.counts && (
          <span className="hidden gap-1 sm:flex">
            {d.counts.error > 0 && <Label tone="danger">{d.counts.error} errors</Label>}
            {d.counts.warning > 0 && <Label tone="attention">{d.counts.warning} warnings</Label>}
          </span>
        )}
        <span className="w-14 shrink-0 text-right text-xs text-fg-subtle">{duration(run)}</span>
        {expandable ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span className="w-3.5" />}
      </button>
      {open && (
        <div className="border-t border-border-muted bg-canvas-subtle px-4 py-3">
          {annotations.length > 0 && (
            <div className="max-h-96 overflow-auto rounded-md border border-border bg-canvas">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-canvas-subtle text-left text-fg-muted">
                  <tr>
                    <th className="px-2 py-1.5">Severity</th>
                    <th className="px-2 py-1.5">Rule</th>
                    <th className="px-2 py-1.5">Message</th>
                    <th className="px-2 py-1.5">Location</th>
                  </tr>
                </thead>
                <tbody>
                  {annotations.map((a, i) => (
                    <tr key={i} className="border-t border-border-muted align-top">
                      <td className="px-2 py-1">
                        <Label tone={a.severity === 'error' ? 'danger' : 'attention'}>{a.severity}</Label>
                      </td>
                      <td className="px-2 py-1 font-mono">{a.type}</td>
                      <td className="px-2 py-1">
                        {a.message}
                        {a.items?.map((it, j) => (
                          <div key={j} className="text-fg-muted">
                            · {it.description}
                          </div>
                        ))}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1">
                        {a.x !== undefined && file ? (
                          <Link
                            to="/$owner/$repo/blob/$ref/$"
                            params={{ owner, repo, ref: run.sha, _splat: file }}
                            search={{ check: run.id, x: a.x, y: a.y }}
                            className="link inline-flex items-center gap-1"
                          >
                            <Crosshair size={11} /> {a.x.toFixed(2)}, {a.y?.toFixed(2)}
                          </Link>
                        ) : (
                          (a.sheet ?? '')
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {Array.isArray(d?.failed) && (d.failed as string[]).length > 0 && (
            <ul className="list-disc pl-5 text-xs text-danger">
              {(d.failed as string[]).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {Array.isArray(d?.failures) && (d.failures as string[]).length > 0 && (
            <ul className="list-disc pl-5 text-xs text-danger">
              {(d.failures as string[]).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {d?.log && <pre className="mt-2 max-h-64 overflow-auto rounded bg-canvas-inset p-2 font-mono text-xs">{d.log}</pre>}
        </div>
      )}
    </div>
  );
}

export function ChecksList({ owner, repo, sha, runs, canRerun }: { owner: string; repo: string; sha: string; runs: CheckRunInfo[]; canRerun?: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rerun = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(repoPath(owner, repo, '/checks/rerun'), { sha });
      await qc.invalidateQueries({ queryKey: [...keys.repo(owner, repo), 'checks'] });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const projects = [...new Set(runs.map((r) => r.projectPath))];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <CheckIcon state={rollup(runs)} size={18} />
        <span className="text-sm">
          Checks for commit <span className="font-mono">{shortSha(sha)}</span>
        </span>
        {canRerun && (
          <Button size="sm" className="ml-auto" leadingIcon={<RefreshCw size={14} />} loading={busy} onClick={() => void rerun()}>
            Re-run checks
          </Button>
        )}
      </div>
      {err && <div className="text-sm text-danger">{err}</div>}
      {runs.length === 0 && (
        <Box>
          <EmptyState title="No checks yet">Checks are queued when commits are pushed. They appear here once the worker picks them up.</EmptyState>
        </Box>
      )}
      {projects.map((p) => (
        <Box key={p}>
          <BoxHeader>
            <span className="font-mono text-sm">{p || 'Repository'}</span>
          </BoxHeader>
          {runs
            .filter((r) => r.projectPath === p)
            .map((r) => (
              <RunRow key={r.id} run={r} owner={owner} repo={repo} />
            ))}
        </Box>
      ))}
    </div>
  );
}
