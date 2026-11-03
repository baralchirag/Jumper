// Types shared by the API and web app for repository hosting features: mirroring, SSH keys, releases, search, LFS.
import { z } from 'zod';
import type { UserSummary } from './schemas';

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

// ---------- releases ----------

/** Kinds of file a release can carry. Generated kinds are built from the tagged revision's check outputs. */
export const RELEASE_ASSET_KINDS = ['gerbers', 'drill', 'bom', 'step', 'pdf', 'positions', 'jlcpcb', 'pcbway', 'oshpark', 'upload'] as const;
export type ReleaseAssetKind = (typeof RELEASE_ASSET_KINDS)[number];
export const GENERATED_ASSET_KINDS = ['gerbers', 'bom', 'step', 'pdf', 'positions', 'jlcpcb', 'pcbway', 'oshpark'] as const satisfies readonly ReleaseAssetKind[];

export const createReleaseSchema = z.object({
  tag: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^(?![./-])(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/+-]+(?<![./])$/, 'Use letters, numbers, dots, dashes and slashes, e.g. v1.2 or rev-B'),
  /** Branch or commit to tag when the tag does not exist yet. Defaults to the default branch. */
  target: z.string().max(200).optional(),
  name: z.string().trim().max(200).default(''),
  body: z.string().max(100_000).default(''),
  draft: z.boolean().default(false),
  prerelease: z.boolean().default(false),
  /** Fabrication files to build from the revision's outputs and attach. */
  assets: z.array(z.enum(GENERATED_ASSET_KINDS)).max(GENERATED_ASSET_KINDS.length).default(['gerbers', 'bom', 'step', 'pdf', 'positions', 'jlcpcb']),
});

export const updateReleaseSchema = z.object({
  name: z.string().trim().max(200).optional(),
  body: z.string().max(100_000).optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});

export interface ReleaseAssetInfo {
  id: string;
  name: string;
  kind: ReleaseAssetKind;
  size: number;
  contentType: string;
  downloadCount: number;
  /** API path that serves the file. */
  url: string;
}

export interface ReleaseInfo {
  id: string;
  tag: string;
  name: string;
  body: string;
  sha: string;
  draft: boolean;
  prerelease: boolean;
  latest: boolean;
  author: UserSummary | null;
  createdAt: string;
  publishedAt: string | null;
  assets: ReleaseAssetInfo[];
  /** Generated kinds that could not be built (e.g. no PCB in the project, or checks not finished). */
  missing: { kind: ReleaseAssetKind; reason: string }[];
  /** Sign-off state when the owner requires named people to approve releases; null when no approval is required. */
  approval: ReleaseApprovalState | null;
  /** Digest of the signed release record, once the release is published on an instance that keeps records. */
  recordDigest: string | null;
}

export interface ReleaseApprovalState {
  required: number;
  /** People whose approval counts. */
  approvers: UserSummary[];
  decisions: { user: UserSummary; decision: 'approved' | 'rejected'; comment: string; sha: string; at: string }[];
  approved: boolean;
  /** Whether the current user may sign off. */
  canSign: boolean;
}

// ---------- search ----------

export const SEARCH_TYPES = ['repos', 'files', 'code', 'parts', 'nets', 'issues'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchRepoRef {
  owner: string;
  name: string;
}

export type SearchHit =
  | { type: 'repos'; repo: SearchRepoRef; description: string; stars: number; updatedAt: string }
  | { type: 'files'; repo: SearchRepoRef; ref: string; path: string }
  | { type: 'code'; repo: SearchRepoRef; ref: string; path: string; line: number; text: string }
  | { type: 'parts'; repo: SearchRepoRef; ref: string; refs: string[]; value: string; footprint: string; mpn: string | null; quantity: number }
  | { type: 'nets'; repo: SearchRepoRef; ref: string; net: string; pads: number }
  | { type: 'issues'; repo: SearchRepoRef; number: number; title: string; state: 'open' | 'closed'; kind: 'issue' | 'discussion'; updatedAt: string };

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
