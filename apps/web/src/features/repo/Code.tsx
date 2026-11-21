import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, ChevronDown, CircuitBoard, Cpu, GitBranch, History } from 'lucide-react';
import type { TreeResponse } from '@jumper/shared';
import { kicadFileKind } from '@jumper/shared';
import { useState } from 'react';
import { Box, BoxHeader, Button, CopyButton, Dropdown, PageSpinner, RelativeTime, SegmentedControl, buttonClass } from '@jumper/ui';
import { CheckIcon, rollup } from '../checks/CheckStatus';
import { Markdown } from '../../shared/components/Markdown';
import { ProjectHero } from './ProjectHero';
import { MissingFiles, useDesigns } from './MissingFiles';
import { ImportFailed, ImportProgress } from './Importing';
import { RefPicker } from '../../shared/components/RefPicker';
import { Breadcrumbs, ErrorView, FileIcon, formatBytes, shortSha } from '../../shared/components/common';
import { api, rawUrl, repoPath } from '../../shared/lib/api';
import { resolveRelative } from '../../shared/lib/markdown';
import { keys, useChecks } from '../../shared/lib/queries';
import { useRepoInfo } from './context';
import { FirstPush } from './FirstPush';
import { EmbedMenu } from './EmbedMenu';

function CloneMenu({ url, sshUrl }: { url: string; sshUrl: string | null }) {
  const [mode, setMode] = useState<'https' | 'ssh'>(() => {
    try {
      return sshUrl && localStorage.getItem('jumper.clone') === 'ssh' ? 'ssh' : 'https';
    } catch {
      return 'https';
    }
  });
  const pick = (m: 'https' | 'ssh') => {
    setMode(m);
    try {
      localStorage.setItem('jumper.clone', m);
    } catch {
      /* private mode */
    }
  };
  const value = mode === 'ssh' && sshUrl ? sshUrl : url;
  return (
    <Dropdown
      align="right"
      width={360}
      trigger={({ toggle }) => (
        <Button size="sm" variant="primary" onClick={toggle} trailingIcon={<ChevronDown size={12} />}>
          Code
        </Button>
      )}
    >
      {() => (
        <div className="space-y-2 p-3">
          {sshUrl ? (
            <SegmentedControl size="sm" value={mode} onChange={pick} options={[{ value: 'https', label: 'HTTPS' }, { value: 'ssh', label: 'SSH' }]} ariaLabel="Clone protocol" />
          ) : (
            <div className="label-mono">Clone over HTTPS</div>
          )}
          <div className="flex gap-1">
            <input readOnly value={value} aria-label="Clone URL" className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-canvas-inset px-2 font-mono text-xs focus:border-select focus:outline-none" onFocus={(e) => e.target.select()} />
            <CopyButton value={value} />
          </div>
          <p className="text-xs text-fg-muted">
            {mode === 'ssh' ? (
              <>
                Uses an SSH key from your{' '}
                <Link to="/settings/$section" params={{ section: 'ssh-keys' }} className="link">
                  account settings
                </Link>
                .
              </>
            ) : (
              'Use your username and a personal access token as the password.'
            )}
          </p>
        </div>
      )}
    </Dropdown>
  );
}

function Designs({ gitRef }: { gitRef: string }) {
  const info = useRepoInfo();
  const q = useQuery({
    queryKey: [...keys.repo(info.owner, info.name), 'designs', gitRef],
    queryFn: () => api.get<string[]>(repoPath(info.owner, info.name, '/designs'), { ref: gitRef }),
  });
  const files = (q.data ?? []).filter((p) => kicadFileKind(p) !== 'project');
  if (!files.length) return null;
  return (
    <div className="border-t border-border pt-5">
      <h3 className="label-mono mb-3">Designs</h3>
      <ul className="space-y-0.5">
        {files.slice(0, 20).map((p) => (
          <li key={p}>
            <Link to="/$owner/$repo/blob/$ref/$" params={{ owner: info.owner, repo: info.name, ref: gitRef, _splat: p }} className="probe flex items-center gap-2 py-1 pl-2.5 text-sm no-underline transition-colors hover:text-accent">
              {kicadFileKind(p) === 'pcb' ? <CircuitBoard size={14} className="text-accent" /> : <Cpu size={14} className="text-accent" />}
              <span className="truncate font-mono text-xs">{p}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CodePage() {
  const info = useRepoInfo();
  const params = useParams({ strict: false }) as { ref?: string; _splat?: string };
  const navigate = useNavigate();
  const gitRef = params.ref ?? info.defaultBranch;
  const path = (params._splat ?? '').replace(/\/$/, '');
  const tree = useQuery({
    queryKey: [...keys.repo(info.owner, info.name), 'tree', gitRef, path],
    queryFn: () => api.get<TreeResponse>(repoPath(info.owner, info.name, '/tree'), { ref: gitRef, path }),
    enabled: !info.isEmpty,
  });
  const checks = useChecks(info.owner, info.name, tree.data?.sha);
  const designs = useDesigns(info.owner, info.name, info.isEmpty || path ? undefined : gitRef);

  if (info.importing) return <ImportProgress info={info} />;
  if (info.isEmpty) return (
    <>
      <ImportFailed info={info} />
      <FirstPush />
    </>
  );
  if (tree.isLoading) return <PageSpinner />;
  if (tree.error) return <ErrorView error={tree.error} />;
  const t = tree.data!;
  const isRoot = path === '';
  const readmeDir = t.readme ? t.readme.path.split('/').slice(0, -1).join('/') : '';

  return (
    <div className={isRoot ? 'grid gap-6 lg:grid-cols-[1fr_300px]' : ''}>
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <RefPicker owner={info.owner} repo={info.name} value={gitRef} onChange={(r) => void navigate({ to: '/$owner/$repo/tree/$ref/$', params: { owner: info.owner, repo: info.name, ref: r, _splat: path } })} />
          {!isRoot && <Breadcrumbs owner={info.owner} repo={info.name} gitRef={gitRef} path={path} />}
          <div className="ml-auto flex items-center gap-2">
            <Link to="/$owner/$repo/branches" params={{ owner: info.owner, repo: info.name }} className={buttonClass('invisible', 'sm')}>
              <GitBranch size={14} /> Branches
            </Link>
            {isRoot && <EmbedMenu />}
            <CloneMenu url={info.cloneUrl} sshUrl={info.sshCloneUrl} />
          </div>
        </div>

        {isRoot && <MissingFiles designs={designs.data} runs={checks.data?.runs} />}
        {isRoot && <ProjectHero owner={info.owner} repo={info.name} gitRef={gitRef} sha={t.sha} runs={checks.data?.runs ?? []} />}

        <Box>
          {t.lastCommit && (
            <BoxHeader className="text-sm">
              <span className="font-medium">{t.lastCommit.author.name}</span>
              <Link to="/$owner/$repo/commit/$sha" params={{ owner: info.owner, repo: info.name, sha: t.lastCommit.sha }} className="link-muted min-w-0 flex-1 truncate">
                {t.lastCommit.subject}
              </Link>
              <Link to="/$owner/$repo/checks" params={{ owner: info.owner, repo: info.name }} search={{ sha: t.sha }} title="Checks">
                <CheckIcon state={rollup(checks.data?.runs)} size={14} />
              </Link>
              <span className="hidden font-mono text-xs text-fg-muted sm:inline">{shortSha(t.lastCommit.sha)}</span>
              <span className="hidden font-mono text-xs text-fg-subtle sm:inline">
                <RelativeTime date={t.lastCommit.committer.date} />
              </span>
              <Link to="/$owner/$repo/commits/$ref" params={{ owner: info.owner, repo: info.name, ref: gitRef }} search={{ path }} className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 font-mono text-xs uppercase tracking-[0.04em] text-fg-muted transition-colors hover:bg-neutral-muted hover:text-fg">
                <History size={13} /> History
              </Link>
            </BoxHeader>
          )}
          <table className="relative w-full text-sm">
            <tbody>
              {!isRoot && (
                <tr className="border-b border-border-muted transition-colors hover:bg-canvas-subtle">
                  <td className="probe px-4 py-2.5 font-mono text-[13px]" colSpan={2}>
                    <Link
                      to="/$owner/$repo/tree/$ref/$"
                      params={{ owner: info.owner, repo: info.name, ref: gitRef, _splat: path.split('/').slice(0, -1).join('/') }}
                      className="text-fg-muted no-underline transition-colors hover:text-accent"
                    >
                      ..
                    </Link>
                  </td>
                </tr>
              )}
              {t.entries.map((e) => (
                <tr key={e.path} className="group/file border-b border-border-muted transition-colors last:border-0 hover:bg-canvas-subtle">
                  <td className="probe w-full px-4 py-2.5">
                    <span className="probe-shift flex items-center gap-2.5">
                      <FileIcon name={e.name} type={e.type} />
                      {e.type === 'commit' ? (
                        <span className="text-fg-muted">{e.name} (submodule)</span>
                      ) : (
                        <Link
                          to={e.type === 'tree' ? '/$owner/$repo/tree/$ref/$' : '/$owner/$repo/blob/$ref/$'}
                          params={{ owner: info.owner, repo: info.name, ref: gitRef, _splat: e.path }}
                          className="font-mono text-[13px] text-fg no-underline transition-colors after:absolute after:inset-0 after:content-[''] group-hover/file:text-accent"
                        >
                          {e.name}
                        </Link>
                      )}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-xs tabular-nums text-fg-subtle">{e.type === 'blob' ? formatBytes(e.size) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>

        {t.readme && (
          <Box>
            <BoxHeader>
              <BookOpen size={14} className="text-accent" />
              <span className="font-mono text-xs">{t.readme.path.split('/').pop()}</span>
            </BoxHeader>
            <div className="px-5 py-8 md:px-12 md:py-12">
              <Markdown
                source={t.readme.text}
                ctx={{
                  resolveLink: (href) => `/${info.owner}/${info.name}/blob/${encodeURIComponent(gitRef)}/${resolveRelative(readmeDir, href)}`,
                  resolveImage: (src) => rawUrl(info.owner, info.name, t.sha, resolveRelative(readmeDir, src)),
                }}
              />
            </div>
          </Box>
        )}
      </div>

      {isRoot && (
        <aside className="space-y-6 lg:pt-1">
          {checks.data && checks.data.runs.length > 0 && (
            <div>
              <h3 className="label-mono mb-3">Latest checks</h3>
              <ul className="space-y-1.5 text-[13px]">
                {['ERC', 'DRC', 'BOM', 'Render', 'Exports'].map((name) => {
                  const runs = checks.data!.runs.filter((r) => r.name === name);
                  if (!runs.length) return null;
                  return (
                    <li key={name} className="flex items-center gap-2">
                      <CheckIcon state={rollup(runs)} size={14} />
                      <Link to="/$owner/$repo/checks" params={{ owner: info.owner, repo: info.name }} search={{ sha: t.sha }} className="hover:text-accent">
                        {name}
                      </Link>
                      <span className="truncate text-xs text-fg-muted">{runs[0]!.summary}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <Designs gitRef={gitRef} />
        </aside>
      )}
    </div>
  );
}
