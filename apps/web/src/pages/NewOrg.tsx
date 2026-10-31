import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Flash, FormField, Input, PageSpinner } from '@pcbhub/ui';
import { PageContainer } from '../components/common';
import { api, errorMessage } from '../lib/api';
import { keys, useMe } from '../lib/queries';

export function NewOrgPage() {
  const { data: me, isLoading } = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ slug: '', name: '', description: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (isLoading) return <PageSpinner />;
  if (!me) return <Navigate to="/login" search={{ redirect: '/organizations/new' }} />;

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
      <h1 className="border-b border-border pb-4 text-2xl font-semibold">Create an organization</h1>
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
