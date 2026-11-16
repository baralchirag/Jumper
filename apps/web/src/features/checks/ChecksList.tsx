import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Crosshair, RefreshCw, Search } from 'lucide-react';
import type { CheckAnnotation, CheckName, CheckRunInfo } from '@jumper/shared';
import { Button, cx } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';
import { CheckIcon, rollup, runState } from './CheckStatus';
import { shortSha } from '../../shared/components/common';

const TITLES: Record<CheckName, string> = {
  ERC: 'Electrical rules',
  DRC: 'Design rules',
  BOM: 'Bill of materials',
  Render: 'Renders',
  Exports: 'Fabrication exports',
};

function duration(r: CheckRunInfo): string {
  if (!r.startedAt || !r.completedAt) return '';
  const s = (new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000;
  return s < 60 ? `${Math.max(0, Math.round(s))}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function stateLabel(r: CheckRunInfo): string {
  if (r.status === 'queued') return 'Queued';
  if (r.status === 'in_progress') return 'Running';
  switch (r.conclusion) {
    case 'success':
      return 'Passed';
    case 'failure':
      return 'Failed';
    case 'skipped':
      return 'Skipped';
    case 'timed_out':
      return 'Timed out';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Neutral';
  }
}

/** Small mono key/value used for counts: only the number carries colour. */
function Count({ n, tone, unit }: { n: number; tone: 'danger' | 'attention'; unit: string }) {
  if (!n) return null;
  return (
    <span className="whitespace-nowrap font-mono text-xs text-fg-subtle">
      <span className={cx('tabular-nums', tone === 'danger' ? 'text-danger' : 'text-attention')}>{n}</span> {unit}
    </span>
  );
}

// ─── Violations ────────────────────────────────────────────────────────────

function ViolationGroup({ type, items, run, owner, repo, file }: { type: string; items: CheckAnnotation[]; run: CheckRunInfo; owner: string; repo: string; file: string | null }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(50);
  const errors = items.some((a) => a.severity === 'error');
  return (
    <li className="border-t border-border-muted first:border-t-0">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-baseline gap-3 py-2 text-left hover:text-fg">
        <ChevronRight size={12} className={cx('shrink-0 translate-y-0.5 text-fg-subtle transition-transform', open && 'rotate-90')} />
        <span className={cx('w-8 shrink-0 text-right font-mono text-xs tabular-nums', errors ? 'text-danger' : 'text-attention')}>{items.length}</span>
        <span className="shrink-0 font-mono text-[13px]">{type}</span>
        <span className="min-w-0 truncate text-xs text-fg-muted">{items[0]?.message}</span>
      </button>
      {open && (
        <ul className="mb-2 ml-[3.25rem] border-l border-border-muted">
          {items.slice(0, limit).map((a, i) => (
            <li key={i} className="flex items-start gap-3 py-1.5 pl-3 text-[13px]">
              <div className="min-w-0 flex-1">
                <div className="text-fg">{a.message}</div>
                {a.items?.map((it, j) => (
                  <div key={j} className="truncate text-xs text-fg-muted">
                    {it.description}
                  </div>
                ))}
              </div>
              {a.x !== undefined && file ? (
                <Link
                  to="/$owner/$repo/blob/$ref/$"
                  params={{ owner, repo, ref: run.sha, _splat: file }}
                  search={{ check: run.id, x: a.x, y: a.y }}
                  className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-muted hover:text-accent"
                  title="Show on the design"
                >
                  <Crosshair size={11} /> Locate
                </Link>
              ) : (
                a.sheet && <span className="shrink-0 font-mono text-xs text-fg-subtle">{a.sheet}</span>
              )}
            </li>
          ))}
          {items.length > limit && (
            <li className="py-1.5 pl-3">
              <button onClick={() => setLimit((l) => l + 200)} className="text-xs text-accent hover:underline">
                Show {Math.min(200, items.length - limit)} more
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function Violations({ run, owner, repo }: { run: CheckRunInfo; owner: string; repo: string }) {
  const annotations = useMemo(() => run.details?.annotations ?? [], [run.details]);
  const errors = annotations.filter((a) => a.severity === 'error').length;
  const warnings = annotations.filter((a) => a.severity === 'warning').length;
  const [sev, setSev] = useState<'all' | 'error' | 'warning'>(errors ? 'error' : 'all');
  const [q, setQ] = useState('');
  const file = typeof run.details?.file === 'string' ? run.details.file : null;
  const groups = useMemo(() => {
    const s = q.toLowerCase();
    const m = new Map<string, CheckAnnotation[]>();
    for (const a of annotations) {
      if (sev !== 'all' && a.severity !== sev) continue;
      if (s && !`${a.type} ${a.message} ${a.items?.map((i) => i.description).join(' ')}`.toLowerCase().includes(s)) continue;
      m.set(a.type, [...(m.get(a.type) ?? []), a]);
    }
    return [...m].sort((x, y) => Number(y[1].some((a) => a.severity === 'error')) - Number(x[1].some((a) => a.severity === 'error')) || y[1].length - x[1].length);
  }, [annotations, sev, q]);
  if (!annotations.length) return null;
  const tabs = [
    ['error', 'Errors', errors],
    ['warning', 'Warnings', warnings],
    ['all', 'All', annotations.length],
  ] as const;
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border-muted pb-2">
        <div role="tablist" aria-label="Severity" className="flex gap-4 text-xs">
          {tabs.map(([v, l, n]) => (
            <button
              key={v}
              role="tab"
              aria-selected={sev === v}
              onClick={() => setSev(v)}
              className={cx('pb-0.5 transition-colors', sev === v ? 'border-b border-fg text-fg' : 'text-fg-muted hover:text-fg')}
            >
              {l} <span className="font-mono tabular-nums text-fg-subtle">{n}</span>
            </button>
          ))}
        </div>
        <label className="relative ml-auto">
          <span className="sr-only">Filter violations</span>
          <Search size={12} className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter"
            className="w-40 border-0 bg-transparent py-0.5 pl-5 text-xs text-fg placeholder:text-fg-subtle focus:outline-none"
          />
        </label>
      </div>
      {groups.length ? (
        <ul className="max-h-[55vh] overflow-y-auto">
          {groups.map(([type, items]) => (
            <ViolationGroup key={type} type={type} items={items} run={run} owner={owner} repo={repo} file={file} />
          ))}
        </ul>
      ) : (
        <p className="py-4 text-xs text-fg-muted">Nothing matches.</p>
      )}
    </div>
  );
}

// ─── Detail ────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
      <div className="text-xs text-fg-subtle">{label}</div>
      <div className="min-w-0 text-[13px]">{children}</div>
    </div>
  );
}

interface LibraryUse {
  nickname: string;
  status: 'project' | 'standard' | 'file-missing' | 'missing' | 'unknown';
  uses: number;
  examples: string[];
  uri?: string;
}
interface LibraryDetails {
  symbols: LibraryUse[];
  footprints: LibraryUse[];
  missingSheets: string[];
}

/** Libraries only on the author's computer: the board still renders from embedded copies, but a fresh clone warns. */
function LibraryField({ libraries, problems }: { libraries: LibraryDetails; problems: LibraryUse[] }) {
  const kind = (l: LibraryUse) => (libraries.symbols.includes(l) ? 'symbol' : 'footprint');
  return (
    <Field label="Libraries">
      <p className="text-xs text-fg-muted">
        Jumper rendered this from the copies KiCad stores in the design, but anyone who clones the repository will get missing-library warnings and cannot update parts from these libraries.
      </p>
      <ul className="mt-2 space-y-1.5 text-xs">
        {problems.map((l) => (
          <li key={`${kind(l)}-${l.nickname}`}>
            <span className="font-mono font-medium text-attention">{l.nickname}</span>{' '}
            <span className="text-fg-muted">
              {kind(l)} library, used {l.uses}× (e.g. <span className="font-mono">{l.examples[0]}</span>).{' '}
              {l.status === 'file-missing' ? (
                <>
                  Listed in the project&rsquo;s {kind(l) === 'symbol' ? 'sym-lib-table' : 'fp-lib-table'} as <span className="font-mono">{l.uri}</span>, but that {kind(l) === 'symbol' ? 'file' : 'folder'} is not committed.
                </>
              ) : (
                <>
                  Not a standard KiCad library and not in the project&rsquo;s {kind(l) === 'symbol' ? 'sym-lib-table' : 'fp-lib-table'}. Commit it (e.g. under <span className="font-mono">libs/</span>) and add it as a project library with the path{' '}
                  <span className="font-mono">{'${KIPRJMOD}/libs/…'}</span>.
                </>
              )}
            </span>
          </li>
        ))}
        {libraries.missingSheets.map((s) => (
          <li key={s}>
            <span className="font-mono font-medium text-danger">{s}</span> <span className="text-fg-muted">is used as a sheet in the schematic but is not committed. Pages from it are missing from renders and the BOM.</span>
          </li>
        ))}
      </ul>
      <Link to="/docs/$slug" params={{ slug: 'faq' }} hash="missing-libraries" className="link mt-2 inline-block text-xs">
        How to fix missing libraries
      </Link>
    </Field>
  );
}

function CheckDetail({ run, owner, repo }: { run: CheckRunInfo; owner: string; repo: string }) {
  const d = run.details;
  const done = Array.isArray(d?.done) ? (d.done as string[]) : Array.isArray(d?.produced) ? (d.produced as string[]) : [];
  const failed = [...(Array.isArray(d?.failed) ? (d.failed as string[]) : []), ...(Array.isArray(d?.failures) ? (d.failures as string[]) : [])];
  const models = d?.models as { resolved: number; missing: string[] } | undefined;
  const libraries = d?.libraries as LibraryDetails | undefined;
  const libProblems = libraries ? [...libraries.symbols, ...libraries.footprints].filter((l) => l.status === 'missing' || l.status === 'file-missing') : [];
  const changes = Array.isArray(d?.changes) ? (d.changes as { op: string; value: string; footprint: string; quantityBefore: number; quantityAfter: number }[]) : [];
  const [showLog, setShowLog] = useState(false);
  const hasViolations = (d?.annotations?.length ?? 0) > 0;
  const nothing = !hasViolations && !done.length && !failed.length && !changes.length && !d?.log && !models?.missing.length && !libProblems.length && !libraries?.missingSheets.length;

  return (
    <div className="space-y-4 border-t border-border-muted bg-canvas-subtle/40 px-4 py-4 sm:pl-11">
      <div className="space-y-2 empty:hidden">
        {done.length > 0 && (
          <Field label="Generated">
            <span className="font-mono text-xs leading-6 text-fg-muted">{done.join(' · ')}</span>{' '}
            <Link to="/$owner/$repo/outputs" params={{ owner, repo }} search={{ sha: run.sha }} className="link ml-1 text-xs">
              Open outputs
            </Link>
          </Field>
        )}
        {failed.length > 0 && (
          <Field label="Failed steps">
            <ul className="font-mono text-xs text-danger">
              {failed.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </Field>
        )}
        {models && models.missing.length > 0 && (
          <Field label="3D models">
            <p className="text-xs text-fg-muted">
              <span className="text-attention">{models.missing.length} missing</span>, {models.resolved} resolved from the KiCad library. Commit custom models next to the project and reference them as{' '}
              <code className="font-mono">{'${KIPRJMOD}/…'}</code>.
            </p>
            <ul className="mt-1 space-y-0.5 font-mono text-xs text-fg-muted">
              {models.missing.map((m) => (
                <li key={m} className="truncate">
                  {m}
                </li>
              ))}
            </ul>
          </Field>
        )}
        {libraries && (libProblems.length > 0 || libraries.missingSheets.length > 0) && <LibraryField libraries={libraries} problems={libProblems} />}
        {changes.length > 0 && (
          <Field label="BOM changes">
            <table className="w-full text-xs">
              <tbody>
                {changes.map((c, i) => (
                  <tr key={i} className="border-t border-border-muted first:border-t-0">
                    <td className={cx('w-16 py-1 font-mono', c.op === 'added' ? 'text-success' : c.op === 'removed' ? 'text-danger' : 'text-attention')}>{c.op}</td>
                    <td className="py-1">{c.value}</td>
                    <td className="truncate py-1 font-mono text-fg-muted">{c.footprint}</td>
                    <td className="py-1 text-right font-mono tabular-nums text-fg-muted">
                      {c.quantityBefore} → {c.quantityAfter}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Field>
        )}
      </div>
      {hasViolations && <Violations run={run} owner={owner} repo={repo} />}
      {d?.log && (
        <div>
          <button onClick={() => setShowLog((s) => !s)} className="text-xs text-fg-muted hover:text-fg">
            {showLog ? 'Hide' : 'Show'} raw log
          </button>
          {showLog && <pre className="mt-2 max-h-72 overflow-auto border border-border-muted bg-canvas-inset p-3 font-mono text-xs">{d.log}</pre>}
        </div>
      )}
      {nothing && <p className="text-xs text-fg-muted">{run.status === 'completed' ? 'Nothing else to report.' : 'Waiting for the worker…'}</p>}
    </div>
  );
}

// ─── List ──────────────────────────────────────────────────────────────────

function CheckRow({ run, open, onToggle, owner, repo }: { run: CheckRunInfo; open: boolean; onToggle: () => void; owner: string; repo: string }) {
  const c = run.details?.counts;
  const st = runState(run);
  return (
    <li className="border-b border-border-muted last:border-b-0">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 text-left transition-colors hover:bg-canvas-subtle sm:grid-cols-[1rem_9rem_minmax(0,1fr)_auto_3rem_1rem]"
      >
        <CheckIcon state={st} size={15} />
        <span className="flex items-baseline gap-2 sm:block">
          <span className="font-mono text-[13px] font-medium">{run.name}</span>
          <span className="text-xs text-fg-muted sm:hidden">{stateLabel(run)}</span>
        </span>
        <span className="col-span-3 col-start-2 row-start-2 truncate text-[13px] text-fg-muted sm:col-span-1 sm:col-start-auto sm:row-start-auto">
          {run.status === 'completed' ? (run.summary ?? TITLES[run.name] ?? '') : stateLabel(run) + '…'}
        </span>
        <span className="hidden items-center gap-3 sm:flex">
          {c && <Count n={c.error} tone="danger" unit="err" />}
          {c && <Count n={c.warning} tone="attention" unit="warn" />}
          <span className={cx('text-xs', st === 'failure' ? 'text-danger' : 'text-fg-subtle')}>{stateLabel(run)}</span>
        </span>
        <span className="hidden text-right font-mono text-xs tabular-nums text-fg-subtle sm:block">{duration(run)}</span>
        <ChevronRight size={14} className={cx('hidden text-fg-subtle transition-transform sm:block', open && 'rotate-90')} />
      </button>
      {open && <CheckDetail run={run} owner={owner} repo={repo} />}
    </li>
  );
}

export function ChecksList({ owner, repo, sha, runs, canRerun }: { owner: string; repo: string; sha: string; runs: CheckRunInfo[]; canRerun?: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const projects = useMemo(() => [...new Set(runs.map((r) => r.projectPath))], [runs]);
  const firstFailing = runs.find((r) => runState(r) === 'failure');
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  const expanded = openId === undefined ? (firstFailing?.id ?? null) : openId;

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

  const state = rollup(runs);
  const failing = runs.filter((r) => runState(r) === 'failure').length;
  const passed = runs.filter((r) => runState(r) === 'success').length;
  const pending = runs.filter((r) => runState(r) === 'pending').length;
  const headline =
    state === 'failure'
      ? `${failing} of ${runs.length} checks failing`
      : state === 'pending'
        ? `${pending} of ${runs.length} checks running`
        : state === 'success'
          ? `All ${runs.length} checks passed`
          : runs.length
            ? 'Checks completed'
            : 'No checks yet';
  const kicad = runs.map((r) => r.details?.kicadVersion).find((v) => typeof v === 'string') as string | undefined;
  const total = runs.reduce((s, r) => {
    if (!r.startedAt || !r.completedAt) return s;
    return s + (new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000;
  }, 0);

  return (
    <section aria-labelledby="checks-h">
      <header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <CheckIcon state={state} size={18} />
        <h2 id="checks-h" className="text-[15px] font-medium tracking-[-0.01em]">
          {headline}
        </h2>
        <span className="flex flex-wrap items-center gap-x-3 font-mono text-xs text-fg-subtle">
          <Link to="/$owner/$repo/commit/$sha" params={{ owner, repo, sha }} className="text-fg-muted hover:text-accent">
            {shortSha(sha)}
          </Link>
          {passed > 0 && state === 'failure' && <span>{passed} passed</span>}
          {kicad && <span>kicad {kicad}</span>}
          {total > 0 && <span>{total < 60 ? `${Math.round(total)}s` : `${Math.floor(total / 60)}m ${Math.round(total % 60)}s`} total</span>}
        </span>
        {canRerun && runs.length > 0 && (
          <Button size="sm" variant="invisible" className="ml-auto" leadingIcon={<RefreshCw size={13} />} loading={busy} onClick={() => void rerun()}>
            Re-run
          </Button>
        )}
      </header>
      {err && <p className="mb-3 text-xs text-danger">{err}</p>}

      {runs.length === 0 ? (
        <p className="border-y border-border py-10 text-center text-[13px] text-fg-muted">Checks are queued when commits are pushed and appear here once the worker picks them up.</p>
      ) : (
        <div className="space-y-6">
          {projects.map((p) => (
            <div key={p}>
              {(projects.length > 1 || p) && <h3 className="mb-2 font-mono text-xs text-fg-subtle">{p || 'Repository'}</h3>}
              <ul className="border-y border-border">
                {runs
                  .filter((r) => r.projectPath === p)
                  .map((r) => (
                    <CheckRow key={r.id} run={r} open={expanded === r.id} onToggle={() => setOpenId(expanded === r.id ? null : r.id)} owner={owner} repo={repo} />
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
