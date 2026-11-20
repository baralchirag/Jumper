import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Flash, FormField, Input, PageSpinner, buttonClass } from '@jumper/ui';
import { PageContainer } from '../../shared/components/common';
import { api, errorMessage } from '../../shared/lib/api';
import { keys, useMe, useSite } from '../../shared/lib/queries';

export function NewOrgPage() {
  const { data: me, isLoading } = useMe();
  const site = useSite();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ slug: '', name: '', description: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (isLoading) return <PageSpinner />;
  if (!me) return <Navigate to="/login" search={{ redirect: '/organizations/new' }} />;
  // On the hosted service organizations come with a paid plan (the API enforces this too).
  if (site.data?.plansEnforced && me.plan === 'free' && !me.isAdmin) {
    return (
      <PageContainer className="max-w-xl py-10">
        <h1 className="border-b border-border pb-6 headline text-[length:var(--t-l)]">Organizations are for teams on a paid plan</h1>
        <p className="mt-5 text-[15px] leading-relaxed text-fg-muted">
          An organization gives your team shared boards, roles, single sign-on and one bill. It comes with Pro for small teams and with Business for companies.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link to="/pricing" search={{ for: 'organization' }} className={buttonClass('accent', 'md')}>
            See team plans
          </Link>
          <Link to="/settings/$section" params={{ section: 'usage' }} className={buttonClass('default', 'md')}>
            Your plan
          </Link>
        </div>
      </PageContainer>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/orgs', form);
      await qc.invalidateQueries({ queryKey: keys.me });
      void navigate({ to: '/$owner', params: { owner: form.slug } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PageContainer className="max-w-xl py-10">
      <h1 className="border-b border-border pb-6 headline text-[length:var(--t-l)]">Create an organization</h1>
      <form onSubmit={submit} className="space-y-4 pt-5">
        {error && <Flash tone="danger">{error}</Flash>}
        <FormField label="Organization handle" required hint="Used in URLs, e.g. /acme-hardware">
          {(id) => <Input id={id} value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} required />}
        </FormField>
        <FormField label="Display name" required>
          {(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />}
        </FormField>
        <FormField label="Description">{(id) => <Input id={id} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</FormField>
        <Button type="submit" variant="primary" loading={busy}>
          Create organization
        </Button>
      </form>
    </PageContainer>
  );
}
