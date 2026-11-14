import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { desc, eq, users } from '@jumper/db';
import type { ReferralInfo } from '@jumper/shared';
import { requireUser } from '../auth/plugin';
import { activeReferralBonus, countedReferrals } from './service';

const referralRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get('/user/referrals', async (req): Promise<ReferralInfo> => {
    const user = requireUser(req);
    const invited = await ctx.db.select().from(users).where(eq(users.referredBy, user.id)).orderBy(desc(users.createdAt)).limit(100);
    const counted = await countedReferrals(ctx, user.id);
    const bonus = await activeReferralBonus(ctx, { kind: 'user', userId: user.id });
    const since = Date.now() - ctx.env.REFERRAL_BONUS_DAYS * 86_400_000;
    return {
      link: `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/signup?ref=${encodeURIComponent(user.username)}`,
      signupOpen: ctx.env.ALLOW_SIGNUP,
      bonusPerReferralMb: ctx.env.REFERRAL_BONUS_MB,
      maxBonusMb: ctx.env.REFERRAL_MAX_BONUS_MB,
      bonusMb: bonus.mb,
      bonusDays: ctx.env.REFERRAL_BONUS_DAYS,
      bonusExpiresAt: bonus.expiresAt?.toISOString() ?? null,
      bonusApplies: ctx.env.PLANS_ENFORCED,
      counted,
      invited: invited.map((u) => ({
        username: u.username,
        joinedAt: u.createdAt.toISOString(),
        counts: !u.disabled && (!ctx.env.emailVerificationRequired || u.emailVerifiedAt !== null),
        active: !u.disabled && (!ctx.env.emailVerificationRequired || u.emailVerifiedAt !== null) && u.createdAt.getTime() > since,
      })),
    };
  });
};

export default referralRoutes;
