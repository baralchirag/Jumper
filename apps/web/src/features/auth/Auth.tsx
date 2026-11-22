import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { CurrentUser, SsoProvider } from '@jumper/shared';
import { Button, Flash, FormField, Input } from '@jumper/ui';
import revA from '../home/diff/assets/rev-a.webp';
import { Logo } from '../../app/AppShell';
import { ApiError, api, errorMessage } from '../../shared/lib/api';
import { keys, useProviders } from '../../shared/lib/queries';

function GithubButton() {
  return (
    <a
      href="/api/auth/github"
      className="flex h-10 w-full items-center justify-center gap-2 rounded-sm border border-border bg-canvas text-[13px] font-medium no-underline transition-colors hover:border-fg-subtle hover:bg-canvas-subtle"
    >
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
      Continue with GitHub
    </a>
  );
}

function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-[13px] text-fg-subtle" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      or
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Split page: a real board on the left (the landing's RoyalBlue54L render), the form on the right. */
export function AuthFrame({ title, children, footer }: { title: string; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="grid min-h-[calc(100svh-52px)] lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <aside className="relative hidden flex-col justify-between border-r border-border bg-canvas p-12 lg:flex">
        <p className="max-w-md font-title text-[clamp(2rem,1.2rem+1.8vw,3rem)] font-medium leading-[1.02] tracking-[-0.035em]">
          See what changed, on the board.
        </p>
        <img src={revA} alt="" className="mx-auto w-full max-w-[560px]" draggable={false} />
        <p className="text-sm text-fg-muted">RoyalBlue54L Feather by Lord's Boards · CERN-OHL-P-2.0</p>
      </aside>
      <div className="flex items-center justify-center px-4 py-14">
        <div className="page-enter w-full max-w-[380px]">
          <Logo className="mb-8 h-10 w-10 text-fg" />
          <h1 className="headline mb-8 text-[length:var(--t-l)]">{title}</h1>
          {children}
          <div className="mt-8 border-t border-border pt-5 text-[13px] text-fg-muted">{footer}</div>
        </div>
      </div>
    </div>
  );
}

const safeRedirect = (r: string | undefined) => (r && r.startsWith('/') && !r.startsWith('//') ? r : '/');

function SsoButton({ p, to, email }: { p: SsoProvider; to: string; email?: string }) {
  const href = `${p.url}?to=${encodeURIComponent(to)}${email ? `&email=${encodeURIComponent(email)}` : ''}`;
  return (
    <a href={href} className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-canvas text-sm font-medium transition-colors hover:bg-canvas-subtle">
      Continue with {p.name}
    </a>
  );
}

export function LoginPage() {
  const search = useSearch({ strict: false }) as { redirect?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const providers = useProviders();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [orgSso, setOrgSso] = useState<SsoProvider | null>(null);
  const to = safeRedirect(search.redirect);
  const sso = providers.data?.sso ?? [];

  // Someone typing a work address whose domain an organization claims is offered that organization's sign-in.
  useEffect(() => {
    const email = login.trim();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
      setOrgSso(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .get<{ provider: SsoProvider | null }>('/auth/sso/discover', { email })
        .then((r) => setOrgSso(r.provider))
        .catch(() => setOrgSso(null));
    }, 400);
    return () => clearTimeout(t);
  }, [login]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api.post<CurrentUser>('/auth/login', { login, password, code: needCode ? code : undefined });
      qc.setQueryData(keys.me, me);
      void navigate({ href: to });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'two_factor_required') {
        setNeedCode(true);
      } else {
        setError(errorMessage(err));
        if (err instanceof ApiError && err.code === 'two_factor_invalid') setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  if (needCode) {
    return (
      <AuthFrame title="Two-factor login" footer={<button type="button" className="link" onClick={() => (setNeedCode(false), setCode(''), setError(null))}>Use a different account</button>}>
        <form onSubmit={submit} className="space-y-4">
          {error && <Flash tone="danger">{error}</Flash>}
          <FormField label="Code" hint="The six-digit code from your authenticator app, or one of your recovery codes.">
            {(id) => <Input id={id} autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" required />}
          </FormField>
          <Button type="submit" variant="primary" block loading={busy} className="h-10">
            Verify
          </Button>
        </form>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="Sign in to Jumper"
      footer={
        <>
          New here?{' '}
          <Link to="/signup" search={{ redirect: search.redirect }} className="link">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Flash tone="danger">{error}</Flash>}
        <FormField label="Username or email">{(id) => <Input id={id} autoFocus autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required />}</FormField>
        {orgSso && (
          <div className="rounded-md border border-accent-muted bg-accent-subtle/40 p-3 text-[13px]">
            <p className="mb-2 text-fg-muted">Your organization signs in through {orgSso.name}.</p>
            <SsoButton p={orgSso} to={to} email={login.trim()} />
          </div>
        )}
        <FormField label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</FormField>
        <p className="text-right text-[13px]">
          <Link to="/forgot" className="link">
            Forgot your password?
          </Link>
        </p>
        <Button type="submit" variant="primary" block loading={busy} className="h-10">
          Sign in
        </Button>
        {(providers.data?.github || sso.length > 0) && <OrDivider />}
        <div className="space-y-2">
          {providers.data?.github && <GithubButton />}
          {sso.map((p) => <SsoButton key={p.id} p={p} to={to} />)}
        </div>
      </form>
    </AuthFrame>
  );
}

export function SignupPage() {
  const { ref, redirect } = useSearch({ strict: false }) as { ref?: string; redirect?: string };
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
      const me = await api.post<CurrentUser>('/auth/register', { ...form, ref });
      qc.setQueryData(keys.me, me);
      void navigate({ href: safeRedirect(redirect) });
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
      title={ref ? `Join ${ref} on Jumper` : 'Create your account'}
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" search={{ redirect }} className="link">
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
        <Button type="submit" variant="primary" block loading={busy} className="h-10">
          Create account
        </Button>
        <p className="text-center text-xs leading-relaxed text-fg-muted">
          By creating an account you agree to the{' '}
          <Link to="/terms" className="link">
            terms of service
          </Link>{' '}
          and{' '}
          <Link to="/privacy" className="link">
            privacy policy
          </Link>
          .
        </p>
        {providers.data?.github && (
          <>
            <OrDivider />
            <GithubButton />
          </>
        )}
      </form>
    </AuthFrame>
  );
}
