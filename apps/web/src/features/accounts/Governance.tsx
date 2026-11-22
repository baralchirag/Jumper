// Owner governance screens: repository roles for members, custom roles, organization policy, single sign-on
// and the audit log. Shown inside organization settings.
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import {
  CAPABILITY_LABELS,
  CUSTOM_ROLE_CAPS,
  DEFAULT_ORG_POLICY,
  REPO_ROLES,
  ROLE_LABELS,
  type CustomRoleInfo,
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
import { api, errorMessage } from '../../shared/lib/api';

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
  return <Flash tone="danger">{errorMessage(error)}</Flash>;
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
      api.get<{ policy: OrgPolicy }>(`/owners/${enc(owner)}/policy`),
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
  const set = <K extends keyof OrgPolicy>(k: K, v: OrgPolicy[K]) => setP({ ...p, [k]: v });

  return (
    <section className="space-y-8">
      <SectionTitle title="Policies">
        Rules applied to every repository in the organization, on top of each repository's own
        settings. Repository admins cannot loosen them.
      </SectionTitle>
      <fieldset className="space-y-4">
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

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-medium">Security</legend>
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
        pushes and sign-ins.
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
