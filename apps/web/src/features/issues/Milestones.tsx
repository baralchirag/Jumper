import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Trash2 } from 'lucide-react';
import type { MilestoneInfo } from '@jumper/shared';
import { Box, BoxHeader, BoxRow, Button, EmptyState, Flash, FormField, IconButton, Input, PageSpinner, Textarea } from '@jumper/ui';
import { ErrorView } from '../../shared/components/common';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';
import { canWrite, useRepoInfo } from '../repo/context';

export function MilestonesPage() {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const key = [...keys.repo(info.owner, info.name), 'milestones'];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<MilestoneInfo[]>(repoPath(info.owner, info.name, '/milestones')) });
  const [form, setForm] = useState({ title: '', description: '', dueOn: '' });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: () => api.post(repoPath(info.owner, info.name, '/milestones'), { title: form.title, description: form.description, dueOn: form.dueOn ? new Date(form.dueOn).toISOString() : null }),
    onSuccess: () => {
      setForm({ title: '', description: '', dueOn: '' });
      setError(null);
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (m: MilestoneInfo) => api.patch(repoPath(info.owner, info.name, `/milestones/${m.id}`), { state: m.state === 'open' ? 'closed' : 'open' }),
    onSuccess: refresh,
  });
  const del = useMutation({ mutationFn: (id: string) => api.delete(repoPath(info.owner, info.name, `/milestones/${id}`)), onSuccess: refresh });
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="headline text-[length:var(--t-l)]">Milestones</h1>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          A milestone groups issues for one goal, usually a board revision — “Rev B bring-up”, “Ready for fab”. Progress is the share of its issues that are closed.
        </p>
      </div>
      {canWrite(info) && (
        <Box className="p-4">
          <form
            className="grid gap-3 sm:grid-cols-[1fr_180px]"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            {error && <Flash tone="danger" className="sm:col-span-2">{error}</Flash>}
            <FormField label="Title" required>{(id) => <Input id={id} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} required />}</FormField>
            <FormField label="Due date">{(id) => <Input id={id} type="date" value={form.dueOn} onChange={(e) => setForm({ ...form, dueOn: e.target.value })} />}</FormField>
            <FormField label="Description" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</FormField>
            <div className="sm:col-span-2">
              <Button type="submit" variant="primary" loading={create.isPending} disabled={!form.title.trim()}>
                Create milestone
              </Button>
            </div>
          </form>
        </Box>
      )}
      <Box>
        <BoxHeader className="text-sm font-medium">All milestones</BoxHeader>
        {q.data?.length === 0 && <EmptyState title="No milestones yet">Create one above to start planning a revision.</EmptyState>}
        {q.data?.map((m) => {
          const total = m.openIssues + m.closedIssues;
          const pct = total ? Math.round((m.closedIssues / total) * 100) : 0;
          return (
            <BoxRow key={m.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <Link to="/$owner/$repo/issues" params={{ owner: info.owner, repo: info.name }} search={{ milestone: m.id, state: 'open' }} className="font-semibold hover:text-accent">
                  {m.title}
                </Link>
                {m.state === 'closed' && <span className="text-xs text-fg-muted">closed</span>}
                {m.dueOn && (
                  <span className="flex items-center gap-1 text-xs text-fg-muted">
                    <CalendarDays size={12} /> due {new Date(m.dueOn).toLocaleDateString()}
                  </span>
                )}
                {canWrite(info) && (
                  <span className="ml-auto flex items-center gap-1">
                    <Button size="sm" onClick={() => toggle.mutate(m)}>
                      {m.state === 'open' ? 'Close' : 'Reopen'}
                    </Button>
                    <IconButton label="Delete milestone" size="sm" icon={<Trash2 size={13} />} onClick={() => confirm(`Delete “${m.title}”? Its issues are kept.`) && del.mutate(m.id)} />
                  </span>
                )}
              </div>
              {m.description && <p className="text-sm text-fg-muted">{m.description}</p>}
              <div className="flex items-center gap-3 text-xs text-fg-muted">
                <div className="h-1.5 w-48 overflow-hidden rounded-full bg-neutral-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${m.title} progress`}>
                  <div className="h-full bg-success-emphasis" style={{ width: `${pct}%` }} />
                </div>
                {pct}% · {m.openIssues} open · {m.closedIssues} closed
              </div>
            </BoxRow>
          );
        })}
      </Box>
    </div>
  );
}
