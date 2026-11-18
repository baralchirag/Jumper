import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Download, FileArchive, FileBox, FileSpreadsheet, FileText, Package, Paperclip, RefreshCw, Tag, Trash2 } from 'lucide-react';
import { GENERATED_ASSET_KINDS, type ReleaseAssetInfo, type ReleaseAssetKind, type ReleaseInfo } from '@jumper/shared';
import { Box, BoxHeader, Button, Checkbox, EmptyState, Flash, FormField, IconButton, Input, Label, PageSpinner, RelativeTime, Textarea, buttonClass } from '@jumper/ui';
import { Markdown } from '../../shared/components/Markdown';
import { ErrorView, NotFound, UserLink, formatBytes, shortSha } from '../../shared/components/common';
import { api, errorMessage, repoPath, uploadFile } from '../../shared/lib/api';
import { keys, useBranches } from '../../shared/lib/queries';
import { canWrite, useRepoInfo } from '../repo/context';
import { FabOrderLink, isOrderableFab } from '../checks/FabOrder';

const KIND_LABEL: Record<ReleaseAssetKind, string> = {
  gerbers: 'Gerbers and drill files',
  drill: 'Drill files',
  bom: 'Bill of materials',
  step: '3D model (STEP)',
  pdf: 'PDF',
  positions: 'Pick-and-place',
  jlcpcb: 'JLCPCB order package',
  pcbway: 'PCBWay order package',
  oshpark: 'OSH Park order package',
  upload: 'Attached file',
};

const GENERATED_HELP: Record<(typeof GENERATED_ASSET_KINDS)[number], string> = {
  gerbers: 'Gerbers and Excellon drill files, zipped',
  jlcpcb: 'Gerbers, BOM and CPL in JLCPCB’s layout, ready to upload',
  pcbway: 'Gerbers, BOM and centroid file in PCBWay’s layout, ready to upload',
  oshpark: 'Gerbers and drill files named the way OSH Park expects',
  bom: 'CSV with every part and field',
  step: 'For enclosure and mechanical design',
  pdf: 'Schematic and board drawings',
  positions: 'Component placement for assembly',
};

function kindIcon(kind: ReleaseAssetKind) {
  if (kind === 'gerbers' || kind === 'jlcpcb' || kind === 'pcbway' || kind === 'oshpark' || kind === 'drill') return <FileArchive size={16} />;
  if (kind === 'bom' || kind === 'positions') return <FileSpreadsheet size={16} />;
  if (kind === 'step') return <FileBox size={16} />;
  if (kind === 'pdf') return <FileText size={16} />;
  return <Paperclip size={16} />;
}

function AssetRow({ a, release, editable }: { a: ReleaseAssetInfo; release: ReleaseInfo; editable: boolean }) {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.delete(repoPath(info.owner, info.name, `/releases/${release.id}/assets/${a.id}`)),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...keys.repo(info.owner, info.name), 'releases'] }),
  });
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 text-sm">
      <span className="shrink-0 text-fg-muted" aria-hidden>{kindIcon(a.kind)}</span>
      <a href={a.url} className="min-w-0 flex-1 truncate font-medium hover:text-accent" download>
        {a.name}
      </a>
      {isOrderableFab(a.kind) ? <FabOrderLink fab={a.kind} className="hidden sm:inline-flex" /> : <span className="hidden text-xs text-fg-muted sm:inline">{KIND_LABEL[a.kind]}</span>}
      <span className="w-20 text-right font-mono text-xs tabular-nums text-fg-muted">{formatBytes(a.size)}</span>
      <span className="hidden w-16 text-right text-xs tabular-nums text-fg-muted sm:inline" title="Downloads">
        <Download size={11} className="mr-0.5 inline" aria-hidden />
        {a.downloadCount}
      </span>
      {editable && <IconButton label={`Remove ${a.name}`} size="sm" icon={<Trash2 size={14} />} onClick={() => del.mutate()} />}
    </li>
  );
}

function ApprovalBox({ r, onChange }: { r: ReleaseInfo; onChange: () => void }) {
  const info = useRepoInfo();
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const sign = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') => api.post(repoPath(info.owner, info.name, `/releases/${r.id}/signoff`), { decision, comment }),
    onSuccess: () => {
      setComment('');
      setError(null);
      onChange();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const a = r.approval;
  if (!a) return null;
  const approvals = new Set(a.decisions.filter((d) => d.decision === 'approved' && d.sha === r.sha).map((d) => d.user.id)).size;
  return (
    <div className="border-t border-border px-4 py-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Release approval</span>
        {a.approved ? <Label tone="success">Approved</Label> : <Label tone="attention">{approvals} of {a.required}</Label>}
        <span className="text-xs text-fg-muted">Approvers: {a.approvers.map((u) => u.username).join(', ') || 'none named'}</span>
      </div>
      {a.decisions.length > 0 && (
        <ul className="mt-2 space-y-1">
          {a.decisions.map((d, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-2 text-xs">
              <UserLink user={d.user} size={14} />
              <span className={d.decision === 'approved' ? 'text-success' : 'text-danger'}>{d.decision}</span>
              {d.sha !== r.sha && <span className="text-fg-subtle">(earlier revision)</span>}
              <RelativeTime date={d.at} className="text-fg-subtle" />
              {d.comment && <span className="text-fg-muted">“{d.comment}”</span>}
            </li>
          ))}
        </ul>
      )}
      {r.draft && a.canSign && (
        <div className="mt-3 flex flex-wrap gap-2">
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment (optional)" aria-label="Sign-off comment" className="h-8 min-w-48 flex-1 rounded-md border border-border bg-canvas px-2 text-[13px]" maxLength={2000} />
          <Button size="sm" variant="primary" loading={sign.isPending && sign.variables === 'approved'} onClick={() => sign.mutate('approved')}>Approve</Button>
          <Button size="sm" variant="danger" loading={sign.isPending && sign.variables === 'rejected'} onClick={() => sign.mutate('rejected')}>Reject</Button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

function ReleaseCard({ r, full }: { r: ReleaseInfo; full?: boolean }) {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const editable = canWrite(info);
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const key = [...keys.repo(info.owner, info.name), 'releases'];
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const upload = useMutation({
    mutationFn: (file: File) => uploadFile(repoPath(info.owner, info.name, `/releases/${r.id}/assets/${encodeURIComponent(file.name)}`), file),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const retry = useMutation({ mutationFn: () => api.post(repoPath(info.owner, info.name, `/releases/${r.id}/refresh`)), onSuccess: refresh });
  const publish = useMutation({ mutationFn: () => api.patch(repoPath(info.owner, info.name, `/releases/${r.id}`), { draft: false }), onSuccess: refresh, onError: (e) => setError(errorMessage(e)) });
  const remove = useMutation({
    mutationFn: (deleteTag: boolean) => api.delete(repoPath(info.owner, info.name, `/releases/${r.id}${deleteTag ? '?deleteTag=true' : ''}`)),
    onSuccess: () => {
      void refresh();
      if (full) void navigate({ to: '/$owner/$repo/releases', params: { owner: info.owner, repo: info.name } });
    },
  });
  const pendingChecks = r.missing.some((m) => /running|not run/.test(m.reason));
  return (
    <article className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)] md:gap-8">
      <aside className="space-y-1.5 text-sm text-fg-muted md:pt-1">
        <div className="flex items-center gap-1.5 font-mono text-fg">
          <Tag size={14} aria-hidden /> {r.tag}
        </div>
        <Link to="/$owner/$repo/commit/$sha" params={{ owner: info.owner, repo: info.name, sha: r.sha }} className="block font-mono text-xs hover:text-accent">
          {shortSha(r.sha)}
        </Link>
        <div className="flex items-center gap-1.5 text-xs">
          <Clock size={12} aria-hidden /> <RelativeTime date={r.publishedAt ?? r.createdAt} />
        </div>
      </aside>
      <Box className="min-w-0">
        <div className="space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="headline text-[length:var(--t-m)]">
              {full ? r.name : (
                <Link to="/$owner/$repo/releases/tag/$" params={{ owner: info.owner, repo: info.name, _splat: r.tag }} className="hover:text-accent">
                  {r.name}
                </Link>
              )}
            </h2>
            {r.latest && <Label tone="success">Latest</Label>}
            {r.prerelease && <Label tone="attention">Pre-release</Label>}
            {r.draft && <Label>Draft</Label>}
          </div>
          {r.author && (
            <div className="text-xs text-fg-muted">
              <UserLink user={r.author} size={16} /> released this
            </div>
          )}
          {r.body.trim() ? <Markdown source={r.body} className="text-sm" /> : full ? <p className="text-sm text-fg-muted">No release notes.</p> : null}
          {error && <Flash tone="danger">{error}</Flash>}
        </div>
        <BoxHeader className="flex items-center gap-2 text-sm">
          <Package size={14} aria-hidden /> Files <span className="text-fg-muted">{r.assets.length}</span>
          <div className="ml-auto flex gap-2">
            {editable && (
              <>
                <input ref={fileInput} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
                <Button size="sm" leadingIcon={<Paperclip size={13} />} loading={upload.isPending} onClick={() => fileInput.current?.click()}>
                  Attach file
                </Button>
              </>
            )}
          </div>
        </BoxHeader>
        {r.assets.length > 0 && <ul className="divide-y divide-border-muted">{r.assets.map((a) => <AssetRow key={a.id} a={a} release={r} editable={editable} />)}</ul>}
        {r.missing.length > 0 && (
          <div className="space-y-1 border-t border-border-muted px-4 py-3 text-xs text-fg-muted">
            {r.missing.map((m) => (
              <p key={m.kind}>
                <span className="font-medium text-fg">{KIND_LABEL[m.kind]}:</span> {m.reason}
              </p>
            ))}
            {pendingChecks && (
              <Button size="sm" variant="invisible" leadingIcon={<RefreshCw size={12} />} loading={retry.isPending} onClick={() => retry.mutate()}>
                Check again
              </Button>
            )}
          </div>
        )}
        {r.assets.length === 0 && r.missing.length === 0 && <p className="px-4 py-3 text-sm text-fg-muted">No files attached.</p>}
        <ApprovalBox r={r} onChange={() => void refresh()} />
        {r.recordDigest && (
          <p className="border-t border-border-muted px-4 py-2 text-xs text-fg-muted" title="A signed record of exactly what was released, chained to the previous release.">
            Signed release record <span className="font-mono">{r.recordDigest.slice(0, 16)}…</span>
          </p>
        )}
        {editable && full && (
          <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
            {r.draft && (
              <Button size="sm" variant="primary" loading={publish.isPending} disabled={Boolean(r.approval && !r.approval.approved)} title={r.approval && !r.approval.approved ? 'Waiting for release approval' : undefined} onClick={() => publish.mutate()}>
                Publish release
              </Button>
            )}
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                if (!confirm(`Delete release ${r.tag} and its files?`)) return;
                remove.mutate(confirm(`Also delete the git tag ${r.tag}? Choose Cancel to keep the tag.`));
              }}
            >
              Delete release
            </Button>
          </div>
        )}
      </Box>
    </article>
  );
}

export function ReleasesPage() {
  const info = useRepoInfo();
  const q = useQuery({ queryKey: [...keys.repo(info.owner, info.name), 'releases'], queryFn: () => api.get<ReleaseInfo[]>(repoPath(info.owner, info.name, '/releases')) });
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="headline text-[length:var(--t-l)]">Releases</h1>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">Each release tags a revision and keeps the exact Gerbers, BOM and 3D model that went to the fab.</p>
        </div>
        {canWrite(info) && !info.isEmpty && (
          <Link to="/$owner/$repo/releases/new" params={{ owner: info.owner, repo: info.name }} className={buttonClass('primary')}>
            New release
          </Link>
        )}
      </div>
      {q.data?.length === 0 ? (
        <EmptyState icon={<Tag size={22} />} title="No releases yet">
          Create one when a revision goes to the fab: <span className="font-mono">rev-A</span>, <span className="font-mono">v1.0</span>. Its fabrication files are attached automatically.
        </EmptyState>
      ) : (
        <div className="space-y-10">{q.data?.map((r) => <ReleaseCard key={r.id} r={r} />)}</div>
      )}
    </div>
  );
}

export function ReleasePage() {
  const info = useRepoInfo();
  const { _splat: tag = '' } = useParams({ strict: false }) as { _splat?: string };
  const q = useQuery({
    queryKey: [...keys.repo(info.owner, info.name), 'releases', 'tag', tag],
    queryFn: () => api.get<ReleaseInfo>(repoPath(info.owner, info.name, `/releases/tags/${tag.split('/').map(encodeURIComponent).join('/')}`)),
  });
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <NotFound />;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link to="/$owner/$repo/releases" params={{ owner: info.owner, repo: info.name }} className="text-sm text-fg-muted hover:text-accent">
        ← All releases
      </Link>
      {q.data && <ReleaseCard r={q.data} full />}
    </div>
  );
}

export function NewReleasePage() {
  const info = useRepoInfo();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const branches = useBranches(info.owner, info.name);
  const [form, setForm] = useState({ tag: '', target: info.defaultBranch, name: '', body: '', prerelease: false });
  const [assets, setAssets] = useState<string[]>([...GENERATED_ASSET_KINDS]);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (draft: boolean) => api.post<ReleaseInfo>(repoPath(info.owner, info.name, '/releases'), { ...form, draft, assets }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: [...keys.repo(info.owner, info.name), 'releases'] });
      void navigate({ to: '/$owner/$repo/releases/tag/$', params: { owner: info.owner, repo: info.name, _splat: r.tag } });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  if (!canWrite(info)) return <NotFound />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(false);
  };
  return (
    <form onSubmit={submit} className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="headline text-[length:var(--t-l)]">New release</h1>
        <p className="mt-1 text-sm text-fg-muted">Tag the revision you are sending to the fab. The files below are copied from its check outputs, so they always match what was tagged.</p>
      </div>
      {error && <Flash tone="danger">{error}</Flash>}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Tag" required hint="An existing tag, or a new one to create, e.g. v1.0 or rev-B.">
          {(id) => <Input id={id} value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} required placeholder="rev-B" className="font-mono" autoFocus />}
        </FormField>
        <FormField label="From branch" hint="Used when the tag is new.">
          {(id) => (
            <select id={id} value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} className="h-10 w-full rounded-md border border-border bg-canvas px-3 text-sm">
              {(branches.data ?? [{ name: info.defaultBranch }]).map((b) => <option key={b.name}>{b.name}</option>)}
            </select>
          )}
        </FormField>
      </div>
      <FormField label="Title" hint="Defaults to the tag.">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Rev B: USB-C and reverse-polarity protection" />}</FormField>
      <FormField label="Release notes" hint="Markdown. What changed since the last revision, known issues, assembly notes.">
        {(id) => <Textarea id={id} rows={8} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />}
      </FormField>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Attach fabrication files</legend>
        {GENERATED_ASSET_KINDS.map((k) => (
          <Checkbox key={k} label={KIND_LABEL[k]} hint={GENERATED_HELP[k]} checked={assets.includes(k)} onChange={(e) => setAssets(e.target.checked ? [...assets, k] : assets.filter((x) => x !== k))} />
        ))}
        <p className="text-xs text-fg-muted">You can attach your own files (assembly drawings, test reports, firmware) after creating the release.</p>
      </fieldset>
      <Checkbox label="This is a pre-release" hint="For prototypes and bring-up boards. Pre-releases are never marked as latest." checked={form.prerelease} onChange={(e) => setForm({ ...form, prerelease: e.target.checked })} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={create.isPending && !create.variables} disabled={!form.tag.trim()}>
          Publish release
        </Button>
        <Button onClick={() => create.mutate(true)} loading={create.isPending && create.variables === true} disabled={!form.tag.trim()}>
          Save draft
        </Button>
      </div>
    </form>
  );
}
