import { useMemo } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Download, FolderDown, ListChecks } from 'lucide-react';
import type { ArtifactInfo } from '@jumper/shared';
import { EmptyState, PageSpinner, buttonClass, cx } from '@jumper/ui';
import { ArtifactViewer } from '../viewer/ArtifactViewer';
import { CheckIcon, rollup } from '../checks/CheckStatus';
import { RefPicker } from '../../shared/components/RefPicker';
import { ErrorView, formatBytes, shortSha } from '../../shared/components/common';
import { api, repoPath } from '../../shared/lib/api';
import { downloadUrl, isOutput, OUTPUT_GROUPS, OUTPUT_KINDS, outputTitle, sortOutputs } from '../checks/outputs';
import { keys, useChecks } from '../../shared/lib/queries';
import { useRepoInfo } from './context';
import { FabOrderLink, isOrderableFab } from '../checks/FabOrder';

export function useOutputs(owner: string, repo: string, sha: string | undefined) {
  return useQuery({
    queryKey: [...keys.repo(owner, repo), 'artifacts', sha],
    queryFn: () => api.get<{ sha: string; artifacts: ArtifactInfo[] }>(repoPath(owner, repo, '/artifacts'), { sha }),
    enabled: Boolean(sha),
  });
}

export function OutputsPage() {
  const info = useRepoInfo();
  const search = useSearch({ strict: false }) as { sha?: string; id?: string };
  const navigate = useNavigate();
  const ref = search.sha ?? info.defaultBranch;
  const q = useOutputs(info.owner, info.name, info.isEmpty ? undefined : ref);
  const checks = useChecks(info.owner, info.name, info.isEmpty ? null : ref);

  const outputs = useMemo(() => sortOutputs((q.data?.artifacts ?? []).filter(isOutput)), [q.data]);
  const projects = useMemo(() => [...new Set(outputs.map((o) => o.projectPath))], [outputs]);
  const selected = outputs.find((o) => o.id === search.id) ?? outputs.find((o) => o.kind === 'glb') ?? outputs.find((o) => o.kind === 'pdf') ?? outputs[0];
  const select = (id: string) => void navigate({ to: '/$owner/$repo/outputs', params: { owner: info.owner, repo: info.name }, search: { ...search, id }, replace: true });

  if (info.isEmpty) return <EmptyState icon={<FolderDown size={24} />} title="No outputs yet">Push a KiCad project to generate fabrication files, PDFs and 3D models.</EmptyState>;
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;

  const state = rollup(checks.data?.runs);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <RefPicker
          owner={info.owner}
          repo={info.name}
          value={ref}
          onChange={(r) => void navigate({ to: '/$owner/$repo/outputs', params: { owner: info.owner, repo: info.name }, search: { sha: r } })}
        />
        {q.data && (
          <Link to="/$owner/$repo/checks" params={{ owner: info.owner, repo: info.name }} search={{ sha: q.data.sha }} className="flex items-center gap-1.5 text-sm text-fg-muted hover:text-accent">
            <CheckIcon state={state} size={14} /> Checks for <span className="font-mono">{shortSha(q.data.sha)}</span>
          </Link>
        )}
        <span className="ml-auto text-sm text-fg-muted">{outputs.length} files</span>
      </div>

      {!outputs.length ? (
        <div className="rounded-xl border border-border bg-canvas shadow-card">
          <EmptyState
            icon={<FolderDown size={24} />}
            title={state === 'pending' ? 'Outputs are being generated…' : 'No outputs for this commit'}
            action={
              <Link to="/$owner/$repo/checks" params={{ owner: info.owner, repo: info.name }} search={{ sha: ref }} className={buttonClass('default')}>
                <ListChecks size={14} /> View checks
              </Link>
            }
          >
            The Render and Exports checks produce PDFs, Gerbers, pick-and-place files, 3D models and renders.
          </EmptyState>
        </div>
      ) : (
        <div className="grid overflow-hidden rounded-xl border border-border bg-canvas shadow-card lg:grid-cols-[300px_1fr]">
          <aside className="border-b border-border bg-canvas-subtle/60 lg:max-h-[calc(100vh-170px)] lg:overflow-y-auto lg:border-b-0 lg:border-r">
            {projects.map((p) => (
              <div key={p} className="py-2">
                {projects.length > 1 && <div className="truncate px-4 pb-1 pt-2 font-mono text-xs text-fg-subtle">{p}</div>}
                {OUTPUT_GROUPS.map((g) => {
                  const items = outputs.filter((o) => o.projectPath === p && OUTPUT_KINDS[o.kind]?.group === g);
                  if (!items.length) return null;
                  return (
                    <div key={g} className="px-2 pb-2">
                      <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">{g}</div>
                      {items.map((o) => {
                        const Icon = OUTPUT_KINDS[o.kind]!.icon;
                        const active = o.id === selected?.id;
                        return (
                          <div key={o.id} className={cx('group flex items-center rounded-lg', active ? 'bg-canvas shadow-card ring-1 ring-border' : 'hover:bg-canvas-inset')}>
                            <button onClick={() => select(o.id)} className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left">
                              {o.kind === 'render3d' ? (
                                <img src={o.url} alt="" className="h-7 w-9 shrink-0 rounded object-cover" />
                              ) : (
                                <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', active ? 'bg-accent-subtle text-accent' : 'text-fg-muted')}>
                                  <Icon size={15} />
                                </span>
                              )}
                              <span className="min-w-0">
                                <span className={cx('block truncate text-sm', active && 'font-semibold')}>{outputTitle(o)}</span>
                                <span className="block truncate text-xs text-fg-subtle">{formatBytes(o.size)}</span>
                              </span>
                            </button>
                            <a href={downloadUrl(o)} className="mr-1 rounded p-1.5 text-fg-subtle opacity-0 hover:bg-neutral-muted hover:text-fg group-hover:opacity-100" aria-label={`Download ${o.name}`} title="Download">
                              <Download size={13} />
                            </a>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ))}
          </aside>
          <section className="min-w-0">
            {selected?.kind === 'fab_package' && isOrderableFab(selected.meta.format) && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5 text-[13px] text-fg-muted">
                <span>Download the package, then upload it on the fab's order page.</span>
                <FabOrderLink fab={selected.meta.format} />
              </div>
            )}
            {selected && <ArtifactViewer key={selected.id} artifact={selected} repo={{ owner: info.owner, name: info.name }} height="calc(100vh - 240px)" />}
          </section>
        </div>
      )}
    </div>
  );
}
