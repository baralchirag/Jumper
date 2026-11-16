import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { GitPullRequest, Trash2 } from 'lucide-react';
import { Box, BoxHeader, BoxRow, Flash, IconButton, Label, PageSpinner, RelativeTime, buttonClass } from '@jumper/ui';
import { CheckIcon, rollup } from '../checks/CheckStatus';
import { ErrorView } from '../../shared/components/common';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys, useBranches, useChecks } from '../../shared/lib/queries';
import { canWrite, useRepoInfo } from './context';

function BranchChecks({ sha }: { sha: string }) {
  const info = useRepoInfo();
  const { data } = useChecks(info.owner, info.name, sha);
  return <CheckIcon state={rollup(data?.runs)} size={14} />;
}

export function BranchesPage() {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const q = useBranches(info.owner, info.name);
  const [error, setError] = useState<string | null>(null);
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;

  const remove = async (name: string) => {
    if (!confirm(`Delete branch “${name}”?`)) return;
    try {
      await api.delete(repoPath(info.owner, info.name, `/branches/${name.split('/').map(encodeURIComponent).join('/')}`));
      await qc.invalidateQueries({ queryKey: keys.repo(info.owner, info.name) });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="max-w-5xl space-y-5">
      {error && <Flash tone="danger">{error}</Flash>}
      <Box>
        <BoxHeader>
          <span className="text-sm font-semibold">Branches</span>
        </BoxHeader>
        {q.data!.map((b) => (
          <BoxRow key={b.name} className="flex items-center gap-3">
            <BranchChecks sha={b.sha} />
            <Link to="/$owner/$repo/tree/$ref/$" params={{ owner: info.owner, repo: info.name, ref: b.name, _splat: '' }} className="rounded-md bg-accent-subtle px-2 py-0.5 font-mono text-sm text-accent hover:underline">
              {b.name}
            </Link>
            {b.isDefault && <Label>default</Label>}
            <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
              {b.lastCommit && (
                <>
                  Updated <RelativeTime date={b.lastCommit.committer.date} /> by {b.lastCommit.author.name}
                </>
              )}
            </span>
            {b.aheadBehind && (
              <span className="font-mono text-xs text-fg-muted" title="Behind / ahead of default branch">
                {b.aheadBehind.behind} | {b.aheadBehind.ahead}
              </span>
            )}
            {!b.isDefault && canWrite(info) && (
              <>
                <Link to="/$owner/$repo/compare" params={{ owner: info.owner, repo: info.name }} search={{ base: info.defaultBranch, head: b.name }} className={buttonClass('default', 'sm')}>
                  <GitPullRequest size={14} /> New pull request
                </Link>
                <IconButton label="Delete branch" size="sm" icon={<Trash2 size={14} />} onClick={() => void remove(b.name)} />
              </>
            )}
          </BoxRow>
        ))}
      </Box>
    </div>
  );
}
