import { and, blobDiffs, eq } from '@jumper/db';
import type { BomChange, DiffResult } from '@jumper/kicad-core/types';
import { kicadFileKind } from '@jumper/shared';
import type { Ctx } from '../../context';
import { GitRepo } from '../git/repo';
import { unprocessable } from '../../lib/errors';

export interface SemanticDiffResponse {
  path: string;
  baseOid: string | null;
  headOid: string | null;
  diff: DiffResult;
  bom: BomChange[] | null;
}

const CACHE_VERSION = 'v1';

async function oidAt(git: GitRepo, sha: string | null, path: string): Promise<string | null> {
  if (!sha) return null;
  const e = await git.entryType(sha, path).catch(() => null);
  return e?.type === 'blob' ? e.oid : null;
}

/**
 * Semantic diff of one design file between two commits.
 * Results are cached by blob ids, so identical file pairs are computed once.
 */
export async function semanticDiff(
  ctx: Ctx,
  git: GitRepo,
  baseSha: string | null,
  headSha: string,
  path: string,
  oldPath?: string | null,
): Promise<SemanticDiffResponse> {
  const fileKind = kicadFileKind(path);
  if (fileKind !== 'pcb' && fileKind !== 'sch') throw unprocessable('Not a KiCad schematic or board file');

  const [baseOid, headOid] = await Promise.all([oidAt(git, baseSha, oldPath || path), oidAt(git, headSha, path)]);
  const cacheKind = `${fileKind}:${CACHE_VERSION}`;
  const key = { base: baseOid ?? '0', head: headOid ?? '0' };

  const cached = await ctx.db
    .select({ result: blobDiffs.result })
    .from(blobDiffs)
    .where(and(eq(blobDiffs.baseOid, key.base), eq(blobDiffs.headOid, key.head), eq(blobDiffs.kind, cacheKind)))
    .limit(1);
  if (cached[0]) {
    const r = cached[0].result as { diff: DiffResult; bom: BomChange[] | null };
    return { path, baseOid, headOid, ...r };
  }

  const max = ctx.env.MAX_VIEW_BYTES;
  const read = async (oid: string | null) => (oid ? (await git.readBlob(oid, max)).toString('utf8') : '');
  const [before, after] = await Promise.all([read(baseOid), read(headOid)]);

  let diff: DiffResult;
  try {
    diff = await ctx.kicad.diff(before, after, fileKind);
  } catch (e) {
    throw unprocessable(`Could not parse design: ${(e as Error).message}`);
  }
  const bom = fileKind === 'sch' ? await ctx.kicad.bomDiff([before], [after]).catch(() => null) : null;

  await ctx.db
    .insert(blobDiffs)
    .values({ baseOid: key.base, headOid: key.head, kind: cacheKind, result: { diff, bom } })
    .onConflictDoNothing();
  return { path, baseOid, headOid, diff, bom };
}

/** Collect a root schematic plus every sub-sheet it references (recursively). */
export async function collectSheets(ctx: Ctx, git: GitRepo, sha: string, rootPath: string, limit = 200): Promise<string[]> {
  const dir = rootPath.includes('/') ? rootPath.slice(0, rootPath.lastIndexOf('/') + 1) : '';
  const seen = new Set<string>();
  const texts: string[] = [];
  const queue = [rootPath];
  const sheetFile = /\(property\s+"Sheet ?file"\s+"([^"]+)"/g;
  while (queue.length && seen.size < limit) {
    const p = queue.shift()!;
    if (seen.has(p)) continue;
    seen.add(p);
    const buf = await git.readFile(sha, p, ctx.env.MAX_VIEW_BYTES);
    if (!buf) continue;
    const text = buf.toString('utf8');
    texts.push(text);
    for (const m of text.matchAll(sheetFile)) {
      const rel = m[1]!.replace(/\\/g, '/');
      if (rel.startsWith('/') || rel.split('/').includes('..')) continue;
      queue.push(dir + rel);
    }
  }
  return texts;
}
