import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Trash2 } from 'lucide-react';
import { Box, BoxRow, Button, Checkbox, Flash, FormField, IconButton, Input, Label } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';
import { useRepoInfo } from './context';

interface Rule {
  id: string;
  pattern: string;
  blockDeletion: boolean;
  blockForcePush: boolean;
  enforceAdmins: boolean;
}

/** Protected branches. Enforced by git itself on every push, so no client can sidestep a rule. */
export function BranchProtectionPanel() {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const key = [...keys.repo(info.owner, info.name), 'branch-protection'];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Rule[]>(repoPath(info.owner, info.name, '/branch-protection')) });
  const [form, setForm] = useState({ pattern: info.defaultBranch, blockDeletion: true, blockForcePush: true, enforceAdmins: false });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: () => api.post(repoPath(info.owner, info.name, '/branch-protection'), form),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const del = useMutation({ mutationFn: (id: string) => api.delete(repoPath(info.owner, info.name, `/branch-protection/${id}`)), onSuccess: refresh });
  return (
    <div className="max-w-3xl space-y-6">
      <Box>
        {q.data?.length === 0 && <div className="p-5 text-sm text-fg-muted">No protected branches. Anyone with write access can push to, rewrite or delete any branch.</div>}
        {q.data?.map((r) => (
          <BoxRow key={r.id} className="flex items-start gap-4">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="font-mono text-sm font-medium">{r.pattern}</div>
              <div className="flex flex-wrap gap-1.5">
                {r.blockForcePush && <Label>no force-push</Label>}
                {r.blockDeletion && <Label>no deletion</Label>}
                <Label tone={r.enforceAdmins ? 'attention' : 'default'}>{r.enforceAdmins ? 'applies to admins' : 'admins exempt'}</Label>
              </div>
            </div>
            <IconButton label={`Remove protection for ${r.pattern}`} size="sm" icon={<Trash2 size={14} />} onClick={() => confirm(`Stop protecting “${r.pattern}”?`) && del.mutate(r.id)} />
          </BoxRow>
        ))}
      </Box>

      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h3 className="text-sm font-semibold">Protect a branch</h3>
        {error && <Flash tone="danger">{error}</Flash>}
        <FormField label="Branch name pattern" hint="A branch name, or a pattern: release/* covers release/1.0, release/2.0 and so on.">
          {(id) => <Input id={id} value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} className="max-w-sm font-mono" required />}
        </FormField>
        <div className="space-y-4">
          <Checkbox label="Block force-pushes" hint="History cannot be rewritten, so reviewed work cannot silently disappear." checked={form.blockForcePush} onChange={(e) => setForm({ ...form, blockForcePush: e.target.checked })} />
          <Checkbox label="Block deletion" hint="The branch cannot be deleted from git or the website." checked={form.blockDeletion} onChange={(e) => setForm({ ...form, blockDeletion: e.target.checked })} />
          <Checkbox label="Apply to administrators too" hint="Off: repository admins can bypass the rule in an emergency." checked={form.enforceAdmins} onChange={(e) => setForm({ ...form, enforceAdmins: e.target.checked })} />
        </div>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!form.pattern.trim()}>
          Protect branch
        </Button>
      </form>
    </div>
  );
}
