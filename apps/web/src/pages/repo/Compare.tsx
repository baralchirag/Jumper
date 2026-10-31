import { useState, type FormEvent } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import type { CompareResponse, PullInfo } from '@pcbhub/shared';
import { Box, Button, Flash, FormField, Input, PageSpinner, Textarea } from '@pcbhub/ui';
import { FilesChanged } from '../../components/FilesChanged';
import { RefPicker } from '../../components/RefPicker';
import { shortSha } from '../../components/common';
import { api, errorMessage, repoPath } from '../../lib/api';
import { keys } from '../../lib/queries';
import { canWrite, useRepoInfo } from './context';

export function ComparePage() {
  const info = useRepoInfo();
  const search = useSearch({ strict: false }) as { base?: string; head?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const base = search.base ?? info.defaultBranch;
  const head = search.head ?? '';
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cmp = useQuery({
    queryKey: [...keys.repo(info.owner, info.name), 'compare', base, head],
    queryFn: () => api.get<CompareResponse>(repoPath(info.owner, info.name, '/compare'), { base, head }),
    enabled: Boolean(head && head !== base),
  });

  const set = (patch: { base?: string; head?: string }) => void navigate({ to: '.', search: { base, head, ...patch }, replace: true });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const pr = await api.post<PullInfo>(repoPath(info.owner, info.name, '/pulls'), { base, head, title: title || cmp.data?.commits.at(-1)?.subject || head, body });
      await qc.invalidateQueries({ queryKey: keys.repo(info.owner, info.name) });
      void navigate({ to: '/$owner/$repo/pull/$number', params: { owner: info.owner, repo: info.name, number: String(pr.number) }, search: {} });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Compare changes</h1>
        <p className="text-sm text-fg-muted">Choose two branches to see what changed, then open a pull request.</p>
      </div>
      <Box className="flex flex-wrap items-center gap-2 bg-canvas-subtle p-3">
        <RefPicker owner={info.owner} repo={info.name} value={base} label="base" onChange={(r) => set({ base: r })} />
        <ArrowLeft size={16} className="text-fg-muted" />
        <RefPicker owner={info.owner} repo={info.name} value={head || 'select branch'} label="compare" onChange={(r) => set({ head: r })} />
      </Box>
      {!head && <div className="py-10 text-center text-fg-muted">Select a branch to compare against {base}.</div>}
      {head === base && head && <Flash>Choose different branches.</Flash>}
      {cmp.isLoading && <PageSpinner />}
      {cmp.error && <Flash tone="danger">{errorMessage(cmp.error)}</Flash>}
      {cmp.data && (
        <>
          {cmp.data.commits.length === 0 ? (
            <Flash>There isn’t anything to compare: {head} has no commits that aren’t in {base}.</Flash>
          ) : (
            canWrite(info) && (
              <Box className="p-4">
                <form onSubmit={submit} className="space-y-3">
                  {error && <Flash tone="danger">{error}</Flash>}
                  <FormField label="Title">{(id) => <Input id={id} value={title} placeholder={cmp.data!.commits.at(-1)?.subject} onChange={(e) => setTitle(e.target.value)} />}</FormField>
                  <FormField label="Description" hint="Markdown supported. Describe what changed on the board and why.">
                    {(id) => <Textarea id={id} rows={6} value={body} onChange={(e) => setBody(e.target.value)} />}
                  </FormField>
                  <Button type="submit" variant="primary" loading={busy}>
                    Create pull request
                  </Button>
                </form>
              </Box>
            )
          )}
          <div className="text-sm text-fg-muted">
            {cmp.data.commits.length} commit{cmp.data.commits.length === 1 ? '' : 's'} · merge base <span className="font-mono">{shortSha(cmp.data.mergeBase)}</span>
          </div>
          <FilesChanged owner={info.owner} repo={info.name} files={cmp.data.files} baseSha={cmp.data.mergeBase} headSha={cmp.data.headSha} />
        </>
      )}
    </div>
  );
}
