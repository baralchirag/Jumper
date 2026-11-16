import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Trash2 } from 'lucide-react';
import type { ApprovalRuleInfo } from '@jumper/shared';
import { Box, BoxRow, Button, Flash, FormField, IconButton, Input } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';
import { useRepoInfo } from '../repo/context';

export function ApprovalRulesPanel() {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const key = [...keys.repo(info.owner, info.name), 'approval-rules'];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<ApprovalRuleInfo[]>(repoPath(info.owner, info.name, '/approval-rules')) });
  const [form, setForm] = useState({ name: '', pathPattern: '', requiredApprovals: 1, approvers: '' });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: () =>
      api.post(repoPath(info.owner, info.name, '/approval-rules'), {
        name: form.name,
        pathPattern: form.pathPattern,
        requiredApprovals: form.requiredApprovals,
        approvers: form.approvers.split(',').map((a) => a.trim().replace(/^@/, '')).filter(Boolean),
      }),
    onSuccess: () => {
      setForm({ name: '', pathPattern: '', requiredApprovals: 1, approvers: '' });
      setError(null);
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const del = useMutation({ mutationFn: (id: string) => api.delete(repoPath(info.owner, info.name, `/approval-rules/${id}`)), onSuccess: refresh });
  return (
    <div className="max-w-3xl space-y-6">
      <Box>
        {q.data?.length === 0 && <div className="p-4 text-sm text-fg-muted">No sign-off rules. Any approving review satisfies the repository's required approvals.</div>}
        {q.data?.map((r) => (
          <BoxRow key={r.id} className="flex items-start gap-3 py-3">
            <ShieldCheck size={16} className="mt-0.5 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{r.name}</div>
              <div className="text-sm text-fg-muted">
                Changes to <code className="font-mono text-fg">{r.pathPattern}</code> need {r.requiredApprovals} approval{r.requiredApprovals === 1 ? '' : 's'}
                {r.approvers.length > 0 ? <> from {r.approvers.map((a) => a.username).join(', ')}</> : <> from anyone with write access</>}.
              </div>
            </div>
            <IconButton label={`Delete ${r.name}`} size="sm" icon={<Trash2 size={14} />} onClick={() => confirm(`Delete the “${r.name}” rule?`) && del.mutate(r.id)} />
          </BoxRow>
        ))}
      </Box>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {error && <Flash tone="danger" className="sm:col-span-2">{error}</Flash>}
        <FormField label="Rule name" required hint="Shown to reviewers when the rule blocks a merge.">
          {(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Power sign-off" required maxLength={80} />}
        </FormField>
        <FormField label="Applies to files matching" required hint="Glob: power/**, *.kicad_pcb, rf/*.kicad_sch">
          {(id) => <Input id={id} value={form.pathPattern} onChange={(e) => setForm({ ...form, pathPattern: e.target.value })} placeholder="power/**" className="font-mono" required />}
        </FormField>
        <FormField label="Approvals required">
          {(id) => <Input id={id} type="number" min={1} max={20} value={form.requiredApprovals} onChange={(e) => setForm({ ...form, requiredApprovals: Number(e.target.value) })} className="w-24" />}
        </FormField>
        <FormField label="Who can sign off" hint="Comma-separated usernames. Leave empty to accept any collaborator.">
          {(id) => <Input id={id} value={form.approvers} onChange={(e) => setForm({ ...form, approvers: e.target.value })} placeholder="alice, bob" />}
        </FormField>
        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!form.name.trim() || !form.pathPattern.trim()}>
            Add rule
          </Button>
        </div>
      </form>
    </div>
  );
}
