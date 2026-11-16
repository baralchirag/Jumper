import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, CircuitBoard, Code, Cpu, Download, Gauge, History, Image, Package, Rotate3d } from 'lucide-react';
import type { BomLine } from '@jumper/kicad-core/types';
import type { ArtifactInfo, BlobResponse } from '@jumper/shared';
import { isDesignFile, kicadFileKind, stripExt } from '@jumper/shared';
import type { Marker } from '@jumper/viewer';
import { Box, BoxHeader, EmptyState, Flash, PageSpinner, SegmentedControl, Spinner, buttonClass } from '@jumper/ui';
import { BomPricing } from '../bom/BomPricing';
import { BomTable } from '../bom/BomTable';
import { CostRollup } from '../bom/CostRollup';
import { FabPanel } from '../design/FabPanel';
import { PinmapPanel } from '../design/PinmapPanel';
import { LocksPanel } from '../locks/LocksPanel';
import { CodeView } from '../../shared/components/CodeView';
import { DesignViewer, type DesignViewerHandle } from '../viewer/DesignViewer';
import { Markdown } from '../../shared/components/Markdown';
import { RefPicker } from '../../shared/components/RefPicker';
import { RevisionCompare } from '../viewer/RevisionCompare';
import { SvgViewer } from '../viewer/SvgViewer';
import { Breadcrumbs, ErrorView, formatBytes } from '../../shared/components/common';
import { api, errorMessage, rawUrl, repoPath } from '../../shared/lib/api';
import { loadDesign } from '../viewer/kicad';
import { resolveRelative } from '../../shared/lib/markdown';
import { keys, useChecks } from '../../shared/lib/queries';
import { useRepoInfo } from './context';

// three.js and OpenCascade are only loaded when the 3D tab is opened.
const Viewer3DPanel = lazy(() => import('../viewer/Viewer3DPanel').then((m) => ({ default: m.Viewer3DPanel })));

type Tab = 'view' | 'compare' | 'render' | '3d' | 'bom' | 'fab' | 'firmware' | 'source';

interface BlobSearch {
  tab?: Tab;
  check?: string;
  x?: number;
  y?: number;
  base?: string;
  head?: string;
}

function useArtifacts(owner: string, repo: string, sha: string | undefined) {
  return useQuery({
    queryKey: [...keys.repo(owner, repo), 'artifacts', sha],
    queryFn: () => api.get<{ sha: string; artifacts: ArtifactInfo[] }>(repoPath(owner, repo, '/artifacts'), { sha }),
    enabled: Boolean(sha),
  });
}

function InteractiveView({ owner, repo, sha, path, search }: { owner: string; repo: string; sha: string; path: string; search: BlobSearch }) {
  const navigate = useNavigate();
  const viewer = useRef<DesignViewerHandle>(null);
  const design = useQuery({ queryKey: ['design', owner, repo, sha, path], queryFn: () => loadDesign(owner, repo, sha, path), staleTime: Infinity, retry: false });
  const checks = useChecks(owner, repo, search.check ? sha : null);

  const markers = useMemo<Marker[]>(() => {
    const run = checks.data?.runs.find((r) => r.id === search.check);
    return (run?.details?.annotations ?? [])
      .filter((a) => a.x !== undefined && a.y !== undefined)
      .map((a, i) => ({ id: `a${i}`, kind: a.severity === 'error' ? 'error' : 'warning', at: { x: a.x!, y: a.y! }, label: a.message }));
  }, [checks.data, search.check]);

  useEffect(() => {
    if (design.data && search.x !== undefined && search.y !== undefined) {
      const t = setTimeout(() => viewer.current?.focus({ minX: search.x! - 1, minY: search.y! - 1, maxX: search.x! + 1, maxY: search.y! + 1 }), 50);
      return () => clearTimeout(t);
    }
  }, [design.data, search.x, search.y]);

  if (design.isLoading) {
    return (
      <div className="flex h-[70vh] items-center justify-center gap-2 text-fg-muted">
        <Spinner /> Parsing design…
      </div>
    );
  }
  if (design.error) return <Flash tone="danger" className="m-3">Could not parse this file: {errorMessage(design.error)}</Flash>;
  const dir = path.split('/').slice(0, -1).join('/');
  return (
    <DesignViewer
      ref={viewer}
      design={design.data!}
      height="calc(100vh - 260px)"
      markers={markers}
      onOpenSheet={(file) => void navigate({ to: '/$owner/$repo/blob/$ref/$', params: { owner, repo, ref: sha, _splat: resolveRelative(dir, file) } })}
      toolbar={markers.length ? <span className="mr-2 text-xs text-danger">{markers.length} violation markers</span> : undefined}
    />
  );
}

function Board3DView({ owner, repo, sha, path, glb, step, renders }: { owner: string; repo: string; sha: string; path: string; glb?: ArtifactInfo; step?: ArtifactInfo; renders: ArtifactInfo[] }) {
  const design = useQuery({ queryKey: ['design', owner, repo, sha, path], queryFn: () => loadDesign(owner, repo, sha, path), staleTime: Infinity, retry: false });
  if (design.isLoading && !glb && !step) return <PageSpinner label="Parsing board…" />;
  const pcb = design.data?.kind === 'pcb' ? design.data.model : null;
  return (
    <Suspense fallback={<PageSpinner label="Loading 3D viewer…" />}>
      <Viewer3DPanel key={sha} pcb={pcb} glbUrl={glb?.url} stepUrl={step?.url} renders={renders} height="calc(100vh - 260px)" />
    </Suspense>
  );
}

function BomView({ owner, repo, sha, path }: { owner: string; repo: string; sha: string; path: string }) {
  const [mode, setMode] = useState<'pricing' | 'fields'>('pricing');
  const q = useQuery({
    queryKey: [...keys.repo(owner, repo), 'bom', sha, path],
    queryFn: () => api.get<{ sheets: number; lines: BomLine[] }>(repoPath(owner, repo, '/bom'), { ref: sha, path }),
    staleTime: Infinity,
    enabled: mode === 'fields',
  });
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <SegmentedControl
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'pricing', label: 'Sourcing & pricing' },
            { value: 'fields', label: 'Symbol fields' },
          ]}
        />
      </div>
      {mode === 'pricing' ? (
        <>
          <BomPricing owner={owner} repo={repo} sha={sha} path={path} filename={`${stripExt(path)}-bom.csv`} />
          <div className="p-3">
            <CostRollup owner={owner} repo={repo} sha={sha} path={path} />
          </div>
        </>
      ) : q.isLoading ? (
        <PageSpinner label="Building BOM…" />
      ) : q.error ? (
        <Flash tone="danger" className="m-3">{errorMessage(q.error)}</Flash>
      ) : (
        <BomTable lines={q.data!.lines} filename={`${stripExt(path)}-bom.csv`} />
      )}
    </div>
  );
}

export function BlobPage() {
  const info = useRepoInfo();
  const params = useParams({ strict: false }) as { ref: string; _splat?: string };
  const search = useSearch({ strict: false }) as BlobSearch;
  const navigate = useNavigate();
  const path = params._splat ?? '';
  const gitRef = params.ref;
  const kind = kicadFileKind(path);
  const design = isDesignFile(path);

  const blob = useQuery({
    queryKey: [...keys.repo(info.owner, info.name), 'blob', gitRef, path],
    queryFn: () => api.get<BlobResponse>(repoPath(info.owner, info.name, '/blob'), { ref: gitRef, path }),
  });
  const artifacts = useArtifacts(info.owner, info.name, design ? blob.data?.sha : undefined);
  const [mdSource, setMdSource] = useState(false);
  const tab: Tab = search.tab ?? (design ? 'view' : 'source');
  const setTab = (t: Tab) =>
    void navigate({ to: '/$owner/$repo/blob/$ref/$', params: { owner: info.owner, repo: info.name, ref: gitRef, _splat: path }, search: { ...search, tab: t }, replace: true });

  const mine = useMemo(() => {
    const stem = stripExt(path);
    return (artifacts.data?.artifacts ?? []).filter((a) => {
      const p = a.projectPath.replace(/\.(kicad_pro|kicad_pcb|kicad_sch)$/, '');
      return p === stem;
    });
  }, [artifacts.data, path]);

  if (blob.isLoading) return <PageSpinner />;
  if (blob.error) return <ErrorView error={blob.error} />;
  const b = blob.data!;
  const svgs = mine.filter((a) => a.kind === (kind === 'pcb' ? 'pcb_svg' : 'sch_svg'));
  const glb = mine.find((a) => a.kind === 'glb');
  const step = mine.find((a) => a.kind === 'step');
  const renders3d = mine.filter((a) => a.kind === 'render3d');
  const raw = rawUrl(info.owner, info.name, b.sha, path);
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(path);
  const isMarkdown = /\.(md|markdown)$/i.test(path);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <RefPicker owner={info.owner} repo={info.name} value={gitRef} onChange={(r) => void navigate({ to: '/$owner/$repo/blob/$ref/$', params: { owner: info.owner, repo: info.name, ref: r, _splat: path } })} />
        <Breadcrumbs owner={info.owner} repo={info.name} gitRef={gitRef} path={path} />
      </div>
      {design && <LocksPanel path={path} />}
      <Box className="overflow-hidden">
        <BoxHeader className="flex-wrap">
          {design ? (
            <SegmentedControl
              size="sm"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'view', label: 'Interactive', icon: <CircuitBoard size={12} /> },
                { value: 'compare', label: 'Compare versions', icon: <ArrowLeftRight size={12} /> },
                { value: 'render', label: 'KiCad render', icon: <Image size={12} />, disabled: !svgs.length },
                ...(kind === 'pcb' ? [{ value: '3d' as Tab, label: '3D', icon: <Rotate3d size={12} /> }, { value: 'fab' as Tab, label: 'Fab check', icon: <Gauge size={12} /> }] : []),
                ...(kind === 'sch' ? [{ value: 'bom' as Tab, label: 'BOM', icon: <Package size={12} /> }, { value: 'firmware' as Tab, label: 'Firmware', icon: <Cpu size={12} /> }] : []),
                { value: 'source', label: 'Source', icon: <Code size={12} /> },
              ]}
            />
          ) : isMarkdown ? (
            <SegmentedControl
              size="sm"
              value={mdSource ? 'source' : 'preview'}
              onChange={(v) => setMdSource(v === 'source')}
              options={[
                { value: 'preview', label: 'Preview' },
                { value: 'source', label: 'Code' },
              ]}
            />
          ) : null}
          <span className="text-xs text-fg-muted">{formatBytes(b.size)}</span>
          <span className="ml-auto flex items-center gap-1">
            <Link to="/$owner/$repo/commits/$ref" params={{ owner: info.owner, repo: info.name, ref: gitRef }} search={{ path }} className={buttonClass('invisible', 'sm')}>
              <History size={14} /> History
            </Link>
            <a href={raw} className={buttonClass('default', 'sm')} target="_blank" rel="noreferrer">
              Raw
            </a>
            <a href={`${raw}`} download={path.split('/').pop()} className={buttonClass('invisible', 'sm', 'w-7 px-0')} aria-label="Download">
              <Download size={14} />
            </a>
          </span>
        </BoxHeader>

        {design && tab === 'view' && <InteractiveView owner={info.owner} repo={info.name} sha={b.sha} path={path} search={search} />}
        {design && tab === 'compare' && (
          <RevisionCompare
            owner={info.owner}
            repo={info.name}
            path={path}
            gitRef={gitRef}
            base={search.base}
            head={search.head}
            onChange={(next) =>
              void navigate({ to: '/$owner/$repo/blob/$ref/$', params: { owner: info.owner, repo: info.name, ref: gitRef, _splat: path }, search: { ...search, tab: 'compare', ...next }, replace: true })
            }
          />
        )}
        {design && tab === 'render' &&
          (artifacts.isLoading ? (
            <PageSpinner />
          ) : svgs.length ? (
            <SvgViewer key={b.sha} artifacts={svgs} kind={kind === 'pcb' ? 'pcb' : 'sch'} height="calc(100vh - 260px)" />
          ) : (
            <EmptyState icon={<Image size={32} />} title="No KiCad render yet">
              Renders are produced by the Render check. They appear here once it completes.
            </EmptyState>
          ))}
        {design && tab === '3d' && kind === 'pcb' && <Board3DView owner={info.owner} repo={info.name} sha={b.sha} path={path} glb={glb} step={step} renders={renders3d} />}
        {design && tab === 'bom' && <BomView owner={info.owner} repo={info.name} sha={b.sha} path={path} />}
        {design && tab === 'fab' && kind === 'pcb' && <FabPanel owner={info.owner} repo={info.name} sha={b.sha} path={path} />}
        {design && tab === 'firmware' && kind === 'sch' && <div className="p-4"><PinmapPanel owner={info.owner} repo={info.name} sha={b.sha} /></div>}

        {(tab === 'source' || !design) && (
          <>
            {isImage && (
              <div className="checker flex justify-center p-6">
                <img src={raw} alt={path} className="max-h-[70vh] max-w-full" />
              </div>
            )}
            {!isImage && b.binary && (
              <EmptyState title="Binary file">
                <a href={raw} className="link">
                  Download ({formatBytes(b.size)})
                </a>
              </EmptyState>
            )}
            {!isImage && !b.binary && b.truncated && (
              <EmptyState title="File too large to display">
                <a href={raw} className="link">
                  View raw ({formatBytes(b.size)})
                </a>
              </EmptyState>
            )}
            {b.text !== null && isMarkdown && !mdSource && (
              <div className="px-8 py-6">
                <Markdown
                  source={b.text}
                  ctx={{
                    resolveLink: (href) => `/${info.owner}/${info.name}/blob/${encodeURIComponent(gitRef)}/${resolveRelative(path.split('/').slice(0, -1).join('/'), href)}`,
                    resolveImage: (src) => rawUrl(info.owner, info.name, b.sha, resolveRelative(path.split('/').slice(0, -1).join('/'), src)),
                  }}
                />
              </div>
            )}
            {b.text !== null && (!isMarkdown || mdSource) && <CodeView text={b.text} path={path} maxHeight="calc(100vh - 260px)" />}
          </>
        )}
      </Box>
    </div>
  );
}
