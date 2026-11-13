// Organization-wide policy: one document per owner, applied on top of each repository's own settings.
import { and, eq, orgPolicies, ssoConnections, type Namespace, type User } from '@jumper/db';
import { DEFAULT_ORG_POLICY, orgPolicySchema, type AccessDenial, type OrgPolicy } from '@jumper/shared';
import type { Ctx } from '../../context';
import { currentRequest, perRequest } from '../../lib/request-context';
import { hasFeature } from '../license/license';
import { ipAllowed } from './cidr';

export async function getOrgPolicy(ctx: Ctx, namespaceId: string): Promise<OrgPolicy> {
  return perRequest(`policy:${namespaceId}`, async () => {
    const row = (await ctx.db.select().from(orgPolicies).where(eq(orgPolicies.namespaceId, namespaceId)).limit(1))[0];
    if (!row) return DEFAULT_ORG_POLICY;
    const parsed = orgPolicySchema.safeParse(row.policy);
    return parsed.success ? parsed.data : DEFAULT_ORG_POLICY;
  });
}

/** The policy when the owner is entitled to organization policies, otherwise the defaults (nothing enforced). */
export async function effectivePolicy(ctx: Ctx, ns: Namespace): Promise<OrgPolicy> {
  if (!(await perRequest(`ent:org_policies:${ns.id}`, () => hasFeature(ctx, ns, 'org_policies')))) return DEFAULT_ORG_POLICY;
  return getOrgPolicy(ctx, ns.id);
}

export async function setOrgPolicy(ctx: Ctx, namespaceId: string, policy: OrgPolicy, userId: string): Promise<void> {
  await ctx.db
    .insert(orgPolicies)
    .values({ namespaceId, policy, updatedBy: userId })
    .onConflictDoUpdate({ target: orgPolicies.namespaceId, set: { policy, updatedBy: userId, updatedAt: new Date() } });
  currentRequest()?.cache.delete(`policy:${namespaceId}`);
}

async function enforcedSso(ctx: Ctx, namespaceId: string): Promise<string[]> {
  return perRequest(`sso-enforced:${namespaceId}`, async () =>
    (await ctx.db.select({ id: ssoConnections.id }).from(ssoConnections).where(and(eq(ssoConnections.namespaceId, namespaceId), eq(ssoConnections.enforced, true)))).map((r) => r.id),
  );
}

/**
 * Why `user` may not reach an organization's private work right now, or null. Rules about the session (address, age,
 * single sign-on) only apply inside a request; a scheduled job that asks "can this person see the repository" is
 * answered on the account-level rule (two-factor login) alone.
 */
export async function accessDenial(ctx: Ctx, user: User, ns: Namespace): Promise<AccessDenial | null> {
  if (ns.kind !== 'org' || user.isAdmin) return null;
  if (!(await perRequest(`ent:security_policies:${ns.id}`, () => hasFeature(ctx, ns, 'security_policies')))) return null;
  const policy = await getOrgPolicy(ctx, ns.id);
  if (policy.requireTwoFactor && !user.totpEnabledAt) return 'two_factor';
  const req = currentRequest();
  if (!req) return null;
  if (policy.ipAllowlist.length && req.ip && !ipAllowed(policy.ipAllowlist, req.ip)) return 'ip';
  if (req.method === 'session') {
    if (policy.sessionMaxHours && req.sessionCreatedAt && Date.now() - req.sessionCreatedAt.getTime() > policy.sessionMaxHours * 3600_000) return 'session_age';
    const required = await enforcedSso(ctx, ns.id);
    if (required.length && !(req.ssoConnectionId && required.includes(req.ssoConnectionId)) && (await perRequest(`ent:sso:${ns.id}`, () => hasFeature(ctx, ns, 'sso')))) return 'sso';
  }
  return null;
}

export const DENIAL_MESSAGES: Record<AccessDenial, (org: string) => string> = {
  two_factor: (org) => `${org} requires two-factor login. Turn it on in Settings, Security, then try again.`,
  ip: (org) => `${org} only allows access from approved network addresses.`,
  session_age: (org) => `${org} requires you to sign in again after a set time. Sign out and back in to continue.`,
  sso: (org) => `${org} requires single sign-on. Sign in through your organization's identity provider.`,
};
