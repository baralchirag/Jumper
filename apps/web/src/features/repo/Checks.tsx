import { useSearch } from '@tanstack/react-router';
import { PageSpinner } from '@jumper/ui';
import { ChecksList } from '../checks/ChecksList';
import { OutputsPanel } from '../checks/OutputsPanel';
import { ErrorView, PageHeader } from '../../shared/components/common';
import { useChecks } from '../../shared/lib/queries';
import { canWrite, useRepoInfo } from './context';

export function ChecksPage() {
  const info = useRepoInfo();
  const { sha } = useSearch({ strict: false }) as { sha?: string };
  const q = useChecks(info.owner, info.name, sha ?? info.defaultBranch);
  if (info.isEmpty) return <div className="py-10 text-center text-fg-muted">Push a commit to run checks.</div>;
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;
  return (
    <div className="max-w-5xl space-y-12 py-2">
      <PageHeader title="Checks">ERC, DRC, BOM, renders and exports for this commit.</PageHeader>
      <ChecksList owner={info.owner} repo={info.name} sha={q.data!.sha} runs={q.data!.runs} canRerun={canWrite(info)} />
      <OutputsPanel owner={info.owner} repo={info.name} sha={q.data!.sha} />
    </div>
  );
}
