// Types shared by the API and web app for repository hosting features: mirroring, SSH keys, search, LFS.
import { z } from 'zod';

// ---------- mirroring ----------

export const MIRROR_DIRECTIONS = ['pull', 'push'] as const;
export type MirrorDirection = (typeof MIRROR_DIRECTIONS)[number];

export const createMirrorSchema = z.object({
  direction: z.enum(MIRROR_DIRECTIONS),
  url: z.string().trim().min(8).max(2000),
  username: z.string().max(200).optional(),
  /** Access token; encrypted at rest and never returned. */
  token: z.string().max(500).optional(),
  overwrite: z.boolean().default(false),
  intervalMinutes: z.number().int().min(1).max(7 * 24 * 60).default(60),
});

export const updateMirrorSchema = z.object({
  enabled: z.boolean().optional(),
  overwrite: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
  username: z.string().max(200).optional(),
  /** Empty string removes the saved token. */
  token: z.string().max(500).optional(),
});

export interface MirrorInfo {
  id: string;
  direction: MirrorDirection;
  url: string;
  username: string | null;
  hasToken: boolean;
  overwrite: boolean;
  enabled: boolean;
  intervalMinutes: number;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  createdAt: string;
}

// ---------- SSH keys ----------

export const addSshKeySchema = z.object({
  title: z.string().trim().max(100).default(''),
  /** One line in authorized_keys format: "ssh-ed25519 AAAA... comment". */
  key: z.string().trim().min(20).max(16_000),
});

export interface SshKeyInfo {
  id: string;
  title: string;
  keyType: string;
  fingerprint: string;
  lastUsedAt: string | null;
  createdAt: string;
}

// ---------- search ----------

export const SEARCH_TYPES = ['repos', 'files', 'code', 'parts', 'nets'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchRepoRef {
  owner: string;
  name: string;
}

export type SearchHit =
  | { type: 'repos'; repo: SearchRepoRef; description: string; updatedAt: string }
  | { type: 'files'; repo: SearchRepoRef; ref: string; path: string }
  | { type: 'code'; repo: SearchRepoRef; ref: string; path: string; line: number; text: string }
  | { type: 'parts'; repo: SearchRepoRef; ref: string; refs: string[]; value: string; footprint: string; mpn: string | null; quantity: number }
  | { type: 'nets'; repo: SearchRepoRef; ref: string; net: string; pads: number };

export interface SearchResults {
  query: string;
  type: SearchType;
  hits: SearchHit[];
  /** Hits per type for the tab counts; types searched only within one repository may be omitted. */
  counts: Partial<Record<SearchType, number>>;
  /** True when more results exist than were returned. */
  truncated: boolean;
}

// ---------- LFS ----------

export interface LfsObjectInfo {
  oid: string;
  size: number;
  createdAt: string;
}
