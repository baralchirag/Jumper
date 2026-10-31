import { Link, Outlet, useLocation, useParams } from '@tanstack/react-router';
import { Code, GitPullRequest, ListChecks, Lock, Settings } from 'lucide-react';
import { Label, PageSpinner, UnderlineNav, type NavItem } from '@pcbhub/ui';
import { ErrorView, PageContainer } from '../../components/common';
import { useRepo } from '../../lib/queries';
import { useRepoEvents } from '../../lib/ws';
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
  const section = rest.startsWith('/pull') || rest.startsWith('/compare') ? 'pulls' : rest.startsWith('/checks') ? 'checks' : rest.startsWith('/settings') ? 'settings' : 'code';

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
      key: 'pulls',
      label: 'Pull requests',
      icon: <GitPullRequest size={16} />,
      count: info.openPullCount,
      active: section === 'pulls',
      render: (p) => (
        <Link to="/$owner/$repo/pulls" params={{ owner, repo }} search={{ state: 'open' }} className={p.className}>
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
      <div className="border-b border-border bg-canvas-subtle pt-4">
        <PageContainer wide>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xl">
            <Link to="/$owner" params={{ owner: info.owner }} className="link">
              {info.owner}
            </Link>
            <span className="text-fg-subtle">/</span>
            <Link to="/$owner/$repo" params={{ owner, repo }} className="link font-semibold">
              {info.name}
            </Link>
            <Label className="ml-1">
              {info.visibility === 'private' && <Lock size={10} />}
              {info.visibility === 'private' ? 'Private' : 'Public'}
            </Label>
          </div>
          <UnderlineNav items={items} className="border-b-0" />
        </PageContainer>
      </div>
      <PageContainer wide className="py-6">
        <Outlet />
      </PageContainer>
    </RepoContext.Provider>
  );
}
