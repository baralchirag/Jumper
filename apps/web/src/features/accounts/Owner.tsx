import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CalendarDays, FolderGit2, Link2, MapPin, Pin, Plus, Settings, Star, Tag, Users } from 'lucide-react';
import type { NamespaceInfo } from '@jumper/shared';
import { Avatar, Button, Checkbox, Dialog, Flash, PageSpinner, buttonClass } from '@jumper/ui';
import { BoardCard } from '../../shared/components/BoardCard';
import { errorMessage } from '../../shared/lib/api';
import { Link } from '@tanstack/react-router';
import { RepoList } from '../../shared/components/RepoList';
import { ErrorView, PageContainer, UserLink } from '../../shared/components/common';
import { api } from '../../shared/lib/api';
import { useMe } from '../../shared/lib/queries';
import { FollowButton, PeopleDialog } from './People';
import { PlanBadge } from '../../shared/components/PlanBadge';

export function OwnerPage() {
  const { owner } = useParams({ strict: false }) as { owner: string };
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['namespace', owner.toLowerCase()], queryFn: () => api.get<NamespaceInfo>(`/namespaces/${encodeURIComponent(owner)}`) });
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;
  const ns = q.data!;
  const canCreate = me && (me.username.toLowerCase() === ns.slug.toLowerCase() || me.orgs.some((o) => o.slug.toLowerCase() === ns.slug.toLowerCase()));
  const isOrg = ns.kind === 'org';
  const joined = new Date(ns.createdAt);
  const isMe = Boolean(me && me.username.toLowerCase() === ns.slug.toLowerCase());
  return (
    <>
      <section className="relative overflow-hidden border-b border-border bg-canvas">
        <PageContainer className="relative grid gap-8 py-10 md:grid-cols-[auto_minmax(0,1fr)] md:items-end md:py-14">
          <div className="w-fit">
            <Avatar name={ns.slug} src={ns.avatarUrl} size={132} square={isOrg} className="hidden md:inline-flex" />
            <Avatar name={ns.slug} src={ns.avatarUrl} size={80} square={isOrg} className="md:hidden" />
          </div>
          <div className="min-w-0">
            {isOrg && (
              <p className="mb-3 flex items-center gap-1.5 text-sm text-fg-muted">
                <Building2 size={14} aria-hidden /> Organization
              </p>
            )}
            <h1 className="display flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--t-xl)]">
              <span>{ns.name || ns.slug}</span>
              <PlanBadge plan={ns.plan} className="px-2 text-[12px] leading-[20px]" />
            </h1>
            {ns.bio && <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-fg-muted">{ns.bio}</p>}
          </div>
        </PageContainer>
        <PageContainer className="relative pb-8">
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-4 text-[13px] text-fg-muted">
            <li className="font-mono text-xs text-fg">
              @{ns.slug}
              {ns.pronouns && <span className="text-fg-muted"> · {ns.pronouns}</span>}
            </li>
            {ns.company && (
              <li className="flex items-center gap-1.5">
                <Building2 size={13} /> {ns.company}
              </li>
            )}
            {ns.location && (
              <li className="flex items-center gap-1.5">
                <MapPin size={13} /> {ns.location}
              </li>
            )}
            {ns.website && (
              <li className="flex min-w-0 items-center gap-1.5">
                <Link2 size={13} />
                <a href={ns.website} rel="nofollow noopener noreferrer" target="_blank" className="link truncate">
                  {ns.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                </a>
              </li>
            )}
            <li className="flex items-center gap-1.5">
              <FolderGit2 size={13} /> <span className="font-mono tabular-nums text-fg">{ns.repos.length}</span> projects
            </li>
            {ns.stats && ns.stats.releases > 0 && (
              <li className="flex items-center gap-1.5">
                <Tag size={13} /> <span className="font-mono tabular-nums text-fg">{ns.stats.releases}</span> releases
              </li>
            )}
            {ns.stats && ns.stats.starsReceived > 0 && (
              <li className="flex items-center gap-1.5" title="Stars on public projects">
                <Star size={13} fill="currentColor" fillOpacity={0.25} /> <span className="font-mono tabular-nums text-fg">{ns.stats.starsReceived}</span> stars received
              </li>
            )}
            {ns.starCount !== undefined && (
              <li className="flex items-center gap-1.5">
                <Star size={13} /> <span className="font-mono tabular-nums text-fg">{ns.starCount}</span> starred
              </li>
            )}
            <li className="flex items-center gap-1.5">
              <CalendarDays size={13} /> Joined {joined.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}
            </li>
            {!isOrg && ns.followers !== undefined && <PeopleCounts ns={ns} />}
            {isMe ? (
              <li className="ml-auto">
                <Link to="/settings" className={buttonClass('default', 'sm')}>
                  Edit profile
                </Link>
              </li>
            ) : (
              !isOrg && (
                <li className="ml-auto">
                  <FollowButton username={ns.slug} following={Boolean(ns.viewerFollows)} />
                </li>
              )
            )}
          </ul>
        </PageContainer>
      </section>

      {(ns.pinned?.length || canCreate) && ns.repos.length > 0 ? (
        <PageContainer className="pt-10">
          <section aria-labelledby="pinned-h">
            <div className="mb-3 flex items-center justify-between border-b border-border pb-2">
              <h2 id="pinned-h" className="flex items-center gap-1.5 text-[13px] font-medium"><Pin size={13} /> Pinned</h2>
              {canCreate && <PinEditor ns={ns} />}
            </div>
            {ns.pinned?.length ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {ns.pinned.map((r) => <BoardCard key={r.id} repo={r} showOwner={false} />)}
              </div>
            ) : (
              <p className="text-[13px] text-fg-muted">Pin up to six boards to show them first, with a render of each. Your profile works as a portfolio you can link from a CV.</p>
            )}
          </section>
        </PageContainer>
      ) : null}

      <PageContainer className="grid gap-10 py-10 md:grid-cols-[minmax(0,1fr)_240px] md:gap-14">
        <section aria-labelledby="repos-h" className="min-w-0">
          <div className="flex items-center justify-between border-b border-border pb-2">
            <h2 id="repos-h" className="text-[13px] font-medium">
              Projects <span className="ml-1 font-mono text-xs text-fg-subtle">{ns.repos.length}</span>
            </h2>
            <span className="flex items-center gap-2">
              {isOrg && canCreate && (
                <Link to="/organizations/$org/settings" params={{ org: ns.slug }} className={buttonClass('default', 'sm')}>
                  <Settings size={14} /> Settings
                </Link>
              )}
              {canCreate && (
                <Link to="/new" search={{ owner: ns.slug }} className={buttonClass('accent', 'sm')}>
                  <Plus size={14} /> New
                </Link>
              )}
            </span>
          </div>
          <RepoList
            repos={ns.repos}
            showOwner={false}
            empty={canCreate ? 'No repositories yet. Push a KiCad project, import one from GitHub, or start from the example board.' : `${ns.slug} doesn’t have any public repositories yet.`}
            emptyAction={
              canCreate ? (
                <Link to="/new" search={{ owner: ns.slug }} className={buttonClass('accent', 'sm')}>
                  <Plus size={14} /> New repository
                </Link>
              ) : undefined
            }
          />
        </section>
        <aside className="space-y-10">
          <PushTimeline repos={ns.repos} />
        {ns.members && (
          <div aria-labelledby="members-h">
            <h2 id="members-h" className="border-b border-border pb-2 text-[13px] font-medium">
              Members <span className="ml-1 font-mono text-xs text-fg-subtle">{ns.members.length}</span>
            </h2>
            <ul>
              {ns.members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 border-b border-border-muted py-2.5 text-[13px]">
                  <UserLink user={m} />
                  {m.role === 'owner' && <span className="font-mono text-[11.5px] uppercase tracking-[0.06em] text-fg-subtle">owner</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        </aside>
      </PageContainer>
    </>
  );
}

/** Each project's most recent push placed on a 12-month axis, like test points on a scope trace. */
function PushTimeline({ repos }: { repos: NamespaceInfo['repos'] }) {
  const now = Date.now();
  const span = 365 * 24 * 3600 * 1000;
  const points = repos
    .map((r) => ({ name: r.name, t: new Date(r.pushedAt ?? r.updatedAt).getTime() }))
    .filter((p) => now - p.t <= span)
    .sort((a, b) => a.t - b.t);
  const months = Array.from({ length: 12 }, (_, i) => new Date(new Date().getFullYear(), new Date().getMonth() - 11 + i, 1));
  return (
    <section aria-labelledby="activity-h">
      <h2 id="activity-h" className="border-b border-border pb-2 text-[13px] font-medium">
        Activity
      </h2>
      <p className="mt-2 text-xs text-fg-muted">Latest push per project, past 12 months.</p>
      <div className="relative mt-5 h-16" role="img" aria-label={`${points.length} of ${repos.length} projects pushed in the past 12 months`}>
        <div className="absolute inset-x-0 top-8 h-px bg-border" />
        {months.map((m, i) => (
          <span key={i} className="absolute top-[30px] h-1.5 w-px bg-fg-subtle/50" style={{ left: `${(i / 11) * 100}%` }} />
        ))}
        {points.map((p) => {
          const x = Math.min(1, Math.max(0, 1 - (now - p.t) / span));
          return (
            <span
              key={p.name}
              title={`${p.name} · ${new Date(p.t).toLocaleDateString()}`}
              className="absolute top-[27px] h-[11px] w-[3px] -translate-x-1/2 bg-accent-emphasis"
              style={{ left: `${x * 100}%` }}
            />
          );
        })}
        <div className="absolute inset-x-0 top-11 flex justify-between font-mono text-[11.5px] text-fg-subtle">
          <span>{months[0]!.toLocaleDateString(undefined, { month: 'short' })}</span>
          <span>now</span>
        </div>
      </div>
    </section>
  );
}

/** Choose up to six of the owner's repositories to pin, in the order ticked. */
function PinEditor({ ns }: { ns: NamespaceInfo }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = () => {
    setPicked((ns.pinned ?? []).map((r) => r.name));
    setError(null);
    setOpen(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/namespaces/${encodeURIComponent(ns.slug)}/pins`, { repos: picked });
      await qc.invalidateQueries({ queryKey: ['namespace', ns.slug.toLowerCase()] });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="invisible" onClick={start}>Customize pins</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Pinned boards" footer={<Button variant="primary" loading={busy} onClick={() => void save()}>Save pins</Button>}>
        <p className="mb-3 text-[13px] text-fg-muted">{picked.length} of 6 chosen. They show in the order you tick them.</p>
        {error && <Flash tone="danger" className="mb-3">{error}</Flash>}
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {ns.repos.map((r) => (
            <Checkbox
              key={r.id}
              label={r.name}
              hint={r.description || undefined}
              checked={picked.includes(r.name)}
              disabled={!picked.includes(r.name) && picked.length >= 6}
              onChange={(e) => setPicked(e.target.checked ? [...picked, r.name] : picked.filter((n) => n !== r.name))}
            />
          ))}
        </div>
      </Dialog>
    </>
  );
}

/** "12 followers · 4 following", each opening the list. */
function PeopleCounts({ ns }: { ns: NamespaceInfo }) {
  const [open, setOpen] = useState<'followers' | 'following' | null>(null);
  return (
    <li className="flex items-center gap-1.5">
      <Users size={13} aria-hidden />
      <button type="button" onClick={() => setOpen('followers')} className="hover:text-fg">
        <span className="font-mono tabular-nums text-fg">{ns.followers}</span> {ns.followers === 1 ? 'follower' : 'followers'}
      </button>
      <span aria-hidden>·</span>
      <button type="button" onClick={() => setOpen('following')} className="hover:text-fg">
        <span className="font-mono tabular-nums text-fg">{ns.following}</span> following
      </button>
      <PeopleDialog username={ns.slug} kind={open ?? 'followers'} open={open !== null} onClose={() => setOpen(null)} />
    </li>
  );
}
