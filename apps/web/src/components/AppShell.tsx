import { useState, type FormEvent } from 'react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronDown, KeyRound, LogOut, Monitor, Moon, Plus, Search, Settings, Sun, User } from 'lucide-react';
import { Avatar, Dropdown, MenuHeader, MenuItem } from '@pcbhub/ui';
import { api } from '../lib/api';
import { keys, useMe } from '../lib/queries';
import { applyTheme, getThemePref, type ThemePref } from '../lib/theme';

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="7" fill="currentColor" fillOpacity="0.08" />
      <path d="M9 9h7v4h4v-4h3v14h-3v-7h-4v7H9z" fill="none" stroke="#d07a45" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="9" cy="9" r="2" fill="#d07a45" />
      <circle cx="23" cy="23" r="2" fill="#d07a45" />
    </svg>
  );
}

function HeaderSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void navigate({ to: '/explore', search: { q } });
  };
  return (
    <form onSubmit={submit} className="relative hidden w-72 md:block">
      <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-white/50" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search repositories"
        aria-label="Search repositories"
        className="h-8 w-full rounded-md border border-white/15 bg-white/5 pl-8 pr-3 text-sm text-white placeholder:text-white/45 focus:border-white/40 focus:bg-white/10 focus:outline-none"
      />
    </form>
  );
}

function ThemeItems({ close }: { close: () => void }) {
  const [pref, setPref] = useState<ThemePref>(getThemePref());
  const set = (p: ThemePref) => {
    applyTheme(p);
    setPref(p);
    close();
  };
  return (
    <>
      <MenuHeader>Theme</MenuHeader>
      <MenuItem icon={<Monitor size={14} />} active={pref === 'system'} onClick={() => set('system')}>
        System
      </MenuItem>
      <MenuItem icon={<Sun size={14} />} active={pref === 'light'} onClick={() => set('light')}>
        Light
      </MenuItem>
      <MenuItem icon={<Moon size={14} />} active={pref === 'dark'} onClick={() => set('dark')}>
        Dark
      </MenuItem>
    </>
  );
}

export function AppShell() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const logout = async () => {
    await api.post('/auth/logout');
    qc.setQueryData(keys.me, null);
    await qc.invalidateQueries();
    void navigate({ to: '/' });
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 bg-header text-header-fg">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4 md:px-6">
          <Link to="/" className="flex items-center gap-2 font-semibold text-white no-underline">
            <Logo className="h-7 w-7" />
            <span className="text-[15px] tracking-tight">PCBHub</span>
          </Link>
          <HeaderSearch />
          <nav className="hidden items-center gap-4 text-sm font-medium text-white/80 md:flex">
            <Link to="/explore" search={{ q: '' }} className="hover:text-white">
              Explore
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {me ? (
              <>
                <Dropdown
                  align="right"
                  width={220}
                  trigger={({ toggle }) => (
                    <button onClick={toggle} aria-label="Create new" className="flex h-8 items-center gap-1 rounded-md border border-white/15 px-2 text-white/85 hover:bg-white/10">
                      <Plus size={16} />
                      <ChevronDown size={12} />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <MenuItem icon={<Plus size={14} />} onClick={() => (close(), void navigate({ to: '/new' }))}>
                        New repository
                      </MenuItem>
                      <MenuItem icon={<Building2 size={14} />} onClick={() => (close(), void navigate({ to: '/organizations/new' }))}>
                        New organization
                      </MenuItem>
                    </>
                  )}
                </Dropdown>
                <Dropdown
                  align="right"
                  width={240}
                  trigger={({ toggle }) => (
                    <button onClick={toggle} aria-label="Account menu" className="flex items-center gap-1 rounded-full p-0.5 hover:bg-white/10">
                      <Avatar name={me.username} src={me.avatarUrl} size={28} />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <div className="border-b border-border-muted px-3 py-2 text-sm">
                        Signed in as <strong>{me.username}</strong>
                      </div>
                      <MenuItem icon={<User size={14} />} onClick={() => (close(), void navigate({ to: '/$owner', params: { owner: me.username } }))}>
                        Your profile
                      </MenuItem>
                      {me.orgs.map((o) => (
                        <MenuItem key={o.slug} icon={<Building2 size={14} />} onClick={() => (close(), void navigate({ to: '/$owner', params: { owner: o.slug } }))}>
                          {o.name}
                        </MenuItem>
                      ))}
                      <MenuItem icon={<Settings size={14} />} onClick={() => (close(), void navigate({ to: '/settings' }))}>
                        Settings
                      </MenuItem>
                      <MenuItem icon={<KeyRound size={14} />} onClick={() => (close(), void navigate({ to: '/settings/tokens' }))}>
                        Access tokens
                      </MenuItem>
                      <div className="my-1 border-t border-border-muted" />
                      <ThemeItems close={close} />
                      <div className="my-1 border-t border-border-muted" />
                      <MenuItem icon={<LogOut size={14} />} onClick={() => (close(), void logout())}>
                        Sign out
                      </MenuItem>
                    </>
                  )}
                </Dropdown>
              </>
            ) : (
              <>
                <Link to="/login" className="rounded-md px-3 py-1.5 text-sm text-white/85 hover:text-white">
                  Sign in
                </Link>
                <Link to="/signup" className="rounded-md border border-white/25 px-3 py-1.5 text-sm text-white hover:border-white/50">
                  Sign up
                </Link>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-border-muted py-6 text-center text-xs text-fg-subtle">
        PCBHub · version control and review for KiCad hardware
      </footer>
    </div>
  );
}
