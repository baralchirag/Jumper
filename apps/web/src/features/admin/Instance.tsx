// Instance administration for enterprise installs: version, licence, legal holds, retention,
// directory provisioning (SCIM) and export clearance. Plus invoices for the hosted plans.
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { DEFAULT_RETENTION, type Entitlements, type Feature, type InvoiceInfo, type InvoiceStatus, type LegalHoldInfo, type LicenseStatus, type RetentionSettings, type ScimTokenInfo, type VersionInfo } from '@jumper/shared';
import { Box, BoxRow, Button, CopyButton, Flash, FormField, IconButton, Input, Label, PageSpinner, RelativeTime, Select, Textarea, cx } from '@jumper/ui';
import { UnavailableNotice } from '../../shared/components/common';
import { api, errorMessage } from '../../shared/lib/api';
import { money } from '../accounts/Governance';

function Section({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-12">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-2">
        <div className="max-w-2xl">
          <h2 className="text-[15px] font-medium">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function useAct() {
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      setMsg(ok ? { tone: 'success', text: ok } : null);
    } catch (e) {
      setMsg({ tone: 'danger', text: errorMessage(e) });
    }
  };
  const view = msg && <p className={cx('mt-2 text-[13px]', msg.tone === 'success' ? 'text-success' : 'text-danger')}>{msg.text}</p>;
  return { run, view };
}

// ─── Version ──────────────────────────────────────────────────────────────

function VersionSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-version'], queryFn: () => api.get<VersionInfo>('/admin/instance/version') });
  const check = useMutation({ mutationFn: () => api.post<VersionInfo>('/admin/instance/version/check'), onSuccess: (d) => qc.setQueryData(['admin-version'], d) });
  if (!q.data) return null;
  const v = q.data;
  return (
    <Section
      title="Version"
      action={v.updateCheck === 'on' && <Button size="sm" leadingIcon={<RefreshCw size={14} />} loading={check.isPending} onClick={() => check.mutate()}>Check for updates</Button>}
    >
      <div className="flex flex-wrap gap-8 text-[13px]">
        <div><p className="text-xs text-fg-muted">Running</p><p className="font-mono text-base">{v.version}</p></div>
        <div><p className="text-xs text-fg-muted">Database</p><p className="font-mono text-base">{v.migrations.applied} / {v.migrations.expected} migrations</p></div>
        <div><p className="text-xs text-fg-muted">Node</p><p className="font-mono text-base">{v.node}</p></div>
        <div>
          <p className="text-xs text-fg-muted">Latest</p>
          <p className="font-mono text-base">{v.latest?.version ?? (v.updateCheck === 'on' ? 'not checked yet' : v.updateCheck === 'air_gapped' ? 'off (air-gapped)' : 'off')}</p>
        </div>
      </div>
      {v.updateAvailable && v.latest && (
        <Flash tone="warning" className="mt-4">
          Jumper {v.latest.version} is available.{v.latest.url && <> <a href={v.latest.url} className="link" target="_blank" rel="noreferrer">Release notes</a>.</>} Back up first, then upgrade.
        </Flash>
      )}
      {v.migrations.applied < v.migrations.expected && <Flash tone="danger" className="mt-4">The database is behind this build. Run the migrations (or start with AUTO_MIGRATE=true).</Flash>}
    </Section>
  );
}

// ─── Licence ──────────────────────────────────────────────────────────────

type LicenseView = LicenseStatus & { source: 'env' | 'file' | 'admin' | null; enforced: boolean; host: string };

function LicenseSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-license'], queryFn: () => api.get<LicenseView>('/admin/instance/license') });
  const ent = useQuery({ queryKey: ['admin-entitlements'], queryFn: () => api.get<Entitlements & { labels: Record<Feature, string>; plansEnforced: boolean }>('/admin/instance/entitlements') });
  const [key, setKey] = useState('');
  const { run, view } = useAct();
  if (!q.data) return null;
  const l = q.data;
  const tone = l.state === 'valid' ? 'success' : l.state === 'grace' ? 'attention' : l.state === 'missing' ? 'default' : 'danger';
  const refresh = (d: LicenseView) => {
    qc.setQueryData(['admin-license'], d);
    void qc.invalidateQueries({ queryKey: ['admin-entitlements'] });
  };
  return (
    <Section title="Licence" description={ent.data?.plansEnforced ? 'This instance enforces hosted plans: features follow each owner\'s plan, and the licence is not used.' : 'Business and Enterprise features on this instance come from the licence.'} action={<Label tone={tone}>{l.state.replace('_', ' ')}</Label>}>
      <p className="text-[13px]">{l.message}</p>
      {l.license && (
        <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-y-1 text-[13px]">
          <dt className="text-fg-muted">Licensee</dt><dd>{l.license.licensee}</dd>
          <dt className="text-fg-muted">Tier</dt><dd className="capitalize">{l.license.tier}</dd>
          <dt className="text-fg-muted">Domain</dt><dd className="font-mono">{l.license.domain} <span className="text-fg-subtle">(serving {l.host})</span></dd>
          <dt className="text-fg-muted">Accounts</dt><dd>{l.seatsUsed} of {l.license.seats}</dd>
          <dt className="text-fg-muted">Expires</dt><dd>{l.license.expires}{l.daysLeft !== null && <span className="text-fg-subtle"> ({l.daysLeft >= 0 ? `${l.daysLeft} days left` : `${-l.daysLeft} days ago`})</span>}</dd>
          <dt className="text-fg-muted">Licence id</dt><dd className="font-mono text-xs">{l.license.id}</dd>
        </dl>
      )}
      {ent.data && (
        <div className="mt-4">
          <p className="mb-2 text-xs text-fg-muted">Features available {ent.data.source === 'development' ? '(development instance: everything is unlocked)' : ''}</p>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(ent.data.labels) as Feature[]).map((f) => (
              <Label key={f} tone={ent.data.features.includes(f) ? 'success' : 'default'} className={cx(!ent.data.features.includes(f) && 'opacity-60')}>{ent.data.labels[f]}</Label>
            ))}
          </div>
        </div>
      )}
      {l.source === 'env' || l.source === 'file' ? (
        <p className="mt-4 text-xs text-fg-muted">Set on the server by {l.source === 'env' ? 'LICENSE_KEY' : 'LICENSE_FILE'}. Change it there.</p>
      ) : (
        <form
          className="mt-4 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              refresh(await api.put<LicenseView>('/admin/instance/license', { key }));
              setKey('');
            }, 'Licence installed.');
          }}
        >
          <Textarea rows={3} value={key} onChange={(e) => setKey(e.target.value)} placeholder="JMP1…" aria-label="Licence key" className="font-mono text-xs" />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={key.trim().length < 10}>{l.license ? 'Replace licence' : 'Install licence'}</Button>
            {l.source === 'admin' && <Button variant="danger" onClick={() => confirm('Remove the licence? Business and Enterprise features stop working.') && void run(async () => refresh(await api.delete<LicenseView>('/admin/instance/license')))}>Remove</Button>}
          </div>
        </form>
      )}
      {view}
    </Section>
  );
}

// ─── Legal holds ──────────────────────────────────────────────────────────

function LegalHoldSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-holds'], queryFn: () => api.get<LegalHoldInfo[]>('/admin/instance/legal-holds') });
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const { run, view } = useAct();
  if (!q.data) return null;
  const active = q.data.filter((h) => !h.releasedAt);
  return (
    <Section title="Legal holds" description="While a hold is in force nothing in the repository or owner can be destroyed: no deletion of repositories, branches or releases, no history rewrites, and retention clean-up skips it.">
      <form
        className="mb-4 grid gap-2 sm:grid-cols-[14rem_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            qc.setQueryData(['admin-holds'], await api.post<LegalHoldInfo[]>('/admin/instance/legal-holds', { target, reason }));
            setTarget('');
            setReason('');
          }, 'Hold placed.');
        }}
      >
        <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="owner or owner/repo" aria-label="Target" className="font-mono text-[13px]" required />
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (matter, ticket, counsel)" aria-label="Reason" required minLength={3} />
        <Button type="submit">Place hold</Button>
      </form>
      {view}
      {q.data.length > 0 && (
        <Box>
          {[...active, ...q.data.filter((h) => h.releasedAt)].map((h) => (
            <BoxRow key={h.id} className={cx('flex flex-wrap items-center gap-3 text-[13px]', h.releasedAt && 'opacity-60')}>
              <span className="font-mono">{h.target}</span>
              <span className="min-w-0 flex-1 truncate text-fg-muted">{h.reason}</span>
              <span className="text-xs text-fg-subtle">
                {h.releasedAt ? <>released <RelativeTime date={h.releasedAt} /></> : <>placed <RelativeTime date={h.placedAt} /> by {h.placedBy?.username ?? 'someone'}</>}
              </span>
              {!h.releasedAt && <Button size="sm" onClick={() => confirm(`Release the hold on ${h.target}?`) && void run(async () => qc.setQueryData(['admin-holds'], await api.post<LegalHoldInfo[]>(`/admin/instance/legal-holds/${h.id}/release`)))}>Release</Button>}
            </BoxRow>
          ))}
        </Box>
      )}
    </Section>
  );
}

// ─── Retention ────────────────────────────────────────────────────────────

const RETENTION_FIELDS: { key: keyof RetentionSettings; label: string; hint: string; min: number }[] = [
  { key: 'auditDays', label: 'Audit log', hint: 'At least 30 days.', min: 30 },
  { key: 'notificationDays', label: 'Notifications', hint: 'Read and unread inbox items.', min: 7 },
  { key: 'webhookDeliveryDays', label: 'Webhook deliveries', hint: 'Request and response records.', min: 1 },
  { key: 'outputDays', label: 'Old outputs', hint: 'Generated files of commits that are not a branch tip, tag or release.', min: 7 },
];

function RetentionSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-retention'], queryFn: () => api.get<{ settings: RetentionSettings; editable: boolean; activeHolds: number }>('/admin/instance/retention') });
  const [s, setS] = useState<RetentionSettings>(DEFAULT_RETENTION);
  const { run, view } = useAct();
  useEffect(() => {
    if (q.data) setS(q.data.settings);
  }, [q.data]);
  if (!q.data) return null;
  return (
    <Section title="Retention" description="How long records are kept before the hourly clean-up deletes them. Empty means keep forever.">
      {!q.data.editable && <UnavailableNotice message="Retention settings are part of Enterprise. The defaults below apply." />}
      {q.data.activeHolds > 0 && <p className="mb-3 text-[13px] text-attention">{q.data.activeHolds} legal hold{q.data.activeHolds === 1 ? ' is' : 's are'} in force: the audit log and held repositories are not cleaned while it lasts.</p>}
      <fieldset disabled={!q.data.editable} className="mt-3 grid gap-4 sm:grid-cols-2">
        {RETENTION_FIELDS.map((f) => (
          <FormField key={f.key} label={`${f.label} (days)`} hint={f.hint}>
            {(id) => <Input id={id} type="number" min={f.min} max={3650} value={s[f.key] ?? ''} onChange={(e) => setS({ ...s, [f.key]: e.target.value ? Number(e.target.value) : null })} placeholder="forever" className="w-32" />}
          </FormField>
        ))}
      </fieldset>
      {q.data.editable && (
        <Button className="mt-4" variant="primary" onClick={() => void run(async () => {
          await api.put('/admin/instance/retention', s);
          await qc.invalidateQueries({ queryKey: ['admin-retention'] });
        }, 'Saved. Clean-up applies it within the hour.')}>
          Save retention
        </Button>
      )}
      {view}
    </Section>
  );
}

// ─── SCIM ─────────────────────────────────────────────────────────────────

function ScimSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-scim'], queryFn: () => api.get<{ baseUrl: string; tokens: ScimTokenInfo[] }>('/admin/instance/scim/tokens') });
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const { run, view } = useAct();
  if (!q.data) return null;
  return (
    <Section title="Directory sync (SCIM)" description="Let your identity provider (Okta, Entra ID, JumpCloud, ...) create, update and deactivate accounts, and manage organization membership through groups.">
      <p className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-fg-muted">
        SCIM base URL <span className="font-mono text-fg">{q.data.baseUrl}</span> <CopyButton value={q.data.baseUrl} />
      </p>
      <form
        className="mb-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api.post<{ token: string; tokens: ScimTokenInfo[] }>('/admin/instance/scim/tokens', { name });
            setFresh(r.token);
            setName('');
            qc.setQueryData(['admin-scim'], { ...q.data, tokens: r.tokens });
          });
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name, e.g. Okta" aria-label="Token name" className="w-64" required />
        <Button type="submit" leadingIcon={<Plus size={14} />}>Create token</Button>
      </form>
      {fresh && (
        <Flash tone="warning" className="mb-3">
          <p className="mb-1 font-medium">Copy the token now. It is not shown again.</p>
          <span className="flex items-center gap-2 break-all font-mono text-xs">{fresh} <CopyButton value={fresh} /></span>
        </Flash>
      )}
      {view}
      {q.data.tokens.length > 0 && (
        <Box>
          {q.data.tokens.map((t) => (
            <BoxRow key={t.id} className="flex items-center gap-3 text-[13px]">
              <span className="flex-1 font-medium">{t.name}</span>
              <span className="text-xs text-fg-subtle">{t.lastUsedAt ? <>used <RelativeTime date={t.lastUsedAt} /></> : 'never used'}</span>
              <IconButton label={`Revoke ${t.name}`} icon={<Trash2 size={14} />} onClick={() => confirm(`Revoke ${t.name}? Provisioning through it stops.`) && void run(async () => qc.setQueryData(['admin-scim'], { ...q.data, tokens: (await api.delete<{ tokens: ScimTokenInfo[] }>(`/admin/instance/scim/tokens/${t.id}`)).tokens }))} />
            </BoxRow>
          ))}
        </Box>
      )}
    </Section>
  );
}

// ─── Export clearance ─────────────────────────────────────────────────────

function ExportClearanceSection() {
  const [username, setUsername] = useState('');
  const [cleared, setCleared] = useState(true);
  const { run, view } = useAct();
  return (
    <Section title="Export clearance" description="Repositories marked export-controlled are hidden from everyone without clearance, administrators included. Grant or revoke it per account.">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const u = await api.get<{ id: string; username: string }[]>('/admin/users', { q: username });
            const hit = u.find((x) => x.username.toLowerCase() === username.trim().toLowerCase());
            if (!hit) throw new Error(`No account called ${username}`);
            await api.put(`/admin/instance/users/${hit.id}/export-clearance`, { cleared });
          }, cleared ? `${username} is cleared.` : `${username}'s clearance was revoked.`);
        }}
      >
        <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" aria-label="Username" className="w-56" required />
        <Select value={cleared ? 'grant' : 'revoke'} onChange={(e) => setCleared(e.target.value === 'grant')} className="w-36" aria-label="Action">
          <option value="grant">Grant</option>
          <option value="revoke">Revoke</option>
        </Select>
        <Button type="submit">Apply</Button>
      </form>
      {view}
    </Section>
  );
}

export function InstanceAdmin() {
  return (
    <div className="max-w-4xl">
      <VersionSection />
      <LicenseSection />
      <LegalHoldSection />
      <RetentionSection />
      <ScimSection />
      <ExportClearanceSection />
    </div>
  );
}

// ─── Invoices ─────────────────────────────────────────────────────────────

export function InvoicesAdmin() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const q = useQuery({ queryKey: ['admin-invoices', status], queryFn: () => api.get<InvoiceInfo[]>('/admin/invoices', { status: status || undefined }) });
  const [owner, setOwner] = useState('');
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const [tax, setTax] = useState('0');
  const { run, view } = useAct();
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-invoices'] });
  return (
    <div className="max-w-4xl">
      <Section title="Raise an invoice" description="Leave the line empty to bill the owner's plan for its seats over one billing period (monthly or annual, as the owner chose).">
        <form
          className="grid gap-2 sm:grid-cols-[10rem_1fr_8rem_6rem_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const lines = desc.trim() ? [{ description: desc.trim(), quantity: 1, unitCents: Math.round(Number(amount) * 100) }] : [];
              const inv = await api.post<InvoiceInfo>(`/admin/namespaces/${encodeURIComponent(owner.trim())}/invoices`, { lines, taxPercent: Number(tax) || 0 });
              setDesc('');
              setAmount('');
              await refresh();
              return inv;
            }, 'Invoice raised.');
          }}
        >
          <Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Owner" aria-label="Owner" required />
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Line (empty = plan for one period)" aria-label="Description" />
          <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount $" aria-label="Amount" required={Boolean(desc.trim())} disabled={!desc.trim()} />
          <Input type="number" min={0} max={50} value={tax} onChange={(e) => setTax(e.target.value)} aria-label="Tax %" title="Tax %" />
          <Button type="submit" variant="primary">Raise</Button>
        </form>
        {view}
      </Section>
      <Section
        title="Invoices"
        action={
          <Select value={status} onChange={(e) => setStatus(e.target.value as InvoiceStatus | '')} className="h-8 w-32 text-[13px]" aria-label="Status">
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="paid">Paid</option>
            <option value="draft">Draft</option>
            <option value="void">Void</option>
          </Select>
        }
      >
        {q.isLoading ? (
          <PageSpinner />
        ) : !q.data?.length ? (
          <p className="text-[13px] text-fg-muted">No invoices.</p>
        ) : (
          <Box>
            {q.data.map((i) => (
              <BoxRow key={i.id} className="flex flex-wrap items-center gap-3 text-[13px]">
                <Link to="/billing/$owner/invoices/$id" params={{ owner: i.owner, id: i.id }} className="link font-mono">{i.number}</Link>
                <span className="font-medium">{i.owner}</span>
                <span className="text-fg-muted">{i.dueAt && <>due {i.dueAt.slice(0, 10)}</>}</span>
                <span className="ml-auto tabular-nums">{money(i.totalCents)}</span>
                <Label tone={i.status === 'paid' ? 'success' : i.status === 'open' ? 'attention' : 'default'}>{i.status}</Label>
                {i.status !== 'void' && i.status !== 'paid' && (
                  <>
                    {i.status === 'draft' && <Button size="sm" onClick={() => void run(async () => { await api.patch(`/admin/invoices/${i.id}`, { status: 'open' }); await refresh(); })}>Issue</Button>}
                    <Button size="sm" onClick={() => void run(async () => { await api.patch(`/admin/invoices/${i.id}`, { status: 'paid' }); await refresh(); })}>Mark paid</Button>
                    <Button size="sm" variant="danger" onClick={() => confirm(`Void ${i.number}?`) && void run(async () => { await api.patch(`/admin/invoices/${i.id}`, { status: 'void' }); await refresh(); })}>Void</Button>
                  </>
                )}
              </BoxRow>
            ))}
          </Box>
        )}
      </Section>
    </div>
  );
}
