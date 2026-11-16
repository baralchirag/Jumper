import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Trash2 } from 'lucide-react';
import type { ShareLinkInfo } from '@jumper/shared';
import { Box, BoxRow, Button, Checkbox, CopyButton, Flash, FormField, IconButton, Input, Label, RelativeTime, Select } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';
import { useRepoInfo } from '../repo/context';

const EXPIRY = [
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
  { label: '90 days', hours: 24 * 90 },
  { label: 'Never', hours: 0 },
];

export function ShareLinksPanel() {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const key = [...keys.repo(info.owner, info.name), 'share-links'];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<ShareLinkInfo[]>(repoPath(info.owner, info.name, '/share-links')) });
  const [form, setForm] = useState({ label: '', ref: info.defaultBranch, path: '', canDownload: false, watermark: '', hours: 24 * 7 });
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: () =>
      api.post<{ url: string }>(repoPath(info.owner, info.name, '/share-links'), {
        label: form.label,
        ref: form.ref,
        path: form.path.trim() || null,
        canDownload: form.canDownload,
        watermark: form.watermark.trim() || null,
        expiresInHours: form.hours || null,
      }),
    onSuccess: (r) => {
      setCreated(r.url);
      setError(null);
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.delete(repoPath(info.owner, info.name, `/share-links/${id}`)), onSuccess: refresh });
  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-fg-muted">
        A share link gives someone without an account read-only access to a snapshot of this repository — useful for clients and fab houses. Anyone holding the link can open it, so set an expiry and revoke it when it is no longer needed.
      </p>
      {created && (
        <Flash tone="success" action={<CopyButton value={created} label="Copy link" />}>
          Link created (shown once): <code className="break-all font-mono text-xs">{created}</code>
        </Flash>
      )}
      <Box>
        {q.data?.length === 0 && <div className="p-4 text-sm text-fg-muted">No share links yet.</div>}
        {q.data?.map((l) => (
          <BoxRow key={l.id} className="flex items-center gap-3 py-3">
            <Link2 size={16} className={l.active ? 'text-accent' : 'text-fg-subtle'} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{l.label || 'Untitled link'}</span>
                {!l.active && <Label tone="danger">{l.revokedAt ? 'revoked' : 'expired'}</Label>}
                {l.canDownload ? <Label>downloads</Label> : <Label>view-only</Label>}
                {l.watermark && <Label tone="attention">watermark</Label>}
              </div>
              <div className="text-xs text-fg-muted">
                <span className="font-mono">{l.ref}</span>
                {l.path && <> · <span className="font-mono">{l.path}</span></>} · {l.viewCount} view{l.viewCount === 1 ? '' : 's'}
                {l.expiresAt && <> · {l.active ? 'expires' : 'expired'} <RelativeTime date={l.expiresAt} /></>}
                {' · by '}{l.createdBy.username}
              </div>
            </div>
            {l.active && <IconButton label="Revoke link" size="sm" icon={<Trash2 size={14} />} onClick={() => confirm('Revoke this link? It stops working immediately.') && revoke.mutate(l.id)} />}
          </BoxRow>
        ))}
      </Box>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {error && <Flash tone="danger" className="sm:col-span-2">{error}</Flash>}
        <FormField label="Label" hint="Only you see this. e.g. “ACME review”.">{(id) => <Input id={id} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} maxLength={120} />}</FormField>
        <FormField label="Revision" hint="Branch, tag or commit to share." required>{(id) => <Input id={id} value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} className="font-mono" required />}</FormField>
        <FormField label="Limit to folder or file" hint="Leave empty to share the whole repository.">{(id) => <Input id={id} value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder="hardware/rev-b" className="font-mono" />}</FormField>
        <FormField label="Expires">
          {(id) => (
            <Select id={id} value={form.hours} onChange={(e) => setForm({ ...form, hours: Number(e.target.value) })}>
              {EXPIRY.map((x) => (
                <option key={x.hours} value={x.hours}>
                  {x.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Watermark text" hint="Overlaid on the shared view, e.g. “Confidential — ACME”." className="sm:col-span-2">
          {(id) => <Input id={id} value={form.watermark} onChange={(e) => setForm({ ...form, watermark: e.target.value })} maxLength={120} />}
        </FormField>
        <div className="sm:col-span-2">
          <Checkbox label="Allow downloads" hint="Viewers can save the raw files. Off = view-only in the browser." checked={form.canDownload} onChange={(e) => setForm({ ...form, canDownload: e.target.checked })} />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!form.ref}>
            Create link
          </Button>
        </div>
      </form>
    </div>
  );
}
