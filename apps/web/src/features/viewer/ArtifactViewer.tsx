import { Suspense, lazy, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ExternalLink, FileArchive, FileQuestion, Folder, Minus, Plus } from 'lucide-react';
import type { ArtifactInfo } from '@jumper/shared';
import { Button, EmptyState, Flash, Input, PageSpinner, buttonClass } from '@jumper/ui';
import { downloadUrl, OUTPUT_KINDS, outputTitle, viewerKind } from '../checks/outputs';
import { CodeView } from '../../shared/components/CodeView';
import { formatBytes } from '../../shared/components/common';
import { loadDesign } from './kicad';
import { VIEWER_HEIGHT } from './layout';

const Viewer3DPanel = lazy(() => import('./Viewer3DPanel').then((m) => ({ default: m.Viewer3DPanel })));

const MAX_TEXT = 4 * 1024 * 1024;

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

function useText(a: ArtifactInfo, enabled: boolean) {
  return useQuery({
    queryKey: ['artifact-text', a.id],
    queryFn: async () => {
      const r = await fetch(a.url, { credentials: 'include' });
      if (!r.ok) throw new Error(`Could not load file (${r.status})`);
      return r.text();
    },
    enabled: enabled && a.size <= MAX_TEXT,
    staleTime: Infinity,
  });
}

function CsvView({ a, height }: { a: ArtifactInfo; height: string }) {
  const q = useText(a, true);
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => (q.data ? parseCsv(q.data) : []), [q.data]);
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <Flash tone="danger" className="m-4">{(q.error as Error).message}</Flash>;
  const [head = [], ...body] = rows;
  const f = filter.toLowerCase();
  const shown = f ? body.filter((r) => r.some((c) => c.toLowerCase().includes(f))) : body;
  return (
    <div className="flex flex-col" style={{ height }}>
      <div className="flex items-center gap-3 border-b border-border-muted px-4 py-2">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter rows…" className="h-7 max-w-xs text-xs" />
        <span className="text-xs text-fg-muted">
          {shown.length} of {body.length} rows
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-canvas-subtle text-left text-xs text-fg-muted">
            <tr>
              {head.map((h, i) => (
                <th key={i} className="whitespace-nowrap px-4 py-2 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 5000).map((r, i) => (
              <tr key={i} className="border-t border-border-muted hover:bg-canvas-subtle">
                {r.map((c, j) => (
                  <td key={j} className="max-w-sm truncate px-4 py-1.5 font-mono text-xs" title={c}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TextView({ a, height, json }: { a: ArtifactInfo; height: string; json?: boolean }) {
  const q = useText(a, true);
  const text = useMemo(() => {
    if (!q.data || !json) return q.data ?? '';
    try {
      return JSON.stringify(JSON.parse(q.data), null, 2);
    } catch {
      return q.data;
    }
  }, [q.data, json]);
  if (a.size > MAX_TEXT) return <TooLarge a={a} />;
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <Flash tone="danger" className="m-4">{(q.error as Error).message}</Flash>;
  return <CodeView text={text} path={a.name} maxHeight={height} />;
}

function ImageView({ a, height }: { a: ArtifactInfo; height: string }) {
  const [zoom, setZoom] = useState(1);
  return (
    <div className="relative" style={{ height }}>
      <div className="checker h-full overflow-auto">
        <div className="flex min-h-full items-center justify-center p-6">
          <img src={a.url} alt={outputTitle(a)} style={{ width: `${zoom * 100}%`, maxWidth: zoom === 1 ? '100%' : 'none' }} className="rounded shadow-card" />
        </div>
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-border bg-canvas/95 p-1 shadow-overlay">
        <Button size="sm" variant="invisible" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))} leadingIcon={<Minus size={14} />} />
        <span className="w-12 text-center text-xs tabular-nums text-fg-muted">{Math.round(zoom * 100)}%</span>
        <Button size="sm" variant="invisible" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(6, z * 1.25))} leadingIcon={<Plus size={14} />} />
      </div>
    </div>
  );
}

function ArchiveView({ a }: { a: ArtifactInfo }) {
  const files = Array.isArray(a.meta.files) ? (a.meta.files as string[]) : [];
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    groups.set(dir, [...(groups.get(dir) ?? []), f.slice(f.lastIndexOf('/') + 1)]);
  }
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-5 flex items-center gap-4 rounded-xl border border-border bg-canvas-subtle p-5">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent-subtle text-accent">
          <FileArchive size={24} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{a.name}</div>
          <div className="text-sm text-fg-muted">
            {files.length} files · {formatBytes(a.size)}
            {a.kind === 'fab_package' && a.meta.format === 'jlcpcb' && ' · upload directly at jlcpcb.com'}
          </div>
        </div>
        <a href={downloadUrl(a)} className={buttonClass('accent', 'md')}>
          <Download size={14} /> Download
        </a>
      </div>
      {[...groups].map(([dir, names]) => (
        <div key={dir} className="mb-4">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            <Folder size={12} /> {dir || 'Files'}
          </div>
          <div className="grid gap-1 sm:grid-cols-2">
            {names.map((n) => (
              <div key={n} className="truncate rounded-md border border-border-muted bg-canvas px-3 py-1.5 font-mono text-xs" title={n}>
                {n}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TooLarge({ a }: { a: ArtifactInfo }) {
  return (
    <EmptyState icon={<FileQuestion size={24} />} title="Too large to preview" action={<a href={downloadUrl(a)} className={buttonClass('accent')}>Download ({formatBytes(a.size)})</a>}>
      This file is best opened in a dedicated tool.
    </EmptyState>
  );
}

/** Inline preview of any check output, with open / download actions. */
/**
 * kicad-cli's GLB with the board it came from, parsed in the browser: it gives untextured parts their finish and lets a
 * click find the part or net under it. The board shares the project's name (KiCad requires it).
 */
function GlbView({ a, repo, height }: { a: ArtifactInfo; repo?: { owner: string; name: string }; height: string }) {
  const path = a.projectPath.replace(/\.kicad_pro$/, '.kicad_pcb');
  const design = useQuery({
    queryKey: ['design', repo?.owner, repo?.name, a.sha, path],
    queryFn: () => loadDesign(repo!.owner, repo!.name, a.sha, path),
    enabled: Boolean(repo) && path.endsWith('.kicad_pcb'),
    staleTime: Infinity,
    retry: false,
  });
  // Wait briefly for the board so the model loads once with its finishes; without it the GLB still shows.
  if (repo && design.isLoading) return <PageSpinner label="Loading 3D viewer…" />;
  return <Viewer3DPanel key={a.id} glbUrl={a.url} pcb={design.data?.kind === 'pcb' ? design.data.model : null} height={height} />;
}

export function ArtifactViewer({
  artifact: a,
  height = VIEWER_HEIGHT,
  chrome = true,
  repo,
}: {
  artifact: ArtifactInfo;
  height?: string;
  chrome?: boolean;
  /** The repository the artifact belongs to; lets the 3D view load the board for picking. */
  repo?: { owner: string; name: string };
}) {
  const kind = viewerKind(a);
  const k = OUTPUT_KINDS[a.kind];
  const Icon = k?.icon ?? FileQuestion;
  return (
    <div className="flex min-w-0 flex-col">
      {chrome && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-canvas-inset text-fg-muted">
            <Icon size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{outputTitle(a)}</div>
            <div className="truncate text-xs text-fg-muted">
              <span className="font-mono">{a.name}</span> · {formatBytes(a.size)}
              {k && ` · ${k.hint}`}
            </div>
          </div>
          <a href={a.url} target="_blank" rel="noreferrer" className={buttonClass('invisible', 'sm')}>
            <ExternalLink size={14} /> Open
          </a>
          <a href={downloadUrl(a)} className={buttonClass('default', 'sm')}>
            <Download size={14} /> Download
          </a>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {kind === 'pdf' && <iframe key={a.id} src={`${a.url}#view=FitH&toolbar=1`} title={outputTitle(a)} className="block w-full border-0 bg-canvas-inset" style={{ height }} />}
        {kind === 'image' && <ImageView a={a} height={height} />}
        {kind === '3d-glb' && (
          <Suspense fallback={<PageSpinner label="Loading 3D viewer…" />}>
            <GlbView a={a} repo={repo} height={height} />
          </Suspense>
        )}
        {kind === '3d-step' && (
          <Suspense fallback={<PageSpinner label="Loading 3D viewer…" />}>
            <Viewer3DPanel key={a.id} stepUrl={a.url} height={height} />
          </Suspense>
        )}
        {kind === 'csv' && <CsvView a={a} height={height} />}
        {(kind === 'json' || kind === 'text') && <TextView a={a} height={height} json={kind === 'json'} />}
        {kind === 'archive' && <ArchiveView a={a} />}
        {kind === 'none' && <TooLarge a={a} />}
      </div>
    </div>
  );
}
