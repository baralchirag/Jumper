import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CloudDownload, TriangleAlert } from 'lucide-react';
import type { RepoInfo } from '@jumper/shared';
import { Flash, Spinner } from '@jumper/ui';
import { keys } from '../../shared/lib/queries';

/** Shown while a repository is still being copied from another git host. It updates on its own; leaving is fine. */
export function ImportProgress({ info }: { info: RepoInfo }) {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      void qc.invalidateQueries({ queryKey: keys.repo(info.owner, info.name) });
    }, 3000);
    return () => clearInterval(t);
  }, [qc, info.owner, info.name]);
  const started = info.importing ? new Date(info.importing.startedAt).getTime() : now;
  const secs = Math.max(0, Math.round((now - started) / 1000));
  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <CloudDownload size={32} strokeWidth={1.5} className="mx-auto text-fg-subtle" />
      <h2 className="headline mt-4 text-[length:var(--t-m)]">Copying your repository</h2>
      <p className="mt-2 font-mono text-[13px] text-fg-muted">{info.importing?.source}</p>
      <p className="mt-6 inline-flex items-center gap-2 text-sm text-fg-muted">
        <Spinner size={14} /> {secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`} so far
      </p>
      <p className="mt-6 text-[15px] leading-relaxed text-fg-muted">
        You can close this page. The copy keeps going on our side, and the board, checks and fab files appear here when it is done.
      </p>
    </div>
  );
}

/** A background import that stopped: say why, and what to do next. */
export function ImportFailed({ info }: { info: RepoInfo }) {
  if (!info.importError) return null;
  return (
    <Flash tone="danger" icon={<TriangleAlert size={16} />} className="mb-6">
      <b className="font-medium">The copy from {info.importError.source} stopped.</b> {info.importError.message}
      <span className="mt-1 block text-[13px] text-fg-muted">
        Push your files below, or{' '}
        {info.permission === 'admin' ? (
          <Link to="/$owner/$repo/settings" params={{ owner: info.owner, repo: info.name }} className="link">
            delete this repository
          </Link>
        ) : (
          'delete this repository'
        )}{' '}
        and import it again.
      </span>
    </Flash>
  );
}
