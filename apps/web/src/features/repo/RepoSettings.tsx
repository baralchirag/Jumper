import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, GitBranch, Link2, Package, Trash2, Users, Webhook, Settings as Cog, TriangleAlert } from 'lucide-react';
import type { RepoInfo, RepoRole, UserSummary } from '@jumper/shared';
import { Box, BoxRow, Button, Checkbox, Dialog, Flash, FormField, IconButton, Input, Select, cx } from '@jumper/ui';
import { BranchProtectionPanel } from './BranchProtectionPanel';
import { MirrorsPanel } from './MirrorsPanel';
import { RepoConfigPanel } from '../settings/RepoConfigPanel';
import { ShareLinksPanel } from '../share/ShareLinksPanel';
import { WebhooksPanel } from '../webhooks/WebhooksPanel';
import { NotFound, UserLink } from '../../shared/components/common';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys, useBranches } from '../../shared/lib/queries';
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
    exportControlled: info.exportControlled,
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
    <form onSubmit={submit} className="max-w-xl space-y-6">
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
      <Checkbox
        checked={form.exportControlled}
        onChange={(e) => setForm({ ...form, exportControlled: e.target.checked, visibility: e.target.checked ? 'private' : form.visibility })}
        label="Export-controlled"
        hint="Only people an administrator has cleared can see this repository, administrators included. It must stay private."
      />
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
    <div className="max-w-2xl space-y-5">
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
          <div className="text-sm text-fg-muted">Removes the git history, checks and outputs. This cannot be undone.</div>
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

const SECTIONS = [
  { id: 'general', label: 'General', icon: <Cog size={15} />, title: 'General', blurb: 'Name, description, visibility and default branch.' },
  { id: 'collaborators', label: 'Collaborators', icon: <Users size={15} />, title: 'Collaborators', blurb: 'Who can read, change or administer this repository. Read can view the design and its outputs; Write can push; Admin can change these settings.' },
  { id: 'branches', label: 'Branch protection', icon: <GitBranch size={15} />, title: 'Branch protection', blurb: 'Stop important branches from being rewritten or deleted. Rules are enforced by git on every push, from any client.' },
  { id: 'manufacturing', label: 'Manufacturing & parts', icon: <Package size={15} />, title: 'Manufacturing & parts', blurb: 'Tell Jumper which fabs you build at and which parts are allowed, so boards and BOMs are checked against your real constraints.' },
  { id: 'webhooks', label: 'Webhooks', icon: <Webhook size={15} />, title: 'Webhooks', blurb: 'Send an HTTP request to your own service when something happens here — to trigger CI, post to chat or kick off an order.' },
  { id: 'mirroring', label: 'Mirroring', icon: <ArrowLeftRight size={15} />, title: 'Mirroring', blurb: 'Keep this repository in step with a copy on GitHub, GitLab or another git host: push changes there, pull changes from there, or both.' },
  { id: 'sharing', label: 'Share links', icon: <Link2 size={15} />, title: 'Share links', blurb: 'Give clients, fabs or reviewers read-only access without creating accounts.' },
  { id: 'danger', label: 'Danger zone', icon: <TriangleAlert size={15} />, title: 'Danger zone', blurb: 'Irreversible actions.' },
] as const;

export function RepoSettingsPage() {
  const info = useRepoInfo();
  const { section = 'general' } = useParams({ strict: false }) as { section?: string };
  if (info.permission !== 'admin') return <NotFound />;
  const active = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0];
  return (
    <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-[220px_minmax(0,1fr)]">
      <nav aria-label="Repository settings" className="md:sticky md:top-20 md:self-start">
        <ul className="space-y-0.5">
          {SECTIONS.map((x) => (
            <li key={x.id}>
              <Link
                to="/$owner/$repo/settings/$section"
                params={{ owner: info.owner, repo: info.name, section: x.id }}
                aria-current={x.id === active.id ? 'page' : undefined}
                className={cx(
                  'flex items-center gap-2.5 rounded-sm px-3 py-1.5 text-sm no-underline transition-colors',
                  x.id === active.id ? 'bg-accent-subtle font-medium text-fg' : 'text-fg-muted hover:bg-canvas-subtle hover:text-fg',
                  x.id === 'danger' && 'text-danger',
                )}
              >
                {x.icon} {x.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0">
        <h2 className="headline text-[length:var(--t-m)]">{active.title}</h2>
        <p className="mb-6 mt-1 max-w-2xl text-sm text-fg-muted">{active.blurb}</p>
        {active.id === 'general' && <General />}
        {active.id === 'collaborators' && <Collaborators />}
        {active.id === 'branches' && <BranchProtectionPanel />}
        {active.id === 'manufacturing' && <RepoConfigPanel section="parts" />}
        {active.id === 'webhooks' && <WebhooksPanel />}
        {active.id === 'mirroring' && <MirrorsPanel />}
        {active.id === 'sharing' && <ShareLinksPanel />}
        {active.id === 'danger' && <DangerZone />}
      </div>
    </div>
  );
}
