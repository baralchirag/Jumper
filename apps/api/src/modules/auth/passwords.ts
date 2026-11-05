import { hash, verify } from '@node-rs/argon2';

// OWASP recommended argon2id parameters.
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTS);
}

export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (!stored) return false;
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** Constant work for unknown users to avoid user enumeration via timing. */
const DUMMY = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Hk2XovrUrRSQcxq4cS0xeM+RwYGbqc7wXpJvA4PBcbg';
export async function burnPasswordCheck(password: string): Promise<void> {
  await verifyPassword(DUMMY, password);
}
