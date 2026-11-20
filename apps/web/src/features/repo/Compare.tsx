import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import type { CompareResponse } from '@jumper/shared';
import { Box, Flash, PageSpinner } from '@jumper/ui';
import { FilesChanged } from '../diff/FilesChanged';
import { RefPicker } from '../../shared/components/RefPicker';
import { shortSha } from '../../shared/components/common';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';
import { useRepoInfo } from './context';

export function ComparePage() {
  const info = useRepoInfo();
  const search = useSearch({ strict: false }) as { base?: string; head?: string };
  const navigate = useNavigate();
  const base = search.base ?? info.defaultBranch;
  const head = search.head ?? '';

  const cmp = useQuery({
    queryKey: [...keys.repo(info.owner, info.name), 'compare', base, head],
    queryFn: () => api.get<CompareResponse>(repoPath(info.owner, info.name, '/compare'), { base, head }),
    enabled: Boolean(head && head !== base),
  });

  const set = (patch: { base?: string; head?: string }) => void navigate({ to: '.', search: { base, head, ...patch }, replace: true });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="headline text-[length:var(--t-l)]">Compare changes</h1>
        <p className="text-sm text-fg-muted">Pick two branches, tags or commits to see what changed on the schematic and the board.</p>
      </div>
      <Box className="flex flex-wrap items-center gap-2 bg-canvas-subtle p-3">
        <RefPicker owner={info.owner} repo={info.name} value={base} label="base" onChange={(r) => set({ base: r })} />
        <ArrowLeft size={16} className="text-fg-muted" />
        <RefPicker owner={info.owner} repo={info.name} value={head || 'select branch'} label="compare" onChange={(r) => set({ head: r })} />
      </Box>
      {!head && <div className="py-10 text-center text-fg-muted">Select a branch to compare against {base}.</div>}
      {head === base && head && <Flash>Choose different branches.</Flash>}
      {cmp.isLoading && <PageSpinner />}
      {cmp.error && <Flash tone="danger">{errorMessage(cmp.error)}</Flash>}
      {cmp.data && (
        <>
          {cmp.data.commits.length === 0 && <Flash>There isn’t anything to compare: {head} has no commits that aren’t in {base}.</Flash>}
          <div className="text-sm text-fg-muted">
            {cmp.data.commits.length} commit{cmp.data.commits.length === 1 ? '' : 's'} · merge base <span className="font-mono">{shortSha(cmp.data.mergeBase)}</span>
          </div>
          <FilesChanged owner={info.owner} repo={info.name} files={cmp.data.files} baseSha={cmp.data.mergeBase} headSha={cmp.data.headSha} />
        </>
      )}
    </div>
  );
}
