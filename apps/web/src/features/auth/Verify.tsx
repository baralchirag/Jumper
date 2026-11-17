import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Flash, PageSpinner } from '@jumper/ui';
import { api, errorMessage } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';
import { AuthFrame } from './Auth';

/** Landing page of the confirmation email: shows the address, then confirms it. */
export function VerifyPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const qc = useQueryClient();
  const peek = useQuery({ queryKey: ['verify', token], queryFn: () => api.get<{ email: string }>(`/auth/verify/${token}`), retry: false });
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  // The link itself is the proof, so confirm as soon as the page opens (a POST: link previewers never trigger it).
  useEffect(() => {
    if (!peek.data || started.current) return;
    started.current = true;
    setState('busy');
    api
      .post('/auth/verify', { token })
      .then(() => {
        setState('done');
        void qc.invalidateQueries({ queryKey: keys.me });
      })
      .catch((e) => {
        setError(errorMessage(e));
        setState('error');
      });
  }, [peek.data, token, qc]);

  return (
    <AuthFrame title="Confirm your email" footer={<Link to="/" className="link">Go to Jumper</Link>}>
      {peek.isLoading && <PageSpinner />}
      {peek.error && <Flash tone="danger">This confirmation link is invalid or has expired. Sign in and use “Resend” in the banner at the top of the page.</Flash>}
      {state === 'busy' && <PageSpinner label="Confirming…" />}
      {state === 'done' && <Flash tone="success">{peek.data?.email} is confirmed. You can now create repositories and push.</Flash>}
      {state === 'error' && <Flash tone="danger">{error}</Flash>}
    </AuthFrame>
  );
}
