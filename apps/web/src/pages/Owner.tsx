import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import type { NamespaceInfo } from '@pcbhub/shared';
import { Avatar, PageSpinner, RelativeTime, buttonClass } from '@pcbhub/ui';
import { Link } from '@tanstack/react-router';
import { RepoList } from '../components/RepoList';
import { ErrorView, PageContainer, UserLink } from '../components/common';
import { api } from '../lib/api';
import { useMe } from '../lib/queries';

export function OwnerPage() {
  const { owner } = useParams({ strict: false }) as { owner: string };
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['namespace', owner.toLowerCase()], queryFn: () => api.get<NamespaceInfo>(`/namespaces/${encodeURIComponent(owner)}`) });
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;
  const ns = q.data!;
  const canCreate = me && (me.username.toLowerCase() === ns.slug.toLowerCase() || me.orgs.some((o) => o.slug.toLowerCase() === ns.slug.toLowerCase()));
  return (
    <PageContainer className="grid gap-8 py-8 md:grid-cols-[280px_1fr]">
      <aside>
        <Avatar name={ns.slug} src={ns.avatarUrl} size={240} square={ns.kind === 'org'} className="hidden md:inline-flex" />
        <Avatar name={ns.slug} src={ns.avatarUrl} size={72} square={ns.kind === 'org'} className="md:hidden" />
        <h1 className="mt-4 text-2xl font-semibold">{ns.name || ns.slug}</h1>
        <div className="text-lg font-light text-fg-muted">{ns.slug}</div>
        {ns.bio && <p className="mt-3 text-sm">{ns.bio}</p>}
        <div className="mt-3 flex items-center gap-1 text-xs text-fg-muted">
          {ns.kind === 'org' && <Building2 size={12} />} Joined <RelativeTime date={ns.createdAt} />
        </div>
        {ns.members && (
          <div className="mt-6">
            <h2 className="mb-2 text-sm font-semibold">Members</h2>
            <ul className="space-y-1">
              {ns.members.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-sm">
                  <UserLink user={m} />
                  {m.role === 'owner' && <span className="text-xs text-fg-muted">owner</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
      <section>
        <div className="flex items-center justify-between border-b border-border pb-2">
          <h2 className="font-semibold">
            Repositories <span className="text-fg-muted">{ns.repos.length}</span>
          </h2>
          {canCreate && (
            <Link to="/new" search={{ owner: ns.slug }} className={buttonClass('primary', 'sm')}>
              <Plus size={14} /> New
            </Link>
          )}
        </div>
        <RepoList repos={ns.repos} showOwner={false} empty={`${ns.slug} doesn’t have any repositories yet.`} />
      </section>
    </PageContainer>
  );
}
