import { Link, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { GitMerge, GitPullRequest, GitPullRequestClosed, MessageSquare } from 'lucide-react';
import type { PullInfo, PrState } from '@pcbhub/shared';
import { Box, BoxHeader, BoxRow, EmptyState, Label, PageSpinner, RelativeTime, buttonClass, cx } from '@pcbhub/ui';
import { CheckIcon, rollup } from '../../components/CheckStatus';
import { ErrorView } from '../../components/common';
import { api, repoPath } from '../../lib/api';
import { keys, useChecks } from '../../lib/queries';
import { canWrite, useRepoInfo } from './context';

export function PrStateIcon({ state, size = 16 }: { state: PrState; size?: number }) {
  if (state === 'merged') return <GitMerge size={size} className="text-done" />;
  if (state === 'closed') return <GitPullRequestClosed size={size} className="text-danger" />;
  return <GitPullRequest size={size} className="text-success" />;
}

function PullChecks({ sha }: { sha: string }) {
  const info = useRepoInfo();
  const { data } = useChecks(info.owner, info.name, sha);
  return data?.runs.length ? <CheckIcon state={rollup(data.runs)} size={14} /> : null;
}

export function PullsPage() {
  const info = useRepoInfo();
  const { state = 'open' } = useSearch({ strict: false }) as { state?: PrState | 'all' };
  const q = useQuery({
    queryKey: [...keys.repo(info.owner, info.name), 'pulls', state],
    queryFn: () => api.get<{ pulls: PullInfo[]; counts: Record<PrState, number> }>(repoPath(info.owner, info.name, '/pulls'), { state }),
  });
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;
  const { pulls, counts } = q.data!;
  const tab = (s: PrState | 'all', label: string, icon: React.ReactNode) => (
    <Link to="/$owner/$repo/pulls" params={{ owner: info.owner, repo: info.name }} search={{ state: s }} className={cx('flex items-center gap-1.5 text-sm', state === s ? 'font-semibold text-fg' : 'text-fg-muted hover:text-fg')}>
      {icon} {label}
    </Link>
  );
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex justify-end">
        {canWrite(info) && (
          <Link to="/$owner/$repo/compare" params={{ owner: info.owner, repo: info.name }} search={{}} className={buttonClass('primary', 'md')}>
            New pull request
          </Link>
        )}
      </div>
      <Box>
        <BoxHeader className="gap-4">
          {tab('open', `${counts.open} Open`, <GitPullRequest size={16} />)}
          {tab('merged', `${counts.merged} Merged`, <GitMerge size={16} />)}
          {tab('closed', `${counts.closed} Closed`, <GitPullRequestClosed size={16} />)}
        </BoxHeader>
        {pulls.length === 0 && (
          <EmptyState icon={<GitPullRequest size={32} />} title={`No ${state === 'all' ? '' : state} pull requests`}>
            Pull requests let you review schematic and board changes before they land.
          </EmptyState>
        )}
        {pulls.map((p) => (
          <BoxRow key={p.id} className="flex items-start gap-3 py-3">
            <span className="mt-0.5">
              <PrStateIcon state={p.state} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link to="/$owner/$repo/pull/$number" params={{ owner: info.owner, repo: info.name, number: String(p.number) }} search={{}} className="font-semibold hover:text-accent">
                  {p.title}
                </Link>
                {p.state === 'open' && <PullChecks sha={p.headSha} />}
                {p.reviewSummary.approved > 0 && <Label tone="success">{p.reviewSummary.approved} approved</Label>}
                {p.reviewSummary.changesRequested > 0 && <Label tone="danger">changes requested</Label>}
              </div>
              <div className="mt-0.5 text-xs text-fg-muted">
                #{p.number} {p.state === 'merged' ? 'merged' : 'opened'} <RelativeTime date={p.mergedAt ?? p.createdAt} /> by {p.author.username} ·{' '}
                <span className="font-mono">
                  {p.head} → {p.base}
                </span>
              </div>
            </div>
            {p.commentCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-fg-muted">
                <MessageSquare size={14} /> {p.commentCount}
              </span>
            )}
          </BoxRow>
        ))}
      </Box>
    </div>
  );
}
