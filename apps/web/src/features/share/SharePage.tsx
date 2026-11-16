import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Download, FileText, Folder, ImageIcon, Lock } from 'lucide-react';
import { Box, BoxHeader, BoxRow, Flash, Label, PageSpinner, RelativeTime } from '@jumper/ui';
import { ErrorView, PageContainer, formatBytes } from '../../shared/components/common';
import { ApiError, api } from '../../shared/lib/api';

interface Meta {
  repository: string;
  label: string;
  ref: string;
  sha: string;
  path: string | null;
  watermark: string | null;
  canDownload: boolean;
  expiresAt: string | null;
}
interface Entry {
  name: string;
  type: 'blob' | 'tree' | 'commit';
  size: number | null;
}
interface ArtifactRow {
  id: string;
  kind: string;
  name: string;
  projectPath: string;
  contentType: string;
  size: number;
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const TEXT = /\.(md|txt|csv|json|kicad_pro|kicad_pcb|kicad_sch|yml|yaml)$/i;

/** Tiled, non-interactive watermark laid over the shared content. */
function Watermark({ text }: { text: string }) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='360' height='220'><text x='20' y='120' transform='rotate(-24 180 110)' font-family='sans-serif' font-size='20' fill='rgba(128,128,128,0.28)'>${text.replace(/[<>&"']/g, '')}</text></svg>`;
  return <div aria-hidden className="pointer-events-none fixed inset-0 z-40" style={{ backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")` }} />;
}

function Preview({ token, path, canDownload }: { token: string; path: string; canDownload: boolean }) {
  const src = `/api/share/${token}/file?path=${encodeURIComponent(path)}`;
  const text = useQuery({
    queryKey: ['share-text', token, path],
    enabled: TEXT.test(path),
    queryFn: async () => {
      const r = await fetch(src);
      if (!r.ok) throw new ApiError(r.status, 'failed', 'Could not load file');
      return (await r.text()).slice(0, 400_000);
    },
  });
  if (IMAGE.test(path)) return <img src={src} alt={path} className="mx-auto max-h-[75vh] max-w-full bg-white" />;
  if (/\.pdf$/i.test(path)) return <object data={src} type="application/pdf" className="h-[75vh] w-full" aria-label={path} />;
  if (TEXT.test(path)) {
    if (text.isLoading) return <PageSpinner />;
    if (text.error) return <ErrorView error={text.error} />;
    return <pre className="overflow-auto p-4 font-mono text-[12.5px] leading-relaxed">{text.data}</pre>;
  }
  return (
    <div className="p-6 text-sm text-fg-muted">
      This file type cannot be previewed.
      {canDownload && (
        <>
          {' '}
          <a className="link" href={`${src}&download=1`}>
            Download it
          </a>
          .
        </>
      )}
    </div>
  );
}

export function SharePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const [dir, setDir] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const meta = useQuery({ queryKey: ['share', token], queryFn: () => api.get<Meta>(`/share/${token}`), retry: false });
  const start = meta.data?.path ?? '';
  const isFileScope = Boolean(meta.data?.path && /\.[A-Za-z0-9_]+$/.test(meta.data.path.split('/').pop() ?? ''));
  const current = dir || (isFileScope ? start.split('/').slice(0, -1).join('/') : start);
  const tree = useQuery({
    queryKey: ['share-tree', token, current],
    enabled: Boolean(meta.data),
    queryFn: () => api.get<{ path: string; entries: Entry[] }>(`/share/${token}/tree`, { path: current }),
  });
  const arts = useQuery({ queryKey: ['share-artifacts', token], enabled: Boolean(meta.data), queryFn: () => api.get<ArtifactRow[]>(`/share/${token}/artifacts`) });

  if (meta.isLoading) return <PageSpinner />;
  if (meta.error) {
    return (
      <PageContainer className="py-20">
        <p className="label-mono mb-3">Share link</p>
        <h1 className="display text-[length:var(--t-xl)]">This link is no longer available.</h1>
        <p className="mt-4 max-w-md text-fg-muted">It may have expired or been revoked by the owner. Ask them to send a new one.</p>
      </PageContainer>
    );
  }
  const m = meta.data!;
  const shown = file ?? (isFileScope ? m.path : null);
  const crumbs = current ? current.split('/') : [];
  return (
    <PageContainer className="space-y-4 py-8">
      {m.watermark && <Watermark text={m.watermark} />}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label-mono mb-1 flex items-center gap-1.5">
            <Lock size={11} /> Shared view
          </p>
          <h1 className="headline text-[length:var(--t-l)]">{m.label || m.repository}</h1>
          <p className="mt-1 text-sm text-fg-muted">
            <span className="font-mono">{m.repository}</span> at <span className="font-mono">{m.ref}</span> ({m.sha.slice(0, 7)})
            {m.expiresAt && (
              <>
                {' '}
                · link expires <RelativeTime date={m.expiresAt} />
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Label>{m.canDownload ? 'Downloads allowed' : 'View only'}</Label>
        </div>
      </header>
      <Flash>You are viewing a read-only snapshot shared with you. You do not need an account.</Flash>

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Box>
            <BoxHeader className="flex-wrap gap-1 font-mono text-[13px]">
              <button className="link" onClick={() => (setDir(''), setFile(null))}>
                root
              </button>
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-1">
                  <ChevronRight size={12} className="text-fg-subtle" />
                  <button className="link" onClick={() => (setDir(crumbs.slice(0, i + 1).join('/')), setFile(null))}>
                    {c}
                  </button>
                </span>
              ))}
            </BoxHeader>
            {tree.isLoading && <PageSpinner />}
            {tree.data?.entries.map((e) => {
              const full = current ? `${current}/${e.name}` : e.name;
              return (
                <BoxRow key={e.name} className="flex items-center gap-2 py-1.5 text-sm">
                  {e.type === 'tree' ? <Folder size={15} className="text-fg-muted" /> : <FileText size={15} className="text-fg-muted" />}
                  <button className="min-w-0 flex-1 truncate text-left hover:text-accent" onClick={() => (e.type === 'tree' ? (setDir(full), setFile(null)) : setFile(full))}>
                    {e.name}
                  </button>
                  {e.size !== null && <span className="text-xs text-fg-subtle">{formatBytes(e.size)}</span>}
                </BoxRow>
              );
            })}
          </Box>
          {arts.data && arts.data.length > 0 && (
            <Box>
              <BoxHeader className="gap-2 text-sm font-medium">
                <ImageIcon size={14} /> Renders &amp; reports
              </BoxHeader>
              {arts.data.slice(0, 40).map((a) => (
                <BoxRow key={a.id} className="flex items-center gap-2 py-1.5 text-sm">
                  <a className="min-w-0 flex-1 truncate hover:text-accent" href={`/api/share/${token}/artifacts/${a.id}`} target="_blank" rel="noreferrer">
                    {a.name}
                  </a>
                  {m.canDownload && (
                    <a aria-label={`Download ${a.name}`} href={`/api/share/${token}/artifacts/${a.id}?download=1`}>
                      <Download size={13} />
                    </a>
                  )}
                </BoxRow>
              ))}
            </Box>
          )}
        </div>
        <Box className="min-h-60 overflow-hidden">
          {shown ? (
            <>
              <BoxHeader className="gap-2 font-mono text-[13px]">
                {shown}
                {m.canDownload && (
                  <a className="link ml-auto flex items-center gap-1 font-sans text-xs" href={`/api/share/${token}/file?path=${encodeURIComponent(shown)}&download=1`}>
                    <Download size={12} /> Download
                  </a>
                )}
              </BoxHeader>
              <Preview token={token} path={shown} canDownload={m.canDownload} />
            </>
          ) : (
            <div className="p-8 text-sm text-fg-muted">Choose a file on the left to preview it.</div>
          )}
        </Box>
      </div>
    </PageContainer>
  );
}
