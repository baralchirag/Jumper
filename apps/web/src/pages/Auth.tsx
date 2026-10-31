import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CurrentUser } from '@pcbhub/shared';
import { Box, Button, Flash, FormField, Input } from '@pcbhub/ui';
import { Logo } from '../components/AppShell';
import { api, errorMessage } from '../lib/api';
import { keys } from '../lib/queries';

function useProviders() {
  return useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ github: boolean; signup: boolean }>('/auth/providers'), staleTime: Infinity });
}

function GithubButton() {
  return (
    <a href="/api/auth/github" className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-canvas-subtle text-sm font-medium hover:bg-canvas-inset">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
      Continue with GitHub
    </a>
  );
}

function AuthFrame({ title, children, footer }: { title: string; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-sm px-4 py-12">
      <div className="mb-6 flex flex-col items-center gap-3">
        <Logo className="h-12 w-12 text-fg" />
        <h1 className="text-2xl font-light">{title}</h1>
      </div>
      <Box className="p-5">{children}</Box>
      <Box className="mt-4 p-4 text-center text-sm">{footer}</Box>
    </div>
  );
}

export function LoginPage() {
  const search = useSearch({ strict: false }) as { redirect?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const providers = useProviders();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api.post<CurrentUser>('/auth/login', { login, password });
      qc.setQueryData(keys.me, me);
      const to = search.redirect && search.redirect.startsWith('/') && !search.redirect.startsWith('//') ? search.redirect : '/';
      void navigate({ to });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      title="Sign in to PCBHub"
      footer={
        <>
          New here?{' '}
          <Link to="/signup" className="link">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Flash tone="danger">{error}</Flash>}
        <FormField label="Username or email">{(id) => <Input id={id} autoFocus autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required />}</FormField>
        <FormField label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</FormField>
        <Button type="submit" variant="primary" block loading={busy}>
          Sign in
        </Button>
        {providers.data?.github && (
          <>
            <div className="text-center text-xs text-fg-subtle">or</div>
            <GithubButton />
          </>
        )}
      </form>
    </AuthFrame>
  );
}

export function SignupPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const providers = useProviders();
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api.post<CurrentUser>('/auth/register', form);
      qc.setQueryData(keys.me, me);
      void navigate({ to: '/' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (providers.data && !providers.data.signup) {
    return (
      <AuthFrame title="Sign-up disabled" footer={<Link to="/login" className="link">Sign in</Link>}>
        <p className="text-sm text-fg-muted">This instance does not allow self-registration. Ask an administrator for an account.</p>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="Create your account"
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="link">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Flash tone="danger">{error}</Flash>}
        <FormField label="Username" hint="Letters, digits and single hyphens.">
          {(id) => <Input id={id} autoFocus autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />}
        </FormField>
        <FormField label="Email">{(id) => <Input id={id} type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />}</FormField>
        <FormField label="Password" hint="At least 10 characters.">
          {(id) => <Input id={id} type="password" autoComplete="new-password" minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />}
        </FormField>
        <Button type="submit" variant="primary" block loading={busy}>
          Create account
        </Button>
        {providers.data?.github && <GithubButton />}
      </form>
    </AuthFrame>
  );
}
