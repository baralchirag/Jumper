import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Trash2, UserPlus } from 'lucide-react';
import type { NamespaceInfo } from '@jumper/shared';
import { Avatar, Box, BoxHeader, BoxRow, Button, Dialog, Flash, FormField, IconButton, Input, PageSpinner, Select, Textarea } from '@jumper/ui';
import { ErrorView, PageContainer, PageHeader } from '../../shared/components/common';
import { api, errorMessage } from '../../shared/lib/api';
import { useMe } from '../../shared/lib/queries';
import { UsagePanel } from '../usage/UsagePanel';
import { AuditPanel, BillingPanel, CustomRolesPanel, MemberRolesPanel, PolicyPanel, SsoPanel } from './Governance';
import { InvitePanel } from './Invites';

const ORG_SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'access', label: 'Access and roles' },
  { id: 'policies', label: 'Policies' },
  { id: 'sso', label: 'Single sign-on' },
  { id: 'audit', label: 'Audit log' },
  { id: 'billing', label: 'Billing' },
] as const;
type OrgSection = (typeof ORG_SECTIONS)[number]['id'];

/** Everything an organization owner can manage: profile, members and roles, leaving, deleting. */
export function OrgSettingsPage() {
  const { org = '', section: rawSection = 'general' } = useParams({ strict: false }) as { org?: string; section?: string };
  const section: OrgSection = ORG_SECTIONS.some((s) => s.id === rawSection) ? (rawSection as OrgSection) : 'general';
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = ['namespace', org];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<NamespaceInfo>(`/namespaces/${encodeURIComponent(org)}`) });
  const [form, setForm] = useState({ name: '', description: '' });
  const [saved, setSaved] = useState(false);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'member' | 'owner'>('member');
  const [error, setError] = useState<string | null>(null);
  const [del, setDel] = useState(false);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (q.data) setForm({ name: q.data.name ?? '', description: q.data.bio ?? '' });
  }, [q.data]);

  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const save = useMutation({
    mutationFn: () => api.patch(`/orgs/${org}`, { name: form.name, description: form.description || null }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const setMember = useMutation({
    mutationFn: (v: { username: string; role: 'member' | 'owner' }) => api.put(`/orgs/${org}/members`, v),
    onSuccess: () => {
      setUsername('');
      setError(null);
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const removeMember = useMutation({
    mutationFn: (u: string) => api.delete(`/orgs/${org}/members/${encodeURIComponent(u)}`),
    onSuccess: (_r, u) => {
      void refresh();
      void qc.invalidateQueries({ queryKey: ['me'] });
      if (u === me?.username) void navigate({ to: '/$owner', params: { owner: org } });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const destroy = useMutation({
    mutationFn: () => api.delete(`/orgs/${org}`, { confirm: typed }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      void navigate({ to: '/' });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (q.isLoading) return <PageSpinner />;
  if (q.error || !q.data) return <ErrorView error={q.error} />;
  const ns = q.data;
  if (ns.kind !== 'org') return <ErrorView error={new Error('Not an organization')} />;
  const mine = ns.members?.find((m) => m.id === me?.id);
  const isOwner = mine?.role === 'owner' || me?.isAdmin;
  const owners = ns.members?.filter((m) => m.role === 'owner').length ?? 0;
  if (!isOwner && !mine) return <ErrorView error={Object.assign(new Error('Not found'), { status: 404 })} />;

  return (
    <PageContainer className="max-w-3xl py-10 md:py-14">
      <PageHeader title={`${ns.name || ns.slug} settings`}>
        Manage who belongs to <Link to="/$owner" params={{ owner: ns.slug }} className="link">{ns.slug}</Link> and what it is called.
      </PageHeader>
      {isOwner && (
        <nav aria-label="Organization settings" className="-mx-1 mb-8 flex gap-1 overflow-x-auto border-b border-border">
          {ORG_SECTIONS.map((s) => (
            <Link
              key={s.id}
              to={s.id === 'general' ? '/organizations/$org/settings' : '/organizations/$org/settings/$section'}
              params={{ org: ns.slug, section: s.id }}
              aria-current={section === s.id ? 'page' : undefined}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] no-underline ${section === s.id ? 'border-select font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg'}`}
            >
              {s.label}
            </Link>
          ))}
        </nav>
      )}
      {error && <Flash tone="danger" className="mb-6">{error}</Flash>}

      {section === 'access' && (
        <div className="space-y-12">
      <section>
          <h2 className="mb-1 text-[15px] font-medium">Members</h2>
          <p className="mb-4 text-sm text-fg-muted">Owners manage the organization and everything in it. Members can push to its repositories. Both can be removed at any time.</p>
          <Box>
            <BoxHeader className="text-sm font-medium">{ns.members?.length ?? 0} {ns.members?.length === 1 ? 'person' : 'people'}</BoxHeader>
            {ns.members?.map((m) => (
              <BoxRow key={m.id} className="flex items-center gap-3">
                <Avatar name={m.username} src={m.avatarUrl} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{m.username}{m.id === me?.id && <span className="ml-2 text-xs font-normal text-fg-muted">you</span>}</div>
                  {m.name && <div className="text-xs text-fg-muted">{m.name}</div>}
                </div>
                {isOwner ? (
                  <Select value={m.role} aria-label={`Role of ${m.username}`} className="w-32" onChange={(e) => setMember.mutate({ username: m.username, role: e.target.value as 'member' | 'owner' })} disabled={m.role === 'owner' && owners === 1}>
                    <option value="member">Member</option>
                    <option value="owner">Owner</option>
                  </Select>
                ) : (
                  <span className="text-sm capitalize text-fg-muted">{m.role}</span>
                )}
                {(isOwner || m.id === me?.id) && (
                  <IconButton
                    label={m.id === me?.id ? 'Leave organization' : `Remove ${m.username}`}
                    icon={m.id === me?.id ? <LogOut size={15} /> : <Trash2 size={15} />}
                    disabled={m.role === 'owner' && owners === 1}
                    onClick={() => confirm(m.id === me?.id ? `Leave ${ns.slug}?` : `Remove ${m.username} from ${ns.slug}?`) && removeMember.mutate(m.username)}
                  />
                )}
              </BoxRow>
            ))}
          </Box>
          {owners === 1 && <p className="mt-2 text-xs text-fg-muted">An organization needs at least one owner. Promote someone else before the last owner can leave.</p>}
          {isOwner && (
            <form
              className="mt-4 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setMember.mutate({ username: username.trim(), role });
              }}
            >
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username to add" aria-label="Username to add" className="min-w-52 flex-1" required />
              <Select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'owner')} className="w-32" aria-label="Role">
                <option value="member">Member</option>
                <option value="owner">Owner</option>
              </Select>
              <Button type="submit" leadingIcon={<UserPlus size={14} />} loading={setMember.isPending}>Add</Button>
            </form>
          )}
        </section>
          {isOwner && <InvitePanel org={ns.slug} />}
        </div>
      )}
      {isOwner && section === 'access' && (
        <div className="mt-12 space-y-12">
          <MemberRolesPanel owner={ns.slug} />
          <CustomRolesPanel owner={ns.slug} />
        </div>
      )}
      {isOwner && section === 'policies' && <PolicyPanel owner={ns.slug} />}
      {isOwner && section === 'sso' && <SsoPanel owner={ns.slug} />}
      {isOwner && section === 'audit' && <AuditPanel owner={ns.slug} />}
      {isOwner && section === 'billing' && <BillingPanel owner={ns.slug} />}

      {section === 'general' && <>
      {isOwner && (
        <section className="mb-10">
          <h2 className="mb-3 text-[15px] font-medium">Profile</h2>
          <form
            className="space-y-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setSaved(false);
              save.mutate();
            }}
          >
            <FormField label="Display name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} required />}</FormField>
            <FormField label="Description" hint="Shown on the organization's profile.">{(id) => <Textarea id={id} rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={500} />}</FormField>
            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
              {saved && <span className="text-sm text-success">Saved.</span>}
            </div>
          </form>
        </section>
      )}

      <section className="mb-10">
        <h2 className="mb-1 text-[15px] font-medium">Usage and plan</h2>
        <p className="mb-4 text-sm text-fg-muted">Storage, check minutes and seats used by {ns.slug}'s repositories.</p>
        <UsagePanel owner={ns.slug} />
      </section>

      {isOwner && (
        <section>
          <h2 className="mb-3 text-[15px] font-medium text-danger">Danger zone</h2>
          <Box className="border-danger/40">
            <div className="flex flex-wrap items-center gap-4 p-5">
              <div className="min-w-0 flex-1">
                <div className="font-medium">Delete this organization</div>
                <p className="text-sm text-fg-muted">Permanently deletes {ns.repos.length} repositor{ns.repos.length === 1 ? 'y' : 'ies'} with all history, checks and files. This cannot be undone.</p>
              </div>
              <Button variant="danger" onClick={() => setDel(true)}>Delete organization…</Button>
            </div>
          </Box>
          <Dialog
            open={del}
            onClose={() => setDel(false)}
            title={`Delete ${ns.slug}`}
            footer={<Button variant="danger" disabled={typed.toLowerCase() !== ns.slug.toLowerCase()} loading={destroy.isPending} onClick={() => destroy.mutate()}>I understand, delete it</Button>}
          >
            <p className="mb-3 text-sm">Type <b className="font-mono">{ns.slug}</b> to confirm.</p>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </Dialog>
        </section>
      )}
      </>}
    </PageContainer>
  );
}
