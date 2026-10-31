import { Link } from '@tanstack/react-router';
import { GitPullRequest, Lock } from 'lucide-react';
import type { RepoInfo } from '@pcbhub/shared';
import { Label, RelativeTime } from '@pcbhub/ui';

export function RepoList({ repos, showOwner = true, empty }: { repos: RepoInfo[]; showOwner?: boolean; empty?: string }) {
  if (!repos.length) return <div className="py-8 text-center text-sm text-fg-muted">{empty ?? 'No repositories yet.'}</div>;
  return (
    <ul className="divide-y divide-border-muted">
      {repos.map((r) => (
        <li key={r.id} className="py-4">
          <div className="flex items-center gap-2">
            <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="link text-lg font-semibold">
              {showOwner ? `${r.owner} / ${r.name}` : r.name}
            </Link>
            <Label>
              {r.visibility === 'private' && <Lock size={10} />}
              {r.visibility === 'private' ? 'Private' : 'Public'}
            </Label>
          </div>
          {r.description && <p className="mt-1 text-sm text-fg-muted">{r.description}</p>}
          <div className="mt-2 flex items-center gap-4 text-xs text-fg-muted">
            {r.openPullCount > 0 && (
              <span className="flex items-center gap-1">
                <GitPullRequest size={12} /> {r.openPullCount} open
              </span>
            )}
            <span>Updated <RelativeTime date={r.pushedAt ?? r.updatedAt} /></span>
          </div>
        </li>
      ))}
    </ul>
  );
}
