import { useSearch } from '@tanstack/react-router';
import { PageSpinner } from '@pcbhub/ui';
import { ChecksList } from '../../components/ChecksList';
import { ErrorView } from '../../components/common';
import { useChecks } from '../../lib/queries';
import { canWrite, useRepoInfo } from './context';

export function ChecksPage() {
  const info = useRepoInfo();
  const { sha } = useSearch({ strict: false }) as { sha?: string };
  const q = useChecks(info.owner, info.name, sha ?? info.defaultBranch);
  if (info.isEmpty) return <div className="py-10 text-center text-fg-muted">Push a commit to run checks.</div>;
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;
  return (
    <div className="mx-auto max-w-5xl">
      <ChecksList owner={info.owner} repo={info.name} sha={q.data!.sha} runs={q.data!.runs} canRerun={canWrite(info)} />
    </div>
  );
}
