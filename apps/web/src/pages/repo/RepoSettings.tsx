import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import type { RepoInfo, RepoRole, UserSummary } from '@pcbhub/shared';
import { Box, BoxHeader, BoxRow, Button, Dialog, Flash, FormField, IconButton, Input, Select } from '@pcbhub/ui';
import { NotFound, UserLink } from '../../components/common';
import { api, errorMessage, repoPath } from '../../lib/api';
import { keys, useBranches } from '../../lib/queries';
import { useRepoInfo } from './context';

function General() {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const branches = useBranches(info.owner, info.name);
  const [form, setForm] = useState({
    name: info.name,
    description: info.description,
    visibility: info.visibility,
    defaultBranch: info.defaultBranch,
    requiredApprovals: info.requiredApprovals,
  });
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const updated = await api.patch<RepoInfo>(repoPath(info.owner, info.name), { ...form, defaultBranch: info.isEmpty ? undefined : form.defaultBranch });
      await qc.invalidateQueries({ queryKey: keys.repo(info.owner, info.name) });
      setMsg({ tone: 'success', text: 'Settings saved.' });
      if (updated.name !== info.name) void navigate({ to: '/$owner/$repo/settings', params: { owner: info.owner, repo: updated.name } });
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="max-w-xl space-y-4">
      {msg && <Flash tone={msg.tone}>{msg.text}</Flash>}
      <FormField label="Repository name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</FormField>
      <FormField label="Description">{(id) => <Input id={id} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</FormField>
      <FormField label="Visibility">
        {(id) => (
          <Select id={id} value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as 'public' | 'private' })} className="w-48">
            <option value="public">Public</option>
            <option value="private">Private</option>
          </Select>
        )}
      </FormField>
      {!info.isEmpty && (
        <FormField label="Default branch">
          {(id) => (
            <Select id={id} value={form.defaultBranch} onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })} className="w-64">
              {(branches.data ?? []).map((b) => (
                <option key={b.name}>{b.name}</option>
              ))}
            </Select>
          )}
        </FormField>
      )}
      <FormField label="Required approvals" hint="Approving reviews needed before a pull request can be merged. Required checks are configured in .pcbhub.yml.">
        {(id) => <Input id={id} type="number" min={0} max={10} value={form.requiredApprovals} onChange={(e) => setForm({ ...form, requiredApprovals: Number(e.target.value) })} className="w-24" />}
      </FormField>
      <Button type="submit" variant="primary" loading={busy}>
        Save changes
      </Button>
    </form>
  );
}

function Collaborators() {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const key = [...keys.repo(info.owner, info.name), 'collaborators'];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<(UserSummary & { role: RepoRole })[]>(repoPath(info.owner, info.name, '/collaborators')) });
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<RepoRole>('write');
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.put(repoPath(info.owner, info.name, `/collaborators/${encodeURIComponent(username)}`), { role });
      setUsername('');
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const remove = async (u: string) => {
    await api.delete(repoPath(info.owner, info.name, `/collaborators/${encodeURIComponent(u)}`));
    await qc.invalidateQueries({ queryKey: key });
  };
  return (
    <div className="max-w-2xl space-y-3">
      {error && <Flash tone="danger">{error}</Flash>}
      <form onSubmit={add} className="flex gap-2">
        <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" required />
        <Select value={role} onChange={(e) => setRole(e.target.value as RepoRole)} className="w-32">
          <option value="read">Read</option>
          <option value="write">Write</option>
          <option value="admin">Admin</option>
        </Select>
        <Button type="submit">Add</Button>
      </form>
      <Box>
        {q.data?.length === 0 && <div className="p-4 text-sm text-fg-muted">No collaborators yet.</div>}
        {q.data?.map((c) => (
          <BoxRow key={c.id} className="flex items-center gap-3">
            <UserLink user={c} />
            <span className="text-sm capitalize text-fg-muted">{c.role}</span>
            <IconButton label="Remove" size="sm" className="ml-auto" icon={<Trash2 size={14} />} onClick={() => void remove(c.username)} />
          </BoxRow>
        ))}
      </Box>
    </div>
  );
}

function DangerZone() {
  const info = useRepoInfo();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const del = async () => {
    setBusy(true);
    await api.delete(repoPath(info.owner, info.name));
    await qc.invalidateQueries();
    void navigate({ to: '/$owner', params: { owner: info.owner } });
  };
  return (
    <Box className="max-w-2xl border-danger/40">
      <div className="flex items-center gap-4 p-4">
        <div className="flex-1">
          <div className="font-semibold">Delete this repository</div>
          <div className="text-sm text-fg-muted">Removes the git history, pull requests, checks and artifacts. This cannot be undone.</div>
        </div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete repository
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete ${info.fullName}`}
        footer={
          <Button variant="danger" disabled={confirm !== info.fullName} loading={busy} onClick={() => void del()}>
            I understand, delete it
          </Button>
        }
      >
        <p className="mb-3 text-sm">
          Type <strong>{info.fullName}</strong> to confirm.
        </p>
        <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />
      </Dialog>
    </Box>
  );
}

export function RepoSettingsPage() {
  const info = useRepoInfo();
  if (info.permission !== 'admin') return <NotFound />;
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <section>
        <BoxHeader className="mb-4 rounded-md border border-border">
          <h2 className="font-semibold">General</h2>
        </BoxHeader>
        <General />
      </section>
      <section>
        <BoxHeader className="mb-4 rounded-md border border-border">
          <h2 className="font-semibold">Collaborators</h2>
        </BoxHeader>
        <Collaborators />
      </section>
      <section>
        <h2 className="mb-2 font-semibold text-danger">Danger zone</h2>
        <DangerZone />
      </section>
    </div>
  );
}
