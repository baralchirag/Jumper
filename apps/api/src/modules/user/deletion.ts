import {
  and,
  comments,
  count,
  eq,
  issueComments,
  issues,
  namespaces,
  orgMembers,
  organizations,
  pullEvents,
  pullRequests,
  repositories,
  reviews,
  sql,
  users,
  type User,
} from '@jumper/db';
import type { Ctx } from '../../context';
import { purgeRepoData } from '../repos/purge';

export const GHOST_USERNAME = 'ghost';

/** What deleting an account would remove, and what prevents it. Shown to the user before they confirm. */
export interface DeletionPreview {
  ownedRepos: { name: string; visibility: 'public' | 'private' }[];
  /** Organizations where this user is the only owner: they must be transferred or deleted first. */
  soleOwnerOrgs: { slug: string; name: string; members: number }[];
  isLastAdmin: boolean;
  blocked: boolean;
}

export async function deletionPreview(ctx: Ctx, user: User): Promise<DeletionPreview> {
  const ownedRepos = await ctx.db
    .select({ name: repositories.name, visibility: repositories.visibility })
    .from(repositories)
    .innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId))
    .where(eq(namespaces.userId, user.id))
    .orderBy(repositories.name);

  const mine = await ctx.db
    .select({ orgId: orgMembers.orgId, slug: namespaces.slug, name: organizations.name })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .innerJoin(namespaces, eq(namespaces.orgId, organizations.id))
    .where(and(eq(orgMembers.userId, user.id), eq(orgMembers.role, 'owner')));
  const soleOwnerOrgs: DeletionPreview['soleOwnerOrgs'] = [];
  for (const o of mine) {
    const [{ n: owners }] = (await ctx.db.select({ n: count() }).from(orgMembers).where(and(eq(orgMembers.orgId, o.orgId), eq(orgMembers.role, 'owner')))) as [{ n: number }];
    if (owners > 1) continue;
    const [{ n: members }] = (await ctx.db.select({ n: count() }).from(orgMembers).where(eq(orgMembers.orgId, o.orgId))) as [{ n: number }];
    soleOwnerOrgs.push({ slug: o.slug, name: o.name, members });
  }

  let isLastAdmin = false;
  if (user.isAdmin) {
    const [{ n }] = (await ctx.db.select({ n: count() }).from(users).where(and(eq(users.isAdmin, true), eq(users.disabled, false)))) as [{ n: number }];
    isLastAdmin = n <= 1;
  }
  return { ownedRepos, soleOwnerOrgs, isLastAdmin, blocked: soleOwnerOrgs.length > 0 || isLastAdmin };
}

/**
 * The placeholder author for content whose writer deleted their account (issues, comments, reviews stay readable).
 * It owns a namespace so nobody can register the name later.
 */
export async function ghostUser(ctx: Ctx): Promise<User> {
  const existing = (await ctx.db.select().from(users).where(sql`lower(${users.username}) = ${GHOST_USERNAME}`).limit(1))[0];
  if (existing) return existing;
  return ctx.db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ username: GHOST_USERNAME, email: 'ghost@users.noreply.invalid', passwordHash: null, name: 'Deleted user', disabled: true })
      .returning();
    await tx.insert(namespaces).values({ slug: GHOST_USERNAME, kind: 'user', userId: u!.id });
    return u!;
  });
}

/**
 * Permanently delete an account: sessions, tokens and memberships go with it, owned repositories are removed from the
 * database, disk and artifact storage, and anything the user wrote elsewhere is kept under the "ghost" account.
 * Callers must check `deletionPreview(...).blocked` first.
 */
export async function deleteUserAccount(ctx: Ctx, user: User): Promise<{ repos: number }> {
  const ghost = await ghostUser(ctx);
  if (ghost.id === user.id) throw new Error('The ghost account cannot be deleted');

  const ownedIds = (
    await ctx.db.select({ id: repositories.id }).from(repositories).innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId)).where(eq(namespaces.userId, user.id))
  ).map((r) => r.id);

  await ctx.db.transaction(async (tx) => {
    await tx.update(issues).set({ authorId: ghost.id }).where(eq(issues.authorId, user.id));
    await tx.update(issueComments).set({ authorId: ghost.id }).where(eq(issueComments.authorId, user.id));
    await tx.update(pullRequests).set({ authorId: ghost.id }).where(eq(pullRequests.authorId, user.id));
    await tx.update(pullRequests).set({ mergedById: ghost.id }).where(eq(pullRequests.mergedById, user.id));
    await tx.update(reviews).set({ authorId: ghost.id }).where(eq(reviews.authorId, user.id));
    await tx.update(comments).set({ authorId: ghost.id }).where(eq(comments.authorId, user.id));
    await tx.update(pullEvents).set({ actorId: ghost.id }).where(eq(pullEvents.actorId, user.id));
    // Cascades remove the namespace's repositories and everything hanging off them.
    await tx.delete(namespaces).where(eq(namespaces.userId, user.id));
    await tx.delete(users).where(eq(users.id, user.id));
  });

  // Disk and object storage after the transaction: a failure leaves orphan files, never a half-deleted account.
  await purgeRepoData(ctx, ownedIds);
  return { repos: ownedIds.length };
}
