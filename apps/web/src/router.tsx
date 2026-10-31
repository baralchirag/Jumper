import { createRootRouteWithContext, createRoute, createRouter } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { AppShell } from './components/AppShell';
import { NotFound } from './components/common';
import { LoginPage, SignupPage } from './pages/Auth';
import { ExplorePage } from './pages/Explore';
import { HomePage } from './pages/Home';
import { NewOrgPage } from './pages/NewOrg';
import { NewRepoPage } from './pages/NewRepo';
import { OwnerPage } from './pages/Owner';
import { ProfileSettingsPage, TokensSettingsPage } from './pages/Settings';
import { BlobPage } from './pages/repo/Blob';
import { BranchesPage } from './pages/repo/Branches';
import { ChecksPage } from './pages/repo/Checks';
import { CodePage } from './pages/repo/Code';
import { CommitPage, CommitsPage } from './pages/repo/Commits';
import { ComparePage } from './pages/repo/Compare';
import { PullPage } from './pages/repo/Pull';
import { PullsPage } from './pages/repo/Pulls';
import { RepoLayout } from './pages/repo/RepoLayout';
import { RepoSettingsPage } from './pages/repo/RepoSettings';

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: AppShell,
  notFoundComponent: () => <NotFound />,
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage });
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => ({ redirect: str(s.redirect) }),
  component: LoginPage,
});
const signupRoute = createRoute({ getParentRoute: () => rootRoute, path: '/signup', component: SignupPage });
const exploreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/explore',
  validateSearch: (s: Record<string, unknown>): { q?: string } => ({ q: str(s.q) }),
  component: ExplorePage,
});
const newRepoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/new',
  validateSearch: (s: Record<string, unknown>): { owner?: string } => ({ owner: str(s.owner) }),
  component: NewRepoPage,
});
const newOrgRoute = createRoute({ getParentRoute: () => rootRoute, path: '/organizations/new', component: NewOrgPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: ProfileSettingsPage });
const tokensRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/tokens', component: TokensSettingsPage });
const ownerRoute = createRoute({ getParentRoute: () => rootRoute, path: '/$owner', component: OwnerPage });

const repoRoute = createRoute({ getParentRoute: () => rootRoute, path: '/$owner/$repo', component: RepoLayout });
const repoIndexRoute = createRoute({ getParentRoute: () => repoRoute, path: '/', component: CodePage });
const treeRoute = createRoute({ getParentRoute: () => repoRoute, path: '/tree/$ref/$', component: CodePage });
const blobRoute = createRoute({
  getParentRoute: () => repoRoute,
  path: '/blob/$ref/$',
  validateSearch: (s: Record<string, unknown>): { tab?: 'view' | 'render' | '3d' | 'bom' | 'source'; check?: string; x?: number; y?: number } => ({
    tab: str(s.tab) as 'view' | 'render' | '3d' | 'bom' | 'source' | undefined,
    check: str(s.check),
    x: num(s.x),
    y: num(s.y),
  }),
  component: BlobPage,
});
const commitsRoute = createRoute({
  getParentRoute: () => repoRoute,
  path: '/commits/$ref',
  validateSearch: (s: Record<string, unknown>): { path?: string; page?: number } => ({ path: str(s.path), page: num(s.page) }),
  component: CommitsPage,
});
const commitRoute = createRoute({ getParentRoute: () => repoRoute, path: '/commit/$sha', component: CommitPage });
const branchesRoute = createRoute({ getParentRoute: () => repoRoute, path: '/branches', component: BranchesPage });
const pullsRoute = createRoute({
  getParentRoute: () => repoRoute,
  path: '/pulls',
  validateSearch: (s: Record<string, unknown>): { state?: 'open' | 'closed' | 'merged' | 'all' } => ({ state: str(s.state) as 'open' | 'closed' | 'merged' | 'all' | undefined }),
  component: PullsPage,
});
const compareRoute = createRoute({
  getParentRoute: () => repoRoute,
  path: '/compare',
  validateSearch: (s: Record<string, unknown>): { base?: string; head?: string } => ({ base: str(s.base), head: str(s.head) }),
  component: ComparePage,
});
const pullRoute = createRoute({
  getParentRoute: () => repoRoute,
  path: '/pull/$number',
  validateSearch: (s: Record<string, unknown>): { tab?: 'conversation' | 'commits' | 'checks' | 'files' } => ({ tab: str(s.tab) as 'conversation' | 'commits' | 'checks' | 'files' | undefined }),
  component: PullPage,
});
const checksRoute = createRoute({
  getParentRoute: () => repoRoute,
  path: '/checks',
  validateSearch: (s: Record<string, unknown>): { sha?: string } => ({ sha: str(s.sha) }),
  component: ChecksPage,
});
const repoSettingsRoute = createRoute({ getParentRoute: () => repoRoute, path: '/settings', component: RepoSettingsPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  signupRoute,
  exploreRoute,
  newRepoRoute,
  newOrgRoute,
  settingsRoute,
  tokensRoute,
  ownerRoute,
  repoRoute.addChildren([
    repoIndexRoute,
    treeRoute,
    blobRoute,
    commitsRoute,
    commitRoute,
    branchesRoute,
    pullsRoute,
    compareRoute,
    pullRoute,
    checksRoute,
    repoSettingsRoute,
  ]),
]);

export function makeRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent', scrollRestoration: true });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
