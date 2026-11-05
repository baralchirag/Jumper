// Encryption for credentials the server must be able to use later (mirror access tokens). AES-256-GCM with a key from
// SECRET_KEY, or a random key written once to SECRET_KEY_FILE so a self-hosted instance works without setup.
// Rotating the key makes stored tokens unreadable; affected mirrors then report that the token must be entered again.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 'v1';
const keys = new Map<string, Buffer>();

export interface SecretSource {
  SECRET_KEY?: string;
  secretKeyFile: string;
}

function keyFor(src: SecretSource): Buffer {
  const cacheKey = src.SECRET_KEY ? `env:${src.SECRET_KEY}` : `file:${src.secretKeyFile}`;
  const hit = keys.get(cacheKey);
  if (hit) return hit;
  let material: string;
  if (src.SECRET_KEY) {
    material = src.SECRET_KEY;
  } else {
    if (!existsSync(src.secretKeyFile)) {
      mkdirSync(dirname(src.secretKeyFile), { recursive: true });
      // wx: never overwrite a key another process created a moment ago.
      try {
        writeFileSync(src.secretKeyFile, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    material = readFileSync(src.secretKeyFile, 'utf8').trim();
  }
  const key = createHash('sha256').update(material).digest();
  keys.set(cacheKey, key);
  return key;
}

export function encryptSecret(src: SecretSource, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(src), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

/** null when the value was encrypted with another key or has been tampered with. */
export function decryptSecret(src: SecretSource, sealed: string): string | null {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || data === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(src), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------- signed, short-lived tokens ----------

/** HMAC-signed payload: `<base64url(json)>.<base64url(sig)>`. The signing key is derived from the server secret. */
export function signToken(src: SecretSource, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', createHash('sha256').update(keyFor(src)).update('sign:v1').digest()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** The payload, or null when the signature is wrong or the token is malformed. Expiry is the caller's to check. */
export function verifyToken<T = Record<string, unknown>>(src: SecretSource, token: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', createHash('sha256').update(keyFor(src)).update('sign:v1').digest()).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** HMAC of `data` with a key derived from the server secret for one `purpose`, so signatures cannot be reused elsewhere. */
export function hmacHex(src: SecretSource, purpose: string, data: string): string {
  return createHmac('sha256', createHash('sha256').update(keyFor(src)).update(`hmac:${purpose}`).digest()).update(data).digest('hex');
}
