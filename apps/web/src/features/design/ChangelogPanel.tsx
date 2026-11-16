import { useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { Box, BoxHeader, CopyButton, PageSpinner } from '@jumper/ui';
import { Markdown } from '../../shared/components/Markdown';
import { api, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';

/** Auto-written summary of what changed in the design between two revisions. */
export function ChangelogPanel({ owner, repo, base, head }: { owner: string; repo: string; base: string; head: string }) {
  const q = useQuery({
    queryKey: [...keys.repo(owner, repo), 'changelog', base, head],
    queryFn: () => api.get<{ markdown: string; truncated: boolean }>(repoPath(owner, repo, '/changelog'), { base, head }),
    retry: false,
  });
  if (q.isLoading) return <PageSpinner label="Summarising changes…" />;
  if (q.error || !q.data) return null;
  return (
    <Box>
      <BoxHeader className="gap-2 text-sm font-medium">
        <ScrollText size={14} /> Design changes
        <span className="ml-auto">
          <CopyButton value={q.data.markdown} label="Copy as Markdown" />
        </span>
      </BoxHeader>
      <div className="p-4">
        <Markdown source={q.data.markdown} />
        {q.data.truncated && <p className="mt-2 text-xs text-fg-muted">Only the first 20 design files are summarised.</p>}
      </div>
    </Box>
  );
}
