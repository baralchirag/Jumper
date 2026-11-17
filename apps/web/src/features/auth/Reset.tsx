import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Flash, FormField, Input, PageSpinner } from '@jumper/ui';
import { api, errorMessage } from '../../shared/lib/api';
import { AuthFrame } from './Auth';

const backToSignIn = (
  <Link to="/login" className="link">
    Back to sign in
  </Link>
);

/** Step 1: ask for a reset link. The answer never reveals whether the account exists. */
export function ForgotPage() {
  const [login, setLogin] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/forgot', { login });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Reset your password" footer={backToSignIn}>
      {sent ? (
        <div className="space-y-4">
          <Flash tone="success">If an account matches, a reset link is on its way. It works once and expires in an hour.</Flash>
          <p className="text-sm text-fg-muted">
            No email? If this is a private instance without a mail server, ask an administrator to generate a link from <span className="font-mono text-xs">Admin → Users</span>.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-fg-muted">Enter your username or email and we’ll send you a link to choose a new password.</p>
          {error && <Flash tone="danger">{error}</Flash>}
          <FormField label="Username or email">{(id) => <Input id={id} autoFocus autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required />}</FormField>
          <Button type="submit" variant="primary" block loading={busy} className="h-10">
            Send reset link
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

/** Step 2: choose a new password from the emailed link. */
export function ResetPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const navigate = useNavigate();
  const check = useQuery({ queryKey: ['reset', token], queryFn: () => api.get<{ username: string }>(`/auth/reset/${token}`), retry: false });
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = again.length > 0 && again !== password;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reset', { token, password });
      void navigate({ to: '/login' });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Choose a new password" footer={backToSignIn}>
      {check.isLoading && <PageSpinner />}
      {check.error && (
        <div className="space-y-4">
          <Flash tone="danger">This reset link is invalid or has expired.</Flash>
          <Link to="/forgot" className="link text-sm">
            Request a new link
          </Link>
        </div>
      )}
      {check.data && (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-fg-muted">
            Setting a new password for <b className="text-fg">{check.data.username}</b>. This signs you out everywhere else.
          </p>
          {error && <Flash tone="danger">{error}</Flash>}
          <FormField label="New password" hint="At least 10 characters.">
            {(id) => <Input id={id} type="password" autoComplete="new-password" minLength={10} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />}
          </FormField>
          <FormField label="Repeat it" error={mismatch ? 'The passwords do not match' : null}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} invalid={mismatch} required />}
          </FormField>
          <Button type="submit" variant="primary" block loading={busy} disabled={mismatch || password.length < 10} className="h-10">
            Set password
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}
