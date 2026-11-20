import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Code, Cpu, FileText, FolderGit2, Search as SearchIcon, Spline } from 'lucide-react';
import type { SearchHit, SearchResults, SearchType } from '@jumper/shared';
import { Box, EmptyState, Label, PageSpinner, RelativeTime, cx } from '@jumper/ui';
import { PageContainer } from '../../shared/components/common';
import { api, repoPath } from '../../shared/lib/api';
import { useRepoInfo } from '../repo/context';

const TABS: { type: SearchType; label: string; icon: ReactNode }[] = [
  { type: 'repos', label: 'Repositories', icon: <FolderGit2 size={15} /> },
  { type: 'parts', label: 'Parts', icon: <Cpu size={15} /> },
  { type: 'nets', label: 'Nets', icon: <Spline size={15} /> },
  { type: 'files', label: 'Files', icon: <FileText size={15} /> },
  { type: 'code', label: 'Code', icon: <Code size={15} /> },
];

export type SearchParams = { q?: string; type?: SearchType };
export const parseSearchParams = (s: Record<string, unknown>): SearchParams => ({
  q: typeof s.q === 'string' ? s.q : undefined,
  type: TABS.some((t) => t.type === s.type) ? (s.type as SearchType) : undefined,
});

function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-xs bg-attention-subtle px-0.5 text-fg">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function RepoChip({ repo, show }: { repo: { owner: string; name: string }; show: boolean }) {
  if (!show) return null;
  return (
    <Link to="/$owner/$repo" params={{ owner: repo.owner, repo: repo.name }} className="shrink-0 font-mono text-xs text-fg-muted hover:text-accent">
      {repo.owner}/{repo.name}
    </Link>
  );
}

function Hit({ h, q, showRepo }: { h: SearchHit; q: string; showRepo: boolean }) {
  const base = 'flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm';
  switch (h.type) {
    case 'repos':
      return (
        <li className={base}>
          <Link to="/$owner/$repo" params={{ owner: h.repo.owner, repo: h.repo.name }} className="font-medium hover:text-accent">
            {h.repo.owner}/<Highlight text={h.repo.name} q={q} />
          </Link>
          <span className="min-w-0 flex-1 truncate text-fg-muted">{h.description}</span>
          <span className="text-xs text-fg-muted">
            <RelativeTime date={h.updatedAt} />
          </span>
        </li>
      );
    case 'files':
      return (
        <li className={base}>
          <Link to="/$owner/$repo/blob/$ref/$" params={{ owner: h.repo.owner, repo: h.repo.name, ref: h.ref, _splat: h.path }} className="min-w-0 flex-1 truncate font-mono text-[13px] hover:text-accent">
            <Highlight text={h.path} q={q} />
          </Link>
          <RepoChip repo={h.repo} show={showRepo} />
        </li>
      );
    case 'code':
      return (
        <li className="space-y-1 px-4 py-3 text-sm">
          <div className="flex items-baseline gap-3">
            <Link to="/$owner/$repo/blob/$ref/$" params={{ owner: h.repo.owner, repo: h.repo.name, ref: h.ref, _splat: h.path }} hash={`L${h.line}`} className="min-w-0 flex-1 truncate font-mono text-[13px] hover:text-accent">
              {h.path}:{h.line}
            </Link>
            <RepoChip repo={h.repo} show={showRepo} />
          </div>
          <pre className="overflow-x-auto rounded-sm bg-canvas-inset px-3 py-1.5 font-mono text-xs text-fg-muted">
            <Highlight text={h.text.trim()} q={q} />
          </pre>
        </li>
      );
    case 'parts':
      return (
        <li className={base}>
          <span className="font-medium">
            <Highlight text={h.value} q={q} />
          </span>
          {h.mpn && (
            <span className="font-mono text-xs">
              <Highlight text={h.mpn} q={q} />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
            <Highlight text={h.footprint} q={q} />
          </span>
          <span className="font-mono text-xs text-fg-muted" title={h.refs.join(', ')}>
            {h.refs.slice(0, 6).join(', ')}
            {h.refs.length > 6 ? ` +${h.refs.length - 6}` : ''} · ×{h.quantity}
          </span>
          <RepoChip repo={h.repo} show={showRepo} />
        </li>
      );
    case 'nets':
      return (
        <li className={base}>
          <Link to="/$owner/$repo/outputs" params={{ owner: h.repo.owner, repo: h.repo.name }} search={{ sha: h.ref }} className="min-w-0 flex-1 truncate font-mono text-[13px] hover:text-accent">
            <Highlight text={h.net} q={q} />
          </Link>
          <span className="text-xs text-fg-muted">
            {h.pads} pad{h.pads === 1 ? '' : 's'}
          </span>
          <RepoChip repo={h.repo} show={showRepo} />
        </li>
      );
  }
}

const EMPTY_HELP: Record<SearchType, string> = {
  repos: 'No repositories match. Try a shorter name or a word from the description.',
  parts: 'No parts match. Parts come from each project’s BOM, so they appear once checks have run.',
  nets: 'No nets match. Nets come from the netlist export (outputs.netlist in .jumper.yml).',
  files: 'No file names match.',
  code: 'No text in the default branch matches.',
};

function SearchView({ fetcher, scope, defaultType, search, setSearch }: { fetcher: (q: string, type: SearchType) => Promise<SearchResults>; scope: string; defaultType: SearchType; search: SearchParams; setSearch: (s: SearchParams) => void }) {
  const q = search.q ?? '';
  const type = search.type ?? defaultType;
  const [value, setValue] = useState(q);
  useEffect(() => setValue(q), [q]);
  const res = useQuery({ queryKey: ['search', scope, q, type], queryFn: () => fetcher(q, type), enabled: q.trim().length > 0, placeholderData: (p) => p });
  const tabs = TABS.filter((t) => scope === 'global' || t.type !== 'repos');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSearch({ q: value.trim() || undefined, type });
  };
  return (
    <div className="space-y-6">
      <form onSubmit={submit} role="search" className="group/s relative max-w-2xl">
        <SearchIcon size={16} aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-fg-subtle group-focus-within/s:text-accent" />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          placeholder={scope === 'global' ? 'Search repositories, parts, nets and files' : 'Search this repository'}
          aria-label="Search"
          className="h-11 w-full rounded-full border border-border bg-canvas pl-11 pr-4 text-[15px] shadow-subtle placeholder:text-fg-subtle focus:border-select focus:outline-none focus:shadow-[0_0_0_4px_var(--pcb-accent-subtle)]"
        />
      </form>
      {q && (
        <div className="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
          <nav aria-label="Result types">
            <ul className="flex gap-1 overflow-x-auto md:block md:space-y-0.5">
              {tabs.map((t) => (
                <li key={t.type} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setSearch({ q, type: t.type })}
                    aria-current={t.type === type ? 'page' : undefined}
                    className={cx('flex w-full items-center gap-2.5 rounded-sm px-3 py-1.5 text-sm transition-colors', t.type === type ? 'bg-accent-subtle font-medium text-fg' : 'text-fg-muted hover:bg-canvas-subtle hover:text-fg')}
                  >
                    {t.icon} {t.label}
                    {res.data?.counts[t.type] !== undefined && <span className="ml-auto font-mono text-xs tabular-nums text-fg-muted">{res.data.counts[t.type]}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {scope === 'global' && <p className="mt-4 hidden text-xs text-fg-muted md:block">Parts, nets, files and code cover the most recently pushed repositories. Open a repository to search all of it.</p>}
          </nav>
          <div className="min-w-0">
            {res.isLoading ? (
              <PageSpinner />
            ) : res.data && res.data.hits.length > 0 ? (
              <>
                <Box>
                  <ul className="divide-y divide-border-muted">{res.data.hits.map((h, i) => <Hit key={i} h={h} q={q} showRepo={scope === 'global'} />)}</ul>
                </Box>
                {res.data.truncated && <p className="mt-3 text-xs text-fg-muted">Showing the first results. Refine the search to narrow them down.</p>}
              </>
            ) : (
              <EmptyState icon={<SearchIcon size={22} />} title={`Nothing found for “${q}”`}>
                {EMPTY_HELP[type]}
              </EmptyState>
            )}
          </div>
        </div>
      )}
      {!q && <p className="text-sm text-fg-muted">Search part numbers (<Label>TPS2051</Label>), footprints, net names (<Label>USB_D+</Label>) and file names.</p>}
    </div>
  );
}

export function SearchPage() {
  const search = useSearch({ strict: false }) as SearchParams;
  const navigate = useNavigate();
  return (
    <PageContainer className="max-w-[1280px] py-10">
      <h1 className="display mb-6 text-[length:var(--t-xl)]">Search</h1>
      <SearchView
        scope="global"
        defaultType="repos"
        search={search}
        setSearch={(s) => void navigate({ to: '/search', search: s })}
        fetcher={(q, type) => api.get<SearchResults>('/search', { q, type })}
      />
    </PageContainer>
  );
}

export function RepoSearchPage() {
  const info = useRepoInfo();
  const search = useSearch({ strict: false }) as SearchParams;
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-6xl">
      <SearchView
        scope={`${info.owner}/${info.name}`}
        defaultType="files"
        search={search}
        setSearch={(s) => void navigate({ to: '/$owner/$repo/search', params: { owner: info.owner, repo: info.name }, search: s })}
        fetcher={(q, type) => api.get<SearchResults>(repoPath(info.owner, info.name, '/search'), { q, type })}
      />
    </div>
  );
}
