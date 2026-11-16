import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, GitCommitHorizontal } from 'lucide-react';
import type { CommitDetail, CommitInfo } from '@jumper/shared';
import { isDesignFile } from '@jumper/shared';
import { Avatar, Box, BoxHeader, BoxRow, Button, CopyButton, PageSpinner, RelativeTime, buttonClass } from '@jumper/ui';
import { CheckIcon, rollup } from '../checks/CheckStatus';
import { FilesChanged } from '../pulls/FilesChanged';
import { RefPicker } from '../../shared/components/RefPicker';
import { ErrorView, shortSha } from '../../shared/components/common';
import { api, repoPath } from '../../shared/lib/api';
import { keys, useChecks, useCommits } from '../../shared/lib/queries';
import { useRepoInfo } from './context';

function CommitChecks({ sha }: { sha: string }) {
  const info = useRepoInfo();
  const { data } = useChecks(info.owner, info.name, sha);
  if (!data?.runs.length) return null;
  return (
    <Link to="/$owner/$repo/checks" params={{ owner: info.owner, repo: info.name }} search={{ sha }} title="Checks">
      <CheckIcon state={rollup(data.runs)} size={14} />
    </Link>
  );
}

function CommitRow({ c, path, previous }: { c: CommitInfo; path?: string; previous?: string }) {
  const info = useRepoInfo();
  return (
    <BoxRow className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <Link to="/$owner/$repo/commit/$sha" params={{ owner: info.owner, repo: info.name, sha: c.sha }} className="font-semibold hover:text-accent hover:underline">
          {c.subject}
        </Link>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-muted">
          <Avatar name={c.author.name} size={16} />
          <span className="font-semibold text-fg">{c.author.name}</span> committed <RelativeTime date={c.committer.date} />
          <CommitChecks sha={c.sha} />
        </div>
      </div>
      {path && previous && isDesignFile(path) && (
        <Link
          to="/$owner/$repo/blob/$ref/$"
          params={{ owner: info.owner, repo: info.name, ref: c.sha, _splat: path }}
          search={{ tab: 'compare', base: previous, head: c.sha }}
          className={buttonClass('invisible', 'sm')}
          title="Compare this version with the previous one, side by side"
        >
          <ArrowLeftRight size={14} /> Compare
        </Link>
      )}
      <Link to="/$owner/$repo/commit/$sha" params={{ owner: info.owner, repo: info.name, sha: c.sha }} className="rounded-md border border-border px-2 py-0.5 font-mono text-xs hover:text-accent">
        {shortSha(c.sha)}
      </Link>
      <CopyButton value={c.sha} label="Copy full SHA" />
    </BoxRow>
  );
}

export function CommitsPage() {
  const info = useRepoInfo();
  const { ref } = useParams({ strict: false }) as { ref: string };
  const search = useSearch({ strict: false }) as { path?: string; page?: number };
  const navigate = useNavigate();
  const page = search.page ?? 1;
  const q = useCommits(info.owner, info.name, ref, search.path ?? '', page);
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;

  const groups = new Map<string, CommitInfo[]>();
  for (const c of q.data!.commits) {
    const day = new Date(c.committer.date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    groups.set(day, [...(groups.get(day) ?? []), c]);
  }
  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <RefPicker owner={info.owner} repo={info.name} value={ref} onChange={(r) => void navigate({ to: '/$owner/$repo/commits/$ref', params: { owner: info.owner, repo: info.name, ref: r }, search: { path: search.path } })} />
        {search.path && <span className="font-mono text-sm text-fg-muted">History for {search.path}</span>}
      </div>
      {[...groups].map(([day, commits]) => (
        <div key={day}>
          <h3 className="mb-2 flex items-center gap-2 text-sm text-fg-muted">
            <GitCommitHorizontal size={16} /> Commits on {day}
          </h3>
          <Box>
            {commits.map((c) => {
              const all = q.data!.commits;
              const prev = all[all.findIndex((x) => x.sha === c.sha) + 1]?.sha;
              return <CommitRow key={c.sha} c={c} path={search.path} previous={prev} />;
            })}
          </Box>
        </div>
      ))}
      <div className="flex justify-center gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => void navigate({ to: '.', search: { ...search, page: page - 1 } })}>
          Newer
        </Button>
        <Button size="sm" disabled={!q.data!.hasMore} onClick={() => void navigate({ to: '.', search: { ...search, page: page + 1 } })}>
          Older
        </Button>
      </div>
    </div>
  );
}

export function CommitPage() {
  const info = useRepoInfo();
  const { sha } = useParams({ strict: false }) as { sha: string };
  const q = useQuery({
    queryKey: [...keys.repo(info.owner, info.name), 'commit', sha],
    queryFn: () => api.get<CommitDetail>(repoPath(info.owner, info.name, `/commits/${sha}`)),
    staleTime: Infinity,
  });
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;
  const { commit, files } = q.data!;
  return (
    <div className="space-y-4">
      <Box>
        <BoxHeader className="flex-col items-start gap-1">
          <h1 className="text-lg font-semibold">{commit.subject}</h1>
          {commit.body && <pre className="whitespace-pre-wrap font-sans text-sm text-fg-muted">{commit.body}</pre>}
        </BoxHeader>
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
          <Avatar name={commit.author.name} size={20} />
          <strong>{commit.author.name}</strong>
          <span className="text-fg-muted">
            committed <RelativeTime date={commit.committer.date} />
          </span>
          <CommitChecks sha={commit.sha} />
          <span className="ml-auto text-xs text-fg-muted">
            {commit.parents.length > 0 && (
              <>
                {commit.parents.length} parent{commit.parents.length > 1 ? 's' : ''}{' '}
                {commit.parents.map((p) => (
                  <Link key={p} to="/$owner/$repo/commit/$sha" params={{ owner: info.owner, repo: info.name, sha: p }} className="link mr-1 font-mono">
                    {shortSha(p)}
                  </Link>
                ))}
              </>
            )}
            commit <span className="font-mono text-fg">{commit.sha}</span>
          </span>
        </div>
      </Box>
      <FilesChanged owner={info.owner} repo={info.name} files={files} baseSha={commit.parents[0] ?? null} headSha={commit.sha} />
    </div>
  );
}
