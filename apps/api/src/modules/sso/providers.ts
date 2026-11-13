import { eq, isNull, namespaces, ssoConnections, type SsoConnection } from '@jumper/db';
import type { SsoConnectionInfo, SsoProvider } from '@jumper/shared';
import type { Ctx } from '../../context';
import { decryptSecret } from '../../lib/secrets';
import { hasFeature } from '../license/license';
import type { OidcConfig } from './oidc';
import { samlUrls } from './saml';

export const BUILTIN = ['google', 'microsoft'] as const;
export type Builtin = (typeof BUILTIN)[number];
export const isBuiltin = (id: string): id is Builtin => (BUILTIN as readonly string[]).includes(id);

/** Sign in with Google / Microsoft for the whole instance, from the environment. Off on an air-gapped install. */
export function builtinConfig(ctx: Ctx, id: Builtin): OidcConfig | null {
  const e = ctx.env;
  if (e.AIR_GAPPED) return null;
  if (id === 'google') return e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET ? { issuer: 'https://accounts.google.com', clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET } : null;
  if (!e.MICROSOFT_CLIENT_ID || !e.MICROSOFT_CLIENT_SECRET) return null;
  const tenant = e.MICROSOFT_TENANT;
  const shared = ['common', 'organizations', 'consumers'].includes(tenant);
  return {
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    clientId: e.MICROSOFT_CLIENT_ID,
    clientSecret: e.MICROSOFT_CLIENT_SECRET,
    issuerPattern: shared ? /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/ : undefined,
  };
}

export function oidcConfig(ctx: Ctx, conn: SsoConnection): OidcConfig | null {
  const c = conn.config;
  const secret = c.clientSecret ? decryptSecret(ctx.env, c.clientSecret) : null;
  if (!c.issuer || !c.clientId || !secret) return null;
  return { issuer: c.issuer, clientId: c.clientId, clientSecret: secret };
}

export const callbackUrl = (ctx: Ctx, id: string) => `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/api/auth/sso/${id}/callback`;

/** Buttons for the sign-in page: Google / Microsoft when configured, and instance-wide connections. */
export async function publicProviders(ctx: Ctx): Promise<SsoProvider[]> {
  if (!(await hasFeature(ctx, null, 'sso'))) return [];
  const out: SsoProvider[] = [];
  if (builtinConfig(ctx, 'google')) out.push({ id: 'google', name: 'Google', kind: 'google', url: '/api/auth/sso/google/start' });
  if (builtinConfig(ctx, 'microsoft')) out.push({ id: 'microsoft', name: 'Microsoft', kind: 'microsoft', url: '/api/auth/sso/microsoft/start' });
  const rows = await ctx.db.select().from(ssoConnections).where(isNull(ssoConnections.namespaceId));
  for (const c of rows) out.push({ id: c.id, name: c.name, kind: c.kind, url: `/api/auth/sso/${c.id}/start` });
  return out;
}

/** The connection for an email address's domain, if an organization (or the instance) claims that domain. */
export async function connectionForEmail(ctx: Ctx, email: string): Promise<SsoConnection | null> {
  const domain = email.split('@')[1]?.trim().toLowerCase();
  if (!domain) return null;
  const rows = await ctx.db.select().from(ssoConnections);
  return rows.find((c) => c.domains.includes(domain)) ?? null;
}

export async function toConnectionInfo(ctx: Ctx, c: SsoConnection): Promise<SsoConnectionInfo> {
  const org = c.namespaceId ? (await ctx.db.select({ slug: namespaces.slug }).from(namespaces).where(eq(namespaces.id, c.namespaceId)).limit(1))[0]?.slug ?? null : null;
  const saml = c.kind === 'saml' ? samlUrls(ctx, c.id) : null;
  return {
    id: c.id,
    org,
    kind: c.kind,
    name: c.name,
    issuer: c.config.issuer ?? null,
    clientId: c.config.clientId ?? null,
    hasSecret: Boolean(c.config.clientSecret),
    entryPoint: c.config.entryPoint ?? null,
    idpIssuer: c.config.idpIssuer ?? null,
    hasCertificate: Boolean(c.config.certificate),
    domains: c.domains,
    enforced: c.enforced,
    autoProvision: c.autoProvision,
    callbackUrl: saml ? saml.acs : callbackUrl(ctx, c.id),
    spEntityId: saml?.entityId ?? null,
    metadataUrl: saml?.metadata ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}
