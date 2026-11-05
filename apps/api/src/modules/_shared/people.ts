import { inArray, users, type User } from '@jumper/db';
import type { UserSummary } from '@jumper/shared';
import type { Ctx } from '../../context';
import { toUserSummary } from '../repos/serialize';

export async function usersById(ctx: Ctx, ids: (string | null | undefined)[]): Promise<Map<string, User>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map();
  const rows = await ctx.db.select().from(users).where(inArray(users.id, unique));
  return new Map(rows.map((u) => [u.id, u]));
}

export function summary(map: Map<string, User>, id: string): UserSummary {
  const u = map.get(id);
  return u ? toUserSummary(u) : { id, username: 'ghost', name: null, avatarUrl: null };
}
