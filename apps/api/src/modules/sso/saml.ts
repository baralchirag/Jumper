// SAML 2.0 service provider, on top of node-saml (which does the XML signature validation).
import { SAML } from '@node-saml/node-saml';
import type { SsoConnection } from '@jumper/db';
import type { Ctx } from '../../context';
import { HttpError } from '../../lib/errors';

export const samlUrls = (ctx: Ctx, id: string) => {
  const base = `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/api/auth/sso/${id}`;
  return { acs: `${base}/acs`, metadata: `${base}/metadata`, entityId: `${base}/metadata` };
};

/** Accept a PEM block or bare base64, as identity providers offer either. */
export function normalizeCertificate(input: string): string {
  return input.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

function client(ctx: Ctx, conn: SsoConnection): SAML {
  const { acs, entityId } = samlUrls(ctx, conn.id);
  if (!conn.config.entryPoint || !conn.config.certificate) throw new HttpError(400, 'sso_misconfigured', 'This SAML connection has no sign-in URL or certificate yet');
  return new SAML({
    callbackUrl: acs,
    entryPoint: conn.config.entryPoint,
    issuer: entityId,
    idpCert: normalizeCertificate(conn.config.certificate),
    idpIssuer: conn.config.idpIssuer || undefined,
    audience: entityId,
    wantAssertionsSigned: false,
    // Either the response or the assertion must be signed; node-saml rejects a response where neither is.
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: 120_000,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    disableRequestedAuthnContext: true,
  });
}

export async function samlRedirectUrl(ctx: Ctx, conn: SsoConnection, relayState: string): Promise<string> {
  return client(ctx, conn).getAuthorizeUrlAsync(relayState, undefined, {});
}

export function samlMetadata(ctx: Ctx, conn: SsoConnection): string {
  const { acs, entityId } = samlUrls(ctx, conn.id);
  return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="false" WantAssertionsSigned="true">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acs}" index="1"/>
  </SPSSODescriptor>
</EntityDescriptor>
`;
}

export interface SamlIdentity {
  subject: string;
  email: string | null;
  name: string | null;
}

const first = (v: unknown): string | null => (Array.isArray(v) ? first(v[0]) : typeof v === 'string' && v.trim() ? v.trim() : null);

/** Validate a posted SAMLResponse (signature, audience, validity window) and read who it is about. */
export async function samlIdentity(ctx: Ctx, conn: SsoConnection, samlResponse: string): Promise<SamlIdentity> {
  let profile: Record<string, unknown> | null;
  try {
    ({ profile } = (await client(ctx, conn).validatePostResponseAsync({ SAMLResponse: samlResponse })) as { profile: Record<string, unknown> | null });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, 'sso_failed', `The SAML response was not accepted: ${(e as Error).message}`);
  }
  if (!profile || typeof profile.nameID !== 'string') throw new HttpError(401, 'sso_failed', 'The SAML response names no user');
  const attr = (...names: string[]) => names.map((n) => first(profile![n])).find(Boolean) ?? null;
  const email =
    attr('email', 'mail', 'emailAddress', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'urn:oid:0.9.2342.19200300.100.1.3') ??
    (profile.nameID.includes('@') ? profile.nameID : null);
  const given = attr('givenName', 'firstName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname');
  const family = attr('sn', 'lastName', 'surname', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname');
  const name = attr('displayName', 'name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name') ?? ([given, family].filter(Boolean).join(' ') || null);
  return { subject: profile.nameID, email, name };
}
