import { lazy, Suspense, useState } from 'react';
import { useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { PageSpinner, Spinner, cx } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { DesignViewer } from '../viewer/DesignViewer';
import { loadDesign } from '../viewer/kicad';

const Viewer3DPanel = lazy(() => import('../viewer/Viewer3DPanel').then((m) => ({ default: m.Viewer3DPanel })));

interface EmbedInfo {
  owner: string;
  repo: string;
  ref: string;
  sha: string;
  pcb: string | null;
  sch: string | null;
  description: string;
}

type View = 'pcb' | 'sch' | '3d';

/**
 * Interactive board viewer for other sites: <iframe src="https://host/embed/owner/repo?view=pcb">.
 * Public repositories only. Follows the branch, so it always shows the latest pushed revision.
 */
export function EmbedViewerPage() {
  const { owner = '', repo = '' } = useParams({ strict: false }) as { owner?: string; repo?: string };
  const search = useSearch({ strict: false }) as { view?: View; branch?: string; path?: string };
  const info = useQuery({ queryKey: ['embed', owner, repo, search.branch, search.path], queryFn: () => api.get<EmbedInfo>(repoPath(owner, repo, '/embed'), { branch: search.branch, path: search.path }), retry: false });
  const initial: View = search.view ?? 'pcb';
  const [view, setView] = useState<View>(initial);
  const e = info.data;
  const effective: View = e && view === 'sch' && !e.sch ? 'pcb' : e && view !== 'sch' && !e.pcb ? 'sch' : view;
  const path = effective === 'sch' ? e?.sch : e?.pcb;
  const design = useQuery({ queryKey: ['design', owner, repo, e?.sha, path], queryFn: () => loadDesign(e!.owner, e!.repo, e!.sha, path!), enabled: Boolean(e && path), staleTime: Infinity, retry: false });
  const page = e ? `${window.location.origin}/${e.owner}/${e.repo}` : '#';

  return (
    <div className="flex h-screen flex-col bg-canvas text-fg">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-3 text-[13px]">
        <a href={page} target="_blank" rel="noopener" className="min-w-0 truncate font-medium hover:text-accent">
          {owner}/{repo}
        </a>
        {e && <span className="hidden font-mono text-xs text-fg-subtle sm:inline">{e.ref} · {e.sha.slice(0, 7)}</span>}
        <nav className="ml-auto flex gap-0.5" aria-label="View">
          {(['pcb', 'sch', '3d'] as const).map((v) => {
            const disabled = !e || (v === 'sch' ? !e.sch : !e.pcb);
            return (
              <button key={v} type="button" disabled={disabled} onClick={() => setView(v)} className={cx('rounded-sm px-2 py-1 text-xs', effective === v ? 'bg-neutral-muted font-medium' : 'text-fg-muted hover:text-fg', disabled && 'opacity-40')}>
                {v === 'pcb' ? 'Board' : v === 'sch' ? 'Schematic' : '3D'}
              </button>
            );
          })}
        </nav>
        <a href={page} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg" title="Open on Jumper">
          Jumper <ExternalLink size={11} />
        </a>
      </header>
      <main className="relative min-h-0 flex-1">
        {info.isLoading ? (
          <PageSpinner />
        ) : info.error ? (
          <p className="p-6 text-[13px] text-fg-muted">{errorMessage(info.error)}</p>
        ) : design.isLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-[13px] text-fg-muted"><Spinner /> Loading design…</div>
        ) : design.error ? (
          <p className="p-6 text-[13px] text-fg-muted">Could not open the design: {errorMessage(design.error)}</p>
        ) : effective === '3d' ? (
          <Suspense fallback={<PageSpinner label="Loading 3D viewer…" />}>
            <Viewer3DPanel pcb={design.data?.kind === 'pcb' ? design.data.model : null} height="calc(100vh - 40px)" />
          </Suspense>
        ) : (
          design.data && <DesignViewer key={path} design={design.data} height="calc(100vh - 40px)" className="rounded-none border-0" />
        )}
      </main>
    </div>
  );
}
