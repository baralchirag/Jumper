import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircuitBoard, FileText, FolderGit2, FolderOpen, Inbox, KeyRound } from 'lucide-react';
import { KICAD_GITIGNORE, type RepoInfo, type TokenInfo } from '@jumper/shared';
import { Button, CopyButton, EmptyState, Flash, SegmentedControl, buttonClass } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys, useRepo } from '../../shared/lib/queries';
import { canWrite, useRepoInfo } from './context';

type Path = 'folder' | 'git' | 'web';

function Step({ n, title, done, last, children }: { n: number; title: ReactNode; done?: boolean; last?: boolean; children: ReactNode }) {
  return (
    <li className={last ? 'relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-4' : 'relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-4 pb-8'}>
      {!last && <span aria-hidden className="absolute bottom-0 left-[13.5px] top-7 w-px bg-border" />}
      <span
        className={
          done
            ? 'z-10 flex h-7 w-7 items-center justify-center rounded-full bg-success-emphasis font-mono text-xs text-white'
            : 'z-10 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-canvas font-mono text-xs text-fg-muted'
        }
      >
        {done ? '✓' : n}
      </span>
      <div className="min-w-0 pt-0.5">
        <h3 className="mb-2 text-[15px] font-medium tracking-tight">{title}</h3>
        <div className="space-y-3 text-sm text-fg-muted">{children}</div>
      </div>
    </li>
  );
}

function Commands({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="overflow-auto rounded-md border border-border-muted bg-canvas-inset p-3 pr-12 font-mono text-[12.5px] leading-relaxed text-fg">{text}</pre>
      <div className="absolute right-1.5 top-1.5">
        <CopyButton value={text} />
      </div>
    </div>
  );
}

/** Shown on an empty repository: how to get the first commit in, and it notices when the push arrives. */
export function FirstPush() {
  const info = useRepoInfo();
  // Poll while empty: the moment a push lands, the repo query flips isEmpty and the code view replaces this page.
  useRepo(info.owner, info.name, { refetchInterval: info.isEmpty ? 4000 : false });
  if (!canWrite(info)) {
    return (
      <EmptyState icon={<Inbox size={20} />} title="This repository is empty">
        Nothing has been pushed to <span className="font-mono text-fg">{info.owner}/{info.name}</span> yet. Star or watch it to hear when it is.
      </EmptyState>
    );
  }
  return <Guide info={info} />;
}

function Guide({ info }: { info: RepoInfo }) {
  const qc = useQueryClient();
  const [path, setPath] = useState<Path>('folder');
  const [busy, setBusy] = useState<'readme' | 'sample' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<TokenInfo[]>('/user/tokens') });
  const now = Date.now();
  const usable = (tokens.data ?? []).filter((t) => !t.expiresAt || new Date(t.expiresAt).getTime() > now);
  const branch = info.defaultBranch;

  const initialize = async (kind: 'readme' | 'sample') => {
    setBusy(kind);
    setError(null);
    try {
      const updated = await api.post<RepoInfo>(repoPath(info.owner, info.name, '/initialize'), { kind });
      qc.setQueryData([...keys.repo(info.owner, info.name), 'info'], updated);
      await qc.invalidateQueries({ queryKey: keys.repo(info.owner, info.name) });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  const folder = [
    'cd path/to/your-kicad-project',
    `git init -b ${branch}`,
    '# first, add the KiCad .gitignore shown below',
    'git add .',
    'git commit -m "Add design"',
    `git remote add origin ${info.cloneUrl}`,
    `git push -u origin ${branch}`,
  ].join('\n');
  const existing = [`git remote add jumper ${info.cloneUrl}`, 'git push -u jumper --all', 'git push jumper --tags'].join('\n');

  return (
    <div className="grid max-w-5xl gap-10 lg:grid-cols-[minmax(0,1fr)_260px]">
      <section aria-labelledby="first-push-h">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
          <h2 id="first-push-h" className="headline text-[length:var(--t-m)]">
            Get your board into <span className="font-mono text-[0.85em] tracking-normal">{info.name}</span>
          </h2>
          <span role="status" className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 font-mono text-[11.5px] text-fg-muted">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent-emphasis" />
            Waiting for the first push
          </span>
        </div>
        {error && (
          <Flash tone="danger" className="mb-6">
            {error}
          </Flash>
        )}
        <ol>
          <Step n={1} done={usable.length > 0} title="Create an access token">
            {usable.length > 0 ? (
              <p>
                You have {usable.length === 1 ? 'an access token' : `${usable.length} access tokens`}. Git asks for a username and password: use{' '}
                <span className="font-mono text-fg">your username</span> and the token as the password.
              </p>
            ) : (
              <>
                <p>Git over HTTPS uses a personal access token instead of your password. Give it the <span className="font-mono text-fg">repo:write</span> scope.</p>
                <Link to="/settings/$section" params={{ section: 'tokens' }} className={buttonClass('default', 'sm')}>
                  <KeyRound size={14} /> Create a token
                </Link>
              </>
            )}
            <p className="text-xs">
              Tip: <span className="font-mono">git config --global credential.helper store</span> remembers it after the first push.
            </p>
          </Step>
          <Step n={2} title="Push your project">
            <SegmentedControl<Path>
              size="sm"
              ariaLabel="Starting point"
              value={path}
              onChange={setPath}
              options={[
                { value: 'folder', label: 'A KiCad folder', icon: <FolderOpen size={13} /> },
                { value: 'git', label: 'A git repository', icon: <FolderGit2 size={13} /> },
                { value: 'web', label: 'Nothing yet', icon: <CircuitBoard size={13} /> },
              ]}
            />
            {path === 'folder' && (
              <>
                <p>From the folder that holds your <span className="font-mono text-fg">.kicad_pro</span>, <span className="font-mono text-fg">.kicad_sch</span> and <span className="font-mono text-fg">.kicad_pcb</span> files:</p>
                <Commands text={folder} />
                <details className="group rounded-md border border-border-muted">
                  <summary className="cursor-pointer px-3 py-2 text-[13px] text-fg">The recommended .gitignore for KiCad</summary>
                  <div className="border-t border-border-muted p-2">
                    <Commands text={KICAD_GITIGNORE.trim()} />
                  </div>
                </details>
                <p className="text-xs">Commit custom symbol, footprint and 3D-model libraries the project uses, so checks and the 3D view can find them.</p>
              </>
            )}
            {path === 'git' && (
              <>
                <p>Already tracking the project with git (GitHub, GitLab or local)? Add Jumper as a second remote and push every branch and tag:</p>
                <Commands text={existing} />
              </>
            )}
            {path === 'web' && (
              <>
                <p>Start without the command line. You can clone it afterwards and keep working in KiCad.</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" size="sm" loading={busy === 'sample'} disabled={busy !== null} onClick={() => void initialize('sample')} leadingIcon={<CircuitBoard size={14} />}>
                    Add the example board
                  </Button>
                  <Button size="sm" loading={busy === 'readme'} disabled={busy !== null} onClick={() => void initialize('readme')} leadingIcon={<FileText size={14} />}>
                    Add a README and .jumper.yml
                  </Button>
                </div>
                <p className="text-xs">The example is a small LED indicator board that passes ERC and DRC, so you can see every tab working.</p>
              </>
            )}
          </Step>
          <Step n={3} last title="Watch the checks run">
            <p>
              Every push runs ERC, DRC, renders, the BOM and the fab package. This page updates on its own when your push arrives. Tune what runs with{' '}
              <Link to="/docs/$slug" params={{ slug: 'jumper-yml' }} className="link">
                .jumper.yml
              </Link>
              .
            </p>
          </Step>
        </ol>
      </section>
      <aside className="space-y-4 text-sm lg:pt-16">
        <div className="rounded-md border border-border p-4">
          <p className="label-mono mb-2">Clone URL</p>
          <div className="flex gap-1">
            <input readOnly value={info.cloneUrl} aria-label="Clone URL" onFocus={(e) => e.target.select()} className="h-8 min-w-0 flex-1 rounded-sm border border-border bg-canvas-inset px-2 font-mono text-xs" />
            <CopyButton value={info.cloneUrl} size="md" />
          </div>
          {info.sshCloneUrl && (
            <>
              <p className="label-mono mb-2 mt-4">Over SSH</p>
              <div className="flex gap-1">
                <input readOnly value={info.sshCloneUrl} aria-label="SSH clone URL" onFocus={(e) => e.target.select()} className="h-8 min-w-0 flex-1 rounded-sm border border-border bg-canvas-inset px-2 font-mono text-xs" />
                <CopyButton value={info.sshCloneUrl} size="md" />
              </div>
              <p className="mt-2 text-xs text-fg-muted">
                Add your key under{' '}
                <Link to="/settings/$section" params={{ section: 'ssh-keys' }} className="link">
                  SSH keys
                </Link>{' '}
                first.
              </p>
            </>
          )}
        </div>
        <div className="rounded-md border border-border p-4 text-fg-muted">
          <p className="mb-1 font-medium text-fg">Rather stay in KiCad?</p>
          <p className="mb-2">The Jumper plugin commits, pushes and pulls from a toolbar button in the PCB editor. Paste the clone URL above when it asks.</p>
          <Link to="/docs/$slug" params={{ slug: 'kicad-plugin' }} className="link">
            Get the KiCad plugin
          </Link>
        </div>
        <div className="rounded-md border border-border p-4 text-fg-muted">
          <p className="mb-1 font-medium text-fg">New to git?</p>
          <p className="mb-2">The quick start walks through it in five minutes, with KiCad in mind.</p>
          <Link to="/docs/$slug" params={{ slug: 'quick-start' }} className="link">
            Read the quick start
          </Link>
        </div>
      </aside>
    </div>
  );
}
