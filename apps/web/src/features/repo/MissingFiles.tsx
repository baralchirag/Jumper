import { useQuery } from '@tanstack/react-query';
import { FileWarning } from 'lucide-react';
import type { CheckRunInfo } from '@jumper/shared';
import { kicadFileKind } from '@jumper/shared';
import { Flash, cx } from '@jumper/ui';
import { api, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';

/** KiCad design files (.kicad_pro, .kicad_sch, .kicad_pcb) at a revision. Shared by the overview and Outputs. */
export function useDesigns(owner: string, repo: string, gitRef: string | undefined) {
  return useQuery({
    queryKey: [...keys.repo(owner, repo), 'designs', gitRef],
    queryFn: () => api.get<string[]>(repoPath(owner, repo, '/designs'), { ref: gitRef }),
    enabled: Boolean(gitRef),
  });
}

const stem = (p: string) => p.replace(/\.kicad_(pro|pcb|sch)$/i, '');
const base = (p: string) => p.split('/').pop()!;

interface Problem {
  file: string;
  why: string;
  /** Blocks a build (red) or only limits it (amber). */
  blocking: boolean;
}

/** What is missing from each KiCad project, in the reader's terms: which file, and what cannot be built without it. */
export function findMissing(designs: string[], runs: CheckRunInfo[] = []): Problem[] {
  const byStem = new Map<string, Set<string>>();
  for (const p of designs) {
    const k = kicadFileKind(p);
    if (!k) continue;
    const s = stem(p);
    byStem.set(s, (byStem.get(s) ?? new Set()).add(k));
  }
  const out: Problem[] = [];
  for (const [s, kinds] of byStem) {
    // A schematic on its own is usually a sub-sheet of another project, not a project.
    if (!kinds.has('project') && !kinds.has('pcb')) continue;
    if (!kinds.has('pcb')) out.push({ file: `${base(s)}.kicad_pcb`, blocking: true, why: 'There is no board file, so we can’t make Gerbers, the 3D model, renders or run the board check.' });
    if (!kinds.has('sch')) out.push({ file: `${base(s)}.kicad_sch`, blocking: true, why: 'There is no schematic, so we can’t run the schematic check or build the parts list.' });
    if (!kinds.has('project')) out.push({ file: `${base(s)}.kicad_pro`, blocking: false, why: 'There is no project file, so we use KiCad’s default design rules. Board check results may differ from yours.' });
  }
  const sheets = new Set<string>();
  const models = new Set<string>();
  for (const r of runs) {
    const lib = r.details?.libraries as { missingSheets?: string[]; missingModels?: string[] } | undefined;
    lib?.missingSheets?.forEach((x) => sheets.add(x));
    lib?.missingModels?.forEach((x) => models.add(x));
  }
  for (const s of sheets) out.push({ file: base(s), blocking: true, why: 'The schematic uses this sheet but it was not uploaded. Its pages are missing from the renders and the parts list.' });
  if (models.size) {
    out.push({
      file: models.size === 1 ? base([...models][0]!) : `${models.size} 3D model files`,
      blocking: false,
      why: 'Some parts point to 3D models that were not uploaded. Those parts won’t show in the 3D view.',
    });
  }
  return out;
}

/** A short note naming each missing file and what it stops us building. Renders nothing when the project is complete. */
export function MissingFiles({ designs, runs, className }: { designs: string[] | undefined; runs?: CheckRunInfo[]; className?: string }) {
  if (!designs) return null;
  if (!designs.length) {
    return (
      <Flash tone="warning" icon={<FileWarning size={16} />} className={className}>
        <b className="font-medium">No KiCad project found.</b> We need a <code className="font-mono text-[13px]">.kicad_pcb</code> board file and a{' '}
        <code className="font-mono text-[13px]">.kicad_sch</code> schematic (plus the <code className="font-mono text-[13px]">.kicad_pro</code> project file) to show the board and build fab files.
      </Flash>
    );
  }
  const problems = findMissing(designs, runs);
  if (!problems.length) return null;
  const blocking = problems.some((p) => p.blocking);
  // Nothing is blocked: one quiet line.
  if (!blocking) {
    return (
      <p className={cx('flex items-start gap-2 text-[13px] text-fg-muted', className)}>
        <FileWarning size={14} className="mt-0.5 shrink-0 text-attention" />
        <span>
          {problems.map((p, i) => (
            <span key={p.file}>
              {i > 0 && ' '}
              <code className="font-mono text-fg">{p.file}</code> is missing. {p.why}
            </span>
          ))}
        </span>
      </p>
    );
  }
  return (
    <Flash tone={blocking ? 'danger' : 'warning'} icon={<FileWarning size={16} />} className={className}>
      <b className="font-medium">Some files are missing, so parts of this project can’t be built.</b>
      <ul className="mt-1.5 space-y-1 text-[13px]">
        {problems.map((p) => (
          <li key={p.file}>
            <code className="font-mono font-medium">{p.file}</code> <span className="text-fg-muted">{p.why}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-fg-muted">Add the missing files and push again; everything rebuilds on its own.</p>
    </Flash>
  );
}
