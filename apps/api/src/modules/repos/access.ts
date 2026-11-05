import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import {
  and,
  eq,
  inArray,
  namespaces,
  orgMembers,
  repoCollaborators,
  repositories,
  sql,
  customRoles,
  type CustomRole,
  type Namespace,
  type Repository,
  type User,
} from '@jumper/db';
import { CAPABILITY_LABELS, ROLE_CAPS, ROLE_RANK, type AccessDenial, type Capability, type RepoRole } from '@jumper/shared';
import type { Ctx } from '../../context';
import { requireScope } from '../auth/plugin';
import { HttpError, forbidden, notFound, unauthorized } from '../../lib/errors';
import { DENIAL_MESSAGES, accessDenial } from '../policy/service';
import { GitRepo } from '../git/repo';

export type Permission = RepoRole | 'none';

export interface RepoCtx {
  repo: Repository;
  ns: Namespace;
  permission: Permission;
  /** What the caller may do here; use `can` / `requireCap` rather than comparing roles for these actions. */
  caps: Set<Capability>;
  customRole: string | null;
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

export interface Access {
  permission: Permission;
  caps: Set<Capability>;
  /** Name of the custom role that produced this access, if one did. */
  customRole: string | null;
  /** Set when the person would have access but an organization rule holds it back for this session. */
  denied: AccessDenial | null;
}

interface Grant {
  role: RepoRole;
  customRoleId: string | null;
}

const NO_ACCESS: Access = { permission: 'none', caps: new Set(), customRole: null, denied: null };
const fullAccess = (): Access => ({ permission: 'admin', caps: new Set(ROLE_CAPS.admin), customRole: null, denied: null });

/** Combine everything a person has been granted on one repository: the highest role, and every capability. */
function combine(repo: Repository, grants: Grant[], roles: Map<string, CustomRole>): Access {
  let permission: Permission = repo.visibility === 'public' && !repo.exportControlled ? 'read' : 'none';
  const caps = new Set<Capability>();
  let customRole: string | null = null;
  for (const g of grants) {
    const custom = g.customRoleId ? roles.get(g.customRoleId) : undefined;
    const role: RepoRole = custom ? custom.base : g.role;
    if (ROLE_RANK[role] > ROLE_RANK[permission]) permission = role;
    if (custom) {
      customRole = custom.name;
      for (const c of custom.capabilities) caps.add(c as Capability);
      if (custom.base === 'write') caps.add('push');
    } else for (const c of ROLE_CAPS[role]) caps.add(c);
  }
  return { permission, caps, customRole, denied: null };
}

async function loadRoles(ctx: Ctx, ids: (string | null | undefined)[]): Promise<Map<string, CustomRole>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map();
  return new Map((await ctx.db.select().from(customRoles).where(inArray(customRoles.id, unique))).map((r) => [r.id, r]));
}

/** An organization rule (two-factor, address, session age, single sign-on) holds back everything but public reading. */
function heldBack(repo: Repository, denied: AccessDenial): Access {
  return { permission: repo.visibility === 'public' && !repo.exportControlled ? 'read' : 'none', caps: new Set(), customRole: null, denied };
}

/** Everything `user` may do on a repository. */
export async function accessFor(ctx: Ctx, user: User | null, repo: Repository, ns: Namespace): Promise<Access> {
  // Export control comes first and has no exceptions: administrators and owners need clearance like everyone else.
  if (repo.exportControlled && !user?.exportCleared) return NO_ACCESS;
  if (!user) return combine(repo, [], new Map());
  if (user.isAdmin) return fullAccess();
  if (ns.kind === 'user' && ns.userId === user.id) return fullAccess();
  const grants: Grant[] = [];
  let owner = false;
  if (ns.kind === 'org' && ns.orgId) {
    const m = (
      await ctx.db
        .select({ role: orgMembers.role, repoRole: orgMembers.repoRole, customRoleId: orgMembers.customRoleId })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, ns.orgId), eq(orgMembers.userId, user.id)))
        .limit(1)
    )[0];
    if (m?.role === 'owner') owner = true;
    else if (m) grants.push({ role: m.repoRole, customRoleId: m.customRoleId });
  }
  if (!owner) {
    const collab = await ctx.db
      .select({ role: repoCollaborators.role, customRoleId: repoCollaborators.customRoleId })
      .from(repoCollaborators)
      .where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.userId, user.id)))
      .limit(1);
    if (collab[0]) grants.push(collab[0]);
  }
  if (owner || grants.length) {
    const denied = await accessDenial(ctx, user, ns);
    if (denied) return heldBack(repo, denied);
  }
  if (owner) return fullAccess();
  return combine(repo, grants, await loadRoles(ctx, grants.map((g) => g.customRoleId)));
}

/** Effective role of `user` on a repository. */
export async function permissionFor(ctx: Ctx, user: User | null, repo: Repository, ns: Namespace): Promise<Permission> {
  return (await accessFor(ctx, user, repo, ns)).permission;
}

/**
 * Access to many repositories at once with a fixed number of queries. Same rules as `accessFor`; used by list pages
 * (explore, profiles, dashboards, search).
 */
export async function accessesFor(ctx: Ctx, user: User | null, rows: { repo: Repository; ns: Namespace }[]): Promise<Access[]> {
  if (!user) return rows.map(({ repo }) => (repo.exportControlled ? NO_ACCESS : combine(repo, [], new Map())));
  const orgIds = [...new Set(rows.map((r) => r.ns.orgId).filter((x): x is string => !!x))];
  const repoIds = rows.map((r) => r.repo.id);
  const [memberships, collabs] = user.isAdmin
    ? [[], []]
    : await Promise.all([
        orgIds.length
          ? ctx.db.select({ orgId: orgMembers.orgId, role: orgMembers.role, repoRole: orgMembers.repoRole, customRoleId: orgMembers.customRoleId }).from(orgMembers).where(and(eq(orgMembers.userId, user.id), inArray(orgMembers.orgId, orgIds)))
          : [],
        repoIds.length
          ? ctx.db.select({ repoId: repoCollaborators.repoId, role: repoCollaborators.role, customRoleId: repoCollaborators.customRoleId }).from(repoCollaborators).where(and(eq(repoCollaborators.userId, user.id), inArray(repoCollaborators.repoId, repoIds)))
          : [],
      ]);
  const member = new Map(memberships.map((m) => [m.orgId, m]));
  const collab = new Map(collabs.map((c) => [c.repoId, c]));
  const roles = await loadRoles(ctx, [...memberships.map((m) => m.customRoleId), ...collabs.map((c) => c.customRoleId)]);
  const denials = new Map<string, AccessDenial | null>();
  const out: Access[] = [];
  for (const { repo, ns } of rows) {
    if (repo.exportControlled && !user.exportCleared) {
      out.push(NO_ACCESS);
      continue;
    }
    if (user.isAdmin || (ns.kind === 'user' && ns.userId === user.id)) {
      out.push(fullAccess());
      continue;
    }
    const m = ns.orgId ? member.get(ns.orgId) : undefined;
    const c = collab.get(repo.id);
    const owner = m?.role === 'owner';
    const grants: Grant[] = [];
    if (m && !owner) grants.push({ role: m.repoRole, customRoleId: m.customRoleId });
    if (c && !owner) grants.push(c);
    if (owner || grants.length) {
      if (!denials.has(ns.id)) denials.set(ns.id, await accessDenial(ctx, user, ns));
      const denied = denials.get(ns.id);
      if (denied) {
        out.push(heldBack(repo, denied));
        continue;
      }
    }
    out.push(owner ? fullAccess() : combine(repo, grants, roles));
  }
  return out;
}

export async function permissionsFor(ctx: Ctx, user: User | null, rows: { repo: Repository; ns: Namespace }[]): Promise<Permission[]> {
  return (await accessesFor(ctx, user, rows)).map((a) => a.permission);
}

/**
 * Load a repository for the current request and enforce `min` permission.
 * Private repositories the user cannot read are reported as missing.
 */
export async function loadRepo(req: FastifyRequest, owner: string, name: string, min: RepoRole = 'read'): Promise<RepoCtx> {
  const ctx = req.server.ctx;
  const found = await findRepo(ctx, owner, name);
  if (!found) throw notFound('Repository not found');
  const access = await accessFor(ctx, req.user, found.repo, found.ns);
  const { permission } = access;
  // Someone who belongs here but is held back by an organization rule is told which one, not "not found".
  if (access.denied && ROLE_RANK[permission] < ROLE_RANK[min === 'read' && permission === 'none' ? 'read' : min]) {
    throw new HttpError(403, 'access_policy', DENIAL_MESSAGES[access.denied](found.ns.slug), { reason: access.denied, org: found.ns.slug });
  }
  if (permission === 'none') throw notFound('Repository not found');
  if (ROLE_RANK[permission] < ROLE_RANK[min]) throw req.user ? forbidden() : unauthorized();
  // A token needs write scope for anything that changes state, even actions open to every reader
  // (opening an issue, commenting): a read-only token must never mutate.
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  requireScope(req, min === 'admin' ? 'admin' : min === 'write' || mutating ? 'repo:write' : 'repo:read');
  return { ...found, permission, caps: access.caps, customRole: access.customRole, git: gitFor(ctx, found.repo.id) };
}

/** Whether the caller holds a capability on the loaded repository; throws 403 when `need` is set and they do not. */
export function can(r: Pick<RepoCtx, 'caps'>, cap: Capability): boolean {
  return r.caps.has(cap);
}

export function requireCap(r: Pick<RepoCtx, 'caps'>, cap: Capability, message?: string): void {
  if (!r.caps.has(cap)) throw forbidden(message ?? `Your role does not allow that (${CAPABILITY_LABELS[cap].toLowerCase()})`);
}

/** Whether `user` may create repositories under an owner: themselves, or an organization they can push in. */
export async function canManageNamespace(ctx: Ctx, user: User, ns: Namespace): Promise<boolean> {
  if (user.isAdmin) return true;
  if (ns.kind === 'user') return ns.userId === user.id;
  if (!ns.orgId) return false;
  const m = (
    await ctx.db
      .select({ role: orgMembers.role, repoRole: orgMembers.repoRole, customRoleId: orgMembers.customRoleId })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, ns.orgId), eq(orgMembers.userId, user.id)))
      .limit(1)
  )[0];
  if (!m || (await accessDenial(ctx, user, ns))) return false;
  if (m.role === 'owner') return true;
  const custom = m.customRoleId ? (await loadRoles(ctx, [m.customRoleId])).get(m.customRoleId) : undefined;
  return ROLE_RANK[custom ? custom.base : m.repoRole] >= ROLE_RANK.write;
}
