// Owner governance screens: repository roles for members, custom roles, organization policy, single sign-on,
// the audit log and billing. Shown inside organization settings (and billing in personal settings too).
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, FileText, Plus, Receipt, ShieldCheck, Trash2 } from 'lucide-react';
import {
  CAPABILITY_LABELS,
  CUSTOM_ROLE_CAPS,
  DEFAULT_ORG_POLICY,
  DEFAULT_PLANS,
  REPO_ROLES,
  ROLE_LABELS,
  type BillingCycle,
  type BillingInfo,
  type BillingProfile,
  type CustomRoleInfo,
  type InvoiceInfo,
  type Entitlements,
  type OrgMemberInfo,
  type OrgPolicy,
  type SsoConnectionInfo,
  type SsoKind,
} from '@jumper/shared';
import {
  Avatar,
  Box,
  BoxHeader,
  BoxRow,
  Button,
  Checkbox,
  CopyButton,
  Dialog,
  Flash,
  FormField,
  IconButton,
  Input,
  Label,
  PageSpinner,
  RelativeTime,
  Select,
  Textarea,
  cx,
} from '@jumper/ui';
import { UnavailableNotice, isUnavailable } from '../../shared/components/common';
import { api, errorMessage } from '../../shared/lib/api';
import { PlanBadge } from '../../shared/components/PlanBadge';

const enc = encodeURIComponent;

export function SectionTitle({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="max-w-2xl">
        <h2 className="text-[15px] font-medium">{title}</h2>
        {children && <p className="mt-1 text-sm text-fg-muted">{children}</p>}
      </div>
      {action}
    </div>
  );
}

function Failure({ error }: { error: unknown }) {
  return isUnavailable(error) ? (
    <UnavailableNotice error={error} />
  ) : (
    <Flash tone="danger">{errorMessage(error)}</Flash>
  );
}

const lines = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

// ─── Members' repository roles ────────────────────────────────────────────

export function MemberRolesPanel({ owner }: { owner: string }) {
  const qc = useQueryClient();
  const members = useQuery({
    queryKey: ['org-members', owner],
    queryFn: () => api.get<OrgMemberInfo[]>(`/orgs/${enc(owner)}/members`),
  });
  const roles = useQuery({
    queryKey: ['roles', owner],
    queryFn: () => api.get<CustomRoleInfo[]>(`/owners/${enc(owner)}/roles`),
  });
  const [error, setError] = useState<string | null>(null);
  const set = useMutation({
    mutationFn: (v: { username: string; role: string }) =>
      api.put(`/orgs/${enc(owner)}/members/${enc(v.username)}/role`, { role: v.role }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['org-members', owner] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  if (members.isLoading) return <PageSpinner />;
  if (members.error) return <Failure error={members.error} />;
  return (
    <section>
      <SectionTitle title="Repository access">
        What each member can do in the organization's repositories. Owners always have full access.
        Collaborators added to a single repository are managed in that repository's settings.
      </SectionTitle>
      {error && (
        <Flash tone="danger" className="mb-3">
          {error}
        </Flash>
      )}
      <Box>
        {members.data!.map((m) => (
          <BoxRow key={m.id} className="flex flex-wrap items-center gap-3">
            <Avatar name={m.username} src={m.avatarUrl} size={24} />
            <span className="min-w-0 flex-1 font-medium">{m.username}</span>
            {m.twoFactor ? (
              <span
                className="inline-flex items-center gap-1 text-xs text-success"
                title="Two-factor login is on"
              >
                <ShieldCheck size={13} /> 2FA
              </span>
            ) : (
              <span className="text-xs text-fg-subtle" title="Two-factor login is off">
                no 2FA
              </span>
            )}
            {m.role === 'owner' ? (
              <span className="w-44 text-right text-[13px] text-fg-muted">Owner</span>
            ) : (
              <Select
                className="h-8 w-44 text-[13px]"
                aria-label={`Repository role of ${m.username}`}
                value={m.customRole ? `custom:${m.customRole.id}` : m.repoRole}
                onChange={(e) => set.mutate({ username: m.username, role: e.target.value })}
              >
                {REPO_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
                {roles.data?.map((r) => (
                  <option key={r.id} value={`custom:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </Select>
            )}
          </BoxRow>
        ))}
      </Box>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-fg-muted sm:grid-cols-2">
        <div>
          <dt className="inline font-medium text-fg">Viewer</dt>{' '}
          <dd className="inline">reads and comments.</dd>
        </div>
        <div>
          <dt className="inline font-medium text-fg">Reviewer</dt>{' '}
          <dd className="inline">also downloads outputs and fab packages.</dd>
        </div>
        <div>
          <dt className="inline font-medium text-fg">Committer</dt>{' '}
          <dd className="inline">also pushes.</dd>
        </div>
        <div>
          <dt className="inline font-medium text-fg">Admin</dt>{' '}
          <dd className="inline">also changes settings and access.</dd>
        </div>
      </dl>
    </section>
  );
}

// ─── Custom roles ─────────────────────────────────────────────────────────

type RoleForm = {
  name: string;
  description: string;
  base: 'read' | 'review' | 'write';
  capabilities: string[];
};
const EMPTY_ROLE: RoleForm = { name: '', description: '', base: 'review', capabilities: [] };

export function CustomRolesPanel({ owner }: { owner: string }) {
  const qc = useQueryClient();
  const key = ['roles', owner];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<CustomRoleInfo[]>(`/owners/${enc(owner)}/roles`),
  });
  const [edit, setEdit] = useState<{ id: string | null; form: RoleForm } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (v: { id: string | null; form: RoleForm }) =>
      v.id
        ? api.put<CustomRoleInfo[]>(`/owners/${enc(owner)}/roles/${v.id}`, v.form)
        : api.post<CustomRoleInfo[]>(`/owners/${enc(owner)}/roles`, v.form),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      setEdit(null);
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete<CustomRoleInfo[]>(`/owners/${enc(owner)}/roles/${id}`),
    onSuccess: (d) => qc.setQueryData(key, d),
    onError: (e) => setError(errorMessage(e)),
  });
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <Failure error={q.error} />;
  const f = edit?.form;
  return (
    <section>
      <SectionTitle
        title="Custom roles"
        action={
          <Button
            size="sm"
            leadingIcon={<Plus size={14} />}
            onClick={() => setEdit({ id: null, form: EMPTY_ROLE })}
          >
            New role
          </Button>
        }
      >
        Roles built on Viewer, Reviewer or Committer with capabilities switched on or off, for
        example a layout reviewer who can approve but not merge.
      </SectionTitle>
      {error && (
        <Flash tone="danger" className="mb-3">
          {error}
        </Flash>
      )}
      {q.data!.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-fg-muted">
          No custom roles yet.
        </p>
      ) : (
        <Box>
          {q.data!.map((r) => (
            <BoxRow key={r.id} className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{r.name}</span>
                  <span className="text-xs text-fg-muted">based on {ROLE_LABELS[r.base]}</span>
                  <span className="text-xs text-fg-subtle">
                    · {r.members} {r.members === 1 ? 'person' : 'people'}
                  </span>
                </div>
                {r.description && <p className="text-[13px] text-fg-muted">{r.description}</p>}
                <p className="mt-1 text-xs text-fg-subtle">
                  {r.capabilities.length
                    ? r.capabilities.map((c) => CAPABILITY_LABELS[c]).join(' · ')
                    : 'No extra capabilities'}
                </p>
              </div>
              <Button
                size="sm"
                onClick={() =>
                  setEdit({
                    id: r.id,
                    form: {
                      name: r.name,
                      description: r.description,
                      base: r.base,
                      capabilities: r.capabilities,
                    },
                  })
                }
              >
                Edit
              </Button>
              <IconButton
                label={`Delete ${r.name}`}
                icon={<Trash2 size={14} />}
                onClick={() =>
                  confirm(
                    `Delete the ${r.name} role? People holding it fall back to its base role.`,
                  ) && del.mutate(r.id)
                }
              />
            </BoxRow>
          ))}
        </Box>
      )}
      <Dialog
        open={Boolean(edit)}
        onClose={() => setEdit(null)}
        title={edit?.id ? 'Edit role' : 'New role'}
        footer={
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!f?.name.trim()}
            onClick={() => edit && save.mutate(edit)}
          >
            Save role
          </Button>
        }
      >
        {f && edit && (
          <div className="space-y-4">
            <FormField label="Name">
              {(id) => (
                <Input
                  id={id}
                  value={f.name}
                  onChange={(e) => setEdit({ ...edit, form: { ...f, name: e.target.value } })}
                  maxLength={40}
                  autoFocus
                />
              )}
            </FormField>
            <FormField label="Description" hint="Optional">
              {(id) => (
                <Input
                  id={id}
                  value={f.description}
                  onChange={(e) =>
                    setEdit({ ...edit, form: { ...f, description: e.target.value } })
                  }
                  maxLength={200}
                />
              )}
            </FormField>
            <FormField
              label="Based on"
              hint="Sets what the role can do in git: only Committer can push."
            >
              {(id) => (
                <Select
                  id={id}
                  value={f.base}
                  onChange={(e) =>
                    setEdit({ ...edit, form: { ...f, base: e.target.value as RoleForm['base'] } })
                  }
                >
                  {(['read', 'review', 'write'] as const).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">Capabilities</legend>
              {CUSTOM_ROLE_CAPS.map((c) => (
                <Checkbox
                  key={c}
                  label={CAPABILITY_LABELS[c]}
                  checked={f.capabilities.includes(c)}
                  disabled={f.base !== 'write' && (c === 'merge' || c === 'release')}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      form: {
                        ...f,
                        capabilities: e.target.checked
                          ? [...f.capabilities, c]
                          : f.capabilities.filter((x) => x !== c),
                      },
                    })
                  }
                />
              ))}
            </fieldset>
          </div>
        )}
      </Dialog>
    </section>
  );
}

// ─── Organization policy ──────────────────────────────────────────────────

function ListField({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => setText(value.join('\n')), [value.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FormField label={label} hint={hint}>
      {(id) => (
        <Textarea
          id={id}
          rows={3}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => onChange(lines(text))}
          className="font-mono text-[13px]"
        />
      )}
    </FormField>
  );
}

export function PolicyPanel({ owner }: { owner: string }) {
  const qc = useQueryClient();
  const key = ['policy', owner];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.get<{ policy: OrgPolicy; entitlements: Entitlements }>(`/owners/${enc(owner)}/policy`),
  });
  const [p, setP] = useState<OrgPolicy>(DEFAULT_ORG_POLICY);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  useEffect(() => {
    if (q.data) setP(q.data.policy);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.put<{ policy: OrgPolicy }>(`/owners/${enc(owner)}/policy`, p),
    onSuccess: (d) => {
      qc.setQueryData(key, { ...q.data!, policy: d.policy });
      setMsg({
        tone: 'success',
        text: 'Policy saved. It applies to every repository from now on.',
      });
    },
    onError: (e) => setMsg({ tone: 'danger', text: errorMessage(e) }),
  });
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <Failure error={q.error} />;
  const ent = q.data!.entitlements;
  const has = (f: string) => ent.features.includes(f as never);
  const set = <K extends keyof OrgPolicy>(k: K, v: OrgPolicy[K]) => setP({ ...p, [k]: v });

  return (
    <section className="space-y-8">
      <SectionTitle title="Policies">
        Rules applied to every repository in the organization, on top of each repository's own
        settings. Repository admins cannot loosen them.
      </SectionTitle>
      {!has('org_policies') && (
        <UnavailableNotice
          message={ent.reason ?? 'Organization-wide policies are part of Business.'}
        />
      )}

      <fieldset disabled={!has('org_policies')} className="space-y-4">
        <legend className="mb-2 text-sm font-medium">Branches and sharing</legend>
        <ListField
          label="Protected branches"
          hint="No deletion or force-push in any repository, for admins too. Patterns such as release/* work."
          value={p.releaseBranches}
          onChange={(v) => set('releaseBranches', v)}
        />
        <Checkbox
          checked={p.requireWatermark}
          onChange={(e) => set('requireWatermark', e.target.checked)}
          label="Watermark every share link"
        />
        {p.requireWatermark && (
          <FormField label="Default watermark">
            {(id) => (
              <Input
                id={id}
                value={p.defaultWatermark}
                onChange={(e) => set('defaultWatermark', e.target.value)}
                placeholder="Confidential, {viewer}"
                maxLength={120}
              />
            )}
          </FormField>
        )}
      </fieldset>

      <fieldset disabled={!has('security_policies')} className="space-y-4">
        <legend className="mb-2 text-sm font-medium">Security</legend>
        {!has('security_policies') && (
          <p className="text-xs text-fg-muted">
            Required two-factor login, address allowlists and session limits need Business.
          </p>
        )}
        <Checkbox
          checked={p.requireTwoFactor}
          onChange={(e) => set('requireTwoFactor', e.target.checked)}
          label="Require two-factor login"
          hint="Members without it can still see public work, but not private repositories, until they turn it on."
        />
        <ListField
          label="Allowed network addresses"
          hint="When set, private work is only reachable from these addresses or CIDR ranges."
          value={p.ipAllowlist}
          onChange={(v) => set('ipAllowlist', v)}
          placeholder="203.0.113.0/24"
        />
        <FormField label="Sign in again after (hours)" hint="Leave empty for the instance default.">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              max={2160}
              value={p.sessionMaxHours ?? ''}
              onChange={(e) =>
                set('sessionMaxHours', e.target.value ? Number(e.target.value) : null)
              }
              className="w-28"
            />
          )}
        </FormField>
      </fieldset>

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <Button
          variant="primary"
          loading={save.isPending}
          onClick={() => save.mutate()}
          disabled={!has('org_policies') && !has('security_policies')}
        >
          Save policy
        </Button>
        {msg && (
          <span
            className={cx('text-[13px]', msg.tone === 'success' ? 'text-success' : 'text-danger')}
          >
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}

// ─── Single sign-on ───────────────────────────────────────────────────────

type SsoForm = {
  kind: SsoKind;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  entryPoint: string;
  idpIssuer: string;
  certificate: string;
  domains: string;
  enforced: boolean;
  autoProvision: boolean;
};
const EMPTY_SSO: SsoForm = {
  kind: 'oidc',
  name: '',
  issuer: '',
  clientId: '',
  clientSecret: '',
  entryPoint: '',
  idpIssuer: '',
  certificate: '',
  domains: '',
  enforced: false,
  autoProvision: true,
};

export function SsoPanel({ owner }: { owner: string }) {
  const qc = useQueryClient();
  const key = ['sso', owner];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<SsoConnectionInfo[]>(`/sso/${enc(owner)}/connections`),
  });
  const [edit, setEdit] = useState<{ id: string | null; form: SsoForm } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: ({ id, form }: { id: string | null; form: SsoForm }) => {
      const body = {
        kind: form.kind,
        name: form.name,
        domains: lines(form.domains),
        enforced: form.enforced,
        autoProvision: form.autoProvision,
        ...(form.kind === 'oidc'
          ? {
              issuer: form.issuer || undefined,
              clientId: form.clientId || undefined,
              clientSecret: form.clientSecret,
            }
          : {
              entryPoint: form.entryPoint || undefined,
              idpIssuer: form.idpIssuer || undefined,
              certificate: form.certificate || undefined,
            }),
      };
      return id
        ? api.put(`/sso/${enc(owner)}/connections/${id}`, body)
        : api.post(`/sso/${enc(owner)}/connections`, body);
    },
    onSuccess: () => {
      setEdit(null);
      setError(null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/sso/${enc(owner)}/connections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <Failure error={q.error} />;
  const f = edit?.form;
  const upd = (patch: Partial<SsoForm>) =>
    edit && setEdit({ ...edit, form: { ...edit.form, ...patch } });
  return (
    <section>
      <SectionTitle
        title="Single sign-on"
        action={
          <Button
            size="sm"
            leadingIcon={<Plus size={14} />}
            onClick={() => setEdit({ id: null, form: EMPTY_SSO })}
          >
            Add connection
          </Button>
        }
      >
        Let members sign in through your identity provider (Okta, Entra ID, Google Workspace,
        Keycloak, ...) with OpenID Connect or SAML. People with an address on a claimed domain are
        sent there from the sign-in page.
      </SectionTitle>
      {error && !edit && (
        <Flash tone="danger" className="mb-3">
          {error}
        </Flash>
      )}
      {q.data!.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-fg-muted">
          No connections yet.
        </p>
      ) : (
        <div className="space-y-3">
          {q.data!.map((c) => (
            <Box key={c.id}>
              <BoxHeader className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.name}</span>
                <Label>{c.kind === 'saml' ? 'SAML' : 'OIDC'}</Label>
                {c.enforced && <Label tone="attention">Required</Label>}
                <span className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      setEdit({
                        id: c.id,
                        form: {
                          ...EMPTY_SSO,
                          kind: c.kind,
                          name: c.name,
                          issuer: c.issuer ?? '',
                          clientId: c.clientId ?? '',
                          entryPoint: c.entryPoint ?? '',
                          idpIssuer: c.idpIssuer ?? '',
                          domains: c.domains.join('\n'),
                          enforced: c.enforced,
                          autoProvision: c.autoProvision,
                        },
                      })
                    }
                  >
                    Edit
                  </Button>
                  <IconButton
                    label={`Remove ${c.name}`}
                    icon={<Trash2 size={14} />}
                    onClick={() =>
                      confirm(
                        `Remove ${c.name}? Members who only sign in through it will need a password.`,
                      ) && del.mutate(c.id)
                    }
                  />
                </span>
              </BoxHeader>
              <div className="space-y-1.5 px-4 py-3 text-[13px]">
                <p className="text-fg-muted">
                  Domains:{' '}
                  {c.domains.length ? (
                    <span className="font-mono text-fg">{c.domains.join(', ')}</span>
                  ) : (
                    'none'
                  )}
                </p>
                <p className="flex flex-wrap items-center gap-2 text-fg-muted">
                  {c.kind === 'saml' ? 'Assertion consumer URL' : 'Redirect URI'}:{' '}
                  <span className="break-all font-mono text-fg">{c.callbackUrl}</span>{' '}
                  <CopyButton value={c.callbackUrl} />
                </p>
                {c.spEntityId && (
                  <p className="flex flex-wrap items-center gap-2 text-fg-muted">
                    Entity ID: <span className="break-all font-mono text-fg">{c.spEntityId}</span>{' '}
                    <CopyButton value={c.spEntityId} />
                  </p>
                )}
                {c.metadataUrl && (
                  <a href={c.metadataUrl} className="link text-xs">
                    Service provider metadata (XML)
                  </a>
                )}
              </div>
            </Box>
          ))}
        </div>
      )}
      <Dialog
        open={Boolean(edit)}
        onClose={() => setEdit(null)}
        title={edit?.id ? 'Edit connection' : 'Add connection'}
        footer={
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!f?.name.trim()}
            onClick={() => edit && save.mutate(edit)}
          >
            Save connection
          </Button>
        }
      >
        {f && (
          <div className="space-y-4">
            {error && <Flash tone="danger">{error}</Flash>}
            <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
              <FormField label="Protocol">
                {(id) => (
                  <Select
                    id={id}
                    value={f.kind}
                    onChange={(e) => upd({ kind: e.target.value as SsoKind })}
                    disabled={Boolean(edit?.id)}
                  >
                    <option value="oidc">OIDC</option>
                    <option value="saml">SAML</option>
                  </Select>
                )}
              </FormField>
              <FormField label="Name" hint="Shown on the sign-in button.">
                {(id) => (
                  <Input
                    id={id}
                    value={f.name}
                    onChange={(e) => upd({ name: e.target.value })}
                    placeholder="Acme Okta"
                    maxLength={60}
                  />
                )}
              </FormField>
            </div>
            {f.kind === 'oidc' ? (
              <>
                <FormField label="Issuer URL" hint="Must serve /.well-known/openid-configuration.">
                  {(id) => (
                    <Input
                      id={id}
                      type="url"
                      value={f.issuer}
                      onChange={(e) => upd({ issuer: e.target.value })}
                      placeholder="https://acme.okta.com"
                    />
                  )}
                </FormField>
                <FormField label="Client ID">
                  {(id) => (
                    <Input
                      id={id}
                      value={f.clientId}
                      onChange={(e) => upd({ clientId: e.target.value })}
                    />
                  )}
                </FormField>
                <FormField
                  label="Client secret"
                  hint={edit?.id ? 'Leave empty to keep the saved secret.' : 'Stored encrypted.'}
                >
                  {(id) => (
                    <Input
                      id={id}
                      type="password"
                      value={f.clientSecret}
                      onChange={(e) => upd({ clientSecret: e.target.value })}
                      autoComplete="off"
                    />
                  )}
                </FormField>
              </>
            ) : (
              <>
                <FormField label="Identity provider sign-in URL">
                  {(id) => (
                    <Input
                      id={id}
                      type="url"
                      value={f.entryPoint}
                      onChange={(e) => upd({ entryPoint: e.target.value })}
                    />
                  )}
                </FormField>
                <FormField
                  label="Identity provider entity ID"
                  hint="Optional; checked against the assertion's issuer when set."
                >
                  {(id) => (
                    <Input
                      id={id}
                      value={f.idpIssuer}
                      onChange={(e) => upd({ idpIssuer: e.target.value })}
                    />
                  )}
                </FormField>
                <FormField
                  label="Signing certificate"
                  hint={edit?.id ? 'Leave empty to keep the saved certificate.' : 'PEM or base64.'}
                >
                  {(id) => (
                    <Textarea
                      id={id}
                      rows={4}
                      value={f.certificate}
                      onChange={(e) => upd({ certificate: e.target.value })}
                      className="font-mono text-xs"
                    />
                  )}
                </FormField>
              </>
            )}
            <FormField
              label="Email domains"
              hint="One per line. People with these addresses are offered this sign-in."
            >
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={f.domains}
                  onChange={(e) => upd({ domains: e.target.value })}
                  placeholder="acme.com"
                  className="font-mono text-[13px]"
                />
              )}
            </FormField>
            <Checkbox
              checked={f.autoProvision}
              onChange={(e) => upd({ autoProvision: e.target.checked })}
              label="Create accounts on first sign-in"
              hint="Otherwise only existing or directory-provisioned accounts can sign in."
            />
            <Checkbox
              checked={f.enforced}
              onChange={(e) => upd({ enforced: e.target.checked })}
              label="Require this sign-in for private work"
              hint="Members who signed in another way keep public access only."
            />
          </div>
        )}
      </Dialog>
    </section>
  );
}

// ─── Audit log ────────────────────────────────────────────────────────────

interface AuditEvent {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
}

export function AuditPanel({ owner }: { owner: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [action, setAction] = useState('');
  const query = { from: from || undefined, to: to || undefined, action: action || undefined };
  const q = useQuery({
    queryKey: ['audit', owner, query],
    queryFn: () => api.get<{ events: AuditEvent[] }>(`/owners/${enc(owner)}/audit`, query),
  });
  const csv = `/api/owners/${enc(owner)}/audit?${new URLSearchParams({ format: 'csv', ...(from && { from }), ...(to && { to }), ...(action && { action }) })}`;
  return (
    <section>
      <SectionTitle
        title="Audit log"
        action={
          <a href={csv} className="link inline-flex items-center gap-1 text-[13px]">
            <Download size={13} /> Export CSV
          </a>
        }
      >
        Who changed what in this organization and its repositories: access, settings, policies,
        pushes and sign-ins. Export needs Business.
      </SectionTitle>
      <div className="mb-3 flex flex-wrap gap-2">
        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="From"
          className="h-8 w-40 text-[13px]"
        />
        <Input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="To"
          className="h-8 w-40 text-[13px]"
        />
        <Input
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="Action starts with, e.g. repo."
          aria-label="Action"
          className="h-8 w-56 text-[13px]"
        />
      </div>
      {q.isLoading ? (
        <PageSpinner />
      ) : q.error ? (
        <Failure error={q.error} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-xs text-fg-subtle">
                <th className="px-3 py-2 font-normal">When</th>
                <th className="px-3 py-2 font-normal">Who</th>
                <th className="px-3 py-2 font-normal">Action</th>
                <th className="px-3 py-2 font-normal">Details</th>
              </tr>
            </thead>
            <tbody>
              {q.data!.events.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-fg-muted">
                    No events.
                  </td>
                </tr>
              )}
              {q.data!.events.map((e) => (
                <tr key={e.id} className="border-b border-border-muted align-top last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-fg-muted">
                    <RelativeTime date={e.at} />
                  </td>
                  <td className="px-3 py-2">
                    {e.actor ?? <span className="text-fg-subtle">system</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{e.action}</td>
                  <td
                    className="max-w-md truncate px-3 py-2 font-mono text-xs text-fg-muted"
                    title={JSON.stringify(e.metadata)}
                  >
                    {Object.keys(e.metadata).length ? JSON.stringify(e.metadata) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── Billing ──────────────────────────────────────────────────────────────

export const money = (cents: number | null) =>
  cents === null
    ? 'Quoted'
    : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const CYCLE_COPY: Record<BillingCycle, { label: string; per: string; note: string }> = {
  monthly: { label: 'Monthly', per: 'month', note: 'Invoiced at the start of each month.' },
  annual: { label: 'Annual', per: 'year', note: 'Invoiced once a year. Two months free.' },
};

const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';

const sameProfile = (a: BillingProfile, b: BillingProfile) =>
  (Object.keys(a) as (keyof BillingProfile)[]).every((k) => a[k] === b[k]);

const INVOICE_TONE: Record<InvoiceInfo['status'], 'success' | 'attention' | 'default'> = {
  paid: 'success',
  open: 'attention',
  draft: 'default',
  void: 'default',
};
const INVOICE_LABEL: Record<InvoiceInfo['status'], string> = {
  paid: 'Paid',
  open: 'Due',
  draft: 'Draft',
  void: 'Void',
};

/** Plan summary, the details printed on invoices, and the invoices issued so far. */
export function BillingPanel({ owner }: { owner: string }) {
  const qc = useQueryClient();
  const key = ['billing', owner];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<BillingInfo>(`/owners/${enc(owner)}/billing`),
  });
  const [form, setForm] = useState<BillingProfile | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  useEffect(() => {
    if (q.data) setForm(q.data.profile);
  }, [q.data]);
  useEffect(() => {
    if (msg?.tone !== 'success') return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);
  const save = useMutation({
    mutationFn: () => api.put<BillingInfo>(`/owners/${enc(owner)}/billing`, form),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      setMsg({ tone: 'success', text: 'Billing details saved.' });
    },
    onError: (e) => setMsg({ tone: 'danger', text: errorMessage(e) }),
  });
  if (q.isLoading || !form) return q.error ? <Failure error={q.error} /> : <PageSpinner />;
  const b = q.data!;
  const plan = DEFAULT_PLANS[b.plan];
  const set = (patch: Partial<BillingProfile>) => {
    setMsg(null);
    setForm({ ...form, ...patch });
  };
  const dirty = !sameProfile(form, b.profile);
  const unit = (c: BillingCycle) =>
    c === 'annual' ? plan.priceAnnualCents : plan.priceMonthlyCents;
  const paid = (unit('monthly') ?? 1) > 0;
  const m = unit('monthly'),
    y = unit('annual');
  const annualSaving = m && y ? Math.round((1 - y / (m * 12)) * 100) : 0;
  const emailInvalid = form.email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email);

  return (
    <section className="space-y-6">
      <SectionTitle title="Billing">
        Plans are paid by invoice. What you enter here is printed on every invoice we send.
      </SectionTitle>

      {/* Plan summary */}
      <Box className="grid divide-y divide-border-muted sm:grid-cols-[minmax(0,1fr)_auto] sm:divide-x sm:divide-y-0">
        <div className="flex items-start gap-4 p-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-canvas-subtle text-fg-muted">
            <Receipt size={18} aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="label-mono mb-1">Current plan</p>
            <p className="flex items-center gap-2 text-lg font-medium tracking-tight">
              {plan.name}
              <PlanBadge plan={b.plan} />
            </p>
            <p className="mt-0.5 text-[13px] text-fg-muted">
              {b.seats} {b.seats === 1 ? 'seat' : 'seats'} · billed{' '}
              {b.cycle === 'annual' ? 'annually' : 'monthly'}
            </p>
          </div>
        </div>
        <div className="p-5 sm:min-w-[13rem] sm:text-right">
          <p className="label-mono mb-1">Next invoice</p>
          {b.nextPeriodCents === null ? (
            <>
              <p className="text-lg font-medium">Quoted</p>
              <p className="mt-0.5 text-[13px] text-fg-muted">Priced individually for you</p>
            </>
          ) : b.nextPeriodCents === 0 ? (
            <>
              <p className="text-lg font-medium">Nothing due</p>
              <p className="mt-0.5 text-[13px] text-fg-muted">The {plan.name} plan has no charge</p>
            </>
          ) : (
            <>
              <p className="text-lg font-medium tabular-nums">{money(b.nextPeriodCents)}</p>
              <p className="mt-0.5 text-[13px] text-fg-muted">
                per {CYCLE_COPY[b.cycle].per}, excluding tax
              </p>
            </>
          )}
        </div>
      </Box>

      {/* Billing details */}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!emailInvalid && dirty) save.mutate();
        }}
      >
        <Box>
          <BoxHeader className="flex-col items-start gap-0.5">
            <h3 className="text-sm font-medium">Billing details</h3>
            <p className="text-[13px] text-fg-muted">
              Who the invoice is addressed to. All fields are optional.
            </p>
          </BoxHeader>
          <div className="grid gap-x-6 gap-y-5 p-5 xl:grid-cols-[minmax(0,1fr)_15rem]">
            <div className="space-y-5">
              <fieldset>
                <legend className="mb-2 block text-sm font-medium text-fg">Billing cycle</legend>
                <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
                  {(['monthly', 'annual'] as const).map((c) => {
                    const on = form.cycle === c;
                    const u = unit(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => set({ cycle: c })}
                        className={cx(
                          'relative flex flex-col items-start gap-0.5 rounded-md border px-3.5 py-3 text-left transition-[border-color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-emphasis',
                          on
                            ? 'border-fg bg-canvas ring-1 ring-fg'
                            : 'border-border bg-canvas hover:border-fg-subtle',
                        )}
                      >
                        <span className="flex w-full items-center gap-2 text-sm font-medium">
                          <span
                            aria-hidden
                            className={cx(
                              'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                              on ? 'border-fg' : 'border-border',
                            )}
                          >
                            {on && <span className="h-1.5 w-1.5 rounded-full bg-fg" />}
                          </span>
                          {CYCLE_COPY[c].label}
                          {c === 'annual' && annualSaving > 0 && (
                            <Label tone="success" className="ml-auto">
                              Save {annualSaving}%
                            </Label>
                          )}
                        </span>
                        {paid && u !== null && (
                          <span className="pl-[22px] text-[13px] tabular-nums text-fg">
                            {money(u)}{' '}
                            <span className="text-fg-muted">/ seat / {CYCLE_COPY[c].per}</span>
                          </span>
                        )}
                        <span className="pl-[22px] text-xs text-fg-muted">
                          {CYCLE_COPY[c].note}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <div className="grid gap-5 sm:grid-cols-2">
                <FormField
                  label="Invoice email"
                  hint="Where invoices are sent."
                  error={emailInvalid ? 'Enter a valid email address.' : null}
                >
                  {(id) => (
                    <Input
                      id={id}
                      type="email"
                      autoComplete="email"
                      placeholder="accounts@example.com"
                      value={form.email}
                      invalid={emailInvalid}
                      onChange={(e) => set({ email: e.target.value.trim() })}
                    />
                  )}
                </FormField>
                <FormField label="Company or full name" hint="Shown as the billed party.">
                  {(id) => (
                    <Input
                      id={id}
                      autoComplete="organization"
                      placeholder="Acme Hardware Ltd"
                      value={form.company}
                      onChange={(e) => set({ company: e.target.value })}
                    />
                  )}
                </FormField>
              </div>

              <FormField label="Billing address">
                {(id) => (
                  <Textarea
                    id={id}
                    rows={3}
                    autoComplete="street-address"
                    placeholder={'12 Market Street\nCambridge CB2 3QZ\nUnited Kingdom'}
                    value={form.address}
                    onChange={(e) => set({ address: e.target.value })}
                  />
                )}
              </FormField>

              <div className="grid gap-5 sm:grid-cols-2">
                <FormField label="Tax ID" hint="VAT, GST or similar, if your company has one.">
                  {(id) => (
                    <Input
                      id={id}
                      placeholder="GB123456789"
                      value={form.taxId}
                      onChange={(e) => set({ taxId: e.target.value })}
                      className="font-mono"
                    />
                  )}
                </FormField>
                <FormField label="Purchase order number" hint="If your finance team needs one.">
                  {(id) => (
                    <Input
                      id={id}
                      placeholder="PO-0042"
                      value={form.poNumber}
                      onChange={(e) => set({ poNumber: e.target.value })}
                      className="font-mono"
                    />
                  )}
                </FormField>
              </div>
            </div>

            {/* What the "Bill to" block of the next invoice will say. */}
            <aside aria-label="Invoice preview" className="hidden xl:block">
              <div className="sticky top-20 rounded-md border border-border bg-canvas-subtle p-4 text-[13px]">
                <p className="label-mono mb-3">On your invoice</p>
                <p className="mb-1 text-xs text-fg-subtle">Bill to</p>
                {form.company || form.address || form.email ? (
                  <div className="space-y-0.5 break-words">
                    {form.company && <p className="font-medium">{form.company}</p>}
                    {form.address && (
                      <p className="whitespace-pre-line text-fg-muted">{form.address}</p>
                    )}
                    {form.email && <p className="text-fg-muted">{form.email}</p>}
                  </div>
                ) : (
                  <p className="text-fg-subtle">Your account name</p>
                )}
                {(form.taxId || form.poNumber) && (
                  <dl className="mt-3 space-y-1 border-t border-border-muted pt-3 text-xs">
                    {form.taxId && (
                      <div className="flex justify-between gap-2">
                        <dt className="text-fg-subtle">Tax ID</dt>
                        <dd className="truncate font-mono">{form.taxId}</dd>
                      </div>
                    )}
                    {form.poNumber && (
                      <div className="flex justify-between gap-2">
                        <dt className="text-fg-subtle">PO</dt>
                        <dd className="truncate font-mono">{form.poNumber}</dd>
                      </div>
                    )}
                  </dl>
                )}
              </div>
            </aside>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3 rounded-b-md border-t border-border bg-canvas-subtle px-5 py-3">
            <span
              role="status"
              className={cx(
                'mr-auto text-[13px]',
                msg?.tone === 'danger' ? 'text-danger' : msg ? 'text-success' : 'text-fg-muted',
              )}
            >
              {msg ? (
                <span className="inline-flex items-center gap-1.5">
                  {msg.tone === 'success' && <Check size={14} aria-hidden />}
                  {msg.text}
                </span>
              ) : dirty ? (
                'You have unsaved changes.'
              ) : (
                ''
              )}
            </span>
            {dirty && (
              <Button
                variant="invisible"
                size="sm"
                onClick={() => (setMsg(null), setForm(b.profile))}
              >
                Discard
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={save.isPending}
              disabled={!dirty || emailInvalid}
            >
              Save details
            </Button>
          </div>
        </Box>
      </form>

      {/* Invoices */}
      <Box>
        <BoxHeader>
          <h3 className="text-sm font-medium">Invoices</h3>
          {b.invoices.length > 0 && (
            <span className="ml-auto text-xs text-fg-subtle">{b.invoices.length} issued</span>
          )}
        </BoxHeader>
        {b.invoices.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-10 text-center">
            <FileText size={20} className="mb-3 text-fg-subtle" aria-hidden />
            <p className="text-sm font-medium">No invoices yet</p>
            <p className="mt-1 max-w-sm text-[13px] text-fg-muted">
              {paid
                ? 'Invoices appear here as soon as they are issued, with a printable copy of each.'
                : 'You are on the Free plan, so there is nothing to bill.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead>
                <tr className="border-b border-border-muted text-left text-xs text-fg-subtle">
                  <th className="px-5 py-2 font-normal">Invoice</th>
                  <th className="px-3 py-2 font-normal">Period</th>
                  <th className="px-3 py-2 font-normal">Status</th>
                  <th className="px-5 py-2 text-right font-normal">Amount</th>
                </tr>
              </thead>
              <tbody>
                {b.invoices.map((i) => (
                  <tr
                    key={i.id}
                    className="border-b border-border-muted transition-colors last:border-0 hover:bg-canvas-subtle"
                  >
                    <td className="px-5 py-3">
                      <Link
                        to="/billing/$owner/invoices/$id"
                        params={{ owner, id: i.id }}
                        className="link font-mono"
                      >
                        {i.number}
                      </Link>
                      {i.issuedAt && (
                        <p className="mt-0.5 text-xs text-fg-subtle">
                          Issued {shortDate(i.issuedAt)}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-fg-muted">
                      {shortDate(i.periodStart)} – {shortDate(i.periodEnd)}
                    </td>
                    <td className="px-3 py-3">
                      <Label tone={INVOICE_TONE[i.status]}>{INVOICE_LABEL[i.status]}</Label>
                      {i.status === 'open' && i.dueAt && (
                        <p className="mt-0.5 text-xs text-fg-subtle">by {shortDate(i.dueAt)}</p>
                      )}
                      {i.status === 'paid' && i.paidAt && (
                        <p className="mt-0.5 text-xs text-fg-subtle">{shortDate(i.paidAt)}</p>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right font-medium tabular-nums">
                      {money(i.totalCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Box>
    </section>
  );
}
