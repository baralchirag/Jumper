import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useParams } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  CircleUser,
  Download,
  FolderGit2,
  History,
  KeyRound,
  Bell,
  Gift,
  Laptop,
  Link2,
  Lock,
  MapPin,
  Monitor,
  Moon,
  Palette,
  ShieldCheck,
  Smartphone,
  Sun,
  Terminal,
  Trash2,
  User, Gauge } from 'lucide-react';
import type { AuditEntry, CurrentUser, ReferralInfo, RepoInfo, SessionInfo, SshKeyInfo, TokenInfo, TwoFactorSetup, TwoFactorStatus } from '@jumper/shared';
import qrcode from 'qrcode-generator';
import { TOKEN_SCOPES } from '@jumper/shared';
import { Avatar, Button, Checkbox, CopyButton, Flash, Input, Label, PageSpinner, RelativeTime, Select, Textarea, buttonClass, cx } from '@jumper/ui';
import { NotFound, PageContainer } from '../../shared/components/common';
import { DeleteAccount } from './DeleteAccount';
import { api, errorMessage } from '../../shared/lib/api';
import { keys, useMe } from '../../shared/lib/queries';
import { useThemePref, type ThemePref } from '../../shared/lib/theme';
import { UsagePanel } from '../usage/UsagePanel';
import { BillingPanel } from '../accounts/Governance';
import { PlanBadge } from '../../shared/components/PlanBadge';

// ─── Layout ────────────────────────────────────────────────────────────────

type Section = 'profile' | 'account' | 'appearance' | 'notifications' | 'referrals' | 'security' | 'sessions' | 'tokens' | 'ssh-keys' | 'repositories' | 'organizations' | 'usage' | 'security-log';

const NAV: { group?: string; items: { id: Section; label: string; icon: ReactNode }[] }[] = [
  {
    items: [
      { id: 'profile', label: 'Public profile', icon: <User size={14} /> },
      { id: 'account', label: 'Account', icon: <CircleUser size={14} /> },
      { id: 'appearance', label: 'Appearance', icon: <Palette size={14} /> },
      { id: 'notifications', label: 'Notifications', icon: <Bell size={14} /> },
    ],
  },
  {
    group: 'Access',
    items: [
      { id: 'security', label: 'Password and authentication', icon: <ShieldCheck size={14} /> },
      { id: 'sessions', label: 'Sessions', icon: <Laptop size={14} /> },
      { id: 'tokens', label: 'Personal access tokens', icon: <KeyRound size={14} /> },
      { id: 'ssh-keys', label: 'SSH keys', icon: <Terminal size={14} /> },
    ],
  },
  {
    group: 'Code and organizations',
    items: [
      { id: 'repositories', label: 'Repositories', icon: <FolderGit2 size={14} /> },
      { id: 'organizations', label: 'Organizations', icon: <Building2 size={14} /> },
      { id: 'usage', label: 'Usage and plan', icon: <Gauge size={14} /> },
      { id: 'referrals', label: 'Invite people', icon: <Gift size={14} /> },
    ],
  },
  {
    group: 'Archives',
    items: [{ id: 'security-log', label: 'Security log', icon: <History size={14} /> }],
  },
];

const href = (id: Section) => (id === 'profile' ? '/settings' : `/settings/${id}`);

function SettingsLayout({ section, children }: { section: Section; children: ReactNode }) {
  const { pathname } = useLocation();
  const { data: me, isLoading } = useMe();
  if (isLoading) return <PageSpinner />;
  if (!me) return <Navigate to="/login" search={{ redirect: pathname }} />;
  return (
    <PageContainer className="py-8">
      <header className="mb-8 flex flex-wrap items-center gap-3">
        <Avatar name={me.username} src={me.avatarUrl} size={40} />
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-x-2 text-[17px] font-medium leading-tight tracking-[-0.01em]">
            <span>
              {me.name || me.username} <span className="font-normal text-fg-muted">({me.username})</span>
            </span>
            <PlanBadge plan={me.plan} />
          </h1>
          <p className="text-[13px] text-fg-muted">Your personal account{me.isAdmin && ' · instance administrator'}</p>
        </div>
        <Link to="/$owner" params={{ owner: me.username }} className={buttonClass('default', 'sm', 'ml-auto')}>
          Go to your profile
        </Link>
      </header>
      <div className="grid gap-8 md:grid-cols-[232px_minmax(0,1fr)] md:gap-10">
        <nav aria-label="Settings" className="md:sticky md:top-20 md:self-start">
          <div className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-2 md:mx-0 md:block md:overflow-visible md:p-0">
            {NAV.map((g, gi) => (
              <div key={gi} className={cx('contents md:block', gi > 0 && 'md:mt-4 md:border-t md:border-border-muted md:pt-4')}>
                {g.group && <p className="mb-1 hidden px-2.5 text-xs text-fg-subtle md:block">{g.group}</p>}
                {g.items.map((it) => {
                  const active = it.id === section;
                  return (
                    <Link
                      key={it.id}
                      to={href(it.id)}
                      aria-current={active ? 'page' : undefined}
                      className={cx(
                        'relative flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-sm px-2.5 py-1.5 text-[13px] no-underline transition-colors',
                        active ? 'bg-neutral-muted font-medium text-fg md:before:absolute md:before:-left-2 md:before:inset-y-1 md:before:w-0.5 md:before:bg-accent-emphasis' : 'text-fg-muted hover:bg-neutral-muted hover:text-fg',
                      )}
                    >
                      <span className={active ? 'text-fg' : 'text-fg-subtle'}>{it.icon}</span>
                      {it.label}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </nav>
        <div className="min-w-0 max-w-[860px] space-y-10">{children}</div>
      </div>
    </PageContainer>
  );
}

// ─── Building blocks ───────────────────────────────────────────────────────

function Panel({ title, description, action, children, tone }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode; tone?: 'danger' }) {
  return (
    <section>
      <div className="mb-3 flex items-end gap-4 border-b border-border pb-2">
        <div className="min-w-0 flex-1">
          <h2 className={cx('text-[15px] font-medium tracking-[-0.01em]', tone === 'danger' && 'text-danger')}>{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One setting: label and help on the left, the control on the right. */
function Row({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid gap-2 border-b border-border-muted py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] sm:gap-6">
      <div>
        <label htmlFor={htmlFor} className="block text-[13px] font-medium">
          {label}
        </label>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{hint}</p>}
      </div>
      <div className="min-w-0 self-center">{children}</div>
    </div>
  );
}

function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 border-b border-border-muted py-2.5 text-[13px] last:border-b-0">
      <span className="w-40 shrink-0 text-fg-muted">{k}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  );
}

function useMessage() {
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  useEffect(() => {
    if (msg?.tone !== 'success') return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);
  return [msg, setMsg] as const;
}

/** Parse a user agent into "Firefox on Linux"-style text. */
function describeAgent(ua: string | null): { label: string; mobile: boolean; cli: boolean } {
  if (!ua) return { label: 'Unknown device', mobile: false, cli: false };
  if (/^git\//i.test(ua)) return { label: `Git ${ua.split(/[/ ]/)[1] ?? ''}`.trim(), mobile: false, cli: true };
  if (/curl|wget|httpie|python-requests|node-fetch|undici/i.test(ua)) return { label: ua.split(' ')[0]!, mobile: false, cli: true };
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? (/HeadlessChrome/.test(ua) ? 'Headless Chrome' : 'Chrome') : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  return { label: `${browser} on ${os}`, mobile: /Mobile|Android|iPhone/.test(ua), cli: false };
}

// ─── Public profile ────────────────────────────────────────────────────────

const PROFILE_FIELDS = ['name', 'pronouns', 'bio', 'website', 'company', 'location', 'avatarUrl'] as const;
type ProfileForm = Record<(typeof PROFILE_FIELDS)[number], string>;

function ProfileSection() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const initial = useMemo<ProfileForm>(
    () => ({
      name: me?.name ?? '',
      pronouns: me?.pronouns ?? '',
      bio: me?.bio ?? '',
      website: me?.website ?? '',
      company: me?.company ?? '',
      location: me?.location ?? '',
      avatarUrl: me?.avatarUrl ?? '',
    }),
    [me],
  );
  const [form, setForm] = useState(initial);
  const [msg, setMsg] = useMessage();
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(initial), [initial]);
  const dirty = PROFILE_FIELDS.some((k) => form[k] !== initial[k]);
  const set = (k: keyof ProfileForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const updated = await api.patch<CurrentUser>('/user', form);
      qc.setQueryData(keys.me, updated);
      setMsg({ tone: 'success', text: 'Profile saved.' });
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  if (!me) return null;

  return (
    <form onSubmit={submit}>
      <Panel title="Public profile" description="Shown on your profile page, next to your commits, reviews and comments.">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_220px]">
          <div>
            <Row label="Name" hint="Your full name or a display name." htmlFor="p-name">
              <Input id="p-name" value={form.name} onChange={set('name')} maxLength={100} autoComplete="name" />
            </Row>
            <Row label="Pronouns" hint="Optional." htmlFor="p-pron">
              <Input id="p-pron" value={form.pronouns} onChange={set('pronouns')} maxLength={40} placeholder="they/them" className="max-w-48" />
            </Row>
            <Row label="Bio" hint={`${500 - form.bio.length} characters left.`} htmlFor="p-bio">
              <Textarea id="p-bio" rows={3} value={form.bio} onChange={set('bio')} maxLength={500} placeholder="Power electronics, mostly. Sometimes RF." />
            </Row>
            <Row label="Website" htmlFor="p-web">
              <Input id="p-web" type="url" value={form.website} onChange={set('website')} placeholder="https://" />
            </Row>
            <Row label="Company" htmlFor="p-co">
              <Input id="p-co" value={form.company} onChange={set('company')} maxLength={100} autoComplete="organization" />
            </Row>
            <Row label="Location" htmlFor="p-loc">
              <Input id="p-loc" value={form.location} onChange={set('location')} maxLength={100} />
            </Row>
            <Row label="Avatar URL" hint="An https image. Leave empty to use generated initials." htmlFor="p-av">
              <Input id="p-av" type="url" value={form.avatarUrl} onChange={set('avatarUrl')} placeholder="https://" />
            </Row>
          </div>
          <aside aria-label="Preview" className="lg:pt-3.5">
            <p className="mb-2 text-xs text-fg-subtle">Preview</p>
            <div className="border border-border-muted p-4">
              <Avatar name={me.username} src={form.avatarUrl || null} size={64} />
              <p className="mt-3 text-[15px] font-medium leading-tight">{form.name || me.username}</p>
              <p className="font-mono text-xs text-fg-subtle">
                {me.username}
                {form.pronouns && ` · ${form.pronouns}`}
              </p>
              {form.bio && <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">{form.bio}</p>}
              <ul className="mt-3 space-y-1 text-xs text-fg-muted">
                {form.company && (
                  <li className="flex items-center gap-1.5">
                    <Building2 size={12} /> {form.company}
                  </li>
                )}
                {form.location && (
                  <li className="flex items-center gap-1.5">
                    <MapPin size={12} /> {form.location}
                  </li>
                )}
                {form.website && (
                  <li className="flex items-center gap-1.5 truncate">
                    <Link2 size={12} /> {form.website.replace(/^https?:\/\//, '')}
                  </li>
                )}
              </ul>
            </div>
          </aside>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
            Save profile
          </Button>
          {dirty && (
            <Button variant="invisible" onClick={() => setForm(initial)}>
              Discard
            </Button>
          )}
          {msg && <span className={cx('text-xs', msg.tone === 'success' ? 'text-success' : 'text-danger')}>{msg.text}</span>}
        </div>
      </Panel>
    </form>
  );
}

// ─── Account ───────────────────────────────────────────────────────────────

function AccountSection() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [email, setEmail] = useState(me?.email ?? '');
  const [emailPassword, setEmailPassword] = useState('');
  const [msg, setMsg] = useMessage();
  const [busy, setBusy] = useState(false);
  const repos = useQuery({ queryKey: ['repos', 'mine'], queryFn: () => api.get<RepoInfo[]>('/repos', { mine: true }) });
  useEffect(() => setEmail(me?.email ?? ''), [me?.email]);
  if (!me) return null;
  const owned = repos.data?.filter((r) => r.owner.toLowerCase() === me.username.toLowerCase()) ?? [];

  const saveEmail = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      qc.setQueryData(keys.me, await api.patch<CurrentUser>('/user', { email, currentPassword: me.hasPassword ? emailPassword : undefined }));
      setEmailPassword('');
      setMsg({ tone: 'success', text: 'Email updated. We sent a confirmation link to the new address.' });
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel title="Account" description="Your username is part of every repository URL and git remote, so it cannot be changed.">
        <KV k="Username">
          <span className="font-mono">{me.username}</span>
        </KV>
        <KV k="Account ID">
          <span className="font-mono text-xs text-fg-muted">{me.id}</span> <CopyButton value={me.id} />
        </KV>
        <KV k="Member since">{new Date(me.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</KV>
        <KV k="Role">{me.isAdmin ? <Label tone="accent">Administrator</Label> : 'Member'}</KV>
        <KV k="Repositories">
          {owned.length} owned · {owned.filter((r) => r.visibility === 'private').length} private
        </KV>
        <KV k="Organizations">{me.orgs.length ? me.orgs.map((o) => o.name).join(', ') : 'None'}</KV>
      </Panel>

      <form onSubmit={saveEmail}>
        <Panel title="Email" description="Used for sign-in, password resets and as the author address of merge commits you create in the browser.">
          <Row label="Primary email" htmlFor="a-email" hint={me.emailVerified ? 'Confirmed.' : 'Not confirmed yet. Check your inbox for the link.'}>
            <div className="flex gap-2">
              <Input id="a-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
              <Button type="submit" loading={busy} disabled={email === me.email || (me.hasPassword && !emailPassword)}>
                Save
              </Button>
            </div>
            {email !== me.email && me.hasPassword && (
              <Input type="password" className="mt-2" value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} placeholder="Current password, to confirm the change" aria-label="Current password" autoComplete="current-password" />
            )}
            {msg && <p className={cx('mt-1.5 text-xs', msg.tone === 'success' ? 'text-success' : 'text-danger')}>{msg.text}</p>}
          </Row>
        </Panel>
      </form>

      <Panel title="Export account data" description="A JSON file with your profile, token metadata (never the secrets) and the last 1,000 security log events.">
        <a href="/api/user/export" className={buttonClass('default', 'md')} download>
          <Download size={14} /> Download export
        </a>
      </Panel>

      <Panel title="Delete account" tone="danger" description="Remove your account and the repositories you own. This is permanent.">
        <DeleteAccount />
      </Panel>
    </>
  );
}

// ─── Appearance ────────────────────────────────────────────────────────────

function ThemeCard({ value, label, icon, active, onPick }: { value: ThemePref; label: string; icon: ReactNode; active: boolean; onPick: () => void }) {
  const swatch = value === 'light' ? ['#fdfcfa', '#1f1d1a', '#dcd7cd'] : value === 'dark' ? ['#171614', '#ede9e3', '#2e2b28'] : null;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onPick}
      className={cx('flex flex-col border text-left transition-colors', active ? 'border-select' : 'border-border hover:border-fg-subtle')}
    >
      <span className="block h-24 w-full overflow-hidden border-b border-border-muted">
        {swatch ? (
          <span className="flex h-full flex-col gap-1.5 p-3" style={{ background: swatch[0] }}>
            <span className="h-2 w-16" style={{ background: swatch[1] }} />
            <span className="h-1.5 w-24" style={{ background: swatch[2] }} />
            <span className="h-1.5 w-20" style={{ background: swatch[2] }} />
            <span className="mt-auto h-3 w-10" style={{ background: 'var(--pcb-trace)' }} />
          </span>
        ) : (
          <span className="flex h-full">
            <span className="flex-1" style={{ background: '#fdfcfa' }} />
            <span className="flex-1" style={{ background: '#171614' }} />
          </span>
        )}
      </span>
      <span className="flex items-center gap-2 px-3 py-2 text-[13px]">
        {icon} {label}
        {active && <span className="ml-auto font-mono text-[11.5px] text-accent">Active</span>}
      </span>
    </button>
  );
}

function AppearanceSection() {
  const [pref, setPref] = useThemePref();
  return (
    <>
      <Panel title="Theme" description="Stored in this browser. System follows your operating system and switches automatically.">
        <div role="radiogroup" aria-label="Theme" className="grid gap-3 sm:grid-cols-3">
          <ThemeCard value="system" label="System" icon={<Monitor size={14} />} active={pref === 'system'} onPick={() => setPref('system')} />
          <ThemeCard value="dark" label="Graphite (dark)" icon={<Moon size={14} />} active={pref === 'dark'} onPick={() => setPref('dark')} />
          <ThemeCard value="light" label="Drafting film (light)" icon={<Sun size={14} />} active={pref === 'light'} onPick={() => setPref('light')} />
        </div>
      </Panel>
      <Panel title="Accessibility" description="Preferences that change how the interface moves and is read. They are stored in this browser only.">
        <KV k="Motion">Follows the system “reduce motion” setting: route transitions, trace animations and pulses are turned off.</KV>
        <KV k="Keyboard">
          <kbd className="rounded-xs border border-border px-1 font-mono text-xs">/</kbd> or <kbd className="rounded-xs border border-border px-1 font-mono text-xs">Ctrl K</kbd> focuses search. Markdown editors support{' '}
          <kbd className="rounded-xs border border-border px-1 font-mono text-xs">Ctrl B / I / E / K</kbd>.
        </KV>
      </Panel>
    </>
  );
}

// ─── Password and authentication ───────────────────────────────────────────

function SecuritySection() {
  const { data: me } = useMe();
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ github: boolean }>('/auth/providers'), staleTime: Infinity });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useMessage();
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== next;
  const strength = next.length === 0 ? 0 : next.length < 10 ? 1 : next.length < 14 || !/[^a-z]/i.test(next) ? 2 : 3;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    try {
      await api.post('/user/password', { currentPassword: current || undefined, newPassword: next });
      setMsg({ tone: 'success', text: 'Password changed. Your other sessions were signed out.' });
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  if (!me) return null;

  return (
    <>
      <form onSubmit={submit}>
        <Panel title={me.hasPassword ? 'Change password' : 'Set a password'} description="Changing it signs out every other session. Git over HTTPS should use a token instead.">
          {me.hasPassword && (
            <Row label="Current password" htmlFor="s-cur">
              <Input id="s-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required className="max-w-sm" />
            </Row>
          )}
          <Row label="New password" hint="At least 10 characters." htmlFor="s-new">
            <Input id="s-new" type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required className="max-w-sm" />
            <div className="mt-2 flex max-w-sm gap-1" aria-hidden>
              {[1, 2, 3].map((i) => (
                <span key={i} className={cx('h-0.5 flex-1', strength >= i ? (strength === 1 ? 'bg-danger' : strength === 2 ? 'bg-attention' : 'bg-success') : 'bg-border')} />
              ))}
            </div>
          </Row>
          <Row label="Confirm new password" htmlFor="s-conf">
            <Input id="s-conf" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required invalid={mismatch} className="max-w-sm" />
            {mismatch && <p className="mt-1 text-xs text-danger">Passwords don’t match.</p>}
          </Row>
          <div className="mt-4 flex items-center gap-3">
            <Button type="submit" variant="primary" loading={busy} disabled={mismatch || next.length < 10}>
              Update password
            </Button>
            {msg && <span className={cx('text-xs', msg.tone === 'success' ? 'text-success' : 'text-danger')}>{msg.text}</span>}
          </div>
        </Panel>
      </form>

      <Panel title="Sign-in methods" description="Ways you can sign in. Keep at least one you control; linking a second method protects you from being locked out.">
        <KV k="Password">{me.hasPassword ? <span className="text-success">Set</span> : <span className="text-fg-muted">Not set</span>}</KV>
        <KV k="GitHub">
          {me.githubLinked ? (
            <span className="text-success">Connected</span>
          ) : providers.data?.github ? (
            <a href="/api/auth/github" className="link">
              Connect GitHub account
            </a>
          ) : (
            <span className="text-fg-muted">Not configured on this instance</span>
          )}
        </KV>
        <KV k="Git over HTTPS">
          Username <span className="font-mono">{me.username}</span> with a{' '}
          <Link to="/settings/$section" params={{ section: 'tokens' }} className="link">
            personal access token
          </Link>{' '}
          as the password.
        </KV>
      </Panel>
      <TwoFactorPanel />
      <SsoIdentitiesPanel />
    </>
  );
}

// ─── Two-factor login and single sign-on ───────────────────────────────────

function QrCode({ text, size = 168 }: { text: string; size?: number }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) path += `M${c + 2} ${r + 2}h1v1h-1z`;
    return { n: count + 4, d: path };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} role="img" aria-label="QR code for your authenticator app" className="rounded-sm bg-white" shapeRendering="crispEdges">
      <path d={d} fill="#000" />
    </svg>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join('\n');
  return (
    <div className="mt-3 rounded-md border border-attention/40 bg-attention-subtle/30 p-4">
      <p className="text-[13px] font-medium">Save these recovery codes</p>
      <p className="mt-0.5 text-xs text-fg-muted">Each one signs you in once if you lose your phone. They are shown only now.</p>
      <pre className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[13px] sm:grid-cols-5">{codes.map((c) => <span key={c}>{c}</span>)}</pre>
      <div className="mt-3 flex flex-wrap gap-2">
        <CopyButton value={text} label="Copy codes" />
        <a className={buttonClass('default', 'sm')} href={`data:text/plain;charset=utf-8,${encodeURIComponent(text + '\n')}`} download="jumper-recovery-codes.txt">
          <Download size={13} /> Download
        </a>
        <Button size="sm" variant="primary" onClick={onDone}>I saved them</Button>
      </div>
    </div>
  );
}

function TwoFactorPanel() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['two-factor'], queryFn: () => api.get<TwoFactorStatus>('/user/two-factor') });
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [msg, setMsg] = useMessage();
  const [busy, setBusy] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['two-factor'] }), qc.invalidateQueries({ queryKey: keys.me })]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  if (!q.data) return null;
  const s = q.data;

  return (
    <Panel
      title="Two-factor login"
      description="After your password, sign-in asks for a six-digit code from an authenticator app on your phone (1Password, Google Authenticator, Aegis and others)."
      action={s.enabled ? <Label tone="success">On</Label> : <Label>Off</Label>}
    >
      {s.requiredBy.length > 0 && !s.enabled && (
        <Flash tone="warning" className="mb-3">
          {s.requiredBy.join(', ')} {s.requiredBy.length === 1 ? 'requires' : 'require'} two-factor login. Turn it on to reach {s.requiredBy.length === 1 ? 'its' : 'their'} private repositories.
        </Flash>
      )}
      {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
      {!s.enabled && !setup && (
        <Button className="mt-2" variant="primary" loading={busy} onClick={() => act(async () => setSetup(await api.post<TwoFactorSetup>('/user/two-factor/setup')))}>
          Set up two-factor login
        </Button>
      )}
      {!s.enabled && setup && (
        <form
          className="mt-2 flex flex-wrap gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const r = await api.post<{ recoveryCodes: string[] }>('/user/two-factor/enable', { code });
              setCodes(r.recoveryCodes);
              setSetup(null);
              setCode('');
              await refresh();
            });
          }}
        >
          <QrCode text={setup.uri} />
          <div className="min-w-0 max-w-sm flex-1 space-y-3 text-[13px]">
            <p>1. Scan the code with your authenticator app.</p>
            <p className="text-fg-muted">
              Can’t scan it? Enter this key: <span className="break-all font-mono text-fg">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</span>
            </p>
            <label className="block" htmlFor="tf-code">2. Enter the six-digit code it shows.</label>
            <div className="flex gap-2">
              <Input id="tf-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" value={code} onChange={(e) => setCode(e.target.value)} className="w-32 font-mono" required autoFocus />
              <Button type="submit" variant="primary" loading={busy}>Turn on</Button>
              <Button onClick={() => setSetup(null)}>Cancel</Button>
            </div>
          </div>
        </form>
      )}
      {s.enabled && (
        <>
          <KV k="Turned on">{s.enabledAt && <RelativeTime date={s.enabledAt} />}</KV>
          <KV k="Recovery codes">{s.recoveryCodesLeft} left</KV>
          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
              void act(async () => {
                if (submitter?.value === 'codes') {
                  setCodes((await api.post<{ recoveryCodes: string[] }>('/user/two-factor/recovery-codes', { code })).recoveryCodes);
                } else {
                  const looksLikeCode = /^[0-9a-z -]{6,20}$/i.test(code) && !(me?.hasPassword && code.length > 12);
                  await api.post('/user/two-factor/disable', looksLikeCode ? { code } : { password: code });
                  setMsg({ tone: 'success', text: 'Two-factor login is off.' });
                }
                setCode('');
                await refresh();
              });
            }}
          >
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={me?.hasPassword ? 'Current code or password' : 'Current code'} aria-label="Current code" className="w-56" type="password" autoComplete="one-time-code" required />
            <Button type="submit" value="codes" loading={busy}>New recovery codes</Button>
            <Button type="submit" value="disable" variant="danger" loading={busy}>Turn off</Button>
          </form>
        </>
      )}
      {msg && <p className={cx('mt-2 text-xs', msg.tone === 'success' ? 'text-success' : 'text-danger')}>{msg.text}</p>}
    </Panel>
  );
}

interface SsoIdentity {
  connection: string;
  name: string;
  email: string | null;
  lastLoginAt: string | null;
}

function SsoIdentitiesPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['user-sso'], queryFn: () => api.get<SsoIdentity[]>('/user/sso') });
  const [msg, setMsg] = useMessage();
  if (!q.data?.length) return null;
  const unlink = async (c: string) => {
    try {
      await api.delete(`/user/sso/${encodeURIComponent(c)}`);
      await qc.invalidateQueries({ queryKey: ['user-sso'] });
    } catch (e) {
      setMsg({ tone: 'danger', text: errorMessage(e) });
    }
  };
  return (
    <Panel title="Single sign-on" description="Identity providers you have signed in through. Unlinking one means it can no longer sign you in to this account.">
      {q.data.map((i) => (
        <div key={i.connection} className="flex flex-wrap items-center gap-3 border-b border-border-muted py-2.5 text-[13px] last:border-b-0">
          <span className="w-40 shrink-0 font-medium">{i.name}</span>
          <span className="min-w-0 flex-1 text-fg-muted">
            {i.email}
            {i.lastLoginAt && <> · last used <RelativeTime date={i.lastLoginAt} /></>}
          </span>
          <Button size="sm" onClick={() => confirm(`Unlink ${i.name}?`) && void unlink(i.connection)}>Unlink</Button>
        </div>
      ))}
      {msg && <p className="mt-2 text-xs text-danger">{msg.text}</p>}
    </Panel>
  );
}

// ─── Notifications ─────────────────────────────────────────────────────────

function NotificationsSection() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [preview, setPreview] = useState(false);
  const [msg, setMsg] = useMessage();
  const p = useQuery({ queryKey: ['digest-preview'], queryFn: () => api.get<{ empty: boolean; subject: string; text: string; lastSentAt: string | null }>('/user/digest/preview'), enabled: preview });
  if (!me) return null;
  const set = async (patch: { notifyEmail?: boolean; digestEmail?: boolean }) => {
    try {
      const next = await api.patch<CurrentUser>('/user', patch);
      qc.setQueryData(keys.me, next);
      setMsg({ tone: 'success', text: 'Saved.' });
    } catch (e) {
      setMsg({ tone: 'danger', text: errorMessage(e) });
    }
  };
  return (
    <>
      <Panel title="Email" description={<>Emails go to <span className="font-mono">{me.email}</span>. Your inbox on this site always gets everything.</>} action={msg && <span className={cx('text-xs', msg.tone === 'success' ? 'text-success' : 'text-danger')}>{msg.text}</span>}>
        <Row label="Mentions and assignments" hint="When someone mentions you, assigns you, requests your review, or a watched part runs out.">
          <Checkbox checked={me.notifyEmail} onChange={(e) => void set({ notifyEmail: e.target.checked })} label="Email me" />
        </Row>
        <Row label="Weekly digest" hint="One email a week about the repositories you own, belong to, collaborate on or follow: merges, releases, failed checks, parts problems and reviews waiting on you. Nothing is sent in a quiet week.">
          <Checkbox checked={me.digestEmail} onChange={(e) => void set({ digestEmail: e.target.checked })} label="Send me the weekly digest" />
          <button type="button" className="link mt-2 text-xs" onClick={() => setPreview((v) => !v)}>
            {preview ? 'Hide preview' : 'Preview this week’s digest'}
          </button>
        </Row>
      </Panel>
      {preview && (
        <Panel title="This week’s digest" description={p.data?.lastSentAt ? <>Last sent <RelativeTime date={p.data.lastSentAt} />.</> : 'Not sent yet.'}>
          {p.isLoading ? (
            <PageSpinner />
          ) : p.data?.empty ? (
            <p className="py-4 text-[13px] text-fg-muted">Nothing happened in the last seven days, so no digest would be sent.</p>
          ) : (
            p.data && (
              <div className="rounded-md border border-border">
                <p className="border-b border-border px-4 py-2 text-[13px] font-medium">{p.data.subject}</p>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-relaxed text-fg-muted">{p.data.text}</pre>
              </div>
            )
          )}
        </Panel>
      )}
    </>
  );
}

// ─── Referrals ─────────────────────────────────────────────────────────────

function ReferralsSection() {
  const q = useQuery({ queryKey: ['referrals'], queryFn: () => api.get<ReferralInfo>('/user/referrals') });
  if (q.isLoading) return <PageSpinner />;
  if (!q.data) return null;
  const r = q.data;
  const gb = (mb: number) => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);
  return (
    <>
      <Panel title="Invite people" description={r.bonusPerReferralMb > 0 ? `Share your link. Each person who joins through it adds ${gb(r.bonusPerReferralMb)} of storage to your personal plan for ${r.bonusDays} days, up to ${gb(r.maxBonusMb)} at a time.` : 'Share your link with people who should be here.'}>
        {!r.signupOpen && <Flash className="mb-3">Sign-up is closed on this instance, so the link only works once an administrator opens it.</Flash>}
        <div className="flex gap-1">
          <input readOnly value={r.link} aria-label="Your invite link" onFocus={(e) => e.target.select()} className="h-9 min-w-0 flex-1 rounded-sm border border-border bg-canvas-inset px-2 font-mono text-[13px]" />
          <CopyButton value={r.link} size="md" />
        </div>
        {r.bonusPerReferralMb > 0 && (
          <div className="mt-4 flex flex-wrap gap-8 text-[13px]">
            <div><p className="text-xs text-fg-muted">Joined</p><p className="text-lg font-medium tabular-nums">{r.invited.length}</p></div>
            <div><p className="text-xs text-fg-muted">Counted</p><p className="text-lg font-medium tabular-nums">{r.counted}</p></div>
            <div><p className="text-xs text-fg-muted">Bonus storage now</p><p className="text-lg font-medium tabular-nums">{gb(r.bonusMb)}</p>{r.bonusExpiresAt && <p className="text-xs text-fg-subtle">first runs out <RelativeTime date={r.bonusExpiresAt} /></p>}</div>
          </div>
        )}
        {!r.bonusApplies && r.bonusPerReferralMb > 0 && <p className="mt-2 text-xs text-fg-subtle">This instance does not limit storage, so the bonus is recorded but changes nothing yet.</p>}
      </Panel>
      {r.invited.length > 0 && (
        <Panel title="People you invited">
          {r.invited.map((u) => (
            <KV key={u.username} k={u.username}>
              Joined <RelativeTime date={u.joinedAt} />
              {!u.counts ? <span className="ml-2 text-fg-subtle">(counts once they confirm their email)</span> : !u.active && <span className="ml-2 text-fg-subtle">(bonus ended)</span>}
            </KV>
          ))}
        </Panel>
      )}
    </>
  );
}

// ─── Sessions ──────────────────────────────────────────────────────────────

function SessionsSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<SessionInfo[]>('/user/sessions') });
  const [msg, setMsg] = useMessage();
  const revoke = async (s: SessionInfo) => {
    await api.delete(`/user/sessions/${s.id}`);
    await qc.invalidateQueries({ queryKey: ['sessions'] });
  };
  const revokeOthers = async () => {
    if (!confirm('Sign out every other session?')) return;
    const r = await api.delete<{ revoked: number }>('/user/sessions');
    setMsg({ tone: 'success', text: `${r.revoked} session${r.revoked === 1 ? '' : 's'} signed out.` });
    await qc.invalidateQueries({ queryKey: ['sessions'] });
  };
  const others = q.data?.filter((s) => !s.current).length ?? 0;
  return (
    <Panel
      title="Web sessions"
      description="Browsers signed in to your account. Sessions last 30 days and extend while you use them."
      action={
        others > 0 && (
          <Button size="sm" variant="danger" onClick={() => void revokeOthers()}>
            Sign out other sessions
          </Button>
        )
      }
    >
      {msg && <p className="mb-2 text-xs text-success">{msg.text}</p>}
      {q.isLoading ? (
        <PageSpinner />
      ) : (
        <ul>
          {q.data?.map((s) => {
            const a = describeAgent(s.userAgent);
            return (
              <li key={s.id} className="flex items-center gap-4 border-b border-border-muted py-3 last:border-b-0">
                <span className="text-fg-subtle">{a.cli ? <Terminal size={18} /> : a.mobile ? <Smartphone size={18} /> : <Laptop size={18} />}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[13px] font-medium">
                    {a.label}
                    {s.current && <Label tone="success">This device</Label>}
                  </p>
                  <p className="text-xs text-fg-muted">
                    <span className="font-mono">{s.ip ?? 'unknown IP'}</span> · signed in <RelativeTime date={s.createdAt} /> · expires <RelativeTime date={s.expiresAt} />
                  </p>
                </div>
                {!s.current && (
                  <Button size="sm" onClick={() => void revoke(s)}>
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

// ─── Tokens ────────────────────────────────────────────────────────────────

const SCOPE_HINT: Record<string, string> = {
  'repo:read': 'Clone, fetch and read repositories through the API',
  'repo:write': 'Push, open, review and merge pull requests',
  admin: 'Manage repository settings, collaborators and organizations',
};

function TokensSection() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<TokenInfo[]>('/user/tokens') });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['repo:read', 'repo:write']);
  const [expires, setExpires] = useState('90');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ token: string }>('/user/tokens', { name, scopes, expiresInDays: expires === 'never' ? null : Number(expires) });
      setCreated(res.token);
      setName('');
      setShowForm(false);
      await qc.invalidateQueries({ queryKey: ['tokens'] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (t: TokenInfo) => {
    if (!confirm(`Revoke token “${t.name}”? Anything using it will stop working.`)) return;
    await api.delete(`/user/tokens/${t.id}`);
    await qc.invalidateQueries({ queryKey: ['tokens'] });
  };
  const expiry = expires === 'never' ? null : new Date(Date.now() + Number(expires) * 86400_000);

  return (
    <>
      <Panel
        title="Personal access tokens"
        description={
          <>
            Use a token as the password for <code className="font-mono text-xs">git push</code> over HTTPS, or send it as <code className="font-mono text-xs">Authorization: Bearer …</code> to the API.
          </>
        }
        action={
          !showForm && (
            <Button size="sm" variant="primary" onClick={() => setShowForm(true)}>
              Generate new token
            </Button>
          )
        }
      >
        {created && (
          <Flash tone="success" className="mb-4">
            <div className="mb-1 text-[13px] font-medium">Copy your new token now. You won’t be able to see it again.</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all bg-canvas px-2 py-1 font-mono text-xs">{created}</code>
              <CopyButton value={created} />
            </div>
          </Flash>
        )}
        {showForm && (
          <form onSubmit={submit} className="mb-6 border border-border p-4">
            {error && (
              <Flash tone="danger" className="mb-3">
                {error}
              </Flash>
            )}
            <Row label="Note" hint="What’s this token for?" htmlFor="t-name">
              <Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Laptop git" required autoFocus maxLength={80} />
            </Row>
            <Row label="Expiration" hint={expiry ? `Expires on ${expiry.toLocaleDateString()}.` : 'Tokens without an expiry are a long-lived risk.'} htmlFor="t-exp">
              <Select id="t-exp" value={expires} onChange={(e) => setExpires(e.target.value)} className="max-w-48">
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="366">1 year</option>
                <option value="never">No expiration</option>
              </Select>
            </Row>
            <Row label="Scopes" hint="Grant only what the token needs.">
              <div className="space-y-2">
                {TOKEN_SCOPES.map((s) => (
                  <label key={s} className="flex items-start gap-2.5 text-[13px]">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-3.5 w-3.5 accent-[var(--pcb-accent-emphasis)]"
                      checked={scopes.includes(s)}
                      onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))}
                    />
                    <span>
                      <span className="font-mono">{s}</span>
                      <span className="block text-xs text-fg-muted">{SCOPE_HINT[s]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Row>
            <div className="mt-3 flex gap-2">
              <Button type="submit" variant="primary" loading={busy} disabled={!scopes.length || !name.trim()}>
                Generate token
              </Button>
              <Button variant="invisible" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {tokens.data?.length === 0 ? (
          <p className="mx-auto max-w-md py-8 text-center text-[13px] leading-relaxed text-fg-muted">
            No tokens yet. You need one to push or pull over HTTPS, use the REST API, or connect the KiCad plugin. Create it above and copy it straight away: it is shown once.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead>
                <tr className="border-b border-border-muted text-left text-xs text-fg-subtle">
                  <th className="py-2 pr-4 font-normal">Token</th>
                  <th className="py-2 pr-4 font-normal">Scopes</th>
                  <th className="py-2 pr-4 font-normal">Last used</th>
                  <th className="py-2 pr-4 font-normal">Expires</th>
                  <th className="w-10 py-2" />
                </tr>
              </thead>
              <tbody>
                {tokens.data?.map((t) => {
                  const expired = t.expiresAt && new Date(t.expiresAt) < new Date();
                  return (
                    <tr key={t.id} className="border-b border-border-muted last:border-b-0">
                      <td className="py-2.5 pr-4">
                        <div className="font-medium">{t.name}</div>
                        <div className="font-mono text-xs text-fg-subtle">{t.prefix}…</div>
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-xs text-fg-muted">{t.scopes.join(', ')}</td>
                      <td className="py-2.5 pr-4 text-xs text-fg-muted">{t.lastUsedAt ? <RelativeTime date={t.lastUsedAt} /> : 'Never'}</td>
                      <td className={cx('py-2.5 pr-4 text-xs', expired ? 'text-danger' : 'text-fg-muted')}>{t.expiresAt ? expired ? 'Expired' : <RelativeTime date={t.expiresAt} /> : <span className="text-attention">Never</span>}</td>
                      <td className="py-2.5 text-right">
                        <button onClick={() => void revoke(t)} aria-label={`Revoke ${t.name}`} title="Revoke" className="p-1 text-fg-subtle hover:text-danger">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Using a token with git" description="Git over HTTPS uses your username and a personal access token as the password. Never paste a token into a repository or a chat.">
        <pre className="overflow-x-auto border border-border-muted bg-canvas-inset p-3 font-mono text-xs leading-relaxed text-fg-muted">
          {`git config --global credential.helper store
git clone ${location.origin}/<owner>/<repo>.git
# Username: your username   Password: the token`}
        </pre>
      </Panel>
    </>
  );
}

// ─── Repositories & organizations ──────────────────────────────────────────

function RepositoriesSection() {
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['repos', 'mine'], queryFn: () => api.get<RepoInfo[]>('/repos', { mine: true }) });
  const [filter, setFilter] = useState('');
  const rows = (q.data ?? []).filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Panel
      title="Repositories"
      description="Repositories you own or can push to."
      action={
        <Link to="/new" className={buttonClass('primary', 'sm')}>
          New repository
        </Link>
      }
    >
      <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter repositories" className="mb-3 h-8 max-w-xs text-[13px]" aria-label="Filter repositories" />
      {q.isLoading ? (
        <PageSpinner />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-fg-muted">{filter ? `No repositories match “${filter}”.` : 'You don’t have any repositories yet.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-[13px]">
            <thead>
              <tr className="border-b border-border-muted text-left text-xs text-fg-subtle">
                <th className="py-2 pr-4 font-normal">Name</th>
                <th className="py-2 pr-4 font-normal">Access</th>
                <th className="py-2 pr-4 text-right font-normal">Stars</th>
                <th className="py-2 pr-4 text-right font-normal">Open PRs</th>
                <th className="py-2 pr-4 font-normal">Pushed</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border-muted last:border-b-0">
                  <td className="py-2.5 pr-4">
                    <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="no-underline hover:text-accent">
                      <span className="text-fg-muted">{r.owner}/</span>
                      <span className="font-medium">{r.name}</span>
                    </Link>
                    {r.visibility === 'private' && <Lock size={11} className="ml-1.5 inline text-fg-subtle" aria-label="Private" />}
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-fg-muted">{r.owner.toLowerCase() === me?.username.toLowerCase() ? 'owner' : r.permission}</td>
                  <td className="py-2.5 pr-4 text-right font-mono text-xs tabular-nums">{r.starCount}</td>
                  <td className="py-2.5 pr-4 text-right font-mono text-xs tabular-nums">{r.openPullCount}</td>
                  <td className="py-2.5 pr-4 text-xs text-fg-muted">{r.pushedAt ? <RelativeTime date={r.pushedAt} /> : 'Never'}</td>
                  <td className="py-2.5 text-right">
                    {r.permission === 'admin' && (
                      <Link to="/$owner/$repo/settings" params={{ owner: r.owner, repo: r.name }} className="text-xs text-fg-muted no-underline hover:text-fg">
                        Settings
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function OrganizationsSection() {
  const { data: me } = useMe();
  return (
    <Panel
      title="Organizations"
      description="Shared namespaces for teams. Owners manage members and repositories."
      action={
        <Link to="/organizations/new" className={buttonClass('primary', 'sm')}>
          New organization
        </Link>
      }
    >
      {!me?.orgs.length ? (
        <p className="py-6 text-center text-[13px] text-fg-muted">You are not a member of any organization.</p>
      ) : (
        <ul>
          {me.orgs.map((o) => (
            <li key={o.slug} className="flex items-center gap-3 border-b border-border-muted py-3 last:border-b-0">
              <Avatar name={o.slug} size={28} square />
              <div className="min-w-0 flex-1">
                <Link to="/$owner" params={{ owner: o.slug }} className="text-[13px] font-medium no-underline hover:text-accent">
                  {o.name}
                </Link>
                <p className="font-mono text-xs text-fg-subtle">{o.slug}</p>
              </div>
              <Label tone={o.role === 'owner' ? 'accent' : 'default'}>{o.role}</Label>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ─── Security log ──────────────────────────────────────────────────────────

const ACTION_TEXT: Record<string, string> = {
  'user.login': 'Signed in with password',
  'user.login.github': 'Signed in with GitHub',
  'user.register': 'Created the account',
  'user.password_changed': 'Changed password',
  'user.export': 'Exported account data',
  'token.create': 'Created an access token',
  'token.revoke': 'Revoked an access token',
  'session.revoke': 'Revoked a session',
  'session.revoke_others': 'Signed out other sessions',
  'repo.create': 'Created a repository',
  'repo.update': 'Updated repository settings',
  'repo.delete': 'Deleted a repository',
  'admin.user_update': 'Changed a user’s role',
};

export function auditText(a: AuditEntry): string {
  const name = typeof a.metadata.name === 'string' ? ` ${a.metadata.name}` : '';
  return (ACTION_TEXT[a.action] ?? a.action.replace(/[._]/g, ' ')) + name;
}

function SecurityLogSection() {
  const q = useInfiniteQuery({
    queryKey: ['audit', 'me'],
    queryFn: ({ pageParam }) => api.get<AuditEntry[]>('/user/audit', pageParam ? { before: pageParam, limit: 50 } : { limit: 50 }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => (last.length === 50 ? last.at(-1)!.createdAt : undefined),
  });
  const rows = q.data?.pages.flat() ?? [];
  return (
    <Panel title="Security log" description="Account and repository events performed by you, newest first.">
      {q.isLoading ? (
        <PageSpinner />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-fg-muted">No events yet.</p>
      ) : (
        <>
          <ul>
            {rows.map((a) => (
              <li key={a.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-b border-border-muted py-2.5 last:border-b-0 sm:grid-cols-[12rem_minmax(0,1fr)_8rem_7rem]">
                <span className="font-mono text-xs text-fg-subtle">{a.action}</span>
                <span className="col-span-2 row-start-2 text-[13px] sm:col-span-1 sm:row-start-auto">{auditText(a)}</span>
                <span className="hidden font-mono text-xs text-fg-subtle sm:block">{a.ip}</span>
                <RelativeTime date={a.createdAt} className="row-start-1 text-right text-xs text-fg-muted sm:row-start-auto" />
              </li>
            ))}
          </ul>
          {q.hasNextPage && (
            <Button size="sm" className="mt-3" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              Load older events
            </Button>
          )}
        </>
      )}
    </Panel>
  );
}

type SshInfo = { enabled: false } | { enabled: true; host: string; port: number; hostKeyFingerprint: string | null };

function SshKeysSection() {
  const qc = useQueryClient();
  const keysQ = useQuery({ queryKey: ['ssh-keys'], queryFn: () => api.get<SshKeyInfo[]>('/user/ssh-keys') });
  const info = useQuery({ queryKey: ['ssh-info'], queryFn: () => api.get<SshInfo>('/ssh'), staleTime: Infinity });
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/user/ssh-keys', { title, key });
      setTitle('');
      setKey('');
      setShowForm(false);
      await qc.invalidateQueries({ queryKey: ['ssh-keys'] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (k: SshKeyInfo) => {
    if (!confirm(`Delete SSH key “${k.title}”? Computers using it will no longer be able to push.`)) return;
    await api.delete(`/user/ssh-keys/${k.id}`);
    await qc.invalidateQueries({ queryKey: ['ssh-keys'] });
  };
  const ssh = info.data;
  return (
    <Panel
      title="SSH keys"
      description={<>Push and pull with <code className="font-mono text-xs">git</code> over SSH without typing a token. Add the public key from each computer you use.</>}
      action={
        !showForm && (
          <Button size="sm" variant="primary" onClick={() => setShowForm(true)}>
            New SSH key
          </Button>
        )
      }
    >
      {ssh && !ssh.enabled && (
        <Flash className="mb-4">This server does not run SSH. Keys you add are kept for when it does; use HTTPS with a personal access token meanwhile.</Flash>
      )}
      {showForm && (
        <form onSubmit={submit} className="mb-6 border border-border p-4">
          {error && (
            <Flash tone="danger" className="mb-3">
              {error}
            </Flash>
          )}
          <Row label="Title" hint="Which computer is this key on?" htmlFor="k-title">
            <Input id="k-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Work laptop" maxLength={100} />
          </Row>
          <Row
            label="Public key"
            htmlFor="k-key"
            hint={
              <>
                The contents of <code className="font-mono">~/.ssh/id_ed25519.pub</code>. No key yet? Run <code className="font-mono">ssh-keygen -t ed25519</code>.
              </>
            }
          >
            <Textarea id="k-key" value={key} onChange={(e) => setKey(e.target.value)} rows={4} required autoFocus spellCheck={false} placeholder="ssh-ed25519 AAAA… you@laptop" className="font-mono text-xs" />
          </Row>
          <div className="mt-3 flex gap-2">
            <Button type="submit" variant="primary" loading={busy}>
              Add key
            </Button>
            <Button onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </form>
      )}
      {keysQ.data?.length === 0 && !showForm && <p className="py-3 text-sm text-fg-muted">No SSH keys yet.</p>}
      <ul className="divide-y divide-border-muted">
        {keysQ.data?.map((k) => (
          <li key={k.id} className="flex items-center gap-3 py-3">
            <KeyRound size={16} className="shrink-0 text-fg-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{k.title}</div>
              <div className="truncate font-mono text-xs text-fg-muted">{k.fingerprint}</div>
              <div className="text-xs text-fg-muted">
                Added <RelativeTime date={k.createdAt} /> · {k.lastUsedAt ? <>last used <RelativeTime date={k.lastUsedAt} /></> : 'never used'}
              </div>
            </div>
            <Button size="sm" variant="danger" onClick={() => void remove(k)}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
      {ssh?.enabled && (
        <div className="mt-6 space-y-2 border-t border-border pt-4 text-[13px] text-fg-muted">
          <p>
            Test the connection with <code className="font-mono text-xs">ssh -T -p {ssh.port} git@{ssh.host}</code>.
          </p>
          {ssh.hostKeyFingerprint && (
            <p>
              The first time you connect, check that the server&rsquo;s key fingerprint is <code className="break-all font-mono text-xs">{ssh.hostKeyFingerprint}</code>.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

// ─── Routes ────────────────────────────────────────────────────────────────

const SECTIONS: Record<Section, () => ReactNode> = {
  profile: () => <ProfileSection />,
  account: () => <AccountSection />,
  appearance: () => <AppearanceSection />,
  notifications: () => <NotificationsSection />,
  security: () => <SecuritySection />,
  sessions: () => <SessionsSection />,
  tokens: () => <TokensSection />,
  'ssh-keys': () => <SshKeysSection />,
  repositories: () => <RepositoriesSection />,
  organizations: () => <OrganizationsSection />,
  usage: () => <UsageSection />,
  referrals: () => <ReferralsSection />,
  'security-log': () => <SecurityLogSection />,
};

function UsageSection() {
  const { data: me } = useMe();
  if (!me) return null;
  return (
    <>
    <Panel title="Usage and plan" description="Storage, check minutes and seats used by your personal repositories. Organizations have their own, under their settings.">
      <UsagePanel owner={me.username} />
    </Panel>
    <BillingPanel owner={me.username} />
    </>
  );
}

export function SettingsPage() {
  const { section = 'profile' } = useParams({ strict: false }) as { section?: string };
  const render = SECTIONS[section as Section];
  if (!render) return <NotFound />;
  return <SettingsLayout section={section as Section}>{render()}</SettingsLayout>;
}
