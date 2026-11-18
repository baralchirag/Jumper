import { useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleDot, MessageSquare, MessagesSquare, Milestone as MilestoneIcon, Search } from 'lucide-react';
import type { IssueInfo, MilestoneInfo } from '@jumper/shared';
import { Box, BoxHeader, BoxRow, EmptyState, Input, Label, PageSpinner, RelativeTime, buttonClass, cx } from '@jumper/ui';
import { ErrorView, PageHeader } from '../../shared/components/common';
import { api, repoPath } from '../../shared/lib/api';
import { keys, useMe } from '../../shared/lib/queries';
import { useRepoInfo } from '../repo/context';

export type IssueKind = 'issue' | 'discussion';
export const kindPath = (k: IssueKind) => (k === 'issue' ? 'issues' : 'discussions');

export interface IssueList {
  total: number;
  open: number;
  closed: number;
  items: IssueInfo[];
}

export function StateIcon({ issue, size = 16 }: { issue: Pick<IssueInfo, 'state' | 'kind'>; size?: number }) {
  if (issue.kind === 'discussion') return <MessagesSquare size={size} className={issue.state === 'open' ? 'text-accent' : 'text-done'} />;
  return issue.state === 'open' ? <CircleDot size={size} className="text-success" /> : <CircleCheck size={size} className="text-done" />;
}

export function IssuesPage({ kind }: { kind: IssueKind }) {
  const info = useRepoInfo();
  const { data: me } = useMe();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { state?: 'open' | 'closed'; q?: string; label?: string; milestone?: string };
  const state = search.state ?? 'open';
  const [term, setTerm] = useState(search.q ?? '');
  const q = useQuery({
    queryKey: [...keys.repo(info.owner, info.name), 'issues', kind, state, search.q, search.label, search.milestone],
    queryFn: () => api.get<IssueList>(repoPath(info.owner, info.name, '/issues'), { kind, state, q: search.q, label: search.label, milestone: search.milestone }),
  });
  const milestones = useQuery({
    queryKey: [...keys.repo(info.owner, info.name), 'milestones'],
    queryFn: () => api.get<MilestoneInfo[]>(repoPath(info.owner, info.name, '/milestones')),
    enabled: kind === 'issue',
  });
  const to = kind === 'issue' ? '/$owner/$repo/issues' : '/$owner/$repo/discussions';
  const params = { owner: info.owner, repo: info.name };
  const go = (next: Record<string, string | undefined>) => void navigate({ to, params, search: { ...search, ...next } as never });

  const noun = kind === 'issue' ? 'issue' : 'discussion';
  const data = q.data;
  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        title={kind === 'issue' ? 'Issues' : 'Discussions'}
        action={
          me ? (
          <Link to={`${to}/new` as never} params={params as never} className={buttonClass('primary', 'md')}>
            {kind === 'issue' ? 'New issue' : 'New discussion'}
          </Link>
        ) : (
          <Link to="/login" search={{ redirect: `/${info.owner}/${info.name}/${kindPath(kind)}` }} className={buttonClass('default', 'md')}>
            Sign in to post
          </Link>
        )
        }
      >
        {kind === 'issue'
          ? 'Work that has to be done on this design: wrong footprints, missing test points, bring-up failures. Link each one to the parts or nets it concerns.'
          : 'Questions and design conversations that are not tasks. Everyone who can see this repository can take part.'}
      </PageHeader>
      <div className="flex flex-wrap items-center gap-3">
        <form
          className="relative min-w-60 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go({ q: term || undefined });
          }}
        >
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={`Search ${noun}s`} className="pl-9" aria-label={`Search ${noun}s`} />
        </form>
        {kind === 'issue' && (
          <Link to="/$owner/$repo/milestones" params={params} className={buttonClass('default', 'md')}>
            <MilestoneIcon size={14} /> Milestones
          </Link>
        )}
      </div>

      {(search.label || search.milestone) && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          Filtering by
          {search.label && <Label tone="accent">{search.label}</Label>}
          {search.milestone && <Label tone="accent">{milestones.data?.find((m) => m.id === search.milestone)?.title ?? 'milestone'}</Label>}
          <button className="link" onClick={() => go({ label: undefined, milestone: undefined })}>
            Clear
          </button>
        </div>
      )}

      <Box>
        <BoxHeader className="gap-4">
          {(['open', 'closed'] as const).map((s) => (
            <button
              key={s}
              onClick={() => go({ state: s })}
              aria-pressed={state === s}
              className={cx('flex items-center gap-1.5 text-sm', state === s ? 'font-semibold text-fg' : 'text-fg-muted hover:text-fg')}
            >
              {s === 'open' ? <CircleDot size={15} /> : <CircleCheck size={15} />}
              {data ? (s === 'open' ? data.open : data.closed) : '–'} {s === 'open' ? 'Open' : kind === 'issue' ? 'Closed' : 'Answered / closed'}
            </button>
          ))}
        </BoxHeader>
        {q.isLoading && <PageSpinner />}
        {q.error && <ErrorView error={q.error} />}
        {data && data.items.length === 0 && (
          <EmptyState icon={kind === 'issue' ? <CircleDot size={28} /> : <MessagesSquare size={28} />} title={search.q ? `No ${noun}s match “${search.q}”` : `No ${state} ${noun}s`}>
            {kind === 'issue'
              ? 'Track problems and tasks against specific parts, nets or board locations.'
              : 'Ask questions and discuss design decisions with everyone who can see this repository.'}
          </EmptyState>
        )}
        {data?.items.map((i) => (
          <BoxRow key={i.id} className="flex items-start gap-3 py-3">
            <span className="mt-0.5">
              <StateIcon issue={i} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`${to}/$number` as never} params={{ ...params, number: String(i.number) } as never} className="font-semibold hover:text-accent">
                  {i.title}
                </Link>
                {i.labels.map((l) => (
                  <button key={l} onClick={() => go({ label: l })} title={`Show only “${l}”`}>
                    <Label>{l}</Label>
                  </button>
                ))}
                {i.locations.length > 0 && <Label tone="accent">{i.locations.map((l) => l.ref).slice(0, 3).join(', ')}</Label>}
              </div>
              <div className="mt-0.5 text-xs text-fg-muted">
                #{i.number} {i.state === 'closed' ? 'closed' : 'opened'} <RelativeTime date={i.closedAt ?? i.createdAt} /> by {i.author.username}
                {i.milestone && <> · {i.milestone.title}</>}
                {i.assignee && <> · assigned to {i.assignee.username}</>}
              </div>
            </div>
            {i.commentCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-fg-muted">
                <MessageSquare size={14} /> {i.commentCount}
              </span>
            )}
          </BoxRow>
        ))}
      </Box>
    </div>
  );
}

export function IssuesRoute() {
  return <IssuesPage kind="issue" />;
}
export function DiscussionsRoute() {
  return <IssuesPage kind="discussion" />;
}

/** Used by the router to read `/…/issues/$number`. */
export function useIssueNumber(): number {
  const { number } = useParams({ strict: false }) as { number: string };
  return Number(number);
}
