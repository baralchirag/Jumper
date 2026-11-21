import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Bell, Building2, Database, KeyRound, LogOut, Menu, Monitor, Moon, Plus, Search, Settings, Shield, Sun, Tag, User } from 'lucide-react';
import { Avatar, Dropdown, MenuHeader, MenuItem, cx } from '@jumper/ui';
import { NotificationBell } from '../features/notifications/Notifications';
import { api } from '../shared/lib/api';
import { keys, useMe, useProviders } from '../shared/lib/queries';
import { useThemePref, type ThemePref } from '../shared/lib/theme';
import { PlanBadge, isPaidPlan } from '../shared/components/PlanBadge';

/** Jumper "j": a wire stem whose dot has jumped off along a dashed arc, like a jumper wire leaving its pad. */
function JumperJ() {
  return (
    <>
      <path d="M46 96 V158 Q46 184 18 184" fill="none" stroke="currentColor" strokeWidth="18" />
      <path d="M46 80 Q50 34 72 30" fill="none" stroke="var(--pcb-trace)" strokeWidth="4" strokeLinecap="round" strokeDasharray="1 9" />
      <circle cx="84" cy="32" r="11" fill="var(--pcb-trace)" />
    </>
  );
}

/** The mark on its own (favicon-style "j"). Ink follows `currentColor`, the dot is copper. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="-34 17 180 180" className={className} aria-hidden>
      <JumperJ />
    </svg>
  );
}

const UMPER = 'M81.44 158.96Q74.6 158.96 69.32 155.9Q64.03999999999999 152.84 61.16 147.26Q58.28 141.68 58.28 134.24V98.72H71.96000000000001V133.16Q71.96000000000001 140.36 75.5 143.84Q79.03999999999999 147.32 85.52 147.32Q92.84 147.32 97.1 142.51999999999998Q101.36 137.72 101.36 128.72V98.72H115.03999999999999V158.0H101.6V149.72H99.56Q98.0 152.96 93.86 155.96Q89.72 158.96 81.44 158.96Z M127.56 158.0V98.72H141.12V105.32H143.16Q144.72 102.32 148.38 99.97999999999999Q152.04 97.64 158.16 97.64Q164.64 97.64 168.6 100.28Q172.56 102.92 174.6 107.0H176.51999999999998Q178.56 102.92 182.4 100.28Q186.24 97.64 193.32 97.64Q198.83999999999997 97.64 203.33999999999997 100.03999999999999Q207.83999999999997 102.44 210.54 107.12Q213.24 111.80000000000001 213.24 118.75999999999999V158.0H199.44V119.72Q199.44 114.56 196.68 111.86Q193.92 109.16 189.0 109.16Q183.6 109.16 180.42000000000002 112.7Q177.24 116.24000000000001 177.24 122.84V158.0H163.56V119.72Q163.56 114.56 160.8 111.86Q158.04 109.16 153.12 109.16Q147.6 109.16 144.48 112.7Q141.35999999999999 116.24000000000001 141.35999999999999 122.84V158.0Z M225.15999999999997 182.0V98.72H238.71999999999997V106.52000000000001H240.76Q242.79999999999998 102.80000000000001 247.29999999999998 99.92Q251.79999999999998 97.03999999999999 260.2 97.03999999999999Q267.4 97.03999999999999 273.58 100.58Q279.76 104.12 283.48 110.96000000000001Q287.2 117.80000000000001 287.2 127.4V129.32Q287.2 138.92000000000002 283.48 145.76Q279.76 152.6 273.64 156.14Q267.52 159.68 260.2 159.68Q254.55999999999997 159.68 250.77999999999997 158.36Q246.99999999999997 157.04 244.65999999999997 154.88Q242.31999999999996 152.72 240.99999999999997 150.56H238.95999999999998V182.0ZM256.12 147.68Q263.67999999999995 147.68 268.53999999999996 142.82Q273.4 137.96 273.4 128.96V127.76Q273.4 118.64 268.47999999999996 113.84Q263.55999999999995 109.03999999999999 256.12 109.03999999999999Q248.67999999999998 109.03999999999999 243.7 113.84Q238.71999999999997 118.64 238.71999999999997 127.76V128.96Q238.71999999999997 137.96 243.7 142.82Q248.67999999999998 147.68 256.12 147.68Z M323.96 159.68Q315.08 159.68 308.29999999999995 155.9Q301.52 152.12 297.74 145.22Q293.96 138.32 293.96 129.08V127.64Q293.96 118.28 297.67999999999995 111.44Q301.4 104.6 308.12 100.82Q314.84 97.03999999999999 323.59999999999997 97.03999999999999Q332.24 97.03999999999999 338.72 100.82Q345.2 104.6 348.79999999999995 111.44Q352.4 118.28 352.4 127.4V132.32H307.88Q308.12 139.28 312.79999999999995 143.48000000000002Q317.47999999999996 147.68 324.32 147.68Q331.03999999999996 147.68 334.28 144.74Q337.52 141.8 339.2 138.08L350.59999999999997 143.96Q348.91999999999996 147.2 345.74 150.86Q342.56 154.52 337.28 157.10000000000002Q332.0 159.68 323.96 159.68ZM308.0 121.88H338.36Q337.88 116.0 333.86 112.52Q329.84 109.03999999999999 323.47999999999996 109.03999999999999Q316.88 109.03999999999999 312.91999999999996 112.52Q308.96 116.0 308.0 121.88Z M361.55999999999995 158.0V98.72H375.11999999999995V105.56H377.15999999999997Q378.47999999999996 101.84 381.59999999999997 100.16Q384.71999999999997 98.48 389.03999999999996 98.48H396.23999999999995V110.72H388.79999999999995Q382.79999999999995 110.72 379.0799999999999 113.9Q375.35999999999996 117.08 375.35999999999996 123.68V158.0Z';

/** The full "jumper" logotype. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="6 18 394 178" className={cx('h-[28px] w-auto', className)} role="img" aria-label="Jumper">
      <JumperJ />
      <path d={UMPER} fill="currentColor" />
    </svg>
  );
}

function HeaderSearch() {
  const navigate = useNavigate();
  // Inside a repository the box searches that repository first.
  const { owner, repo } = useParams({ strict: false }) as { owner?: string; repo?: string };
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const slash = e.key === '/' && !e.metaKey && !e.ctrlKey;
      const cmdK = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey);
      if (!slash && !cmdK) return;
      if (slash && t.closest('input, textarea, select, [contenteditable="true"], .cm-editor')) return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    ref.current?.blur();
    if (owner && repo) void navigate({ to: '/$owner/$repo/search', params: { owner, repo }, search: { q } });
    else void navigate({ to: '/search', search: { q } });
  };
  return (
    <form onSubmit={submit} role="search" className="group/search relative hidden w-[min(18rem,26vw)] md:block">
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-header-fg/40 transition-colors group-focus-within/search:text-header-fg/80" />
      <input
        ref={ref}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && ref.current?.blur()}
        placeholder={owner && repo ? 'Search this repository' : 'Search'}
        aria-label={owner && repo ? `Search ${owner}/${repo}` : 'Search repositories, parts, nets and issues'}
        className="h-7 w-full rounded-sm border border-header-fg/10 bg-header-fg/[0.03] pl-8 pr-9 text-[13px] text-header-fg placeholder:text-header-fg/70 transition-[border-color,background-color] hover:border-header-fg/20 focus:border-header-fg/35 focus:bg-header-fg/[0.06] focus:outline-none"
      />
      <kbd aria-hidden className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 rounded-xs border border-header-fg/12 px-1 font-mono text-[11.5px] leading-4 text-header-fg/40 group-focus-within/search:opacity-0">
        /
      </kbd>
    </form>
  );
}

const THEMES: { value: ThemePref; label: string; icon: ReactNode }[] = [
  { value: 'system', label: 'System', icon: <Monitor size={13} /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={13} /> },
  { value: 'light', label: 'Light', icon: <Sun size={13} /> },
];

/** Three-way theme switch, used in the footer and the account menu. */
export function ThemeSwitch({ className }: { className?: string }) {
  const [pref, setPref] = useThemePref();
  return (
    <div role="radiogroup" aria-label="Theme" className={cx('inline-flex rounded-sm border border-border p-0.5', className)}>
      {THEMES.map((t) => (
        <button
          key={t.value}
          role="radio"
          aria-checked={pref === t.value}
          aria-label={t.label}
          title={t.label}
          onClick={() => setPref(t.value)}
          className={cx('flex h-6 w-7 items-center justify-center rounded-xs transition-colors', pref === t.value ? 'bg-neutral-muted text-fg' : 'text-fg-subtle hover:text-fg')}
        >
          {t.icon}
        </button>
      ))}
    </div>
  );
}

const headerLink =
  'relative flex h-7 items-center rounded-sm px-2.5 text-[13px] text-header-fg/65 no-underline transition-colors hover:bg-header-fg/[0.06] hover:text-header-fg data-[status=active]:text-header-fg';

/** Fade the routed page in on pathname changes without remounting it. */
function useRouteTransition() {
  const { pathname } = useLocation();
  const ref = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.animate([{ opacity: 0.75 }, { opacity: 1 }], { duration: 140, easing: 'cubic-bezier(.2,.7,0,1)' });
  }, [pathname]);
  return ref;
}

/** Shown to signed-in accounts that have not confirmed their email, on instances that require it. */
function VerifyBanner() {
  const { data: me } = useMe();
  const providers = useProviders();
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  if (!me || me.emailVerified || !providers.data?.emailVerification) return null;
  const resend = async () => {
    setState('busy');
    try {
      await api.post('/auth/verify/resend');
    } finally {
      setState('sent');
    }
  };
  return (
    <div role="status" className="border-b border-attention/30 bg-attention-subtle">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-sm md:px-8">
        <span>
          Confirm <b className="font-medium">{me.email}</b> to create repositories and push. We sent you a link.
        </span>
        <button onClick={() => void resend()} disabled={state !== 'idle'} className="link disabled:text-fg-muted disabled:no-underline">
          {state === 'sent' ? 'Link sent again' : state === 'busy' ? 'Sending…' : 'Resend the link'}
        </button>
      </div>
    </div>
  );
}

/** Thin bar under the header while a page chunk or its data loads, so a click always gets immediate feedback. */
function NavProgress() {
  const loading = useRouterState({ select: (s) => s.isLoading });
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!loading) return void setShow(false);
    const t = setTimeout(() => setShow(true), 120);
    return () => clearTimeout(t);
  }, [loading]);
  if (!show) return null;
  return <div aria-hidden className="nav-progress pointer-events-none fixed inset-x-0 top-12 z-50 h-0.5 bg-select" />;
}

export function AppShell() {
  // Embeds run inside other sites' iframes: no header, footer or account chrome.
  if (useLocation().pathname.startsWith('/embed/')) return <Outlet />;
  return <FullShell />;
}

function FullShell() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const mainRef = useRouteTransition();
  const go = (to: string) => void navigate({ to });

  const logout = async () => {
    await api.post('/auth/logout');
    qc.setQueryData(keys.me, null);
    await qc.invalidateQueries();
    void navigate({ to: '/' });
  };

  const nav = [
    // Paying accounts have already chosen: the pricing page is for people still deciding.
    ...(isPaidPlan(me?.plan) ? [] : [{ to: '/pricing', label: 'Pricing', icon: <Tag size={14} /> }]),
    { to: '/docs', label: 'Docs', icon: <BookOpen size={14} /> },
    ...(me?.isAdmin ? [{ to: '/admin', label: 'Admin', icon: <Shield size={14} /> }] : []),
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only z-[60] rounded-sm bg-accent-emphasis px-3 py-2 text-sm font-medium text-fg-on-accent focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-border bg-header/[0.94] text-header-fg backdrop-blur-md">
        <div className="mx-auto flex h-12 max-w-[1280px] items-center gap-2 px-5 md:gap-4 md:px-8">
          <Dropdown
            width={220}
            trigger={({ toggle, open }) => (
              <button onClick={toggle} aria-label="Menu" aria-expanded={open} className="-ml-1.5 flex h-8 w-8 items-center justify-center rounded-sm text-header-fg/70 hover:bg-header-fg/[0.06] hover:text-header-fg md:hidden">
                <Menu size={17} />
              </button>
            )}
          >
            {(close) => (
              <div className="py-1">
                {nav.map((n) => (
                  <MenuItem key={n.to} icon={n.icon} onClick={() => (close(), go(n.to))}>
                    {n.label}
                  </MenuItem>
                ))}
              </div>
            )}
          </Dropdown>
          <Link to="/" aria-label="Jumper home" className="-ml-1 flex items-center rounded-sm px-1 py-1 text-header-fg no-underline">
            <Wordmark />
          </Link>
          <nav aria-label="Primary" className="ml-2 hidden items-center gap-0.5 md:flex">
            {nav.map((n) => (
              <Link key={n.to} to={n.to} className={headerLink} activeOptions={{ exact: n.to === '/docs' ? false : true }}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <HeaderSearch />
            {me ? (
              <>
                <Dropdown
                  align="right"
                  width={220}
                  trigger={({ toggle, open }) => (
                    <button
                      onClick={toggle}
                      aria-label="Create new"
                      aria-expanded={open}
                      className="flex h-7 w-7 items-center justify-center rounded-sm border border-header-fg/12 text-header-fg/75 transition-colors hover:border-header-fg/30 hover:text-header-fg aria-expanded:border-header-fg/30 aria-expanded:text-header-fg"
                    >
                      <Plus size={15} />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <MenuHeader>Create</MenuHeader>
                      <MenuItem icon={<Plus size={14} />} onClick={() => (close(), go('/new'))}>
                        New repository
                      </MenuItem>
                      <MenuItem icon={<Building2 size={14} />} onClick={() => (close(), go('/organizations/new'))}>
                        New organization
                      </MenuItem>
                    </>
                  )}
                </Dropdown>
                <NotificationBell className="text-header-fg/70 hover:text-header-fg" />
                <Dropdown
                  align="right"
                  width={240}
                  trigger={({ toggle, open }) => (
                    <button onClick={toggle} aria-label="Account menu" aria-expanded={open} className="flex items-center rounded-full ring-1 ring-transparent transition-shadow hover:ring-header-fg/30 aria-expanded:ring-header-fg/40">
                      <Avatar name={me.username} src={me.avatarUrl} size={26} />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <div className="border-b border-border-muted px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium">{me.name || me.username}</span>
                          <PlanBadge plan={me.plan} />
                        </div>
                        <div className="truncate font-mono text-xs text-fg-subtle">@{me.username}</div>
                      </div>
                      <div className="py-1">
                        <MenuItem icon={<User size={14} />} onClick={() => (close(), void navigate({ to: '/$owner', params: { owner: me.username } }))}>
                          Your profile
                        </MenuItem>
                        <MenuItem icon={<Bell size={14} />} onClick={() => (close(), go('/notifications'))}>
                          Notifications
                        </MenuItem>
                        {me.orgs.map((o) => (
                          <MenuItem key={o.slug} icon={<Building2 size={14} />} onClick={() => (close(), void navigate({ to: '/$owner', params: { owner: o.slug } }))}>
                            {o.name}
                          </MenuItem>
                        ))}
                      </div>
                      <div className="border-t border-border-muted py-1">
                        <MenuItem icon={<Settings size={14} />} onClick={() => (close(), go('/settings'))}>
                          Settings
                        </MenuItem>
                        <MenuItem icon={<KeyRound size={14} />} onClick={() => (close(), go('/settings/tokens'))}>
                          Access tokens
                        </MenuItem>
                        {me.isAdmin && (
                          <MenuItem icon={<Database size={14} />} onClick={() => (close(), go('/admin/database'))}>
                            Database
                          </MenuItem>
                        )}
                      </div>
                      <div className="flex items-center justify-between border-t border-border-muted px-3 py-2">
                        <span className="text-xs text-fg-muted">Theme</span>
                        <ThemeSwitch />
                      </div>
                      <div className="border-t border-border-muted py-1">
                        <MenuItem icon={<LogOut size={14} />} onClick={() => (close(), void logout())}>
                          Sign out
                        </MenuItem>
                      </div>
                    </>
                  )}
                </Dropdown>
              </>
            ) : (
              <>
                <Link to="/login" className={headerLink}>
                  Sign in
                </Link>
                <Link to="/signup" className="inline-flex h-9 items-center md:h-7 rounded-sm bg-header-fg px-3 text-[13px] font-medium text-header no-underline transition-colors hover:bg-accent-emphasis hover:text-fg-on-accent">
                  Sign up
                </Link>
              </>
            )}
          </div>
        </div>
      </header>
      <NavProgress />
      <VerifyBanner />
      <main id="main" ref={mainRef} tabIndex={-1} className="flex-1 focus:outline-none">
        <Outlet />
      </main>
      <SiteFooter signedIn={Boolean(me)} paid={isPaidPlan(me?.plan)} />
    </div>
  );
}

function FooterCol({ title, links }: { title: string; links: { label: string; to?: string; href?: string }[] }) {
  return (
    <div>
      <h2 className="mb-3 text-[13px] font-medium text-fg">{title}</h2>
      <ul className="space-y-2">
        {links.map((l) => (
          <li key={l.label}>
            {l.to ? (
              <Link to={l.to} className="text-sm text-fg-muted no-underline transition-colors hover:text-fg">
                {l.label}
              </Link>
            ) : (
              <a href={l.href} className="text-sm text-fg-muted no-underline transition-colors hover:text-fg">
                {l.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SiteFooter({ signedIn, paid }: { signedIn: boolean; paid: boolean }) {
  return (
    <footer className="border-t border-border bg-page">
      <div className="mx-auto max-w-[1280px] px-5 pb-8 pt-12 md:px-8">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
          <div className="col-span-2 sm:col-span-3 lg:col-span-1">
            <Link to="/" className="inline-flex text-fg no-underline" aria-label="Jumper home">
              <Wordmark />
            </Link>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-fg-muted">Visual diffs, checks and fab files for KiCad projects on GitHub.</p>
          </div>
          <FooterCol
            title="Product"
            links={[
              ...(paid ? [] : [{ label: 'Pricing', to: '/pricing' }]),
              { label: 'New repository', to: '/new' },
              { label: 'KiCad plugin', to: '/docs/kicad-plugin' },
            ]}
          />
          <FooterCol
            title="Docs"
            links={[
              { label: 'Quick start', to: '/docs/quick-start' },
              { label: '.jumper.yml', to: '/docs/jumper-yml' },
              { label: 'REST API', to: '/docs/api' },
            ]}
          />
          <FooterCol
            title="Account"
            links={
              signedIn
                ? [
                    { label: 'Settings', to: '/settings' },
                    { label: 'Notifications', to: '/notifications' },
                  ]
                : [
                    { label: 'Sign in', to: '/login' },
                    { label: 'Create account', to: '/signup' },
                  ]
            }
          />
        </div>
        <div className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-border-muted pt-5 text-xs text-fg-subtle">
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>© {new Date().getFullYear()} Jumper</span>
            <Link to="/terms" className="no-underline hover:text-fg">
              Terms
            </Link>
            <Link to="/privacy" className="no-underline hover:text-fg">
              Privacy
            </Link>
            <Link to="/refunds" className="no-underline hover:text-fg">
              Refunds
            </Link>
            <span className="font-mono">KiCad 8 · 9</span>
          </span>
          <ThemeSwitch />
        </div>
      </div>
    </footer>
  );
}
