import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { AppShell } from './AppShell';
import { NotFound } from '../shared/components/common';

// Every page is its own chunk: the landing page must not download the 3D viewer or the board renderer.
const OrgSettingsPage = lazyRouteComponent(() => import('../features/accounts/OrgSettings'), 'OrgSettingsPage');
const VerifyPage = lazyRouteComponent(() => import('../features/auth/Verify'), 'VerifyPage');
const ForgotPage = lazyRouteComponent(() => import('../features/auth/Reset'), 'ForgotPage');
const ResetPage = lazyRouteComponent(() => import('../features/auth/Reset'), 'ResetPage');
const LoginPage = lazyRouteComponent(() => import('../features/auth/Auth'), 'LoginPage');
const SignupPage = lazyRouteComponent(() => import('../features/auth/Auth'), 'SignupPage');
const HomePage = lazyRouteComponent(() => import('../features/home/Home'), 'HomePage');
const NewOrgPage = lazyRouteComponent(() => import('../features/accounts/NewOrg'), 'NewOrgPage');
const NewRepoPage = lazyRouteComponent(() => import('../features/accounts/NewRepo'), 'NewRepoPage');
const OwnerPage = lazyRouteComponent(() => import('../features/accounts/Owner'), 'OwnerPage');
const AdminDatabasePage = lazyRouteComponent(() => import('../features/admin/Admin'), 'AdminDatabasePage');
const AdminOverviewPage = lazyRouteComponent(() => import('../features/admin/Admin'), 'AdminOverviewPage');
const AdminUsersPage = lazyRouteComponent(() => import('../features/admin/Admin'), 'AdminUsersPage');
const DocsPage = lazyRouteComponent(() => import('../features/docs/Docs'), 'DocsPage');
const SettingsPage = lazyRouteComponent(() => import('../features/settings/Settings'), 'SettingsPage');
const BlobPage = lazyRouteComponent(() => import('../features/repo/Blob'), 'BlobPage');
const BranchesPage = lazyRouteComponent(() => import('../features/repo/Branches'), 'BranchesPage');
const ChecksPage = lazyRouteComponent(() => import('../features/repo/Checks'), 'ChecksPage');
const CodePage = lazyRouteComponent(() => import('../features/repo/Code'), 'CodePage');
const CommitPage = lazyRouteComponent(() => import('../features/repo/Commits'), 'CommitPage');
const CommitsPage = lazyRouteComponent(() => import('../features/repo/Commits'), 'CommitsPage');
const ComparePage = lazyRouteComponent(() => import('../features/repo/Compare'), 'ComparePage');
const OutputsPage = lazyRouteComponent(() => import('../features/repo/Outputs'), 'OutputsPage');
const PartsPage = lazyRouteComponent(() => import('../features/parts/PartsPage'), 'PartsPage');
const RepoLayout = lazyRouteComponent(() => import('../features/repo/RepoLayout'), 'RepoLayout');
const RepoSettingsPage = lazyRouteComponent(() => import('../features/repo/RepoSettings'), 'RepoSettingsPage');
const SearchPage = lazyRouteComponent(() => import('../features/search/Search'), 'SearchPage');
const RepoSearchPage = lazyRouteComponent(() => import('../features/search/Search'), 'RepoSearchPage');
const NotificationsPage = lazyRouteComponent(() => import('../features/notifications/Notifications'), 'NotificationsPage');
const PricingPage = lazyRouteComponent(() => import('../features/pricing/Pricing'), 'PricingPage');
const CheckoutPage = lazyRouteComponent(() => import('../features/pricing/Checkout'), 'CheckoutPage');
const CheckoutDonePage = lazyRouteComponent(() => import('../features/pricing/Checkout'), 'CheckoutDonePage');
const SharePage = lazyRouteComponent(() => import('../features/share/SharePage'), 'SharePage');
const TermsPage = lazyRouteComponent(() => import('../features/legal/Legal'), 'TermsPage');
const PrivacyPage = lazyRouteComponent(() => import('../features/legal/Legal'), 'PrivacyPage');
const RefundsPage = lazyRouteComponent(() => import('../features/legal/Legal'), 'RefundsPage');

type BlobTab = 'view' | 'compare' | 'render' | '3d' | 'bom' | 'fab' | 'firmware' | 'source';

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
const verifyRoute = createRoute({ getParentRoute: () => rootRoute, path: '/verify/$token', component: VerifyPage });
const forgotRoute = createRoute({ getParentRoute: () => rootRoute, path: '/forgot', component: ForgotPage });
const resetRoute = createRoute({ getParentRoute: () => rootRoute, path: '/reset/$token', component: ResetPage });
const signupRoute = createRoute({ getParentRoute: () => rootRoute, path: '/signup', validateSearch: (s: Record<string, unknown>): { ref?: string; redirect?: string } => ({ ref: str(s.ref), redirect: str(s.redirect) }), component: SignupPage });
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/invite/$token', component: lazyRouteComponent(() => import('../features/accounts/Invites'), 'InvitePage') });
const searchParams = (s: Record<string, unknown>): { q?: string; type?: 'repos' | 'files' | 'code' | 'parts' | 'nets' } => ({
  q: str(s.q),
  type: ['repos', 'files', 'code', 'parts', 'nets'].includes(String(s.type)) ? (s.type as 'repos') : undefined,
});
const searchRoute = createRoute({ getParentRoute: () => rootRoute, path: '/search', validateSearch: searchParams, component: SearchPage });
const newRepoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/new',
  validateSearch: (s: Record<string, unknown>): { owner?: string } => ({ owner: str(s.owner) }),
  component: NewRepoPage,
});
const orgSettingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/organizations/$org/settings', component: OrgSettingsPage });
const orgSettingsSectionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/organizations/$org/settings/$section', component: OrgSettingsPage });
const invoiceRoute = createRoute({ getParentRoute: () => rootRoute, path: '/billing/$owner/invoices/$id', component: lazyRouteComponent(() => import('../features/accounts/Invoice'), 'InvoicePage') });
const newOrgRoute = createRoute({ getParentRoute: () => rootRoute, path: '/organizations/new', component: NewOrgPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage });
const settingsSectionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/$section', component: SettingsPage });
const docsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/docs', component: DocsPage });
const docRoute = createRoute({ getParentRoute: () => rootRoute, path: '/docs/$slug', component: DocsPage });
const adminRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin', component: AdminOverviewPage });
const adminUsersRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/users', component: AdminUsersPage });
const adminInstanceRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/instance', component: lazyRouteComponent(() => import('../features/admin/Admin'), 'AdminInstancePage') });
const adminInvoicesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/invoices', component: lazyRouteComponent(() => import('../features/admin/Admin'), 'AdminInvoicesPage') });
type DbSearch = { page?: number; q?: string; sort?: string; dir?: 'asc' | 'desc' };
const dbSearch = (s: Record<string, unknown>): DbSearch => ({ page: num(s.page), q: str(s.q), sort: str(s.sort), dir: s.dir === 'asc' ? 'asc' : s.dir === 'desc' ? 'desc' : undefined });
const adminDbRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/database', validateSearch: dbSearch, component: AdminDatabasePage });
const adminTableRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/database/$table', validateSearch: dbSearch, component: AdminDatabasePage });
const notificationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notifications', component: NotificationsPage });
const pricingRoute = createRoute({ getParentRoute: () => rootRoute, path: '/pricing', validateSearch: (s: Record<string, unknown>): { for?: 'personal' | 'organization' } => ({ for: s.for === 'organization' ? 'organization' : s.for === 'personal' ? 'personal' : undefined }), component: PricingPage });
const checkoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/checkout',
  validateSearch: (s: Record<string, unknown>): { plan?: string; cycle?: string; owner?: string } => ({ plan: str(s.plan), cycle: str(s.cycle), owner: str(s.owner) }),
  component: CheckoutPage,
});
const checkoutDoneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/checkout/done',
  validateSearch: (s: Record<string, unknown>): { owner?: string; plan?: string } => ({ owner: str(s.owner), plan: str(s.plan) }),
  component: CheckoutDonePage,
});
const termsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/terms', component: TermsPage });
const privacyRoute = createRoute({ getParentRoute: () => rootRoute, path: '/privacy', component: PrivacyPage });
const refundsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/refunds', component: RefundsPage });
const embedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/embed/$owner/$repo',
  validateSearch: (s: Record<string, unknown>): { view?: 'pcb' | 'sch' | '3d'; branch?: string; path?: string } => ({ view: ['pcb', 'sch', '3d'].includes(String(s.view)) ? (s.view as 'pcb' | 'sch' | '3d') : undefined, branch: str(s.branch), path: str(s.path) }),
  component: lazyRouteComponent(() => import('../features/embed/EmbedViewer'), 'EmbedViewerPage'),
});
const shareRoute = createRoute({ getParentRoute: () => rootRoute, path: '/share/$token', component: SharePage });
const ownerRoute = createRoute({ getParentRoute: () => rootRoute, path: '/$owner', component: OwnerPage });

const repoRoute = createRoute({ getParentRoute: () => rootRoute, path: '/$owner/$repo', component: RepoLayout });
const repoIndexRoute = createRoute({ getParentRoute: () => repoRoute, path: '/', component: CodePage });
const treeRoute = createRoute({ getParentRoute: () => repoRoute, path: '/tree/$ref/$', component: CodePage });
const blobRoute = createRoute({
  getParentRoute: () => repoRoute,
  path: '/blob/$ref/$',
  validateSearch: (s: Record<string, unknown>): { tab?: BlobTab; check?: string; x?: number; y?: number; base?: string; head?: string } => ({
    tab: str(s.tab) as BlobTab | undefined,
    check: str(s.check),
    x: num(s.x),
    y: num(s.y),
    base: str(s.base),
    head: str(s.head),
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
const compareRoute = createRoute({
  getParentRoute: () => repoRoute,
  path: '/compare',
  validateSearch: (s: Record<string, unknown>): { base?: string; head?: string } => ({ base: str(s.base), head: str(s.head) }),
  component: ComparePage,
});
const checksRoute = createRoute({
  getParentRoute: () => repoRoute,
  path: '/checks',
  validateSearch: (s: Record<string, unknown>): { sha?: string } => ({ sha: str(s.sha) }),
  component: ChecksPage,
});
const outputsRoute = createRoute({
  getParentRoute: () => repoRoute,
  path: '/outputs',
  validateSearch: (s: Record<string, unknown>): { sha?: string; id?: string } => ({ sha: str(s.sha), id: str(s.id) }),
  component: OutputsPage,
});
const partsRoute = createRoute({ getParentRoute: () => repoRoute, path: '/parts', component: PartsPage });
// Stock-alert notifications link here.
const bomAlertsRoute = createRoute({ getParentRoute: () => repoRoute, path: '/bom-alerts', component: PartsPage });
const repoSettingsRoute = createRoute({ getParentRoute: () => repoRoute, path: '/settings', component: RepoSettingsPage });
const repoSettingsSectionRoute = createRoute({ getParentRoute: () => repoRoute, path: '/settings/$section', component: RepoSettingsPage });
const repoSearchRoute = createRoute({ getParentRoute: () => repoRoute, path: '/search', validateSearch: searchParams, component: RepoSearchPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  pricingRoute,
  checkoutRoute,
  checkoutDoneRoute,
  termsRoute,
  privacyRoute,
  refundsRoute,
  loginRoute,
  signupRoute,
  inviteRoute,
  forgotRoute,
  verifyRoute,
  resetRoute,
  searchRoute,
  newRepoRoute,
  newOrgRoute,
  orgSettingsRoute,
  orgSettingsSectionRoute,
  invoiceRoute,
  settingsRoute,
  settingsSectionRoute,
  docsRoute,
  docRoute,
  notificationsRoute,

  shareRoute,
  embedRoute,
  adminRoute,
  adminUsersRoute,
  adminInstanceRoute,
  adminInvoicesRoute,
  adminDbRoute,
  adminTableRoute,
  ownerRoute,
  repoRoute.addChildren([
    repoIndexRoute,
    treeRoute,
    blobRoute,
    commitsRoute,
    commitRoute,
    branchesRoute,
    compareRoute,
    checksRoute,
    outputsRoute,
    partsRoute,
    bomAlertsRoute,
    repoSettingsRoute,
    repoSettingsSectionRoute,
    repoSearchRoute,
  ]),
]);

/** Page chunks in the order people usually reach them; fetched one by one once the first page has settled. */
const WARM = [
  HomePage, PricingPage, LoginPage, SignupPage, DocsPage, SearchPage, RepoLayout, CodePage, BlobPage, OwnerPage,
  ChecksPage, OutputsPage, PartsPage, CommitsPage, CommitPage, BranchesPage, ComparePage, SettingsPage, RepoSettingsPage,
  NewRepoPage, NotificationsPage, NewOrgPage, OrgSettingsPage, TermsPage, AdminOverviewPage,
];

function warmPages() {
  const idle = (fn: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 200));
  let i = 0;
  const next = () => {
    const page = WARM[i++];
    if (!page) return;
    Promise.resolve(page.preload?.()).catch(() => {}).finally(() => idle(next));
  };
  setTimeout(() => idle(next), 1200);
}

export function makeRouter(queryClient: QueryClient) {
  const router = createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent', defaultPreloadDelay: 30, scrollRestoration: true });
  warmPages();
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
