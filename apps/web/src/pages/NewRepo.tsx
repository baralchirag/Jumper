import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Globe, Lock } from 'lucide-react';
import type { RepoInfo } from '@pcbhub/shared';
import { Button, Checkbox, Flash, FormField, Input, PageSpinner, Select, cx } from '@pcbhub/ui';
import { PageContainer } from '../components/common';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/queries';

export function NewRepoPage() {
  const { data: me, isLoading } = useMe();
  const search = useSearch({ strict: false }) as { owner?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [owner, setOwner] = useState(search.owner ?? '');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [initReadme, setInitReadme] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isLoading) return <PageSpinner />;
  if (!me) return <Navigate to="/login" search={{ redirect: '/new' }} />;

  const owners = [me.username, ...me.orgs.map((o) => o.slug)];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const repo = await api.post<RepoInfo>('/repos', { owner: owner || me.username, name, description, visibility, initReadme });
      await qc.invalidateQueries({ queryKey: ['repos'] });
      void navigate({ to: '/$owner/$repo', params: { owner: repo.owner, repo: repo.name } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer className="max-w-2xl py-10">
      <h1 className="text-2xl font-semibold">Create a new repository</h1>
      <p className="mt-1 border-b border-border pb-4 text-sm text-fg-muted">A repository holds your KiCad project files and their full revision history.</p>
      <form onSubmit={submit} className="space-y-5 pt-5">
        {error && <Flash tone="danger">{error}</Flash>}
        <div className="flex items-end gap-2">
          <FormField label="Owner" required className="w-48">
            {(id) => (
              <Select id={id} value={owner || me.username} onChange={(e) => setOwner(e.target.value)}>
                {owners.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            )}
          </FormField>
          <span className="pb-1.5 text-xl text-fg-muted">/</span>
          <FormField label="Repository name" required className="flex-1">
            {(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="power-supply-v2" required pattern="[A-Za-z0-9._\-]+" title="Letters, digits, '.', '_' and '-'" />}
          </FormField>
        </div>
        <FormField label="Description" hint="Optional">
          {(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={350} />}
        </FormField>
        <fieldset className="space-y-2 border-y border-border py-4">
          {(['public', 'private'] as const).map((v) => (
            <label key={v} className={cx('flex cursor-pointer gap-3 rounded-md p-2', visibility === v && 'bg-canvas-subtle')}>
              <input type="radio" name="visibility" checked={visibility === v} onChange={() => setVisibility(v)} className="mt-1" />
              {v === 'public' ? <Globe size={20} className="mt-0.5 text-fg-muted" /> : <Lock size={20} className="mt-0.5 text-fg-muted" />}
              <span>
                <span className="block font-semibold capitalize">{v}</span>
                <span className="text-sm text-fg-muted">{v === 'public' ? 'Anyone can see this repository.' : 'Only you and people you grant access can see it.'}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Checkbox
          checked={initReadme}
          onChange={(e) => setInitReadme(e.target.checked)}
          label="Initialize with README, KiCad .gitignore and .pcbhub.yml"
          hint="Lets you clone the repository immediately."
        />
        <Button type="submit" variant="primary" loading={busy}>
          Create repository
        </Button>
      </form>
    </PageContainer>
  );
}
