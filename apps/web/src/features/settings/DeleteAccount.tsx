import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { Button, Dialog, Flash, FormField, Input, Spinner } from '@jumper/ui';
import { api, errorMessage } from '../../shared/lib/api';
import { keys, useMe } from '../../shared/lib/queries';

interface Preview {
  ownedRepos: { name: string; visibility: 'public' | 'private' }[];
  soleOwnerOrgs: { slug: string; name: string; members: number }[];
  isLastAdmin: boolean;
  blocked: boolean;
}

/** Permanent account deletion. Shows exactly what goes away and what is blocking, then asks for username and password. */
export function DeleteAccount() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useQuery({ queryKey: ['deletion-preview'], queryFn: () => api.get<Preview>('/user/deletion-preview'), enabled: open });
  if (!me) return null;
  const p = preview.data;
  const ready = confirm === me.username && (!me.hasPassword || password.length > 0) && !p?.blocked;

  const close = () => {
    setOpen(false);
    setConfirm('');
    setPassword('');
    setError(null);
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.delete('/user', { confirm, password: me.hasPassword ? password : undefined });
      // Leave first: clearing the signed-in user while on a settings page would bounce us to the sign-in screen.
      await navigate({ to: '/' });
      qc.setQueryData(keys.me, null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-4">
        <p className="min-w-0 flex-1 text-[14px] text-fg-muted">
          Permanently delete your account and everything you own. Things you wrote on other people’s repositories (issues, comments, reviews) stay, shown as “ghost”.
        </p>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete my account…
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={close}
        title="Delete your account"
        width={520}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="danger" disabled={!ready} loading={busy} onClick={() => void remove()}>
              Delete forever
            </Button>
          </>
        }
      >
        {preview.isLoading && (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <Spinner size={14} /> Checking what would be deleted…
          </p>
        )}
        {preview.error && <Flash tone="danger">{errorMessage(preview.error)}</Flash>}
        {p && (
          <div className="space-y-4 text-sm">
            {p.isLastAdmin && <Flash tone="danger">You are the only administrator. Run <code className="font-mono text-xs">pnpm admin:grant &lt;username&gt;</code> for someone else first.</Flash>}
            {p.soleOwnerOrgs.length > 0 && (
              <Flash tone="danger">
                You are the only owner of {p.soleOwnerOrgs.map((o) => o.name || o.slug).join(', ')}. Add another owner or delete the organization first.
              </Flash>
            )}
            <div className="rounded-lg border border-border bg-canvas-subtle p-4">
              <p className="mb-2 flex items-center gap-2 font-medium">
                <TriangleAlert size={15} className="text-danger" /> This will permanently delete
              </p>
              <ul className="list-disc space-y-1 pl-5 text-fg-muted">
                <li>your profile, sessions, access tokens and stars</li>
                <li>
                  {p.ownedRepos.length === 0 ? 'no repositories (you own none)' : `${p.ownedRepos.length} repositor${p.ownedRepos.length === 1 ? 'y' : 'ies'} with all git history, pull requests, checks and files`}
                  {p.ownedRepos.length > 0 && <span className="block font-mono text-xs">{p.ownedRepos.slice(0, 8).map((r) => r.name).join(', ')}{p.ownedRepos.length > 8 ? ` and ${p.ownedRepos.length - 8} more` : ''}</span>}
                </li>
              </ul>
              <p className="mt-3 text-fg-muted">This cannot be undone. Export your data first if you may need it.</p>
            </div>
            <FormField label={<>Type <b className="font-mono">{me.username}</b> to confirm</>}>
              {(id) => <Input id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />}
            </FormField>
            {me.hasPassword && (
              <FormField label="Your password">
                {(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}
              </FormField>
            )}
            {error && <Flash tone="danger">{error}</Flash>}
          </div>
        )}
      </Dialog>
    </>
  );
}
