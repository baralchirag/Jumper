import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2, User } from 'lucide-react';
import type { CurrentUser, TokenInfo } from '@pcbhub/shared';
import { TOKEN_SCOPES } from '@pcbhub/shared';
import { Box, BoxHeader, BoxRow, Button, Checkbox, CopyButton, Flash, FormField, IconButton, Input, Label, PageSpinner, RelativeTime, Select, Textarea, cx } from '@pcbhub/ui';
import { PageContainer } from '../components/common';
import { api, errorMessage } from '../lib/api';
import { keys, useMe } from '../lib/queries';

function SettingsLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { data: me, isLoading } = useMe();
  if (isLoading) return <PageSpinner />;
  if (!me) return <Navigate to="/login" search={{ redirect: pathname }} />;
  const items = [
    { to: '/settings', label: 'Profile', icon: <User size={14} /> },
    { to: '/settings/tokens', label: 'Access tokens', icon: <KeyRound size={14} /> },
  ] as const;
  return (
    <PageContainer className="grid gap-8 py-8 md:grid-cols-[220px_1fr]">
      <nav className="space-y-0.5">
        {items.map((it) => (
          <Link key={it.to} to={it.to} className={cx('flex items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-neutral-muted', pathname === it.to && 'bg-neutral-muted font-semibold')}>
            {it.icon}
            {it.label}
          </Link>
        ))}
      </nav>
      <div className="min-w-0">{children}</div>
    </PageContainer>
  );
}

export function ProfileSettingsPage() {
  return (
    <SettingsLayout>
      <ProfileForm />
      <PasswordForm />
      <GithubLink />
    </SettingsLayout>
  );
}

function GithubLink() {
  const { data: me } = useMe();
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ github: boolean }>('/auth/providers'), staleTime: Infinity });
  if (!providers.data?.github) return null;
  return (
    <section className="mt-10">
      <h2 className="border-b border-border pb-2 text-xl font-semibold">Connected accounts</h2>
      <div className="flex items-center gap-3 pt-4 text-sm">
        <span className="font-semibold">GitHub</span>
        {me?.githubLinked ? (
          <span className="text-success">Connected</span>
        ) : (
          <a href="/api/auth/github" className="link">
            Connect your GitHub account
          </a>
        )}
      </div>
    </section>
  );
}

function ProfileForm() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', bio: '' });
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (me) setForm({ name: me.name ?? '', email: me.email, bio: me.bio ?? '' });
  }, [me]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const updated = await api.patch<CurrentUser>('/user', form);
      qc.setQueryData(keys.me, updated);
      setMsg({ tone: 'success', text: 'Profile updated.' });
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mb-10">
      <h2 className="border-b border-border pb-2 text-xl font-semibold">Public profile</h2>
      <form onSubmit={submit} className="max-w-lg space-y-4 pt-4">
        {msg && <Flash tone={msg.tone}>{msg.text}</Flash>}
        <FormField label="Name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</FormField>
        <FormField label="Email">{(id) => <Input id={id} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</FormField>
        <FormField label="Bio">{(id) => <Textarea id={id} rows={3} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} />}</FormField>
        <Button type="submit" variant="primary" loading={busy}>
          Update profile
        </Button>
      </form>
    </section>
  );
}

function PasswordForm() {
  const { data: me } = useMe();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/user/password', { currentPassword: current || undefined, newPassword: next });
      setMsg({ tone: 'success', text: 'Password changed. Other sessions were signed out.' });
      setCurrent('');
      setNext('');
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h2 className="border-b border-border pb-2 text-xl font-semibold">{me?.hasPassword ? 'Change password' : 'Set a password'}</h2>
      <form onSubmit={submit} className="max-w-lg space-y-4 pt-4">
        {msg && <Flash tone={msg.tone}>{msg.text}</Flash>}
        {me?.hasPassword && (
          <FormField label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />}</FormField>
        )}
        <FormField label="New password" hint="At least 10 characters. Also used for git over HTTPS if you don't use a token.">
          {(id) => <Input id={id} type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />}
        </FormField>
        <Button type="submit" loading={busy}>
          Update password
        </Button>
      </form>
    </section>
  );
}

export function TokensSettingsPage() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<TokenInfo[]>('/user/tokens') });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['repo:read', 'repo:write']);
  const [expires, setExpires] = useState('90');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ token: string }>('/user/tokens', { name, scopes, expiresInDays: expires === 'never' ? null : Number(expires) });
      setCreated(res.token);
      setName('');
      await qc.invalidateQueries({ queryKey: ['tokens'] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (t: TokenInfo) => {
    if (!confirm(`Revoke token “${t.name}”? Anything using it will stop working.`)) return;
    await api.delete(`/user/tokens/${t.id}`);
    await qc.invalidateQueries({ queryKey: ['tokens'] });
  };

  return (
    <SettingsLayout>
      <h2 className="border-b border-border pb-2 text-xl font-semibold">Personal access tokens</h2>
      <p className="mt-2 text-sm text-fg-muted">
        Use a token as the password for <code className="rounded bg-neutral-muted px-1">git push</code> over HTTPS, or as a Bearer token for the API.
      </p>
      {created && (
        <Flash tone="success" className="mt-4">
          <div className="mb-1 font-semibold">Copy your new token now — you won’t see it again.</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-canvas px-2 py-1 font-mono text-xs">{created}</code>
            <CopyButton value={created} />
          </div>
        </Flash>
      )}
      <form onSubmit={submit} className="mt-4 max-w-lg space-y-4">
        {error && <Flash tone="danger">{error}</Flash>}
        <FormField label="Token name" required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Laptop git" required />}
        </FormField>
        <FormField label="Expiration">
          {(id) => (
            <Select id={id} value={expires} onChange={(e) => setExpires(e.target.value)} className="w-48">
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="366">1 year</option>
              <option value="never">No expiration</option>
            </Select>
          )}
        </FormField>
        <div className="space-y-2">
          <div className="text-sm font-semibold">Scopes</div>
          {TOKEN_SCOPES.map((s) => (
            <Checkbox
              key={s}
              checked={scopes.includes(s)}
              onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))}
              label={s}
              hint={s === 'repo:read' ? 'Clone and read repositories' : s === 'repo:write' ? 'Push, open and merge pull requests' : 'Manage repository settings and organizations'}
            />
          ))}
        </div>
        <Button type="submit" variant="primary" loading={busy} disabled={!scopes.length}>
          Generate token
        </Button>
      </form>
      <Box className="mt-8">
        <BoxHeader>
          <span className="text-sm font-semibold">Active tokens</span>
        </BoxHeader>
        {tokens.data?.length === 0 && <div className="p-4 text-sm text-fg-muted">No tokens.</div>}
        {tokens.data?.map((t) => (
          <BoxRow key={t.id} className="flex items-center gap-3">
            <KeyRound size={16} className="text-fg-muted" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{t.name}</div>
              <div className="text-xs text-fg-muted">
                <code>{t.prefix}…</code> · {t.scopes.map((s) => <Label key={s} className="mr-1">{s}</Label>)}
              </div>
              <div className="text-xs text-fg-subtle">
                {t.lastUsedAt ? <>Last used <RelativeTime date={t.lastUsedAt} /></> : 'Never used'} ·{' '}
                {t.expiresAt ? <>Expires <RelativeTime date={t.expiresAt} /></> : 'No expiration'}
              </div>
            </div>
            <IconButton label="Revoke" icon={<Trash2 size={14} />} variant="danger" size="sm" onClick={() => void revoke(t)} />
          </BoxRow>
        ))}
      </Box>
    </SettingsLayout>
  );
}
