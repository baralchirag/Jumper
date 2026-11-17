import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircuitBoard, Cpu, Download, FilePlus2, Globe, Lock } from 'lucide-react';
import type { RepoInfo, RepoTemplateInfo } from '@jumper/shared';
import { Button, Checkbox, Flash, FormField, Input, PageSpinner, Select, cx } from '@jumper/ui';
import { PageContainer } from '../../shared/components/common';
import { api, errorMessage } from '../../shared/lib/api';
import { useMe } from '../../shared/lib/queries';

type Start = 'empty' | 'sample' | 'template' | 'import';

const STARTS: { id: Start; title: string; hint: string; icon: React.ReactNode }[] = [
  { id: 'empty', title: 'Empty repository', hint: 'Push your own project from your computer.', icon: <FilePlus2 size={18} /> },
  { id: 'sample', title: 'Example board', hint: 'A small complete KiCad project to explore.', icon: <CircuitBoard size={18} /> },
  { id: 'template', title: 'Starter template', hint: 'A microcontroller board ready to lay out.', icon: <Cpu size={18} /> },
  { id: 'import', title: 'Import from a URL', hint: 'Copy an existing git repository, history and all.', icon: <Download size={18} /> },
];

/** "https://github.com/acme/power-board.git" -> "power-board" (a suggestion; the field stays editable). */
const nameFromUrl = (url: string) => {
  try {
    return (new URL(url).pathname.split('/').filter(Boolean).pop() ?? '').replace(/\.git$/i, '').replace(/[^A-Za-z0-9._-]/g, '-');
  } catch {
    return '';
  }
};

export function NewRepoPage() {
  const { data: me, isLoading } = useMe();
  const search = useSearch({ strict: false }) as { owner?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [start, setStart] = useState<Start>('empty');
  const [owner, setOwner] = useState(search.owner ?? '');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [initReadme, setInitReadme] = useState(false);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [mirror, setMirror] = useState<'none' | 'pull' | 'two-way'>('none');
  const [template, setTemplate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.get<RepoTemplateInfo[]>('/templates'), staleTime: Infinity });

  if (isLoading) return <PageSpinner />;
  if (!me) return <Navigate to="/login" search={{ redirect: '/new' }} />;

  const owners = [me.username, ...me.orgs.map((o) => o.slug)];
  const importing = start === 'import';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const who = owner || me.username;
      const repo = importing
        ? await api.post<RepoInfo>('/repos/import', { url, owner: who, name: name || undefined, description, visibility, username: username || undefined, token: token || undefined, mirror })
        : start === 'template'
          ? await api.post<RepoInfo>('/repos', { owner: who, name, description, visibility, template: template || templates.data?.[0]?.id })
          : await api.post<RepoInfo>('/repos', { owner: who, name, description, visibility, initReadme: start === 'empty' ? initReadme : true, sample: start === 'sample' });
      await qc.invalidateQueries({ queryKey: ['repos'] });
      void navigate({ to: '/$owner/$repo', params: { owner: repo.owner, repo: repo.name } });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <PageContainer className="max-w-2xl py-10">
      <h1 className="headline text-[length:var(--t-l)]">Create a new repository</h1>
      <p className="mt-3 border-b border-border pb-6 text-[15px] text-fg-muted">A repository holds your KiCad project files and their full revision history.</p>
      <form onSubmit={submit} className="space-y-6 pt-6">
        {error && <Flash tone="danger">{error}</Flash>}

        <fieldset>
          <legend className="mb-2 text-sm font-medium">Start from</legend>
          <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
            {STARTS.filter((s) => s.id !== 'template' || templates.data?.length).map((s) => (
              <label key={s.id} className={cx('flex cursor-pointer flex-col gap-1 rounded-lg border p-3.5 transition-colors', start === s.id ? 'border-select bg-accent-subtle' : 'border-border hover:border-fg-subtle')}>
                <input type="radio" name="start" className="sr-only" checked={start === s.id} onChange={() => setStart(s.id)} />
                <span className={cx('flex items-center gap-2 font-medium', start === s.id && 'text-accent')}>
                  {s.icon} {s.title}
                </span>
                <span className="text-[13px] leading-snug text-fg-muted">{s.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {start === 'template' && templates.data && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Template</legend>
            <div role="radiogroup" className="divide-y divide-border-muted rounded-lg border border-border">
              {templates.data.map((t) => {
                const on = (template || templates.data[0]?.id) === t.id;
                return (
                  <label key={t.id} className={cx('flex cursor-pointer gap-3 p-3.5', on && 'bg-canvas-subtle')}>
                    <input type="radio" name="template" checked={on} onChange={() => setTemplate(t.id)} className="mt-1" />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{t.name}</span>
                        <span className="font-mono text-xs text-fg-muted">{t.part}</span>
                      </span>
                      <span className="mt-0.5 block text-[13px] text-fg-muted">{t.description}</span>
                      <span className="mt-1.5 block text-xs text-fg-subtle">{t.includes.join(' · ')}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-fg-muted">Schematic and board use KiCad's own symbols and footprints. The parts are placed and connected but not routed, so check every value before ordering.</p>
          </fieldset>
        )}

        {importing && (
          <div className="space-y-4 rounded-lg border border-border bg-canvas-subtle p-4">
            <FormField label="Repository URL" required hint="The https:// address you would use with git clone. All branches and tags are copied.">
              {(id) => (
                <Input
                  id={id}
                  type="url"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    if (!nameTouched) setName(nameFromUrl(e.target.value));
                  }}
                  placeholder="https://github.com/acme/power-board.git"
                  required
                  autoFocus
                />
              )}
            </FormField>
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">This repository is private</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <FormField label="Username">{(id) => <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />}</FormField>
                <FormField label="Access token" hint={mirror === 'none' ? 'Used once for this import. Never stored.' : 'Stored encrypted so the mirror can keep syncing. Use a token that can only reach this repository.'}>
                  {(id) => <Input id={id} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />}
                </FormField>
              </div>
            </details>
            <FormField label="After importing" hint="Mirroring works with GitHub, GitLab, Gitea or any host that serves git over HTTPS. You can change it later under Settings → Mirroring.">
              {(id) => (
                <Select id={id} value={mirror} onChange={(e) => setMirror(e.target.value as typeof mirror)} className="sm:w-96">
                  <option value="none">Keep a one-time copy</option>
                  <option value="pull">Keep pulling new commits from the original</option>
                  <option value="two-way">Two-way: pull new commits and push changes made here back</option>
                </Select>
              )}
            </FormField>
            {mirror === 'two-way' && !token && <p className="text-xs text-fg-muted">Pushing back needs an access token with write access to the original repository.</p>}
          </div>
        )}

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
          <span className="pb-2 text-xl text-fg-muted">/</span>
          <FormField label="Repository name" required={!importing} className="flex-1">
            {(id) => (
              <Input
                id={id}
                autoFocus={!importing}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                placeholder={importing ? 'Taken from the URL' : 'power-supply-v2'}
                required={!importing}
                pattern="[A-Za-z0-9._\-]+"
                title="Letters, digits, '.', '_' and '-'"
              />
            )}
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
        {start === 'empty' && (
          <Checkbox checked={initReadme} onChange={(e) => setInitReadme(e.target.checked)} label="Initialize with README, KiCad .gitignore and .jumper.yml" hint="Leave unticked if you are about to push an existing project, so the first push does not conflict." />
        )}
        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" variant="primary" loading={busy}>
            {importing ? 'Import repository' : 'Create repository'}
          </Button>
          {importing && busy && <span className="text-sm text-fg-muted">Copying the repository. Large ones can take a few minutes; please keep this page open.</span>}
        </div>
      </form>
    </PageContainer>
  );
}
