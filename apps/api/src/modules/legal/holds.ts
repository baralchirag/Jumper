// Legal hold: while a hold is in force on a repository (or on its owner), nothing in it may be destroyed. Deleting the
// repository, its owner, releases or branches is refused, history cannot be rewritten, and retention clean-up skips it.
import { and, eq, isNull, legalHolds, or, repositories, type LegalHold } from '@jumper/db';
import type { Ctx } from '../../context';
import { HttpError } from '../../lib/errors';
import { perRequest } from '../../lib/request-context';

/** The hold covering a repository: one on the repository itself, or on its owner. */
export async function holdOnRepo(ctx: Ctx, repo: { id: string; namespaceId: string }): Promise<LegalHold | null> {
  return perRequest(`hold:${repo.id}`, async () => {
    const rows = await ctx.db
      .select()
      .from(legalHolds)
      .where(and(isNull(legalHolds.releasedAt), or(eq(legalHolds.repoId, repo.id), eq(legalHolds.namespaceId, repo.namespaceId))))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** A hold on an owner, or on any of their repositories. */
export async function holdOnNamespace(ctx: Ctx, namespaceId: string): Promise<LegalHold | null> {
  const rows = await ctx.db
    .select({ h: legalHolds })
    .from(legalHolds)
    .leftJoin(repositories, eq(repositories.id, legalHolds.repoId))
    .where(and(isNull(legalHolds.releasedAt), or(eq(legalHolds.namespaceId, namespaceId), eq(repositories.namespaceId, namespaceId))))
    .limit(1);
  return rows[0]?.h ?? null;
}

const held = (what: string) => new HttpError(423, 'legal_hold', `${what} is under legal hold and cannot be deleted or rewritten. An administrator has to release the hold first.`);

export async function assertRepoNotHeld(ctx: Ctx, repo: { id: string; namespaceId: string; name: string }): Promise<void> {
  if (await holdOnRepo(ctx, repo)) throw held(`The repository ${repo.name}`);
}

export async function assertNamespaceNotHeld(ctx: Ctx, namespaceId: string, slug: string): Promise<void> {
  if (await holdOnNamespace(ctx, namespaceId)) throw held(`${slug}, or one of its repositories,`);
}

/** Repository ids that retention clean-up must not touch. */
export async function heldRepoIds(ctx: Ctx): Promise<Set<string>> {
  const holds = await ctx.db.select().from(legalHolds).where(isNull(legalHolds.releasedAt));
  const ids = new Set<string>();
  const owners = holds.map((h) => h.namespaceId).filter((x): x is string => Boolean(x));
  for (const h of holds) if (h.repoId) ids.add(h.repoId);
  for (const ns of owners) for (const r of await ctx.db.select({ id: repositories.id }).from(repositories).where(eq(repositories.namespaceId, ns))) ids.add(r.id);
  return ids;
}
