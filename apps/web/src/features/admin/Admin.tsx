import { InstanceAdmin, InvoicesAdmin } from './Instance';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, CreditCard, Database, EyeOff, LayoutDashboard, Search, Table2, Users, Receipt, Server } from 'lucide-react';
import type { AdminOverview, AdminTableInfo, AdminTablePage, UserSummary } from '@jumper/shared';
import { Avatar, Button, Input, Label, PageSpinner, RelativeTime, cx } from '@jumper/ui';
import { ErrorView, NotFound, PageContainer, formatBytes } from '../../shared/components/common';
import { api, errorMessage } from '../../shared/lib/api';
import { useMe } from '../../shared/lib/queries';
import { auditText } from '../settings/Settings';

export type AdminSection = 'overview' | 'users' | 'customers' | 'database' | 'instance' | 'invoices';

export function AdminLayout({ section, children, wide }: { section: AdminSection; children: ReactNode; wide?: boolean }) {
  const { pathname } = useLocation();
  const { data: me, isLoading } = useMe();
  if (isLoading) return <PageSpinner />;
  if (!me) return <Navigate to="/login" search={{ redirect: pathname }} />;
  if (!me.isAdmin) return <NotFound>Only instance administrators can open this page.</NotFound>;
  const items = [
    { id: 'overview', to: '/admin', label: 'Overview', icon: <LayoutDashboard size={14} /> },
    { id: 'users', to: '/admin/users', label: 'Users', icon: <Users size={14} /> },
    { id: 'customers', to: '/admin/customers', label: 'Customers', icon: <CreditCard size={14} /> },
    { id: 'database', to: '/admin/database', label: 'Database', icon: <Database size={14} /> },
    { id: 'instance', to: '/admin/instance', label: 'Instance', icon: <Server size={14} /> },
    { id: 'invoices', to: '/admin/invoices', label: 'Invoices', icon: <Receipt size={14} /> },
  ] as const;
  return (
    <PageContainer className={cx("py-8", wide && "max-w-[1600px]")}>
      <header className="mb-6 flex flex-wrap items-end gap-x-8 gap-y-3 border-b border-border">
        <div className="pb-3">
          <p className="font-mono text-xs text-fg-subtle">Site administration</p>
          <h1 className="text-[17px] font-medium tracking-[-0.01em]">Jumper instance</h1>
        </div>
        <nav aria-label="Administration" className="flex gap-1">
          {items.map((it) => (
            <Link
              key={it.id}
              to={it.to}
              aria-current={it.id === section ? 'page' : undefined}
              className={cx(
                '-mb-px flex items-center gap-2 border-b px-3 pb-3 pt-1 text-[13px] no-underline transition-colors',
                it.id === section ? 'border-select text-fg' : 'border-transparent text-fg-muted hover:text-fg',
              )}
            >
              {it.icon}
              {it.label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </PageContainer>
  );
}

// ─── Overview ──────────────────────────────────────────────────────────────

function Stat({ label, value, to }: { label: string; value: ReactNode; to?: string }) {
  const body = (
    <>
      <span className="block text-xs text-fg-muted">{label}</span>
      <span className="mt-1 block font-mono text-xl tabular-nums tracking-tight">{value}</span>
    </>
  );
  return to ? (
    <Link to="/admin/database/$table" params={{ table: to }} className="border-b border-r border-border-muted px-4 py-3 no-underline transition-colors hover:bg-canvas-subtle">
      {body}
    </Link>
  ) : (
    <div className="border-b border-r border-border-muted px-4 py-3">{body}</div>
  );
}

export function AdminOverviewPage() {
  const q = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api.get<AdminOverview>('/admin/overview') });
  return (
    <AdminLayout section="overview">
      {q.isLoading ? (
        <PageSpinner />
      ) : q.error ? (
        <ErrorView error={q.error} />
      ) : (
        q.data && <Overview o={q.data} />
      )}
    </AdminLayout>
  );
}

function Overview({ o }: { o: AdminOverview }) {
  const checkTotal = o.checks.reduce((s, c) => s + c.n, 0);
  const byConclusion = (k: string) => o.checks.filter((c) => (c.conclusion ?? c.status) === k).reduce((s, c) => s + c.n, 0);
  const bars = [
    ['success', 'bg-success'],
    ['failure', 'bg-danger'],
    ['neutral', 'bg-fg-subtle'],
    ['skipped', 'bg-border'],
  ] as const;
  return (
    <div className="space-y-10">
      <section>
        <div className="grid grid-cols-2 border-l border-t border-border-muted sm:grid-cols-4">
          <Stat label="Users" value={o.counts.users} to="users" />
          <Stat label="Organizations" value={o.counts.orgs} to="organizations" />
          <Stat label="Repositories" value={o.counts.repos} to="repositories" />
          <Stat label="Check runs" value={o.counts.checks} to="check_runs" />
          <Stat label="Artifacts" value={o.counts.artifacts} to="artifacts" />
          <Stat label="Active sessions" value={o.counts.sessions} to="sessions" />
        </div>
      </section>

      <div className="grid gap-10 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 border-b border-border pb-2 text-[15px] font-medium">Storage</h2>
          {[
            ['Git repositories', o.repoBytes],
            ['Artifacts (renders, exports)', o.storageBytes],
            ['PostgreSQL database', o.dbBytes],
          ].map(([k, v]) => (
            <div key={k as string} className="flex justify-between border-b border-border-muted py-2 text-[13px]">
              <span className="text-fg-muted">{k}</span>
              <span className="font-mono tabular-nums">{formatBytes(v as number)}</span>
            </div>
          ))}
          <div className="flex justify-between border-b border-border-muted py-2 text-[13px]">
            <span className="text-fg-muted">Runtime</span>
            <span className="font-mono text-xs">
              node {o.version.node.replace(/^v/, '')} · {o.version.postgres}
            </span>
          </div>
        </section>
        <section>
          <h2 className="mb-3 border-b border-border pb-2 text-[15px] font-medium">Check outcomes</h2>
          {checkTotal > 0 && (
            <div className="mb-3 flex h-1.5 overflow-hidden bg-canvas-inset">
              {bars.map(([k, c]) => {
                const n = byConclusion(k);
                return n ? <div key={k} className={c} style={{ width: `${(n / checkTotal) * 100}%` }} title={`${k}: ${n}`} /> : null;
              })}
            </div>
          )}
          {o.checks.map((c, i) => (
            <div key={i} className="flex justify-between border-b border-border-muted py-2 text-[13px]">
              <span className="text-fg-muted">{c.conclusion ?? c.status}</span>
              <span className="font-mono tabular-nums">{c.n}</span>
            </div>
          ))}
        </section>
      </div>

      <div className="grid gap-10 lg:grid-cols-2">
        <section>
          <div className="mb-3 flex items-baseline border-b border-border pb-2">
            <h2 className="text-[15px] font-medium">Newest users</h2>
            <Link to="/admin/users" className="link ml-auto text-xs">
              All users
            </Link>
          </div>
          <ul>
            {o.recentUsers.map((u) => (
              <li key={u.id} className="flex items-center gap-3 border-b border-border-muted py-2 text-[13px]">
                <Avatar name={u.username} src={u.avatarUrl} size={20} />
                <Link to="/$owner" params={{ owner: u.username }} className="font-medium no-underline hover:text-accent">
                  {u.username}
                </Link>
                {u.isAdmin && <Label tone="accent">admin</Label>}
                {u.disabled && <Label tone="danger">disabled</Label>}
                <RelativeTime date={u.createdAt} className="ml-auto text-xs text-fg-muted" />
              </li>
            ))}
          </ul>
        </section>
        <section>
          <div className="mb-3 flex items-baseline border-b border-border pb-2">
            <h2 className="text-[15px] font-medium">Recent activity</h2>
            <Link to="/admin/database/$table" params={{ table: 'audit_log' }} className="link ml-auto text-xs">
              Audit log table
            </Link>
          </div>
          <ul>
            {o.recentAudit.map((a) => (
              <li key={a.id} className="flex items-baseline gap-3 border-b border-border-muted py-2 text-[13px]">
                <span className="w-24 shrink-0 truncate font-medium">{a.actor?.username ?? 'system'}</span>
                <span className="min-w-0 flex-1 truncate text-fg-muted">{auditText(a)}</span>
                <RelativeTime date={a.createdAt} className="shrink-0 text-xs text-fg-subtle" />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

// ─── Users ─────────────────────────────────────────────────────────────────

type AdminUser = UserSummary & { email: string; isAdmin: boolean; disabled: boolean; emailVerified: boolean; repos: number; createdAt: string; lastSignIn: string | null };

export function AdminUsersPage() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const users = useQuery({ queryKey: ['admin', 'users', debounced], queryFn: () => api.get<AdminUser[]>('/admin/users', { q: debounced }), placeholderData: keepPreviousData });
  const update = async (u: AdminUser, patch: { isAdmin?: boolean; disabled?: boolean; emailVerified?: boolean }) => {
    const verb = patch.emailVerified ? 'Mark the email address of' : patch.disabled !== undefined ? (patch.disabled ? 'Suspend' : 'Reactivate') : patch.isAdmin ? 'Make admin:' : 'Remove admin from';
    if (!confirm(`${verb} ${u.username}?`)) return;
    setErr(null);
    try {
      await api.patch(`/admin/users/${u.id}`, patch);
      await qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  const remove = async (u: AdminUser) => {
    if (!confirm(`Permanently delete ${u.username} and the ${u.repos} repositor${u.repos === 1 ? 'y' : 'ies'} they own? This cannot be undone.`)) return;
    if (prompt(`Type ${u.username} to confirm`) !== u.username) return;
    setErr(null);
    try {
      await api.delete(`/admin/users/${u.id}`);
      await qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  const resetLink = async (u: AdminUser) => {
    setErr(null);
    try {
      const r = await api.post<{ url: string; expiresInMinutes: number }>(`/admin/users/${u.id}/reset-link`);
      await navigator.clipboard?.writeText(r.url).catch(() => {});
      prompt(`One-time password reset link for ${u.username} (valid ${r.expiresInMinutes} minutes, copied to your clipboard). Send it to them securely:`, r.url);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  return (
    <AdminLayout section="users">
      <div className="mb-3 flex items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find by username or email" className="h-8 pl-8 text-[13px]" aria-label="Find users" />
        </div>
        <span className="font-mono text-xs text-fg-subtle">{users.data?.length ?? 0} users</span>
      </div>
      {err && <p className="mb-2 text-xs text-danger">{err}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-xs text-fg-subtle">
              <th className="py-2 pr-4 font-normal">User</th>
              <th className="py-2 pr-4 font-normal">Email</th>
              <th className="py-2 pr-4 text-right font-normal">Repos</th>
              <th className="py-2 pr-4 font-normal">Joined</th>
              <th className="py-2 pr-4 font-normal">Last sign-in</th>
              <th className="py-2 pr-4 font-normal">Status</th>
              <th className="py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id} className="border-b border-border-muted">
                <td className="py-2 pr-4">
                  <span className="flex items-center gap-2">
                    <Avatar name={u.username} src={u.avatarUrl} size={20} />
                    <Link to="/$owner" params={{ owner: u.username }} className="font-medium no-underline hover:text-accent">
                      {u.username}
                    </Link>
                    {u.name && <span className="truncate text-fg-muted">{u.name}</span>}
                  </span>
                </td>
                <td className="py-2 pr-4 font-mono text-xs text-fg-muted">{u.email}</td>
                <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums">{u.repos}</td>
                <td className="py-2 pr-4 text-xs text-fg-muted">
                  <RelativeTime date={u.createdAt} />
                </td>
                <td className="py-2 pr-4 text-xs text-fg-muted">{u.lastSignIn ? <RelativeTime date={u.lastSignIn} /> : 'Never'}</td>
                <td className="py-2 pr-4">
                  <span className="flex gap-1">
                    {u.isAdmin && <Label tone="accent">admin</Label>}
                    {u.disabled ? <Label tone="danger">suspended</Label> : <Label>active</Label>}
                    {!u.emailVerified && <Label tone="attention">unverified</Label>}
                  </span>
                </td>
                <td className="py-2 text-right">
                  {u.id !== me?.id && (
                    <span className="flex justify-end gap-1">
                      <Button size="sm" variant="invisible" onClick={() => void update(u, { isAdmin: !u.isAdmin })}>
                        {u.isAdmin ? 'Revoke admin' : 'Make admin'}
                      </Button>
                      {!u.emailVerified && (
                        <Button size="sm" variant="invisible" onClick={() => void update(u, { emailVerified: true })}>
                          Mark verified
                        </Button>
                      )}
                      <Button size="sm" variant="invisible" onClick={() => void resetLink(u)}>
                        Reset link
                      </Button>
                      <Button size="sm" variant={u.disabled ? 'default' : 'danger'} onClick={() => void update(u, { disabled: !u.disabled })}>
                        {u.disabled ? 'Reactivate' : 'Suspend'}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => void remove(u)}>
                        Delete
                      </Button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminLayout>
  );
}

// ─── Database browser ──────────────────────────────────────────────────────

function Cell({ value, type, hidden }: { value: unknown; type: string; hidden: boolean }) {
  if (hidden)
    return (
      <span className="inline-flex items-center gap-1 text-fg-subtle" title="Secret column: value never leaves the server">
        <EyeOff size={11} /> hidden
      </span>
    );
  if (value === null || value === undefined) return <span className="text-fg-subtle">NULL</span>;
  if (typeof value === 'boolean') return <span className={value ? 'text-success' : 'text-fg-muted'}>{String(value)}</span>;
  if (typeof value === 'object') return <span className="text-fg-muted">{JSON.stringify(value)}</span>;
  const s = String(value);
  if (/timestamp/.test(type)) {
    const d = new Date(s);
    return <span title={s}>{Number.isNaN(d.getTime()) ? s : d.toLocaleString()}</span>;
  }
  return <>{s}</>;
}

function RowDetail({ row, columns, onClose }: { row: Record<string, unknown>; columns: AdminTablePage['columns']; onClose: () => void }) {
  return (
    <div className="mt-3 border border-border">
      <div className="flex items-center border-b border-border-muted bg-canvas-subtle px-3 py-1.5 text-xs">
        <span className="font-medium">Row</span>
        <button onClick={onClose} className="ml-auto text-fg-muted hover:text-fg">
          Close
        </button>
      </div>
      <dl className="max-h-96 overflow-auto font-mono text-xs">
        {columns.map((c) => {
          const v = row[c.name];
          const text = c.hidden ? '•••• hidden' : v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
          return (
            <div key={c.name} className="grid grid-cols-[12rem_minmax(0,1fr)] gap-4 border-b border-border-muted px-3 py-1.5 last:border-b-0">
              <dt className="text-fg-muted">
                {c.name} <span className="text-[11.5px] text-fg-subtle">{c.type}</span>
              </dt>
              <dd className={cx('whitespace-pre-wrap break-all', (c.hidden || v === null) && 'text-fg-subtle')}>{text}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

export function AdminDatabasePage() {
  const { table } = useParams({ strict: false }) as { table?: string };
  const search = useSearch({ strict: false }) as { page?: number; q?: string; sort?: string; dir?: 'asc' | 'desc' };
  const navigate = useNavigate();
  const tables = useQuery({ queryKey: ['admin', 'tables'], queryFn: () => api.get<AdminTableInfo[]>('/admin/tables') });
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [q, setQ] = useState(search.q ?? '');
  useEffect(() => setQ(search.q ?? ''), [search.q, table]);
  useEffect(() => setSelected(null), [table, search.page, search.q, search.sort, search.dir]);
  const current = table ?? tables.data?.[0]?.name;
  const page = search.page ?? 1;
  const rows = useQuery({
    queryKey: ['admin', 'table', current, page, search.q, search.sort, search.dir],
    queryFn: () => api.get<AdminTablePage>(`/admin/tables/${current}`, { page, pageSize: 50, q: search.q, sort: search.sort, dir: search.dir }),
    enabled: Boolean(current),
    placeholderData: keepPreviousData,
  });
  const visibleTables = useMemo(() => (tables.data ?? []).filter((t) => t.name.includes(filter.toLowerCase())), [tables.data, filter]);
  const info = tables.data?.find((t) => t.name === current);
  const setSearch = (patch: Partial<typeof search>) =>
    void navigate({ to: '/admin/database/$table', params: { table: current! }, search: { ...search, ...patch } });
  const pages = rows.data ? Math.max(1, Math.ceil(rows.data.total / rows.data.pageSize)) : 1;
  const sortCol = search.sort ?? (rows.data?.columns.some((c) => c.name === 'created_at') ? 'created_at' : rows.data?.columns[0]?.name);
  const dir = search.dir ?? 'desc';

  return (
    <AdminLayout section="database" wide>
      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tables" className="mb-2 h-8 text-[13px]" aria-label="Filter tables" />
          <ul className="max-h-[70vh] overflow-y-auto">
            {visibleTables.map((t) => (
              <li key={t.name}>
                <Link
                  to="/admin/database/$table"
                  params={{ table: t.name }}
                  className={cx(
                    'flex items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] no-underline transition-colors',
                    t.name === current ? 'bg-neutral-muted text-fg' : 'text-fg-muted hover:bg-neutral-muted hover:text-fg',
                  )}
                >
                  <Table2 size={13} className="shrink-0 text-fg-subtle" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{t.name}</span>
                  <span className="font-mono text-xs tabular-nums text-fg-subtle">{t.rows}</span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-relaxed text-fg-subtle">
            Read-only. Secret columns (password and token hashes, session ids) are never sent to the browser. For editing, run <code className="font-mono">pnpm db:studio</code>.
          </p>
        </aside>

        <section className="min-w-0">
          {tables.error ? (
            <ErrorView error={tables.error} />
          ) : !current ? (
            <PageSpinner />
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <h2 className="font-mono text-[15px] font-medium">{current}</h2>
                {info && (
                  <span className="font-mono text-xs text-fg-subtle">
                    {info.rows} rows · {info.columns.length} columns · {formatBytes(info.bytes)}
                  </span>
                )}
                <form
                  className="relative ml-auto w-full max-w-xs"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setSearch({ q: q || undefined, page: undefined });
                  }}
                >
                  <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all columns, Enter to apply" className="h-8 pl-8 text-[13px]" aria-label="Search rows" />
                </form>
              </div>
              {rows.error ? (
                <ErrorView error={rows.error} />
              ) : !rows.data ? (
                <PageSpinner />
              ) : (
                <>
                  <div className={cx('overflow-auto border border-border transition-opacity', rows.isFetching && 'opacity-60')} style={{ maxHeight: 'calc(100vh - 290px)' }}>
                    <table className="w-max min-w-full border-collapse font-mono text-xs">
                      <thead className="sticky top-0 z-10 bg-canvas-subtle">
                        <tr>
                          {rows.data.columns.map((c) => (
                            <th key={c.name} className="border-b border-r border-border px-0 py-0 text-left font-normal last:border-r-0">
                              <button
                                onClick={() => setSearch({ sort: c.name, dir: sortCol === c.name && dir === 'desc' ? 'asc' : 'desc', page: undefined })}
                                className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-neutral-muted"
                                title={`Sort by ${c.name}`}
                              >
                                <span className="text-fg">{c.name}</span>
                                <span className="text-[11.5px] text-fg-subtle">{c.type}</span>
                                {sortCol === c.name && (dir === 'asc' ? <ArrowUp size={11} className="text-accent" /> : <ArrowDown size={11} className="text-accent" />)}
                              </button>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.data.rows.map((r, i) => (
                          <tr
                            key={i}
                            onClick={() => setSelected(selected === i ? null : i)}
                            aria-selected={selected === i}
                            className={cx('cursor-pointer', selected === i ? 'bg-accent-subtle' : 'hover:bg-canvas-subtle')}
                          >
                            {rows.data!.columns.map((c) => (
                              <td key={c.name} className="max-w-[28rem] truncate border-b border-r border-border-muted px-2.5 py-1.5 align-top last:border-r-0">
                                <Cell value={r[c.name]} type={c.type} hidden={c.hidden} />
                              </td>
                            ))}
                          </tr>
                        ))}
                        {rows.data.rows.length === 0 && (
                          <tr>
                            <td colSpan={rows.data.columns.length} className="px-3 py-8 text-center font-sans text-[13px] text-fg-muted">
                              {search.q ? 'No rows match.' : 'This table is empty.'}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {selected !== null && rows.data.rows[selected] && (
                    <RowDetail row={rows.data.rows[selected]} columns={rows.data.columns} onClose={() => setSelected(null)} />
                  )}
                  <div className="mt-3 flex items-center gap-3 text-xs text-fg-muted">
                    <span className="font-mono">
                      {rows.data.total === 0 ? 0 : (page - 1) * rows.data.pageSize + 1}–{Math.min(page * rows.data.pageSize, rows.data.total)} of {rows.data.total}
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      <Button size="sm" variant="invisible" disabled={page <= 1} onClick={() => setSearch({ page: page - 1 })} leadingIcon={<ChevronLeft size={13} />}>
                        Prev
                      </Button>
                      <span className="font-mono">
                        {page} / {pages}
                      </span>
                      <Button size="sm" variant="invisible" disabled={page >= pages} onClick={() => setSearch({ page: page + 1 })} trailingIcon={<ChevronRight size={13} />}>
                        Next
                      </Button>
                    </span>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </AdminLayout>
  );
}

export function AdminInstancePage() {
  return (
    <AdminLayout section="instance">
      <InstanceAdmin />
    </AdminLayout>
  );
}

export function AdminInvoicesPage() {
  return (
    <AdminLayout section="invoices">
      <InvoicesAdmin />
    </AdminLayout>
  );
}
