import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { CircuitBoard, GitFork, Lock, Star } from 'lucide-react';
import type { RepoInfo } from '@jumper/shared';
import { RelativeTime, cx } from '@jumper/ui';

/** A repository as a card with a render of its board: for featured work, trending lists and pinned portfolios. */
export function BoardCard({ repo, showOwner = true, rank }: { repo: RepoInfo; showOwner?: boolean; rank?: number }) {
  const [failed, setFailed] = useState(repo.isEmpty);
  const src = `/api/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/preview.png?view=iso`;
  return (
    <Link
      to="/$owner/$repo"
      params={{ owner: repo.owner, repo: repo.name }}
      className="group flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-canvas no-underline transition-colors hover:border-fg-subtle"
    >
      <div className="relative aspect-[16/10] overflow-hidden border-b border-border bg-canvas-inset">
        {failed ? (
          <div aria-hidden className="flex h-full items-center justify-center text-fg-subtle">
            <CircuitBoard size={28} />
          </div>
        ) : (
          <img src={src} alt={`${repo.name} board`} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-contain p-3 transition-transform duration-300 group-hover:scale-[1.02]" />
        )}
        {rank !== undefined && <span className="absolute left-2 top-2 rounded-sm bg-canvas px-1.5 font-mono text-xs tabular-nums text-fg-muted">{rank}</span>}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[14px] font-medium text-fg group-hover:underline group-hover:decoration-fg/40 group-hover:underline-offset-4">
          {repo.visibility === 'private' && <Lock size={12} className="shrink-0 text-fg-muted" />}
          <span className="truncate">
            {showOwner && <span className="font-normal text-fg-muted">{repo.owner}/</span>}
            {repo.name}
          </span>
        </span>
        {repo.description && <p className="line-clamp-2 text-[13px] leading-snug text-fg-muted">{repo.description}</p>}
        <span className={cx('mt-auto flex items-center gap-3 pt-2 text-xs text-fg-subtle')}>
          <span className="inline-flex items-center gap-1"><Star size={12} /> {repo.starCount}</span>
          {repo.forkCount > 0 && <span className="inline-flex items-center gap-1"><GitFork size={12} /> {repo.forkCount}</span>}
          {repo.pushedAt && <span className="ml-auto">updated <RelativeTime date={repo.pushedAt} /></span>}
        </span>
      </div>
    </Link>
  );
}
