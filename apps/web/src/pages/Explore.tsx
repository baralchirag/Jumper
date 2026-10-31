import { useState, type FormEvent } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { RepoInfo } from '@pcbhub/shared';
import { Button, Input, PageSpinner } from '@pcbhub/ui';
import { RepoList } from '../components/RepoList';
import { PageContainer } from '../components/common';
import { api } from '../lib/api';

export function ExplorePage() {
  const { q = '' } = useSearch({ strict: false }) as { q?: string };
  const navigate = useNavigate();
  const [value, setValue] = useState(q);
  const { data, isLoading } = useQuery({ queryKey: ['repos', 'explore', q], queryFn: () => api.get<RepoInfo[]>('/repos', { q }) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void navigate({ to: '/explore', search: { q: value } });
  };
  return (
    <PageContainer className="max-w-4xl py-8">
      <h1 className="mb-4 text-2xl font-semibold">Explore</h1>
      <form onSubmit={submit} className="mb-4 flex gap-2">
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Search public repositories…" />
        <Button type="submit">Search</Button>
      </form>
      {isLoading ? <PageSpinner /> : <RepoList repos={data ?? []} empty={q ? `No repositories match “${q}”.` : 'No public repositories yet.'} />}
    </PageContainer>
  );
}
