import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import {
  and,
  eq,
  namespaces,
  orgMembers,
  repoCollaborators,
  repositories,
  sql,
  type Namespace,
  type Repository,
  type User,
} from '@pcbhub/db';
import { ROLE_RANK, type RepoRole } from '@pcbhub/shared';
import type { Ctx } from '../context';
import { requireScope } from '../auth/plugin';
import { forbidden, notFound } from '../lib/errors';
import { GitRepo } from '../git/repo';

export type Permission = RepoRole | 'none';

export interface RepoCtx {
  repo: Repository;
  ns: Namespace;
  permission: Permission;
  git: GitRepo;
}

export function repoDiskPath(ctx: Ctx, repoId: string): string {
  return join(ctx.env.reposDir, `${repoId}.git`);
}

export function gitFor(ctx: Ctx, repoId: string): GitRepo {
  return new GitRepo(repoDiskPath(ctx, repoId));
}

export async function findNamespace(ctx: Ctx, slug: string): Promise<Namespace | null> {
  const rows = await ctx.db.select().from(namespaces).where(sql`lower(${namespaces.slug}) = lower(${slug})`).limit(1);
  return rows[0] ?? null;
}

export async function findRepo(ctx: Ctx, owner: string, name: string): Promise<{ repo: Repository; ns: Namespace } | null> {
  const clean = name.replace(/\.git$/, '');
  const rows = await ctx.db
    .select({ repo: repositories, ns: namespaces })
    .from(repositories)
    .innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId))
    .where(and(sql`lower(${namespaces.slug}) = lower(${owner})`, sql`lower(${repositories.name}) = lower(${clean})`))
    .limit(1);
  return rows[0] ?? null;
}

export async function orgRoleFor(ctx: Ctx, orgId: string, userId: string): Promise<'owner' | 'member' | null> {
  const rows = await ctx.db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

/** Effective permission of `user` on a repository. */
export async function permissionFor(ctx: Ctx, user: User | null, repo: Repository, ns: Namespace): Promise<Permission> {
  let best: Permission = repo.visibility === 'public' ? 'read' : 'none';
  if (!user) return best;
  if (user.isAdmin) return 'admin';
  const raise = (p: Permission) => {
    if (ROLE_RANK[p] > ROLE_RANK[best]) best = p;
  };
  if (ns.kind === 'user' && ns.userId === user.id) return 'admin';
  if (ns.kind === 'org' && ns.orgId) {
    const role = await orgRoleFor(ctx, ns.orgId, user.id);
    if (role === 'owner') return 'admin';
    if (role === 'member') raise('write');
  }
  const collab = await ctx.db
    .select({ role: repoCollaborators.role })
    .from(repoCollaborators)
    .where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.userId, user.id)))
    .limit(1);
  if (collab[0]) raise(collab[0].role);
  return best;
}

/**
 * Load a repository for the current request and enforce `min` permission.
 * Private repositories the user cannot read are reported as missing.
 */
export async function loadRepo(req: FastifyRequest, owner: string, name: string, min: RepoRole = 'read'): Promise<RepoCtx> {
  const ctx = req.server.ctx;
  const found = await findRepo(ctx, owner, name);
  if (!found) throw notFound('Repository not found');
  const permission = await permissionFor(ctx, req.user, found.repo, found.ns);
  if (permission === 'none') throw notFound('Repository not found');
  if (ROLE_RANK[permission] < ROLE_RANK[min]) throw forbidden();
  requireScope(req, min === 'read' ? 'repo:read' : min === 'write' ? 'repo:write' : 'admin');
  return { ...found, permission, git: gitFor(ctx, found.repo.id) };
}

export async function canManageNamespace(ctx: Ctx, user: User, ns: Namespace): Promise<boolean> {
  if (user.isAdmin) return true;
  if (ns.kind === 'user') return ns.userId === user.id;
  return ns.orgId ? (await orgRoleFor(ctx, ns.orgId, user.id)) !== null : false;
}
