// Releases: a named, tagged revision of a board with its fabrication files attached, so "what did we send to the fab"
// always has one answer. Generated files are copied out of the revision's check outputs into the release's own storage,
// so they stay downloadable even if outputs for old commits are cleaned up.
import { and, artifacts, checkRuns, eq, inArray, releaseAssets, releases, type Release, type ReleaseAsset } from '@jumper/db';
import type { ReleaseAssetKind } from '@jumper/shared';
import type { Ctx } from '../../context';

type Artifact = typeof artifacts.$inferSelect;

/** Which check outputs make up each generated release file. */
const SOURCES: Record<string, { match: (a: Artifact) => boolean; suffix: (a: Artifact) => string }> = {
  gerbers: { match: (a) => a.kind === 'gerbers', suffix: () => 'gerbers.zip' },
  bom: { match: (a) => a.kind === 'bom' && a.name === 'bom.csv', suffix: () => 'bom.csv' },
  step: { match: (a) => a.kind === 'step', suffix: () => 'board.step' },
  pdf: { match: (a) => a.kind === 'pdf', suffix: (a) => a.name },
  positions: { match: (a) => a.kind === 'pos', suffix: () => 'positions.csv' },
  jlcpcb: { match: (a) => a.kind === 'fab_package' && (a.meta as { format?: string }).format === 'jlcpcb', suffix: () => 'jlcpcb.zip' },
  pcbway: { match: (a) => a.kind === 'fab_package' && (a.meta as { format?: string }).format === 'pcbway', suffix: () => 'pcbway.zip' },
  oshpark: { match: (a) => a.kind === 'fab_package' && (a.meta as { format?: string }).format === 'oshpark', suffix: () => 'oshpark.zip' },
};

const HOW_TO_ENABLE: Record<string, string> = {
  gerbers: 'outputs.gerbers',
  bom: 'a schematic in the project',
  step: 'outputs.step',
  pdf: 'outputs.pdf',
  positions: 'outputs.pos',
  jlcpcb: 'outputs.fab_package: jlcpcb',
  pcbway: 'outputs.fab_package: [jlcpcb, pcbway]',
  oshpark: 'outputs.fab_package: [jlcpcb, oshpark]',
};

export function releaseStorageKey(repoId: string, releaseId: string, name: string): string {
  // Under repos/<id>/ so deleting the repository removes release files with everything else.
  return `repos/${repoId}/releases/${releaseId}/${name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function projectBase(projectPath: string, repoName: string): string {
  const file = projectPath.split('/').pop() ?? '';
  return (file.replace(/\.kicad_pro$/, '') || repoName).replace(/[^A-Za-z0-9._-]/g, '-');
}

export function assetName(base: string, tag: string, suffix: string): string {
  return `${base}-${tag.replace(/[^A-Za-z0-9._-]/g, '-')}-${suffix}`;
}

export interface MissingAsset {
  kind: ReleaseAssetKind;
  reason: string;
}

/**
 * Copy the requested generated files for the release's revision into the release. Kinds that already have an asset are
 * skipped, so this can run again (after checks finish) without duplicating anything. Returns what is still missing.
 */
export async function attachGenerated(ctx: Ctx, release: Release, repoName: string): Promise<MissingAsset[]> {
  const kinds = release.assetKinds.filter((k) => SOURCES[k]);
  if (!kinds.length) return [];
  const have = await ctx.db.select().from(releaseAssets).where(eq(releaseAssets.releaseId, release.id));
  const haveKinds = new Set(have.map((a) => a.kind));
  const wanted = kinds.filter((k) => !haveKinds.has(k));
  if (!wanted.length) return [];

  const outs = await ctx.db.select().from(artifacts).where(and(eq(artifacts.repoId, release.repoId), eq(artifacts.sha, release.sha)));
  const projects = new Set(outs.map((a) => a.projectPath));
  const missing: MissingAsset[] = [];
  for (const kind of wanted) {
    const src = SOURCES[kind]!;
    const matches = outs.filter(src.match);
    if (!matches.length) {
      missing.push({ kind: kind as ReleaseAssetKind, reason: '' });
      continue;
    }
    for (const a of matches) {
      const base = projects.size > 1 ? projectBase(a.projectPath, repoName) : repoName.replace(/[^A-Za-z0-9._-]/g, '-');
      const name = assetName(base, release.tag, src.suffix(a));
      const obj = await ctx.storage.get(a.storageKey);
      if (!obj) {
        missing.push({ kind: kind as ReleaseAssetKind, reason: 'The generated file is no longer stored. Re-run the checks for this revision, then refresh.' });
        continue;
      }
      const key = releaseStorageKey(release.repoId, release.id, name);
      await ctx.storage.put(key, obj.body, a.contentType, obj.size);
      await ctx.db
        .insert(releaseAssets)
        .values({ releaseId: release.id, name, kind, size: a.size, contentType: a.contentType, storageKey: key })
        .onConflictDoNothing();
    }
  }
  if (!missing.length) return [];
  return explainMissing(ctx, release, missing);
}

/** Say why a file is missing: checks still running, or the output is not produced for this project. */
async function explainMissing(ctx: Ctx, release: Release, missing: MissingAsset[]): Promise<MissingAsset[]> {
  const runs = await ctx.db.select({ status: checkRuns.status }).from(checkRuns).where(and(eq(checkRuns.repoId, release.repoId), eq(checkRuns.sha, release.sha)));
  const pending = runs.length === 0 || runs.some((r) => r.status !== 'completed');
  return missing.map((m) =>
    m.reason
      ? m
      : {
          kind: m.kind,
          reason: pending
            ? runs.length === 0
              ? 'Checks have not run for this revision yet. The file is attached when they finish.'
              : 'Checks are still running for this revision. The file is attached when they finish.'
            : `Not generated for this revision. It needs ${HOW_TO_ENABLE[m.kind] ?? 'the matching output'} in .jumper.yml and a KiCad project with a board.`,
        },
  );
}

/** Retry generated files for releases of this revision once its checks are done. Called from check events and on reads. */
export async function attachForRevision(ctx: Ctx, repoId: string, sha: string, repoName: string): Promise<void> {
  const rows = await ctx.db.select().from(releases).where(and(eq(releases.repoId, repoId), eq(releases.sha, sha)));
  for (const r of rows) await attachGenerated(ctx, r, repoName);
}

export async function assetsFor(ctx: Ctx, releaseIds: string[]): Promise<Map<string, ReleaseAsset[]>> {
  const out = new Map<string, ReleaseAsset[]>();
  if (!releaseIds.length) return out;
  const rows = await ctx.db.select().from(releaseAssets).where(inArray(releaseAssets.releaseId, releaseIds)).orderBy(releaseAssets.name);
  for (const a of rows) out.set(a.releaseId, [...(out.get(a.releaseId) ?? []), a]);
  return out;
}
