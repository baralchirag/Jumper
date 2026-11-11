import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';

/** Key types accepted for git over SSH. DSA and short RSA keys are refused. */
const ALLOWED = new Set([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

export interface ParsedPublicKey {
  keyType: string;
  /** Base64 blob, as in authorized_keys. */
  blob: string;
  comment: string;
  fingerprint: string;
}

/** OpenSSH's `SHA256:` fingerprint of a public key blob. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** Read the RSA modulus size straight from the wire format: string "ssh-rsa", mpint e, mpint n. */
function rsaBits(blob: Buffer): number {
  let off = 0;
  const next = () => {
    const len = blob.readUInt32BE(off);
    const v = blob.subarray(off + 4, off + 4 + len);
    off += 4 + len;
    return v;
  };
  next();
  next();
  const n = next();
  let i = 0;
  while (i < n.length && n[i] === 0) i++;
  return (n.length - i) * 8;
}

/** Parse one authorized_keys-style line. Throws an Error with a message fit to show the user. */
export function parsePublicKey(line: string): ParsedPublicKey {
  const text = line.trim().replace(/\s+/g, ' ');
  if (/PRIVATE KEY/.test(text)) throw new Error('That is a private key. Paste the public key (the .pub file) instead, and keep the private key secret.');
  const [keyType, blob, ...rest] = text.split(' ');
  if (!keyType || !blob) throw new Error('Paste the whole public key line, starting with ssh-ed25519, ecdsa-sha2-… or ssh-rsa');
  if (!ALLOWED.has(keyType)) throw new Error(keyType === 'ssh-dss' ? 'DSA keys are no longer secure. Create an ed25519 key with: ssh-keygen -t ed25519' : `Unsupported key type "${keyType}"`);
  const parsed = ssh2.utils.parseKey(`${keyType} ${blob}`);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('That does not look like a valid public key');
  const raw = parsed.getPublicSSH();
  if (raw.toString('base64') !== blob) throw new Error('That does not look like a valid public key');
  if (keyType === 'ssh-rsa' && rsaBits(raw) < 2048) throw new Error('RSA keys must be at least 2048 bits. Create an ed25519 key with: ssh-keygen -t ed25519');
  return { keyType, blob, comment: rest.join(' ').slice(0, 200), fingerprint: fingerprintOf(raw) };
}

/**
 * Parse the command a git client sends over SSH, e.g. `git-receive-pack '/alice/board.git'`.
 * Only the three git services are accepted, with a single quoted owner/repo path.
 */
export function parseGitCommand(command: string): { service: 'git-upload-pack' | 'git-receive-pack' | 'git-upload-archive'; owner: string; repo: string } | null {
  const m = /^(git-upload-pack|git-receive-pack|git-upload-archive|git upload-pack|git receive-pack|git upload-archive) '?\/?([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?'?$/.exec(command.trim());
  if (!m) return null;
  return { service: m[1]!.replace(' ', '-') as 'git-upload-pack' | 'git-receive-pack' | 'git-upload-archive', owner: m[2]!, repo: m[3]! };
}
