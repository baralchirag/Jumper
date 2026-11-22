import { and, customRoles, eq, type Namespace } from '@jumper/db';
import { REPO_ROLES, type RepoRole } from '@jumper/shared';
import type { Ctx } from '../../context';
import { badRequest } from '../../lib/errors';

/**
 * Turn `read` / `review` / `write` / `admin` or `custom:<id>` into the columns stored on a membership. A custom role
 * must belong to the same owner; its base role is stored too, so the grant still means something if the role is deleted.
 */
export async function resolveRoleRef(ctx: Ctx, ns: Namespace, ref: string): Promise<{ role: RepoRole; customRoleId: string | null }> {
  if ((REPO_ROLES as readonly string[]).includes(ref)) return { role: ref as RepoRole, customRoleId: null };
  const id = ref.replace(/^custom:/, '');
  const role = (await ctx.db.select().from(customRoles).where(and(eq(customRoles.id, id), eq(customRoles.namespaceId, ns.id))).limit(1))[0];
  if (!role) throw badRequest('That custom role does not exist for this owner');
  return { role: role.base, customRoleId: role.id };
}
