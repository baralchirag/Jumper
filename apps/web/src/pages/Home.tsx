import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CircuitBoard, GitPullRequest, ListChecks, Plus, Rotate3d } from 'lucide-react';
import type { RepoInfo } from '@pcbhub/shared';
import { Avatar, Box, BoxHeader, PageSpinner, buttonClass } from '@pcbhub/ui';
import { RepoList } from '../components/RepoList';
import { PageContainer } from '../components/common';
import { api } from '../lib/api';
import { useMe } from '../lib/queries';

function Landing() {
  const features = [
    { icon: <CircuitBoard size={20} />, title: 'Semantic diffs', body: 'See which footprints moved, which nets were rerouted and which values changed — matched by KiCad UUIDs, not text lines.' },
    { icon: <GitPullRequest size={20} />, title: 'Pull requests for hardware', body: 'Review boards side by side, overlaid or with a swipe, and comment directly on components, pads and tracks.' },
    { icon: <ListChecks size={20} />, title: 'ERC, DRC and BOM checks', body: 'Every push runs kicad-cli in a sandbox. Required checks block merges until the design is clean.' },
    { icon: <Rotate3d size={20} />, title: 'Native-feeling viewers', body: 'WebGL schematic and PCB viewers in KiCad colours, plus a 3D board view from KiCad’s own exports.' },
  ];
  return (
    <div>
      <section className="border-b border-border bg-canvas-subtle">
        <PageContainer className="py-20">
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight md:text-5xl">Version control and review for KiCad hardware.</h1>
          <p className="mt-4 max-w-xl text-lg text-fg-muted">Push your KiCad projects with git. Browse schematics and boards in the browser, review visual diffs, and merge with confidence.</p>
          <div className="mt-8 flex gap-3">
            <Link to="/signup" className={buttonClass('primary', 'md', 'h-10 px-5 text-base')}>
              Get started
            </Link>
            <Link to="/explore" search={{ q: '' }} className={buttonClass('default', 'md', 'h-10 px-5 text-base')}>
              Explore projects
            </Link>
          </div>
        </PageContainer>
      </section>
      <PageContainer className="grid gap-6 py-12 md:grid-cols-2 lg:grid-cols-4">
        {features.map((f) => (
          <div key={f.title}>
            <div className="mb-3 inline-flex rounded-md border border-border bg-canvas-subtle p-2 text-accent">{f.icon}</div>
            <h3 className="font-semibold">{f.title}</h3>
            <p className="mt-1 text-sm text-fg-muted">{f.body}</p>
          </div>
        ))}
      </PageContainer>
    </div>
  );
}

export function HomePage() {
  const { data: me, isLoading } = useMe();
  const mine = useQuery({ queryKey: ['repos', 'mine'], queryFn: () => api.get<RepoInfo[]>('/repos', { mine: true }), enabled: Boolean(me) });
  const recent = useQuery({ queryKey: ['repos', 'explore', ''], queryFn: () => api.get<RepoInfo[]>('/repos'), enabled: Boolean(me) });
  if (isLoading) return <PageSpinner />;
  if (!me) return <Landing />;
  return (
    <PageContainer className="grid gap-8 py-8 md:grid-cols-[300px_1fr]">
      <aside>
        <div className="mb-4 flex items-center gap-2">
          <Avatar name={me.username} src={me.avatarUrl} size={32} />
          <span className="font-semibold">{me.username}</span>
        </div>
        <Box>
          <BoxHeader className="justify-between">
            <span className="text-sm font-semibold">Your repositories</span>
            <Link to="/new" className={buttonClass('primary', 'sm')}>
              <Plus size={14} /> New
            </Link>
          </BoxHeader>
          <ul className="max-h-[60vh] overflow-auto px-4 py-2">
            {mine.data?.map((r) => (
              <li key={r.id} className="py-1 text-sm">
                <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="flex items-center gap-2 hover:text-accent">
                  <Avatar name={r.owner} size={16} square={r.ownerKind === 'org'} />
                  <span className="truncate">
                    {r.owner}/<strong>{r.name}</strong>
                  </span>
                </Link>
              </li>
            ))}
            {mine.data?.length === 0 && <li className="py-2 text-sm text-fg-muted">Create your first repository to get started.</li>}
          </ul>
        </Box>
      </aside>
      <section>
        <h2 className="mb-2 text-base font-semibold">Recently updated</h2>
        {recent.isLoading ? <PageSpinner /> : <RepoList repos={recent.data ?? []} />}
      </section>
    </PageContainer>
  );
}
