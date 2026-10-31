import type { Namespace, Repository, User } from '@pcbhub/db';
import type { RepoInfo, UserSummary } from '@pcbhub/shared';
import type { Ctx } from '../context';
import type { Permission } from './access';

export function toUserSummary(u: Pick<User, 'id' | 'username' | 'name' | 'avatarUrl'>): UserSummary {
  return { id: u.id, username: u.username, name: u.name, avatarUrl: u.avatarUrl };
}

export function cloneUrl(ctx: Ctx, ns: Namespace, repo: Repository): string {
  return `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/${ns.slug}/${repo.name}.git`;
}

export function toRepoInfo(
  ctx: Ctx,
  repo: Repository,
  ns: Namespace,
  permission: Permission,
  extra: { isEmpty?: boolean; openPullCount?: number } = {},
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
    openPullCount: extra.openPullCount ?? 0,
    cloneUrl: cloneUrl(ctx, ns, repo),
  };
}
