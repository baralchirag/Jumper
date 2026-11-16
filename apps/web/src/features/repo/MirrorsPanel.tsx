import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, RefreshCw, Trash2 } from 'lucide-react';
import type { MirrorDirection, MirrorInfo } from '@jumper/shared';
import { Box, BoxRow, Button, Checkbox, Flash, FormField, IconButton, Input, Label, RelativeTime, Select } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';
import { useRepoInfo } from './context';

const INTERVALS = [
  { value: 10, label: 'Every 10 minutes' },
  { value: 60, label: 'Every hour' },
  { value: 360, label: 'Every 6 hours' },
  { value: 1440, label: 'Once a day' },
];

function MirrorRow({ m }: { m: MirrorInfo }) {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const key = [...keys.repo(info.owner, info.name), 'mirrors'];
  const path = repoPath(info.owner, info.name, `/mirrors/${m.id}`);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const sync = useMutation({ mutationFn: () => api.post<MirrorInfo>(`${path}/sync`), onSuccess: () => { void refresh(); void qc.invalidateQueries({ queryKey: keys.repo(info.owner, info.name) }); } });
  const patch = useMutation({ mutationFn: (body: Partial<Pick<MirrorInfo, 'enabled' | 'overwrite' | 'intervalMinutes'>>) => api.patch(path, body), onSuccess: refresh });
  const del = useMutation({ mutationFn: () => api.delete(path), onSuccess: refresh });
  const pull = m.direction === 'pull';
  return (
    <BoxRow className="block space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-fg-muted" aria-hidden>{pull ? <ArrowDownToLine size={16} /> : <ArrowUpFromLine size={16} />}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm">{m.url}</div>
          <div className="text-xs text-fg-muted">
            {pull ? 'Pulls from this remote' : 'Pushes to this remote'}
            {m.username && ` as ${m.username}`}
            {m.hasToken ? ' · token saved' : ' · no token'}
            {' · '}
            {m.lastSyncAt ? <>last synced <RelativeTime date={m.lastSyncAt} /></> : 'not synced yet'}
          </div>
        </div>
        {!m.enabled ? <Label>Paused</Label> : m.lastError ? <Label tone="danger">Failing</Label> : m.lastSuccessAt ? <Label tone="success">In sync</Label> : null}
        <Button size="sm" leadingIcon={<RefreshCw size={14} />} loading={sync.isPending} onClick={() => sync.mutate()} disabled={!m.enabled}>
          Sync now
        </Button>
        <IconButton label="Remove mirror" size="sm" variant="danger" onClick={() => del.mutate()} icon={<Trash2 size={14} />} />
      </div>
      {m.lastError && <Flash tone="danger">{m.lastError}</Flash>}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pl-7 text-sm">
        <Checkbox label="Enabled" checked={m.enabled} onChange={(e) => patch.mutate({ enabled: e.target.checked })} />
        <Checkbox
          label={pull ? 'Overwrite local branches' : 'Force-push'}
          hint={pull ? 'Make this a read-only copy: remote history always wins and deleted branches are removed here.' : 'Remote history is replaced with this one, and branches deleted here are deleted there.'}
          checked={m.overwrite}
          onChange={(e) => patch.mutate({ overwrite: e.target.checked })}
        />
        {pull && (
          <Select aria-label="Sync interval" value={m.intervalMinutes} onChange={(e) => patch.mutate({ intervalMinutes: Number(e.target.value) })} className="w-48">
            {[...INTERVALS, ...(INTERVALS.some((i) => i.value === m.intervalMinutes) ? [] : [{ value: m.intervalMinutes, label: `Every ${m.intervalMinutes} minutes` }])].map((i) => (
              <option key={i.value} value={i.value}>{i.label}</option>
            ))}
          </Select>
        )}
      </div>
    </BoxRow>
  );
}

export function MirrorsPanel() {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const key = [...keys.repo(info.owner, info.name), 'mirrors'];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<MirrorInfo[]>(repoPath(info.owner, info.name, '/mirrors')) });
  const [form, setForm] = useState({ direction: 'push' as MirrorDirection, url: '', username: '', token: '', intervalMinutes: 60 });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<MirrorInfo>(repoPath(info.owner, info.name, '/mirrors'), { ...form, username: form.username || undefined, token: form.token || undefined }),
    onSuccess: () => {
      setForm({ ...form, url: '', username: '', token: '' });
      setError(null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const hasPull = q.data?.some((m) => m.direction === 'pull');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <div className="max-w-3xl space-y-6">
      <Box>
        {q.data?.length === 0 && (
          <div className="p-4 text-sm text-fg-muted">
            No mirrors. Add a push mirror to keep a copy on GitHub or GitLab up to date, a pull mirror to follow one, or both for a two-way mirror.
          </div>
        )}
        {q.data?.map((m) => <MirrorRow key={m.id} m={m} />)}
      </Box>

      <form onSubmit={submit} className="space-y-4 rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold">Add a mirror</h3>
        {error && <Flash tone="danger">{error}</Flash>}
        <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
          <FormField label="Direction">
            {(id) => (
              <Select id={id} value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as MirrorDirection })}>
                <option value="push">Push to remote</option>
                <option value="pull" disabled={hasPull}>Pull from remote</option>
              </Select>
            )}
          </FormField>
          <FormField label="Remote URL" required hint="The https:// clone address, e.g. https://github.com/acme/board.git">
            {(id) => <Input id={id} type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required placeholder="https://github.com/acme/board.git" />}
          </FormField>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Username" hint="Optional for most hosts when using a token.">{(id) => <Input id={id} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />}</FormField>
          <FormField label="Access token" hint={form.direction === 'push' ? 'Needs write access to the remote. Stored encrypted.' : 'Only for private remotes. Stored encrypted.'}>
            {(id) => <Input id={id} type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} autoComplete="new-password" />}
          </FormField>
        </div>
        {form.direction === 'pull' && (
          <FormField label="Check for new commits">
            {(id) => (
              <Select id={id} value={form.intervalMinutes} onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) })} className="w-48">
                {INTERVALS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
              </Select>
            )}
          </FormField>
        )}
        <p className="text-xs text-fg-muted">
          Mirrors only fast-forward by default: if both copies change the same branch, nothing is overwritten and the mirror shows what needs merging.
          Push mirrors run after every push, merge and web edit.
        </p>
        <Button type="submit" variant="primary" loading={create.isPending}>Add mirror</Button>
      </form>
    </div>
  );
}
