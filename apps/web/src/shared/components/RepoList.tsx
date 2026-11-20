import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { CircuitBoard, Lock } from 'lucide-react';
import type { RepoInfo } from '@jumper/shared';
import { Avatar, Label, RelativeTime, cx } from '@jumper/ui';

/** The repository's own board render (isometric), or a quiet placeholder when there is none yet. */
export function RepoThumb({ repo, className }: { repo: RepoInfo; className?: string }) {
  const [failed, setFailed] = useState(repo.isEmpty);
  const src = `/api/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/preview.png?view=iso`;
  return (
    <div className={cx('relative flex items-center justify-center overflow-hidden rounded-md border border-border bg-canvas-inset', className)}>
      {failed ? (
        <CircuitBoard size={20} aria-hidden className="text-fg-subtle" />
      ) : (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-contain p-1.5" />
      )}
    </div>
  );
}

function RepoRow({ r, showOwner }: { r: RepoInfo; showOwner: boolean }) {
  return (
    <li className="group/repo relative flex gap-4 py-4 sm:gap-5">
      <RepoThumb repo={r} className="aspect-[16/10] w-24 shrink-0 sm:w-32" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {showOwner && <Avatar name={r.owner} src={null} size={18} square={r.ownerKind === 'org'} />}
          <Link
            to="/$owner/$repo"
            params={{ owner: r.owner, repo: r.name }}
            className="min-w-0 truncate text-[15px] text-fg no-underline after:absolute after:inset-0 after:content-[''] group-hover/repo:underline group-hover/repo:decoration-fg/40 group-hover/repo:underline-offset-4"
          >
            {showOwner && <span className="text-fg-muted">{r.owner} / </span>}
            <span className="font-medium">{r.name}</span>
          </Link>
          {r.visibility === 'private' && (
            <Label className="shrink-0">
              <Lock size={9} /> Private
            </Label>
          )}
        </div>
        {r.description && <p className="line-clamp-2 max-w-2xl text-[14px] leading-[1.45] text-fg-muted">{r.description}</p>}
        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-fg-subtle">
          <span>
            Updated <RelativeTime date={r.pushedAt ?? r.updatedAt} />
          </span>
        </div>
      </div>
    </li>
  );
}

/** Repository index: hairline rows, each with the board's own render. */
export function RepoList({ repos, showOwner = true, empty, emptyAction }: { repos: RepoInfo[]; showOwner?: boolean; empty?: ReactNode; emptyAction?: ReactNode }) {
  if (!repos.length)
    return (
      <div className="flex flex-col items-center gap-4 rounded-md border border-dashed border-border px-6 py-14 text-center text-[15px] text-fg-muted">
        <p className="max-w-md">{empty ?? 'No repositories yet.'}</p>
        {emptyAction}
      </div>
    );
  return (
    <ul className="divide-y divide-border-muted border-y border-border">
      {repos.map((r) => (
        <RepoRow key={r.id} r={r} showOwner={showOwner} />
      ))}
    </ul>
  );
}
