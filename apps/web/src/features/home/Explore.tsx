import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Clock, Flame, Search, Star } from 'lucide-react';
import type { ExploreInfo, RepoInfo } from '@jumper/shared';
import { PageSpinner, SegmentedControl, buttonClass } from '@jumper/ui';
import { RepoList } from '../../shared/components/RepoList';
import { BoardCard } from '../../shared/components/BoardCard';
import { PageContainer } from '../../shared/components/common';
import { api } from '../../shared/lib/api';

export function ExplorePage() {
  const search = useSearch({ strict: false }) as { q?: string; sort?: 'updated' | 'stars' | 'trending' };
  const { q = '', sort = 'updated' } = search;
  // The landing view (no search, no explicit sort) shows featured and trending work above the full list.
  const landing = !q && !search.sort;
  const explore = useQuery({ queryKey: ['explore'], queryFn: () => api.get<ExploreInfo>('/explore'), enabled: landing, staleTime: 60_000 });
  const navigate = useNavigate();
  const [value, setValue] = useState(q);
  useEffect(() => setValue(q), [q]);
  const { data, isLoading } = useQuery({ queryKey: ['repos', 'explore', q, sort], queryFn: () => api.get<RepoInfo[]>('/repos', { q, sort }), placeholderData: (prev) => prev });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void navigate({ to: '/explore', search: { q: value || undefined, sort } });
  };
  const count = data ? `${data.length} ${data.length === 1 ? 'board' : 'boards'}${q ? ` for “${q}”` : ''}` : '';
  return (
    <PageContainer className="max-w-[1280px] py-10 md:py-14">
      <header className="mb-8 grid gap-6 md:mb-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:items-end">
        <div>
          <h1 className="text-[clamp(2.5rem,1.6rem+2.6vw,4rem)] font-medium leading-[0.95]">Explore</h1>
          <p className="mt-3 max-w-xl text-[16px] leading-relaxed text-fg-muted">Public KiCad projects on Jumper: open any of them to browse the schematic, the board in 3D, its checks and its BOM.</p>
        </div>
        <form onSubmit={submit} role="search" className="group/s relative">
          <Search size={16} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-subtle transition-colors group-focus-within/s:text-fg" />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Search boards by name or description"
            aria-label="Search public repositories"
            className="h-11 w-full rounded-md border border-border bg-canvas pl-10 pr-4 text-[15px] text-fg placeholder:text-fg-subtle transition-[border-color,box-shadow] focus:border-select focus:outline-none focus:shadow-[0_0_0_3px_var(--pcb-accent-subtle)]"
          />
        </form>
      </header>

      {landing && explore.data && explore.data.featured.length > 0 && (
        <section className="mb-14" aria-labelledby="featured-h">
          <div className="mb-4 flex items-baseline justify-between gap-4 border-b border-border pb-3">
            <h2 id="featured-h" className="text-lg font-medium">Featured</h2>
            <p className="text-[13px] text-fg-muted">Picked by the people who run this site</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {explore.data.featured.map((r) => <BoardCard key={r.id} repo={r} />)}
          </div>
        </section>
      )}
      {landing && explore.data && explore.data.trending.length > 0 && (
        <section className="mb-14" aria-labelledby="trending-h">
          <div className="mb-4 flex items-baseline justify-between gap-4 border-b border-border pb-3">
            <h2 id="trending-h" className="text-lg font-medium">Trending</h2>
            <p className="text-[13px] text-fg-muted">Most stars, forks, merges and releases in the last two weeks</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {explore.data.trending.slice(0, 8).map((r, i) => <BoardCard key={r.id} repo={r} rank={i + 1} />)}
          </div>
        </section>
      )}

      <section aria-labelledby="all-h">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pb-3">
          <h2 id="all-h" className="flex items-baseline gap-3 text-lg font-medium">
            {q ? 'Results' : 'All boards'}
            <span className="text-[13px] font-normal text-fg-muted" aria-live="polite">{count}</span>
          </h2>
          <SegmentedControl
            size="md"
            value={sort}
            onChange={(s) => void navigate({ to: '/explore', search: { q: q || undefined, sort: s } })}
            options={[
              { value: 'updated', label: 'Recent', icon: <Clock size={13} /> },
              { value: 'stars', label: 'Starred', icon: <Star size={13} /> },
              { value: 'trending', label: 'Trending', icon: <Flame size={13} /> },
            ]}
          />
        </div>
        {isLoading ? (
          <PageSpinner />
        ) : (
          <RepoList
            repos={data ?? []}
            empty={q ? `No boards match “${q}”. Try a shorter search, or search by part or board name.` : 'No public boards yet. Be the first to push one.'}
            emptyAction={
              q ? (
                <Link to="/explore" search={{ q: '' }} className={buttonClass('default', 'sm')}>
                  Clear the search
                </Link>
              ) : (
                <Link to="/new" className={buttonClass('accent', 'sm')}>
                  New repository
                </Link>
              )
            }
          />
        )}
      </section>
    </PageContainer>
  );
}
