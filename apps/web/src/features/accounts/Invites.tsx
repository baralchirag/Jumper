import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Trash2 } from 'lucide-react';
import type { CreatedInvite, InvitePreview, OrgInviteInfo } from '@jumper/shared';
import { Avatar, Button, CopyButton, Flash, IconButton, Input, PageSpinner, RelativeTime, Select, buttonClass } from '@jumper/ui';
import { ApiError, api, errorMessage } from '../../shared/lib/api';
import { keys, useMe } from '../../shared/lib/queries';

const enc = encodeURIComponent;
const ACCESS: Record<OrgInviteInfo['repoRole'], string> = { read: 'Viewer', review: 'Reviewer', write: 'Committer', admin: 'Admin' };

/** Owners make single-use invite links for people who are not in the organization yet (with or without an account). */
export function InvitePanel({ org }: { org: string }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'owner'>('member');
  const [repoRole, setRepoRole] = useState<OrgInviteInfo['repoRole']>('write');
  const [made, setMade] = useState<CreatedInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['org-invites', org], queryFn: () => api.get<OrgInviteInfo[]>(`/orgs/${enc(org)}/invites`) });
  const create = useMutation({
    mutationFn: () => api.post<CreatedInvite>(`/orgs/${enc(org)}/invites`, { role, repoRole, ...(email.trim() ? { email: email.trim() } : {}) }),
    onSuccess: (inv) => {
      setMade(inv);
      setEmail('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['org-invites', org] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${enc(org)}/invites/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['org-invites', org] }),
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <section aria-labelledby="invite-h">
      <h2 id="invite-h" className="mb-1 text-[15px] font-medium">Invite people</h2>
      <p className="mb-4 text-sm text-fg-muted">
        Make a link for someone who is not here yet. It works once, for 7 days; they sign in or create an account, then join. Add an email to send it to them as well.
      </p>
      {error && <Flash tone="danger" className="mb-3">{error}</Flash>}
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" aria-label="Email to send the invite to" className="min-w-52 flex-1" />
        <Select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'owner')} aria-label="Organization role" className="w-32">
          <option value="member">Member</option>
          <option value="owner">Owner</option>
        </Select>
        {role === 'member' && (
          <Select value={repoRole} onChange={(e) => setRepoRole(e.target.value as OrgInviteInfo['repoRole'])} aria-label="Repository access" className="w-36">
            {(Object.keys(ACCESS) as OrgInviteInfo['repoRole'][]).map((r) => (
              <option key={r} value={r}>
                {ACCESS[r]}
              </option>
            ))}
          </Select>
        )}
        <Button type="submit" variant="primary" loading={create.isPending} leadingIcon={<Link2 size={14} />}>
          Create link
        </Button>
      </form>

      {made && (
        <div className="mt-4 rounded-md border border-select bg-accent-subtle p-4">
          <p className="mb-2 text-sm font-medium">
            {made.emailed ? `Sent to ${made.email}. You can also share the link yourself:` : made.email ? `Mail is not configured here, so share this link with ${made.email}:` : 'Share this link. It is shown only now:'}
          </p>
          <div className="flex gap-1">
            <input readOnly value={made.link} aria-label="Invite link" onFocus={(e) => e.target.select()} className="h-9 min-w-0 flex-1 rounded-sm border border-border bg-canvas px-2 font-mono text-[13px]" />
            <CopyButton value={made.link} size="md" />
          </div>
        </div>
      )}

      {list.data && list.data.length > 0 && (
        <ul className="mt-6 divide-y divide-border-muted border-y border-border">
          {list.data.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate">{i.email ?? <span className="text-fg-muted">Link without an email</span>}</span>
              <span className="text-fg-muted">{i.role === 'owner' ? 'Owner' : `Member · ${ACCESS[i.repoRole]}`}</span>
              <span className="text-xs text-fg-subtle">
                by {i.createdBy ?? 'someone'}, expires <RelativeTime date={i.expiresAt} />
              </span>
              <IconButton label="Revoke invite" icon={<Trash2 size={15} />} onClick={() => revoke.mutate(i.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** /invite/:token: see which organization the link is for, then join it (after signing in if needed). */
export function InvitePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const { data: me, isLoading: meLoading } = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['invite', token, me?.id ?? ''], queryFn: () => api.get<InvitePreview>(`/invites/${enc(token)}`), retry: false });
  const accept = useMutation({
    mutationFn: () => api.post<{ org: string }>(`/invites/${enc(token)}/accept`),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: keys.me });
      void navigate({ to: '/$owner', params: { owner: r.org } });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  if (q.isLoading || meLoading) return <PageSpinner />;
  const here = `/invite/${token}`;
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-5 py-16">
      {q.error || !q.data ? (
        <>
          <h1 className="headline text-[2rem]">Invite not found</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-fg-muted">
            {q.error instanceof ApiError ? q.error.message : 'This invite link is invalid, used or expired.'} Ask whoever sent it for a new one.
          </p>
          <Link to="/" className={buttonClass('default', 'md', 'mt-6 w-fit')}>
            Go home
          </Link>
        </>
      ) : (
        <>
          <Avatar name={q.data.org.slug} src={q.data.org.avatarUrl} size={56} square />
          <h1 className="headline mt-6 text-[2rem]">Join {q.data.org.name}</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-fg-muted">
            {q.data.invitedBy ? `${q.data.invitedBy} invited you` : 'You were invited'} to join <span className="font-medium text-fg">{q.data.org.slug}</span> as {q.data.role === 'owner' ? 'an owner' : 'a member'}. The link expires <RelativeTime date={q.data.expiresAt} />.
          </p>
          {error && <Flash tone="danger" className="mt-4">{error}</Flash>}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {!me ? (
              <>
                <Link to="/signup" search={{ redirect: here }} className={buttonClass('accent', 'md')}>
                  Create an account
                </Link>
                <Link to="/login" search={{ redirect: here }} className={buttonClass('default', 'md')}>
                  Sign in
                </Link>
              </>
            ) : q.data.alreadyMember ? (
              <Link to="/$owner" params={{ owner: q.data.org.slug }} className={buttonClass('primary', 'md')}>
                You are already in {q.data.org.name}. Open it
              </Link>
            ) : (
              <>
                <Button variant="accent" loading={accept.isPending} onClick={() => accept.mutate()}>
                  Join as {me.username}
                </Button>
                <span className="text-[13px] text-fg-muted">Not you? Sign out first.</span>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
