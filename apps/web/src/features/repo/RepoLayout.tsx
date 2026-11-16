import { Link, Outlet, useLocation, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CircleDot, Code, Cpu, FolderDown, GitPullRequest, Globe, ListChecks, Lock, MessagesSquare, Settings, Star, Tag } from 'lucide-react';
import type { RepoInfo } from '@jumper/shared';
import { Label, PageSpinner, UnderlineNav, cx, type NavItem } from '@jumper/ui';
import { ErrorView, PageContainer } from '../../shared/components/common';
import { api, repoPath } from '../../shared/lib/api';
import { keys, useMe, useRepo } from '../../shared/lib/queries';
import { useRepoEvents } from '../../shared/lib/ws';
import { ForkButton } from './ForkButton';
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
    rest.startsWith('/pull') || rest.startsWith('/compare') ? 'pulls' : rest.startsWith('/issues') || rest.startsWith('/milestones') ? 'issues' : rest.startsWith('/discussions') ? 'discussions' : rest.startsWith('/checks') ? 'checks' : rest.startsWith('/outputs') ? 'outputs' : rest.startsWith('/parts') || rest.startsWith('/bom-alerts') ? 'parts' : rest.startsWith('/releases') ? 'releases' : rest.startsWith('/settings') ? 'settings' : 'code';

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
      key: 'issues',
      label: 'Issues',
      icon: <CircleDot size={16} />,
      active: section === 'issues',
      render: (p) => (
        <Link to="/$owner/$repo/issues" params={{ owner, repo }} search={{}} className={p.className}>
          {p.children}
        </Link>
      ),
    },
    {
      key: 'discussions',
      label: 'Discussions',
      icon: <MessagesSquare size={16} />,
      active: section === 'discussions',
      render: (p) => (
        <Link to="/$owner/$repo/discussions" params={{ owner, repo }} search={{}} className={p.className}>
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
    {
      key: 'releases',
      label: 'Releases',
      icon: <Tag size={16} />,
      active: section === 'releases',
      render: (p) => (
        <Link to="/$owner/$repo/releases" params={{ owner, repo }} className={p.className}>
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
        <PageContainer>
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
              {info.forkOf && (
                <p className="mt-1.5 text-sm text-fg-muted">
                  Forked from{' '}
                  <Link to="/$owner/$repo" params={{ owner: info.forkOf.owner, repo: info.forkOf.name }} className="link">
                    {info.forkOf.owner}/{info.forkOf.name}
                  </Link>
                </p>
              )}
              {info.description && <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-fg-muted">{info.description}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <StarButton info={info} />
              <ForkButton info={info} />
            </div>
          </div>
          <UnderlineNav items={items} className="-mx-3 border-b-0" />
        </PageContainer>
      </div>
      <PageContainer className="py-8 md:py-12">
        <Outlet />
      </PageContainer>
    </RepoContext.Provider>
  );
}

function StarButton({ info }: { info: RepoInfo }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const infoKey = [...keys.repo(info.owner, info.name), 'info'];
  const toggle = async () => {
    if (!me) return void navigate({ to: '/login', search: { redirect: `/${info.owner}/${info.name}` } });
    setBusy(true);
    const next = !info.starred;
    // Optimistic: flip immediately, reconcile with the server's count.
    qc.setQueryData<RepoInfo>(infoKey, (old) => old && { ...old, starred: next, starCount: old.starCount + (next ? 1 : -1) });
    try {
      const res = next ? await api.put<{ starCount: number }>(repoPath(info.owner, info.name, '/star')) : await api.delete<{ starCount: number }>(repoPath(info.owner, info.name, '/star'));
      qc.setQueryData<RepoInfo>(infoKey, (old) => old && { ...old, starred: next, starCount: res.starCount });
      void qc.invalidateQueries({ queryKey: ['repos'] });
    } catch {
      void qc.invalidateQueries({ queryKey: infoKey });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={info.starred}
      className="inline-flex h-7 items-stretch overflow-hidden rounded-sm border border-border text-xs transition-colors hover:border-fg-subtle"
    >
      <span className="flex items-center gap-1.5 px-2.5">
        <Star size={13} className={cx(info.starred ? 'fill-current text-attention' : 'text-fg-muted')} />
        {info.starred ? 'Starred' : 'Star'}
      </span>
      <span className="flex items-center border-l border-border px-2 font-mono tabular-nums text-fg-muted">{info.starCount}</span>
    </button>
  );
}
