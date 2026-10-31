import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, ChevronDown, CircuitBoard, Cpu, GitBranch, History } from 'lucide-react';
import type { TreeResponse } from '@pcbhub/shared';
import { kicadFileKind } from '@pcbhub/shared';
import { Box, BoxHeader, Button, CopyButton, Dropdown, PageSpinner, RelativeTime, buttonClass } from '@pcbhub/ui';
import { CheckIcon, rollup } from '../../components/CheckStatus';
import { Markdown } from '../../components/Markdown';
import { RefPicker } from '../../components/RefPicker';
import { Breadcrumbs, ErrorView, FileIcon, formatBytes, shortSha } from '../../components/common';
import { api, rawUrl, repoPath } from '../../lib/api';
import { resolveRelative } from '../../lib/markdown';
import { keys, useChecks } from '../../lib/queries';
import { useRepoInfo } from './context';

function CloneMenu({ url }: { url: string }) {
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
          <div className="text-sm font-semibold">Clone over HTTPS</div>
          <div className="flex gap-1">
            <input readOnly value={url} className="h-7 min-w-0 flex-1 rounded-md border border-border bg-canvas-subtle px-2 font-mono text-xs" onFocus={(e) => e.target.select()} />
            <CopyButton value={url} />
          </div>
          <p className="text-xs text-fg-muted">Use your username and a personal access token as the password.</p>
        </div>
      )}
    </Dropdown>
  );
}

function EmptyRepo() {
  const info = useRepoInfo();
  const cmds = `git init\ngit add .\ngit commit -m "Initial KiCad project"\ngit branch -M ${info.defaultBranch}\ngit remote add origin ${info.cloneUrl}\ngit push -u origin ${info.defaultBranch}`;
  return (
    <Box className="mx-auto max-w-3xl">
      <BoxHeader>
        <span className="font-semibold">Quick setup</span>
      </BoxHeader>
      <div className="space-y-4 p-4">
        <div className="flex gap-1">
          <input readOnly value={info.cloneUrl} className="h-8 min-w-0 flex-1 rounded-md border border-border bg-canvas-subtle px-2 font-mono text-sm" />
          <CopyButton value={info.cloneUrl} size="md" />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">Push an existing KiCad project from the command line</h3>
          <pre className="overflow-auto rounded-md bg-canvas-inset p-3 font-mono text-xs">{cmds}</pre>
        </div>
        <p className="text-sm text-fg-muted">
          Authenticate with your username and a{' '}
          <Link to="/settings/tokens" className="link">
            personal access token
          </Link>
          . Every push runs ERC, DRC, BOM and render checks automatically.
        </p>
      </div>
    </Box>
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
    <div className="border-t border-border-muted pt-4">
      <h3 className="mb-2 text-sm font-semibold">Designs</h3>
      <ul className="space-y-1">
        {files.slice(0, 20).map((p) => (
          <li key={p}>
            <Link to="/$owner/$repo/blob/$ref/$" params={{ owner: info.owner, repo: info.name, ref: gitRef, _splat: p }} className="flex items-center gap-2 text-sm hover:text-accent">
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

  if (info.isEmpty) return <EmptyRepo />;
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
            <CloneMenu url={info.cloneUrl} />
          </div>
        </div>

        <Box>
          {t.lastCommit && (
            <BoxHeader className="text-sm">
              <span className="font-semibold">{t.lastCommit.author.name}</span>
              <Link to="/$owner/$repo/commit/$sha" params={{ owner: info.owner, repo: info.name, sha: t.lastCommit.sha }} className="link-muted min-w-0 flex-1 truncate">
                {t.lastCommit.subject}
              </Link>
              <Link to="/$owner/$repo/checks" params={{ owner: info.owner, repo: info.name }} search={{ sha: t.sha }} title="Checks">
                <CheckIcon state={rollup(checks.data?.runs)} size={14} />
              </Link>
              <span className="font-mono text-xs text-fg-muted">{shortSha(t.lastCommit.sha)}</span>
              <span className="text-xs text-fg-muted">
                <RelativeTime date={t.lastCommit.committer.date} />
              </span>
              <Link to="/$owner/$repo/commits/$ref" params={{ owner: info.owner, repo: info.name, ref: gitRef }} search={{ path }} className="flex items-center gap-1 text-xs font-semibold hover:text-accent">
                <History size={14} /> History
              </Link>
            </BoxHeader>
          )}
          <table className="w-full text-sm">
            <tbody>
              {!isRoot && (
                <tr className="border-b border-border-muted hover:bg-canvas-subtle">
                  <td className="px-4 py-2" colSpan={2}>
                    <Link
                      to="/$owner/$repo/tree/$ref/$"
                      params={{ owner: info.owner, repo: info.name, ref: gitRef, _splat: path.split('/').slice(0, -1).join('/') }}
                      className="font-semibold hover:text-accent"
                    >
                      ..
                    </Link>
                  </td>
                </tr>
              )}
              {t.entries.map((e) => (
                <tr key={e.path} className="border-b border-border-muted last:border-0 hover:bg-canvas-subtle">
                  <td className="w-full px-4 py-2">
                    <span className="flex items-center gap-2">
                      <FileIcon name={e.name} type={e.type} />
                      {e.type === 'commit' ? (
                        <span className="text-fg-muted">{e.name} (submodule)</span>
                      ) : (
                        <Link
                          to={e.type === 'tree' ? '/$owner/$repo/tree/$ref/$' : '/$owner/$repo/blob/$ref/$'}
                          params={{ owner: info.owner, repo: info.name, ref: gitRef, _splat: e.path }}
                          className="hover:text-accent hover:underline"
                        >
                          {e.name}
                        </Link>
                      )}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right text-xs text-fg-muted">{e.type === 'blob' ? formatBytes(e.size) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>

        {t.readme && (
          <Box>
            <BoxHeader>
              <BookOpen size={16} className="text-fg-muted" />
              <span className="text-sm font-semibold">{t.readme.path.split('/').pop()}</span>
            </BoxHeader>
            <div className="px-6 py-5 md:px-8">
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
        <aside className="space-y-4">
          <div>
            <h3 className="mb-2 font-semibold">About</h3>
            <p className="text-sm text-fg-muted">{info.description || 'No description provided.'}</p>
          </div>
          {checks.data && checks.data.runs.length > 0 && (
            <div className="border-t border-border-muted pt-4">
              <h3 className="mb-2 text-sm font-semibold">Latest checks</h3>
              <ul className="space-y-1 text-sm">
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
