import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { downloadUrl, isOutput, OUTPUT_KINDS, outputTitle, sortOutputs } from './outputs';
import { useOutputs } from '../repo/Outputs';
import { formatBytes } from '../../shared/components/common';

/** The commit's key outputs as a plain list; each opens in the Outputs viewer. */
export function OutputsPanel({ owner, repo, sha }: { owner: string; repo: string; sha: string }) {
  const q = useOutputs(owner, repo, sha);
  const all = sortOutputs((q.data?.artifacts ?? []).filter(isOutput));
  if (!all.length) return null;
  const hero = all.find((a) => a.kind === 'render3d' && a.meta.view === 'iso-top') ?? all.find((a) => a.kind === 'render3d');
  const picks = all.filter((a) => a.kind === 'fab_package' || a.kind === 'pdf' || a.kind === 'step' || a.kind === 'gerbers' || (a.kind === 'bom' && a.name.endsWith('.csv'))).slice(0, 7);

  return (
    <section aria-labelledby="outputs-h">
      <header className="mb-3 flex items-baseline gap-3">
        <h2 id="outputs-h" className="text-[15px] font-medium tracking-[-0.01em]">
          Outputs
        </h2>
        <span className="font-mono text-xs text-fg-subtle">{all.length} files</span>
        <Link to="/$owner/$repo/outputs" params={{ owner, repo }} search={{ sha }} className="link ml-auto text-xs">
          All outputs
        </Link>
      </header>
      <div className="grid gap-6 border-t border-border pt-0 md:grid-cols-[minmax(0,1fr)_14rem]">
        <ul>
          {picks.map((a) => {
            const k = OUTPUT_KINDS[a.kind]!;
            return (
              <li key={a.id} className="group flex items-center gap-3 border-b border-border-muted py-2 text-[13px]">
                <Link to="/$owner/$repo/outputs" params={{ owner, repo }} search={{ sha, id: a.id }} className="flex min-w-0 flex-1 items-baseline gap-3 no-underline">
                  <span className="shrink-0 font-medium text-fg group-hover:text-accent">{outputTitle(a)}</span>
                  <span className="hidden min-w-0 truncate text-xs text-fg-muted sm:block">{k.hint}</span>
                </Link>
                <span className="shrink-0 font-mono text-xs tabular-nums text-fg-subtle">{formatBytes(a.size)}</span>
                <a href={downloadUrl(a)} className="shrink-0 p-1 text-fg-subtle hover:text-fg" aria-label={`Download ${a.name}`} title="Download">
                  <Download size={14} />
                </a>
              </li>
            );
          })}
        </ul>
        {hero && (
          <Link to="/$owner/$repo/outputs" params={{ owner, repo }} search={{ sha, id: hero.id }} className="group mt-3 block self-start">
            <img src={hero.url} alt="KiCad 3D render of the board" className="aspect-[4/3] w-full border border-border-muted bg-[#c9cbd6] object-cover" />
            <span className="mt-1.5 block font-mono text-xs text-fg-subtle group-hover:text-fg">3D render · all angles</span>
          </Link>
        )}
      </div>
    </section>
  );
}
