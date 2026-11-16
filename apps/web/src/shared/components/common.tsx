import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { CircuitBoard, Cpu, File, FileCode, FileText, Folder, FolderGit2, Image } from 'lucide-react';
import { Avatar, Flash, cx } from '@jumper/ui';
import type { UserSummary } from '@jumper/shared';
import { kicadFileKind } from '@jumper/shared';
import { ApiError, errorMessage } from '../lib/api';

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}

export function UserLink({ user, avatar = true, size = 20, className }: { user: UserSummary | null; avatar?: boolean; size?: number; className?: string }) {
  if (!user) return <span className="text-fg-muted">ghost</span>;
  return (
    <Link to="/$owner" params={{ owner: user.username }} className={cx('inline-flex items-center gap-1.5 font-medium text-fg transition-colors hover:text-accent', className)}>
      {avatar && <Avatar name={user.username} src={user.avatarUrl} size={size} />}
      {user.username}
    </Link>
  );
}

export function ErrorView({ error, title }: { error: unknown; title?: string }) {
  if (error instanceof ApiError && error.status === 404) return <NotFound />;
  return (
    <div className="mx-auto max-w-3xl px-4 py-14">
      <p className="label-mono mb-3">Error</p>
      <Flash tone="danger">
        <strong>{title ?? 'Something went wrong.'}</strong> {errorMessage(error)}
      </Flash>
    </div>
  );
}

export function NotFound({ children }: { children?: ReactNode }) {
  return (
    <div className="relative overflow-hidden">
      <div className="relative mx-auto flex max-w-3xl flex-col items-start px-4 py-20 md:py-28">
        <svg viewBox="0 0 360 60" className="mb-8 w-full max-w-md overflow-visible" aria-hidden>
          <rect x="0" y="22" width="16" height="16" fill="var(--pcb-trace)" />
          <path d="M16 30 H130 L150 10 H190" fill="none" stroke="var(--pcb-trace)" strokeWidth="3" />
          <path d="M240 50 H300 L320 30 H344" fill="none" stroke="var(--pcb-fg-subtle)" strokeWidth="3" strokeDasharray="6 5" />
          <circle cx="352" cy="30" r="8" fill="none" stroke="var(--pcb-fg-subtle)" strokeWidth="2" />
          <g stroke="var(--pcb-danger)" strokeWidth="2">
            <path d="M206 14 l16 16 M222 14 l-16 16" />
          </g>
          <text x="214" y="52" textAnchor="middle" fill="var(--pcb-danger)" style={{ font: '500 10px var(--font-mono)' }}>
            404
          </text>
        </svg>
        <h1 className="display text-[length:var(--t-xl)]">This net goes nowhere.</h1>
        <p className="mt-5 max-w-md text-[15px] text-fg-muted">{children ?? 'The page may have been moved or deleted, or you may not have access to it.'}</p>
        <Link to="/" className="link mt-8 text-[15px]">
          Back to the start
        </Link>
      </div>
    </div>
  );
}

export function FileIcon({ name, type, className }: { name: string; type: 'blob' | 'tree' | 'commit'; className?: string }) {
  const c = cx('shrink-0', className);
  if (type === 'tree') return <Folder size={16} className={cx(c, 'text-fg-muted')} fill="currentColor" fillOpacity={0.15} />;
  if (type === 'commit') return <FolderGit2 size={16} className={cx(c, 'text-fg-muted')} />;
  const kind = kicadFileKind(name);
  if (kind === 'pcb') return <CircuitBoard size={16} className={cx(c, 'text-accent')} />;
  if (kind === 'sch') return <Cpu size={16} className={cx(c, 'text-accent')} />;
  if (kind) return <FileCode size={16} className={cx(c, 'text-fg-muted')} />;
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return <Image size={16} className={cx(c, 'text-fg-muted')} />;
  if (/\.(md|txt|rst)$/i.test(name)) return <FileText size={16} className={cx(c, 'text-fg-muted')} />;
  return <File size={16} className={cx(c, 'text-fg-muted')} />;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  const gb = n / 1024 ** 3;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

export function PageContainer({ children, className }: { children: ReactNode; className?: string }) {
  // A max-w-* class passed in replaces the default width (CSS order, not class order, would otherwise decide).
  const own = /(^|\s)max-w-/.test(className ?? '');
  return <div className={cx('mx-auto w-full px-5 md:px-8', !own && 'max-w-[1280px]', className)}>{children}</div>;
}

export function Breadcrumbs({ owner, repo, gitRef, path }: { owner: string; repo: string; gitRef: string; path: string }) {
  const parts = path ? path.split('/') : [];
  return (
    <nav aria-label="Path" className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-[13px]">
      <Link to="/$owner/$repo/tree/$ref/$" params={{ owner, repo, ref: gitRef, _splat: '' }} className="link font-medium">
        {repo}
      </Link>
      {parts.map((p, i) => {
        const sub = parts.slice(0, i + 1).join('/');
        const last = i === parts.length - 1;
        return (
          <span key={sub} className="flex items-center gap-1">
            <span className="text-fg-subtle">/</span>
            {last ? (
              <span className="font-medium text-fg">{p}</span>
            ) : (
              <Link to="/$owner/$repo/tree/$ref/$" params={{ owner, repo, ref: gitRef, _splat: sub }} className="link">
                {p}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** Title, a one-line explanation of what the page is for, and the page's primary action. */
export function PageHeader({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="min-w-0 max-w-2xl">
        <h1 className="headline text-[length:var(--t-l)]">{title}</h1>
        {children && <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">{children}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </header>
  );
}

/** True when the API refused because the owner's plan or the instance's licence does not include a feature. */
export function isUnavailable(e: unknown): boolean {
  return e instanceof ApiError && e.status === 402;
}

/** Calm notice in place of a feature the plan or licence does not include, instead of an error. */
export function UnavailableNotice({ error, what, message }: { error?: unknown; what?: string; message?: string }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-5 text-[13px] text-fg-muted">
      <p className="label-mono mb-1.5">{(error instanceof ApiError && (error.details as { needs?: string } | undefined)?.needs) === 'enterprise' ? 'Enterprise' : 'Business'}</p>
      <p>{what ? `${what}: ` : ''}{message ?? errorMessage(error)}</p>
    </div>
  );
}
