import { useMemo } from 'react';
import { ArrowLeftRight, ArrowRight } from 'lucide-react';
import type { CommitInfo } from '@jumper/shared';
import { Button, EmptyState, Flash, PageSpinner, Select } from '@jumper/ui';
import { errorMessage } from '../../shared/lib/api';
import { useCommits } from '../../shared/lib/queries';
import { shortSha } from '../../shared/components/common';
import { VisualDiff } from './VisualDiff';

function label(c: CommitInfo, i: number): string {
  const when = new Date(c.committer.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${shortSha(c.sha)} · ${c.subject.slice(0, 60)} · ${when}${i === 0 ? ' (latest)' : ''}`;
}

/**
 * Side-by-side / overlay / swipe comparison of any two revisions of one
 * schematic or board, picked from the file's history.
 */
export function RevisionCompare({
  owner,
  repo,
  path,
  gitRef,
  base,
  head,
  onChange,
}: {
  owner: string;
  repo: string;
  path: string;
  gitRef: string;
  base?: string;
  head?: string;
  onChange: (next: { base?: string; head?: string }) => void;
}) {
  // History of this file from the current ref (first page covers 30 versions).
  const history = useCommits(owner, repo, gitRef, path, 1);
  const commits = useMemo(() => history.data?.commits ?? [], [history.data]);

  if (history.isLoading) return <PageSpinner label="Loading file history…" />;
  if (history.error) return <Flash tone="danger" className="m-3">{errorMessage(history.error)}</Flash>;
  if (commits.length < 2) {
    return (
      <EmptyState icon={<ArrowLeftRight size={32} />} title="Only one version of this file">
        Commit and push a change to this design to compare versions side by side.
      </EmptyState>
    );
  }

  const headSha = head && commits.some((c) => c.sha === head) ? head : (head ?? commits[0]!.sha);
  const headIdx = commits.findIndex((c) => c.sha === headSha);
  const baseSha = base ?? commits[Math.min(headIdx + 1, commits.length - 1)]?.sha ?? commits[1]!.sha;
  const select = (value: string, set: (v: string) => void, ariaLabel: string) => (
    <Select value={value} onChange={(e) => set(e.target.value)} className="h-8 min-w-0 max-w-md flex-1 text-xs" aria-label={ariaLabel}>
      {!commits.some((c) => c.sha === value) && <option value={value}>{shortSha(value)}</option>}
      {commits.map((c, i) => (
        <option key={c.sha} value={c.sha}>
          {label(c, i)}
        </option>
      ))}
    </Select>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-canvas-subtle px-3 py-2">
        <span className="rounded bg-danger-subtle px-1.5 py-0.5 text-xs font-semibold text-danger">Before</span>
        {select(baseSha, (v) => onChange({ base: v, head: headSha }), 'Before revision')}
        <ArrowRight size={14} className="shrink-0 text-fg-muted" />
        <span className="rounded bg-success-subtle px-1.5 py-0.5 text-xs font-semibold text-success">After</span>
        {select(headSha, (v) => onChange({ base: baseSha, head: v }), 'After revision')}
        <Button size="sm" variant="invisible" leadingIcon={<ArrowLeftRight size={14} />} onClick={() => onChange({ base: headSha, head: baseSha })} title="Swap">
          Swap
        </Button>
      </div>
      {baseSha === headSha ? (
        <EmptyState title="Same revision on both sides">Pick two different versions to compare.</EmptyState>
      ) : (
        <VisualDiff key={`${baseSha}..${headSha}`} owner={owner} repo={repo} path={path} baseSha={baseSha} headSha={headSha} height={860} />
      )}
    </div>
  );
}
