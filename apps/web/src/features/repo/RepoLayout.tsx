import { Link, Outlet, useLocation, useParams } from '@tanstack/react-router';
import { Code, Cpu, FolderDown, GitCompare, Globe, ListChecks, Lock, Settings } from 'lucide-react';
import { Label, PageSpinner, UnderlineNav, type NavItem } from '@jumper/ui';
import { ErrorView, PageContainer } from '../../shared/components/common';
import { useRepo } from '../../shared/lib/queries';
import { useRepoEvents } from '../../shared/lib/ws';
import { RepoContext } from './context';

export function RepoLayout() {
  const { owner, repo } = useParams({ strict: false }) as { owner: string; repo: string };
  const { pathname } = useLocation();
  const q = useRepo(owner, repo);
  useRepoEvents(owner, repo, q.data?.id);

  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;
  const info = q.data!;
  const base = `/${owner}/${repo}`;
  const rest = pathname.slice(base.length);
  const section =
    rest.startsWith('/compare') ? 'compare' : rest.startsWith('/checks') ? 'checks' : rest.startsWith('/outputs') ? 'outputs' : rest.startsWith('/parts') || rest.startsWith('/bom-alerts') ? 'parts' : rest.startsWith('/settings') ? 'settings' : 'code';

  // Pages built around a big viewer get more width.
  const wide = section === 'outputs' || section === 'compare' || rest.startsWith('/blob/') || rest.startsWith('/commit/');
  const width = wide ? 'max-w-[1680px]' : undefined;

  const items: NavItem[] = [
    {
      key: 'code',
      label: 'Code',
      icon: <Code size={16} />,
      active: section === 'code',
      render: (p) => (
        <Link to="/$owner/$repo" params={{ owner, repo }} className={p.className}>
          {p.children}
        </Link>
      ),
    },
    {
      key: 'compare',
      label: 'Compare',
      icon: <GitCompare size={16} />,
      active: section === 'compare',
      render: (p) => (
        <Link to="/$owner/$repo/compare" params={{ owner, repo }} search={{}} className={p.className}>
          {p.children}
        </Link>
      ),
    },
    {
      key: 'checks',
      label: 'Checks',
      icon: <ListChecks size={16} />,
      active: section === 'checks',
      render: (p) => (
        <Link to="/$owner/$repo/checks" params={{ owner, repo }} search={{}} className={p.className}>
          {p.children}
        </Link>
      ),
    },
    {
      key: 'outputs',
      label: 'Outputs',
      icon: <FolderDown size={16} />,
      active: section === 'outputs',
      render: (p) => (
        <Link to="/$owner/$repo/outputs" params={{ owner, repo }} search={{}} className={p.className}>
          {p.children}
        </Link>
      ),
    },
    {
      key: 'parts',
      label: 'Parts',
      icon: <Cpu size={16} />,
      active: section === 'parts',
      render: (p) => (
        <Link to="/$owner/$repo/parts" params={{ owner, repo }} className={p.className}>
          {p.children}
        </Link>
      ),
    },
  ];
  if (info.permission === 'admin') {
    items.push({
      key: 'settings',
      label: 'Settings',
      icon: <Settings size={16} />,
      active: section === 'settings',
      render: (p) => (
        <Link to="/$owner/$repo/settings" params={{ owner, repo }} className={p.className}>
          {p.children}
        </Link>
      ),
    });
  }

  return (
    <RepoContext.Provider value={info}>
      <div className="border-b border-border bg-canvas pt-8 md:pt-10">
        <PageContainer className={width}>
          <div className="mb-6 flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
            <div className="min-w-0 flex-1 basis-72">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 className="headline min-w-0 text-[length:var(--t-l)] max-sm:text-[1.4rem]">
                  <Link to="/$owner" params={{ owner: info.owner }} className="inline-block font-normal text-fg-muted no-underline transition-colors hover:text-accent">
                    {info.owner}
                  </Link>
                  <span className="px-1.5 font-normal text-fg-subtle">/</span>
                  <Link to="/$owner/$repo" params={{ owner, repo }} className="inline-block text-fg no-underline transition-colors hover:text-accent">
                    {info.name}
                  </Link>
                </h1>
                <Label>
                  {info.visibility === 'private' ? <Lock size={9} /> : <Globe size={9} />}
                  {info.visibility === 'private' ? 'Private' : 'Public'}
                </Label>
              </div>
              {info.description && <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-fg-muted">{info.description}</p>}
            </div>
          </div>
          <UnderlineNav items={items} className="-mx-3 border-b-0" />
        </PageContainer>
      </div>
      <PageContainer className={wide ? 'max-w-[1680px] py-6 md:py-8' : 'py-8 md:py-12'}>
        <Outlet />
      </PageContainer>
    </RepoContext.Provider>
  );
}
