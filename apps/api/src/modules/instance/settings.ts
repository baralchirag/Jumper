// Settings an administrator changes while the instance runs, stored in `instance_settings`.
import type { z } from 'zod';
import { eq, instanceSettings } from '@jumper/db';
import { DEFAULT_RETENTION, retentionSchema, type RetentionSettings } from '@jumper/shared';
import type { Ctx } from '../../context';
import { hasFeature } from '../license/license';

export async function getSetting<T>(ctx: Ctx, key: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  const row = (await ctx.db.select().from(instanceSettings).where(eq(instanceSettings.key, key)).limit(1))[0];
  if (!row) return fallback;
  const parsed = schema.safeParse(row.value);
  return parsed.success ? parsed.data : fallback;
}

export async function setSetting(ctx: Ctx, key: string, value: unknown): Promise<void> {
  await ctx.db.insert(instanceSettings).values({ key, value }).onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: new Date() } });
}

/**
 * How long records are kept. Without the retention feature the audit log follows AUDIT_RETENTION_DAYS and the other
 * defaults apply; with it, whatever the administrator saved.
 */
export async function retentionSettings(ctx: Ctx): Promise<RetentionSettings> {
  const base: RetentionSettings = { ...DEFAULT_RETENTION, auditDays: ctx.env.AUDIT_RETENTION_DAYS };
  if (!(await hasFeature(ctx, null, 'retention'))) return base;
  return getSetting(ctx, 'retention', retentionSchema, base);
}
