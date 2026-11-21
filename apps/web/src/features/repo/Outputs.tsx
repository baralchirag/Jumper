import { Suspense, lazy, useMemo } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Box as BoxIcon, Download, FolderDown, Hourglass, Image as ImageIcon, Rotate3d } from 'lucide-react';
import type { ArtifactInfo, ArtifactKind, CheckName, CheckRunInfo } from '@jumper/shared';
import { kicadFileKind } from '@jumper/shared';
import { EmptyState, PageSpinner, Spinner, cx } from '@jumper/ui';
import { ArtifactViewer } from '../viewer/ArtifactViewer';
import { CheckIcon, rollup } from '../checks/CheckStatus';
import { RefPicker } from '../../shared/components/RefPicker';
import { ErrorView, formatBytes, shortSha } from '../../shared/components/common';
import { api, repoPath } from '../../shared/lib/api';
import { downloadUrl, isOutput, OUTPUT_GROUPS, OUTPUT_KINDS, outputTitle, sortOutputs, type OutputGroup } from '../checks/outputs';
import { keys, useChecks } from '../../shared/lib/queries';
import { loadDesign } from '../viewer/kicad';
import type { Source3D } from '../viewer/Viewer3DPanel';
import { VIEWER_HEIGHT } from '../viewer/layout';
import { useRepoInfo } from './context';
import { FabOrderLink, isOrderableFab } from '../checks/FabOrder';
import { MissingFiles, useDesigns } from './MissingFiles';

// three.js and OpenCascade load only when a 3D view is shown.
const Viewer3DPanel = lazy(() => import('../viewer/Viewer3DPanel').then((m) => ({ default: m.Viewer3DPanel })));


export function useOutputs(owner: string, repo: string, sha: string | undefined) {
  return useQuery({
    queryKey: [...keys.repo(owner, repo), 'artifacts', sha],
    queryFn: () => api.get<{ sha: string; artifacts: ArtifactInfo[] }>(repoPath(owner, repo, '/artifacts'), { sha }),
    enabled: Boolean(sha),
  });
}

/** Which check makes each kind of output, so a missing file can say whether it is still coming. */
const MADE_BY: Partial<Record<ArtifactKind, CheckName>> = {
  fab_package: 'Exports',
  gerbers: 'Exports',
  pos: 'Exports',
  pdf: 'Exports',
  step: 'Exports',
  glb: 'Exports',
  netlist: 'Exports',
  render3d: 'Render',
  bom: 'BOM',
  erc_report: 'ERC',
  drc_report: 'DRC',
};

const stemOf = (p: string) => p.replace(/\.kicad_(pro|pcb|sch)$/i, '');

/** One row in the list: a file, the project's 3D view, or a file that is still being made. */
type Entry =
  | { key: string; type: 'file'; group: OutputGroup; project: string; a: ArtifactInfo }
  | { key: string; type: '3d'; group: OutputGroup; project: string; source: Source3D; title: string; sub: string; thumb?: string; download?: ArtifactInfo }
  | { key: string; type: 'pending'; group: OutputGroup; project: string; title: string; queued: boolean };

function buildEntries(outputs: ArtifactInfo[], projects: string[], pcbs: Map<string, string>, runs: CheckRunInfo[]): Entry[] {
  const out: Entry[] = [];
  for (const p of projects) {
    const mine = outputs.filter((o) => stemOf(o.projectPath) === p);
    const runsHere = runs.filter((r) => stemOf(r.projectPath) === p || !r.projectPath);
    const glb = mine.find((o) => o.kind === 'glb');
    const step = mine.find((o) => o.kind === 'step');
    const renders = mine.filter((o) => o.kind === 'render3d');
    const iso = renders.find((r) => r.meta.view === 'iso-top') ?? renders[0];
    // 3D: one viewer, opened on different views. Available as soon as there is a board file.
    if (pcbs.has(p) || glb || step) {
      out.push({ key: `3d:${p}`, type: '3d', group: '3D', project: p, source: glb ? 'glb' : step && !pcbs.has(p) ? 'step' : 'board', title: '3D view', sub: glb ? 'Real part models · turn, zoom, click parts' : 'Quick preview from your board file', thumb: iso?.url });
    }
    if (renders.length) out.push({ key: `renders:${p}`, type: '3d', group: '3D', project: p, source: 'renders', title: 'Ray-traced images', sub: `${renders.length} ${renders.length === 1 ? 'angle' : 'angles'} from KiCad's renderer`, thumb: iso?.url });
    if (step) out.push({ key: `step:${p}`, type: '3d', group: '3D', project: p, source: 'step', title: 'STEP model', sub: `${formatBytes(step.size)} · for mechanical CAD`, download: step });
    if (glb) out.push({ key: `glb:${p}`, type: '3d', group: '3D', project: p, source: 'glb', title: 'GLB model', sub: `${formatBytes(glb.size)} · for the web and Blender`, download: glb });
    for (const a of mine) {
      if (a.kind === 'render3d' || a.kind === 'step' || a.kind === 'glb') continue;
      out.push({ key: a.id, type: 'file', group: OUTPUT_KINDS[a.kind]!.group, project: p, a });
    }
    // Placeholders for what is still being made, so nobody lands on an empty page.
    const have = new Set(mine.map((o) => o.kind));
    for (const [kind, check] of Object.entries(MADE_BY) as [ArtifactKind, CheckName][]) {
      if (have.has(kind)) continue;
      const run = runsHere.find((r) => r.name === check);
      if (!run || run.status === 'completed') continue;
      const k = OUTPUT_KINDS[kind]!;
      if (kind === 'glb' || kind === 'step') {
        if (out.some((e) => e.key === `pending:${p}:3dmodels`)) continue;
        out.push({ key: `pending:${p}:3dmodels`, type: 'pending', group: '3D', project: p, title: '3D models (STEP, GLB)', queued: run.status === 'queued' });
        continue;
      }
      out.push({ key: `pending:${p}:${kind}`, type: 'pending', group: k.group, project: p, title: kind === 'render3d' ? 'Ray-traced images' : kind === 'pdf' ? 'Schematic and board PDFs' : k.label, queued: run.status === 'queued' });
    }
  }
  return out;
}

function Board3D({ owner, repo, sha, pcbPath, outputs, source }: { owner: string; repo: string; sha: string; pcbPath?: string; outputs: ArtifactInfo[]; source: Source3D }) {
  const design = useQuery({
    queryKey: ['design', owner, repo, sha, pcbPath],
    queryFn: () => loadDesign(owner, repo, sha, pcbPath!),
    enabled: Boolean(pcbPath),
    staleTime: Infinity,
    retry: false,
  });
  const glb = outputs.find((o) => o.kind === 'glb');
  const step = outputs.find((o) => o.kind === 'step');
  const renders = outputs.filter((o) => o.kind === 'render3d');
  if (pcbPath && design.isLoading) return <PageSpinner label="Reading your board…" />;
  const pcb = design.data?.kind === 'pcb' ? design.data.model : null;
  return (
    <Suspense fallback={<PageSpinner label="Loading 3D viewer…" />}>
      {/* Remount when files arrive or the view changes, so the chosen view opens. */}
      <Viewer3DPanel key={`${sha}:${source}:${glb?.id ?? ''}:${renders.length}`} pcb={pcb} glbUrl={glb?.url} stepUrl={step?.url} renders={renders} initialSource={source} height={VIEWER_HEIGHT} />
    </Suspense>
  );
}

export function OutputsPage() {
  const info = useRepoInfo();
  const search = useSearch({ strict: false }) as { sha?: string; id?: string };
  const navigate = useNavigate();
  const ref = search.sha ?? info.defaultBranch;
  const q = useOutputs(info.owner, info.name, info.isEmpty ? undefined : ref);
  const checks = useChecks(info.owner, info.name, info.isEmpty ? null : ref);
  const designs = useDesigns(info.owner, info.name, info.isEmpty ? undefined : ref);
  const runs = useMemo(() => checks.data?.runs ?? [], [checks.data]);

  const outputs = useMemo(() => sortOutputs((q.data?.artifacts ?? []).filter(isOutput)), [q.data]);
  const pcbs = useMemo(() => new Map((designs.data ?? []).filter((p) => kicadFileKind(p) === 'pcb').map((p) => [stemOf(p), p])), [designs.data]);
  const projects = useMemo(() => {
    const fromFiles = outputs.map((o) => stemOf(o.projectPath));
    const fromRuns = runs.map((r) => stemOf(r.projectPath)).filter(Boolean);
    return [...new Set([...fromFiles, ...pcbs.keys(), ...fromRuns])];
  }, [outputs, pcbs, runs]);
  const entries = useMemo(() => buildEntries(outputs, projects, pcbs, runs), [outputs, projects, pcbs, runs]);
  const real = entries.filter((e) => e.type !== 'pending');
  // Old links used an artifact id; a 3D file id opens the 3D view on that model.
  const legacy = outputs.find((o) => o.id === search.id);
  const legacyKey = legacy && (legacy.kind === 'glb' ? `glb:${stemOf(legacy.projectPath)}` : legacy.kind === 'step' ? `step:${stemOf(legacy.projectPath)}` : legacy.kind === 'render3d' ? `renders:${stemOf(legacy.projectPath)}` : null);
  const selected = real.find((e) => e.key === (legacyKey ?? search.id)) ?? real.find((e) => e.type === '3d') ?? real[0];
  const select = (id: string) => void navigate({ to: '/$owner/$repo/outputs', params: { owner: info.owner, repo: info.name }, search: { ...search, id }, replace: true });

  if (info.isEmpty) return <EmptyState icon={<FolderDown size={24} />} title="No outputs yet">Push a KiCad project to generate fabrication files, PDFs and 3D models.</EmptyState>;
  if (q.isLoading || designs.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;

  const state = rollup(runs);
  const pendingCount = entries.filter((e) => e.type === 'pending').length;
  const anyQueued = runs.some((r) => r.status === 'queued');
  const selectedFiles = selected ? outputs.filter((o) => stemOf(o.projectPath) === selected.project) : [];

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
        <span className="ml-auto text-sm text-fg-muted">
          {pendingCount > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              {anyQueued && !runs.some((r) => r.status === 'in_progress') ? <Hourglass size={13} /> : <Spinner size={13} />}
              {outputs.length} ready · {pendingCount} still being made
            </span>
          ) : (
            `${outputs.length} files`
          )}
        </span>
      </div>

      <MissingFiles designs={designs.data} runs={runs} />

      {!entries.length ? (
        <div className="rounded-xl border border-border bg-canvas shadow-card">
          <EmptyState icon={<FolderDown size={24} />} title="No outputs for this commit">
            Outputs are made from the KiCad files in the repository: Gerbers, PDFs, the parts list, 3D models and images.
          </EmptyState>
        </div>
      ) : (
        <div className="grid overflow-hidden rounded-xl border border-border bg-canvas shadow-card lg:grid-cols-[272px_1fr]">
          <aside className="border-b border-border bg-canvas-subtle/60 lg:max-h-[max(560px,calc(100vh-150px))] lg:overflow-y-auto lg:border-b-0 lg:border-r">
            {projects.map((p) => (
              <div key={p} className="py-2">
                {projects.length > 1 && <div className="truncate px-4 pb-1 pt-2 font-mono text-xs text-fg-subtle">{p.split('/').pop()}</div>}
                {(['3D', ...OUTPUT_GROUPS.filter((g) => g !== '3D')] as OutputGroup[]).map((g) => {
                  const items = entries.filter((e) => e.project === p && e.group === g);
                  if (!items.length) return null;
                  return (
                    <div key={g} className="px-2 pb-2">
                      <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">{g}</div>
                      {items.map((e) => (
                        <EntryRow key={e.key} e={e} active={e.key === selected?.key} onSelect={() => select(e.key)} />
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </aside>
          <section className="min-w-0">
            {selected?.type === 'file' && selected.a.kind === 'fab_package' && isOrderableFab(selected.a.meta.format) && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5 text-[13px] text-fg-muted">
                <span>Download the package, then upload it on the fab's order page.</span>
                <FabOrderLink fab={selected.a.meta.format} />
              </div>
            )}
            {selected?.type === 'file' && <ArtifactViewer key={selected.a.id} artifact={selected.a} repo={{ owner: info.owner, name: info.name }} height={VIEWER_HEIGHT} />}
            {selected?.type === '3d' && (
              <Board3D owner={info.owner} repo={info.name} sha={q.data?.sha ?? ref} pcbPath={pcbs.get(selected.project)} outputs={selectedFiles} source={selected.source} />
            )}
            {!selected && (
              <EmptyState icon={<Hourglass size={24} />} title="Your files are on their way">
                Gerbers, PDFs, the parts list and 3D models show up in the list as each one finishes. You can leave this page; they keep building.
              </EmptyState>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function EntryRow({ e, active, onSelect }: { e: Entry; active: boolean; onSelect: () => void }) {
  if (e.type === 'pending') {
    return (
      <div className="flex items-center gap-2.5 px-2 py-1.5 text-fg-subtle" title={e.queued ? 'In line: starts after the quick checks finish' : 'Being made now'}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center">{e.queued ? <Hourglass size={14} /> : <Spinner size={14} />}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm">{e.title}</span>
          <span className="block truncate text-xs">{e.queued ? 'In line' : 'Being made…'}</span>
        </span>
      </div>
    );
  }
  const download = e.type === 'file' ? e.a : e.download;
  const title = e.type === 'file' ? outputTitle(e.a) : e.title;
  const sub = e.type === 'file' ? formatBytes(e.a.size) : e.sub;
  const Icon = e.type === 'file' ? OUTPUT_KINDS[e.a.kind]!.icon : e.source === 'renders' ? ImageIcon : e.source === 'step' || e.source === 'glb' ? BoxIcon : Rotate3d;
  const thumb = e.type === '3d' && (e.key.startsWith('3d:') || e.key.startsWith('renders:')) ? e.thumb : undefined;
  return (
    <div className={cx('group flex items-center rounded-lg', active ? 'bg-canvas shadow-card ring-1 ring-border' : 'hover:bg-canvas-inset')}>
      <button onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left">
        {thumb ? (
          <img src={thumb} alt="" className="h-7 w-9 shrink-0 rounded object-cover" />
        ) : (
          <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', active ? 'bg-accent-subtle text-accent' : 'text-fg-muted')}>
            <Icon size={15} />
          </span>
        )}
        <span className="min-w-0">
          <span className={cx('block truncate text-sm', active && 'font-semibold')}>{title}</span>
          <span className="block truncate text-xs text-fg-subtle">{sub}</span>
        </span>
      </button>
      {download && (
        <a href={downloadUrl(download)} className="mr-1 rounded p-1.5 text-fg-subtle opacity-0 hover:bg-neutral-muted hover:text-fg focus:opacity-100 group-hover:opacity-100" aria-label={`Download ${download.name}`} title="Download">
          <Download size={13} />
        </a>
      )}
    </div>
  );
}
