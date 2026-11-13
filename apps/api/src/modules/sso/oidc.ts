// OpenID Connect sign-in (authorization code flow with PKCE), written against the standard so Google, Microsoft
// Entra ID, Okta, Keycloak, Authentik and friends all work through the same code.
import { createHash, createPublicKey, randomBytes, verify, type webcrypto } from 'node:crypto';

type JsonWebKey = webcrypto.JsonWebKey;
import { HttpError } from '../../lib/errors';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Microsoft's shared endpoints issue tokens whose `iss` names the user's tenant, not the endpoint. */
  issuerPattern?: RegExp;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface IdClaims {
  sub: string;
  iss: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  picture?: string;
  nonce?: string;
  tid?: string;
}

const discoveries = new Map<string, { at: number; doc: Discovery }>();
const keySets = new Map<string, { at: number; keys: (JsonWebKey & { kid?: string })[] }>();
const HOUR = 3600_000;

const failed = (message: string) => new HttpError(502, 'sso_failed', message);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }).catch((e: Error) => {
    throw failed(`Could not reach the identity provider (${e.message})`);
  });
  if (!res.ok) throw failed(`The identity provider answered ${res.status} for ${new URL(url).pathname}`);
  return (await res.json()) as T;
}

export async function discover(issuer: string): Promise<Discovery> {
  const hit = discoveries.get(issuer);
  if (hit && Date.now() - hit.at < HOUR) return hit.doc;
  const doc = await getJson<Discovery>(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw failed('The identity provider has no usable OpenID configuration');
  discoveries.set(issuer, { at: Date.now(), doc });
  return doc;
}

async function keysFor(jwksUri: string, refresh = false): Promise<(JsonWebKey & { kid?: string })[]> {
  const hit = keySets.get(jwksUri);
  if (!refresh && hit && Date.now() - hit.at < HOUR) return hit.keys;
  const { keys } = await getJson<{ keys: (JsonWebKey & { kid?: string })[] }>(jwksUri);
  keySets.set(jwksUri, { at: Date.now(), keys: keys ?? [] });
  return keys ?? [];
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export async function authorizeUrl(cfg: OidcConfig, p: { redirectUri: string; state: string; nonce: string; challenge: string; loginHint?: string }): Promise<string> {
  const d = await discover(cfg.issuer);
  const url = new URL(d.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', p.state);
  url.searchParams.set('nonce', p.nonce);
  url.searchParams.set('code_challenge', p.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (p.loginHint) url.searchParams.set('login_hint', p.loginHint);
  return url.toString();
}

const ALGS: Record<string, { hash: string; dsa?: 'ieee-p1363'; pss?: boolean }> = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true },
  ES256: { hash: 'sha256', dsa: 'ieee-p1363' },
  ES384: { hash: 'sha384', dsa: 'ieee-p1363' },
};

/** Verify an ID token's signature and standard claims; returns its claims. */
export async function verifyIdToken(cfg: OidcConfig, jwksUri: string, token: string, nonce: string, now = Date.now()): Promise<IdClaims> {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw failed('The identity provider returned a malformed ID token');
  let header: { alg?: string; kid?: string };
  let claims: IdClaims & { aud?: string | string[]; exp?: number; azp?: string };
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw failed('The identity provider returned a malformed ID token');
  }
  const alg = ALGS[header.alg ?? ''];
  if (!alg) throw failed(`ID tokens signed with ${header.alg ?? 'no algorithm'} are not accepted`);
  const pick = (keys: (JsonWebKey & { kid?: string })[]) => (header.kid ? keys.find((k) => k.kid === header.kid) : keys.length === 1 ? keys[0] : undefined);
  // A key we have not seen may be a fresh rotation: fetch the set once more before giving up.
  const jwk = pick(await keysFor(jwksUri)) ?? pick(await keysFor(jwksUri, true));
  if (!jwk) throw failed('The ID token was signed with a key the identity provider does not publish');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = verify(alg.hash, Buffer.from(`${h}.${p}`), alg.pss ? { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: -1 } : alg.dsa ? { key, dsaEncoding: alg.dsa } : key, Buffer.from(s, 'base64url'));
  if (!ok) throw failed('The ID token signature is not valid');
  const issuerOk = cfg.issuerPattern ? cfg.issuerPattern.test(claims.iss ?? '') : (claims.iss ?? '').replace(/\/$/, '') === cfg.issuer.replace(/\/$/, '');
  if (!issuerOk) throw failed('The ID token was issued by someone else');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.clientId)) throw failed('The ID token was issued for another application');
  if (!claims.exp || claims.exp * 1000 < now - 60_000) throw failed('The ID token has expired');
  if (claims.nonce !== nonce) throw failed('The ID token does not belong to this sign-in attempt');
  if (!claims.sub) throw failed('The ID token names no user');
  return claims;
}

export async function exchangeCode(cfg: OidcConfig, p: { code: string; redirectUri: string; verifier: string; nonce: string }): Promise<IdClaims> {
  const d = await discover(cfg.issuer);
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: p.verifier }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e: Error) => {
    throw failed(`Could not reach the identity provider (${e.message})`);
  });
  const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.id_token) throw failed(`The identity provider refused the sign-in${json.error ? `: ${json.error_description ?? json.error}` : ''}`);
  return verifyIdToken(cfg, d.jwks_uri, json.id_token, p.nonce);
}
