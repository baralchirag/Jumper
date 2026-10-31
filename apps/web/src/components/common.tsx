import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { CircuitBoard, Cpu, File, FileCode, FileText, Folder, FolderGit2, Image } from 'lucide-react';
import { Avatar, Flash, cx } from '@pcbhub/ui';
import type { UserSummary } from '@pcbhub/shared';
import { kicadFileKind } from '@pcbhub/shared';
import { ApiError, errorMessage } from '../lib/api';

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}

export function UserLink({ user, avatar = true, size = 20, className }: { user: UserSummary | null; avatar?: boolean; size?: number; className?: string }) {
  if (!user) return <span className="text-fg-muted">ghost</span>;
  return (
    <Link to="/$owner" params={{ owner: user.username }} className={cx('inline-flex items-center gap-1.5 font-semibold text-fg hover:text-accent', className)}>
      {avatar && <Avatar name={user.username} src={user.avatarUrl} size={size} />}
      {user.username}
    </Link>
  );
}

export function ErrorView({ error, title }: { error: unknown; title?: string }) {
  if (error instanceof ApiError && error.status === 404) return <NotFound />;
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <Flash tone="danger">
        <strong>{title ?? 'Something went wrong.'}</strong> {errorMessage(error)}
      </Flash>
    </div>
  );
}

export function NotFound({ children }: { children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-24 text-center">
      <div className="mb-4 font-mono text-6xl font-semibold text-fg-subtle">404</div>
      <h1 className="text-xl font-semibold">This is not the page you are looking for</h1>
      <p className="mt-2 text-fg-muted">{children ?? 'It may have been moved, deleted, or you may not have access to it.'}</p>
      <Link to="/" className="link mt-6 inline-block">
        Go home
      </Link>
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
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function PageContainer({ children, wide, className }: { children: ReactNode; wide?: boolean; className?: string }) {
  return <div className={cx('mx-auto w-full px-4 md:px-6', wide ? 'max-w-[1600px]' : 'max-w-[1280px]', className)}>{children}</div>;
}

export function Breadcrumbs({ owner, repo, gitRef, path }: { owner: string; repo: string; gitRef: string; path: string }) {
  const parts = path ? path.split('/') : [];
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-1 text-base">
      <Link to="/$owner/$repo/tree/$ref/$" params={{ owner, repo, ref: gitRef, _splat: '' }} className="link font-semibold">
        {repo}
      </Link>
      {parts.map((p, i) => {
        const sub = parts.slice(0, i + 1).join('/');
        const last = i === parts.length - 1;
        return (
          <span key={sub} className="flex items-center gap-1">
            <span className="text-fg-subtle">/</span>
            {last ? (
              <span className="font-semibold">{p}</span>
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
