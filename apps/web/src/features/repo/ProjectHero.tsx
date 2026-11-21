import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Box as BoxIcon, CircuitBoard, Cpu, Download, FolderDown, Package } from 'lucide-react';
import { kicadFileKind } from '@jumper/shared';
import { buttonClass, cx } from '@jumper/ui';
import { downloadUrl } from '../checks/outputs';
import { useOutputs } from './Outputs';
import { useDesigns } from './MissingFiles';
import { CheckIcon, rollup } from '../checks/CheckStatus';
import type { CheckRunInfo } from '@jumper/shared';

/** Board preview and shortcuts at the top of a repository. */
export function ProjectHero({ owner, repo, gitRef, sha, runs }: { owner: string; repo: string; gitRef: string; sha: string; runs: CheckRunInfo[] }) {
  const designs = useDesigns(owner, repo, gitRef);
  const outputs = useOutputs(owner, repo, sha);
  const files = designs.data ?? [];
  const pcb = files.find((p) => kicadFileKind(p) === 'pcb');
  const sch = files.find((p) => kicadFileKind(p) === 'sch');
  if (!pcb && !sch) return null;
  const arts = outputs.data?.artifacts ?? [];
  const render = arts.find((a) => a.kind === 'render3d' && a.meta.view === 'iso-top') ?? arts.find((a) => a.kind === 'render3d');
  const thumb = render ?? arts.find((a) => a.kind === 'thumbnail' && a.meta.side === 'top');
  const fab = arts.find((a) => a.kind === 'fab_package');
  const bom = arts.find((a) => a.kind === 'bom' && a.name.endsWith('.json'));
  const name = (pcb ?? sch)!.split('/').pop()!.replace(/\.kicad_(pcb|sch)$/, '');
  const ext = (to: 'view', path: string) => ({ to: '/$owner/$repo/blob/$ref/$' as const, params: { owner, repo, ref: gitRef, _splat: path }, search: { tab: to } });
  // 3D lives in one place: Outputs, where the quick preview, KiCad's model and the ray-traced images share one viewer.
  const in3d = (path: string) => ({ to: '/$owner/$repo/outputs' as const, params: { owner, repo }, search: { sha, id: `3d:${path.replace(/\.kicad_pcb$/i, '')}` } });

  const tile =
    'probe group/tile flex items-center gap-2.5 border-b border-border px-4 py-3 text-[13px] font-medium no-underline transition-colors hover:bg-canvas-subtle hover:text-fg sm:[&:nth-child(odd)]:border-r';
  return (
    <div className="grid overflow-hidden rounded-lg border border-border bg-canvas md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <Link
        {...(pcb ? in3d(pcb) : ext('view', sch!))}
        className={cx('group relative flex min-h-56 items-center justify-center overflow-hidden border-b border-border md:border-b-0 md:border-r', render ? 'bg-[#c9cbd6]' : 'bg-[#0b1510]')}
      >
        {!render && <div aria-hidden className="sheet-grid absolute inset-0 opacity-60" data-theme="dark" />}
        {thumb ? (
          <img
            src={thumb.url}
            alt={`${name} preview`}
            className={cx('relative max-h-72 w-full object-cover transition-transform duration-700 ease-[var(--ease-route)] group-hover:scale-[1.03]', !render && 'object-contain p-6')}
          />
        ) : (
          <CircuitBoard size={56} strokeWidth={1} className="relative text-[#3f8f63]" />
        )}
        <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-sm bg-black/70 px-2 py-1 font-mono text-[11.5px] uppercase tracking-[0.06em] text-white backdrop-blur transition-colors group-hover:bg-[var(--pcb-trace)] group-hover:text-[#120a05]">
          {pcb ? 'Open in 3D' : 'Open schematic'} <ArrowUpRight size={12} className="arrow-travel" />
        </span>
      </Link>
      <div className="flex flex-col">
        <div className="p-5 md:p-6">
          <div className="label-mono">KiCad project</div>
          <div className="mt-2 flex items-center gap-2.5">
            <h2 className="headline truncate text-[26px]">{name}</h2>
            {runs.length > 0 && (
              <Link to="/$owner/$repo/checks" params={{ owner, repo }} search={{ sha }} title="Checks">
                <CheckIcon state={rollup(runs)} size={18} />
              </Link>
            )}
          </div>
          {bom && typeof bom.meta.lines === 'number' && <div className="mt-1 font-mono text-xs text-fg-muted">{bom.meta.lines} BOM lines</div>}
        </div>
        <div className="grid border-t border-border sm:grid-cols-2">
          {sch && (
            <Link {...ext('view', sch)} className={tile}>
              <Cpu size={15} className="text-fg-subtle transition-colors group-hover/tile:text-accent" /> <span className="probe-shift">Schematic</span>
            </Link>
          )}
          {pcb && (
            <Link {...ext('view', pcb)} className={tile}>
              <CircuitBoard size={15} className="text-fg-subtle transition-colors group-hover/tile:text-accent" /> <span className="probe-shift">PCB layout</span>
            </Link>
          )}
          {pcb && (
            <Link {...in3d(pcb)} className={tile}>
              <BoxIcon size={15} className="text-fg-subtle transition-colors group-hover/tile:text-accent" /> <span className="probe-shift">3D view</span>
            </Link>
          )}
          {sch && (
            <Link to="/$owner/$repo/parts" params={{ owner, repo }} className={tile}>
              <Package size={15} className="text-fg-subtle transition-colors group-hover/tile:text-accent" /> <span className="probe-shift">BOM &amp; pricing</span>
            </Link>
          )}
        </div>
        <div className="mt-auto flex flex-wrap gap-2 p-5 md:p-6">
          <Link to="/$owner/$repo/outputs" params={{ owner, repo }} search={{ sha }} className={buttonClass('default', 'md')}>
            <FolderDown size={14} /> Outputs
          </Link>
          {fab && (
            <a href={downloadUrl(fab)} className={buttonClass('accent', 'md')}>
              <Download size={14} /> {fab.meta.format === 'jlcpcb' ? 'JLCPCB package' : 'Fab package'}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
