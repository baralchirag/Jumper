import { Link } from '@tanstack/react-router';
import { ArrowRight, FolderDown } from 'lucide-react';
import { isOutput } from './outputs';
import { useOutputs } from '../repo/Outputs';

/**
 * One line pointing to Outputs. The files themselves are listed in one place only (the Outputs page), so the checks
 * page doesn't grow a second, partial copy of that list.
 */
export function OutputsPanel({ owner, repo, sha }: { owner: string; repo: string; sha: string }) {
  const q = useOutputs(owner, repo, sha);
  const all = (q.data?.artifacts ?? []).filter(isOutput);
  const hero = all.find((a) => a.kind === 'render3d' && a.meta.view === 'iso-top') ?? all.find((a) => a.kind === 'render3d');
  if (!all.length) return null;
  return (
    <Link
      to="/$owner/$repo/outputs"
      params={{ owner, repo }}
      search={{ sha }}
      className="group flex items-center gap-4 border-y border-border py-3 text-[13px] no-underline transition-colors hover:bg-canvas-subtle"
    >
      {hero ? <img src={hero.url} alt="" className="h-10 w-14 shrink-0 border border-border-muted bg-[#c9cbd6] object-cover" /> : <FolderDown size={18} className="shrink-0 text-fg-subtle" />}
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-fg">Outputs for this commit</span>
        <span className="block text-xs text-fg-muted">{all.length} files: 3D view, fab package, Gerbers, PDFs and the parts list</span>
      </span>
      <span className="inline-flex items-center gap-1 text-fg-muted group-hover:text-accent">
        Open <ArrowRight size={13} />
      </span>
    </Link>
  );
}
