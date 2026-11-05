import { eq, repoConfig, type RepoConfig } from '@jumper/db';
import type { Ctx } from '../../context';

export const DEFAULT_CONFIG: RepoConfig = {
  fabProfiles: [],
  checklistTemplate: [],
  stackups: {},
  partPolicy: { approvedManufacturers: [], preferredParts: [], bannedParts: [], bannedFootprints: [] },
  requireChecklist: false,
};

export async function getRepoConfig(ctx: Ctx, repoId: string): Promise<RepoConfig> {
  const row = (await ctx.db.select().from(repoConfig).where(eq(repoConfig.repoId, repoId)).limit(1))[0];
  const c = row?.config ?? {};
  return { ...DEFAULT_CONFIG, ...c, partPolicy: { ...DEFAULT_CONFIG.partPolicy, ...c.partPolicy } };
}

export async function setRepoConfig(ctx: Ctx, repoId: string, config: RepoConfig): Promise<void> {
  await ctx.db
    .insert(repoConfig)
    .values({ repoId, config })
    .onConflictDoUpdate({ target: repoConfig.repoId, set: { config, updatedAt: new Date() } });
}
