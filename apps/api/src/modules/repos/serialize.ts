import type { Namespace, Repository, User } from '@jumper/db';
import { ROLE_CAPS, type Capability, type RepoInfo, type UserSummary } from '@jumper/shared';
import type { Ctx } from '../../context';
import type { Permission } from './access';
import { importState } from '../import/jobs';

export function toUserSummary(u: Pick<User, 'id' | 'username' | 'name' | 'avatarUrl'>): UserSummary {
  return { id: u.id, username: u.username, name: u.name, avatarUrl: u.avatarUrl };
}

export function cloneUrl(ctx: Ctx, ns: Namespace, repo: Repository): string {
  return `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/${ns.slug}/${repo.name}.git`;
}

/** `git@host:owner/repo.git` (port 22) or `ssh://git@host:port/owner/repo.git`; null when SSH is off. */
export function sshCloneUrl(ctx: Ctx, ns: Namespace, repo: Repository): string | null {
  if (!ctx.env.SSH_ENABLED) return null;
  const host = ctx.env.SSH_PUBLIC_HOST ?? new URL(ctx.env.PUBLIC_URL).hostname;
  const port = ctx.env.SSH_PUBLIC_PORT ?? ctx.env.SSH_PORT;
  return port === 22 ? `git@${host}:${ns.slug}/${repo.name}.git` : `ssh://git@${host}:${port}/${ns.slug}/${repo.name}.git`;
}

export function toRepoInfo(
  ctx: Ctx,
  repo: Repository,
  ns: Namespace,
  permission: Permission,
  extra: { isEmpty?: boolean; access?: { caps: Set<Capability>; customRole: string | null }; legalHold?: boolean } = {},
): RepoInfo {
  return {
    id: repo.id,
    owner: ns.slug,
    ownerKind: ns.kind,
    name: repo.name,
    fullName: `${ns.slug}/${repo.name}`,
    description: repo.description,
    visibility: repo.visibility,
    defaultBranch: repo.defaultBranch,
    requiredApprovals: repo.requiredApprovals,
    isEmpty: extra.isEmpty ?? repo.pushedAt === null,
    createdAt: repo.createdAt.toISOString(),
    updatedAt: repo.updatedAt.toISOString(),
    pushedAt: repo.pushedAt?.toISOString() ?? null,
    permission,
    capabilities: extra.access ? [...extra.access.caps] : [...ROLE_CAPS[permission]],
    customRole: extra.access?.customRole ?? null,
    exportControlled: repo.exportControlled,
    legalHold: extra.legalHold ?? false,
    cloneUrl: cloneUrl(ctx, ns, repo),
    sshCloneUrl: sshCloneUrl(ctx, ns, repo),
    ...importState(repo.id),
  };
}
