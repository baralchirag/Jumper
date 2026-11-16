import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { GitFork } from 'lucide-react';
import type { RepoInfo } from '@jumper/shared';
import { Button, Dialog, Flash, FormField, Input, Select } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { useMe } from '../../shared/lib/queries';

/** Copy this repository, with all its history, into your account or an organization you belong to. */
export function ForkButton({ info }: { info: RepoInfo }) {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState('');
  const [name, setName] = useState(info.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = me ? [me.username, ...me.orgs.map((o) => o.slug)] : [];
  const disabled = info.isEmpty;

  const start = () => {
    if (!me) return void navigate({ to: '/login', search: { redirect: `/${info.owner}/${info.name}` } });
    setOwner(me.username);
    setName(info.name);
    setError(null);
    setOpen(true);
  };
  const fork = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<RepoInfo>(repoPath(info.owner, info.name, '/fork'), { owner, name });
      await qc.invalidateQueries({ queryKey: ['repos'] });
      void navigate({ to: '/$owner/$repo', params: { owner: r.owner, repo: r.name } });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <>
      <button
        onClick={start}
        disabled={disabled}
        title={disabled ? 'An empty repository cannot be forked' : 'Copy this repository to your account'}
        className="inline-flex h-8 items-stretch overflow-hidden rounded-md border border-border text-sm transition-colors hover:border-fg-subtle disabled:opacity-50"
      >
        <span className="flex items-center gap-1.5 px-3">
          <GitFork size={14} className="text-fg-muted" /> Fork
        </span>
        <span className="flex items-center border-l border-border px-2.5 font-mono tabular-nums text-fg-muted">{info.forkCount}</span>
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Fork ${info.fullName}`}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void fork()}>
              Create fork
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">A fork is your own copy with the full history. Changes you push stay in your copy; you can open a pull request back to the original.{info.visibility === 'private' && ' Forks of private repositories stay private.'}</p>
          {error && <Flash tone="danger">{error}</Flash>}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Owner">
              {(id) => (
                <Select id={id} value={owner} onChange={(e) => setOwner(e.target.value)}>
                  {targets.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Repository name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} className="font-mono" />}</FormField>
          </div>
        </div>
      </Dialog>
    </>
  );
}
