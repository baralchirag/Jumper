import { Link, Navigate, useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { RepoInfo } from '@jumper/shared';
import { PageSpinner, buttonClass } from '@jumper/ui';
import { RepoList } from '../../shared/components/RepoList';
import { PageContainer } from '../../shared/components/common';
import { api } from '../../shared/lib/api';
import { useMe } from '../../shared/lib/queries';

export function StarsPage() {
  const { pathname } = useLocation();
  const { data: me, isLoading } = useMe();
  const q = useQuery({ queryKey: ['repos', 'starred'], queryFn: () => api.get<RepoInfo[]>('/repos', { starred: true }), enabled: Boolean(me) });
  if (isLoading) return <PageSpinner />;
  if (!me) return <Navigate to="/login" search={{ redirect: pathname }} />;
  return (
    <PageContainer className="max-w-5xl py-10">
      <div className="mb-1 flex items-baseline justify-between border-b border-border pb-3">
        <div>
          <h1 className="text-[17px] font-medium tracking-[-0.01em]">Your stars</h1>
          <p className="text-[13px] text-fg-muted">Repositories you starred to find again or follow.</p>
        </div>
        <span className="font-mono text-xs tabular-nums text-fg-subtle">{q.data?.length ?? ''}</span>
      </div>
      {q.isLoading ? <PageSpinner /> : <RepoList
          repos={q.data ?? []}
          empty="Nothing starred yet. Star a repository from its page to keep it here and follow its releases."
          emptyAction={
            <Link to="/explore" search={{ q: '' }} className={buttonClass('default', 'sm')}>
              Explore projects
            </Link>
          }
        />}
    </PageContainer>
  );
}
