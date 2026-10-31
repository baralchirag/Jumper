// Request schemas (validated by the API) and response types (consumed by the web app).
import { z } from 'zod';
import {
  CHECK_CONCLUSIONS,
  CHECK_STATUSES,
  MERGE_METHODS,
  REPO_ROLES,
  REVIEW_STATES,
  TOKEN_SCOPES,
  type ArtifactKind,
  type CheckConclusion,
  type CheckName,
  type CheckStatus,
  type PrState,
  type RepoRole,
  type ReviewState,
} from './constants';

const RESERVED_NAMES = new Set([
  'api', 'login', 'logout', 'signup', 'new', 'settings', 'explore', 'orgs', 'admin', 'assets',
  'static', 'help', 'about', 'search', 'notifications', 'pulls', 'issues', 'git', 'health',
]);

export const slugSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9]))*$/, 'Only letters, digits and single hyphens')
  .refine((s) => !RESERVED_NAMES.has(s.toLowerCase()), 'This name is reserved');

export const repoNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Only letters, digits, ".", "_" and "-"')
  .refine((s) => !s.endsWith('.git') && s !== '.' && s !== '..', 'Invalid repository name');

export const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    // git forbids control characters in ref names (see git-check-ref-format).
    // eslint-disable-next-line no-control-regex
    (s) => !/(^[-/.])|(\.\.)|([\s~^:?*[\\\x00-\x1f\x7f])|(@\{)|(\.lock$)|(\/$)|(\/\/)|(\.$)/.test(s),
    'Invalid branch name',
  );

// ---------- auth ----------

export const registerSchema = z.object({
  username: slugSchema,
  email: z.email().max(254),
  password: z.string().min(10, 'Use at least 10 characters').max(256),
});

export const loginSchema = z.object({
  login: z.string().min(1).max(254),
  password: z.string().min(1).max(256),
});

export const updateProfileSchema = z.object({
  name: z.string().max(100).optional(),
  email: z.email().max(254).optional(),
  bio: z.string().max(500).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().max(256).optional(),
  newPassword: z.string().min(10).max(256),
});

export const createTokenSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(TOKEN_SCOPES)).min(1),
  expiresInDays: z.number().int().min(1).max(366).nullable().default(90),
});

// ---------- orgs ----------

export const createOrgSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

export const orgMemberSchema = z.object({
  username: z.string().min(1),
  role: z.enum(['owner', 'member']).default('member'),
});

// ---------- repos ----------

export const createRepoSchema = z.object({
  owner: z.string().optional(),
  name: repoNameSchema,
  description: z.string().max(350).default(''),
  visibility: z.enum(['public', 'private']).default('public'),
  initReadme: z.boolean().default(true),
});

export const updateRepoSchema = z.object({
  name: repoNameSchema.optional(),
  description: z.string().max(350).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  defaultBranch: branchNameSchema.optional(),
  requiredApprovals: z.number().int().min(0).max(10).optional(),
});

export const collaboratorSchema = z.object({ role: z.enum(REPO_ROLES) });

// ---------- pull requests ----------

export const objectAnchorSchema = z.object({
  type: z.literal('object'),
  path: z.string().max(4096),
  commitSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  objectType: z.string().max(40),
  objectId: z.string().max(200),
  label: z.string().max(200).optional(),
  layer: z.string().max(60).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

export const lineAnchorSchema = z.object({
  type: z.literal('line'),
  path: z.string().max(4096),
  commitSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  line: z.number().int().min(1),
  side: z.enum(['old', 'new']),
});

export const commentAnchorSchema = z.discriminatedUnion('type', [objectAnchorSchema, lineAnchorSchema]);
export type CommentAnchor = z.infer<typeof commentAnchorSchema>;

export const createPullSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(65536).default(''),
  base: branchNameSchema,
  head: branchNameSchema,
});

export const updatePullSchema = z.object({
  title: z.string().min(1).max(256).optional(),
  body: z.string().max(65536).optional(),
  state: z.enum(['open', 'closed']).optional(),
});

export const createCommentSchema = z.object({
  body: z.string().min(1).max(65536),
  anchor: commentAnchorSchema.optional(),
  inReplyTo: z.uuid().optional(),
});

export const updateCommentSchema = z.object({
  body: z.string().min(1).max(65536).optional(),
  resolved: z.boolean().optional(),
});

export const createReviewSchema = z.object({
  state: z.enum(REVIEW_STATES),
  body: z.string().max(65536).default(''),
  comments: z.array(z.object({ body: z.string().min(1).max(65536), anchor: commentAnchorSchema })).max(200).default([]),
});

export const mergePullSchema = z.object({
  method: z.enum(MERGE_METHODS).default('merge'),
  title: z.string().max(256).optional(),
  message: z.string().max(65536).optional(),
  deleteBranch: z.boolean().default(false),
});

export const checkStatusSchema = z.enum(CHECK_STATUSES);
export const checkConclusionSchema = z.enum(CHECK_CONCLUSIONS);

// ---------- response types ----------

export interface UserSummary {
  id: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface CurrentUser extends UserSummary {
  email: string;
  bio: string | null;
  isAdmin: boolean;
  hasPassword: boolean;
  githubLinked: boolean;
  orgs: { slug: string; name: string; role: 'owner' | 'member' }[];
}

export interface TokenInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface RepoInfo {
  id: string;
  owner: string;
  ownerKind: 'user' | 'org';
  name: string;
  fullName: string;
  description: string;
  visibility: 'public' | 'private';
  defaultBranch: string;
  requiredApprovals: number;
  isEmpty: boolean;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  permission: RepoRole | 'none';
  openPullCount: number;
  cloneUrl: string;
}

export interface NamespaceInfo {
  slug: string;
  kind: 'user' | 'org';
  name: string | null;
  bio: string | null;
  avatarUrl: string | null;
  createdAt: string;
  repos: RepoInfo[];
  members?: (UserSummary & { role: 'owner' | 'member' })[];
}

export interface GitSignature {
  name: string;
  email: string;
  date: string;
}

export interface CommitInfo {
  sha: string;
  parents: string[];
  author: GitSignature;
  committer: GitSignature;
  subject: string;
  body: string;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'blob' | 'tree' | 'commit';
  oid: string;
  size: number | null;
  mode: string;
}

export interface TreeResponse {
  ref: string;
  sha: string;
  path: string;
  entries: TreeEntry[];
  lastCommit: CommitInfo | null;
  readme: { path: string; text: string } | null;
}

export interface BlobResponse {
  ref: string;
  sha: string;
  path: string;
  oid: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  text: string | null;
}

export interface RefInfo {
  name: string;
  sha: string;
  isDefault?: boolean;
  lastCommit?: CommitInfo;
  aheadBehind?: { ahead: number; behind: number } | null;
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'type_changed';

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  oldOid: string | null;
  newOid: string | null;
  /** Unified diff body; null when too large or binary. */
  patch: string | null;
  truncated: boolean;
}

export interface CompareResponse {
  base: string;
  head: string;
  baseSha: string;
  headSha: string;
  mergeBase: string | null;
  commits: CommitInfo[];
  files: FileDiff[];
}

export interface CommitDetail {
  commit: CommitInfo;
  files: FileDiff[];
}

export interface CheckRunInfo {
  id: string;
  sha: string;
  name: CheckName;
  projectPath: string;
  status: CheckStatus;
  conclusion: CheckConclusion | null;
  summary: string | null;
  details: CheckDetails | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CheckAnnotation {
  severity: 'error' | 'warning' | 'info';
  type: string;
  message: string;
  file?: string;
  sheet?: string;
  x?: number;
  y?: number;
  items?: { description: string; uuid?: string; x?: number; y?: number }[];
}

export interface CheckDetails {
  counts?: { error: number; warning: number; ignored: number };
  annotations?: CheckAnnotation[];
  log?: string;
  [key: string]: unknown;
}

export interface ArtifactInfo {
  id: string;
  sha: string;
  projectPath: string;
  kind: ArtifactKind;
  name: string;
  contentType: string;
  size: number;
  meta: Record<string, unknown>;
  url: string;
}

export interface PullInfo {
  id: string;
  number: number;
  title: string;
  body: string;
  state: PrState;
  author: UserSummary;
  base: string;
  head: string;
  baseSha: string;
  headSha: string;
  mergeCommitSha: string | null;
  mergedBy: UserSummary | null;
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  reviewSummary: { approved: number; changesRequested: number };
}

export interface Mergeability {
  mergeable: boolean;
  conflicts: string[];
  canFastForward: boolean;
  checks: { name: string; state: 'success' | 'failure' | 'pending' | 'missing' }[];
  approvals: number;
  requiredApprovals: number;
  changesRequested: boolean;
  blockers: string[];
}

export interface PullDetail extends PullInfo {
  mergeability: Mergeability | null;
}

export interface CommentInfo {
  id: string;
  author: UserSummary;
  body: string;
  anchor: CommentAnchor | null;
  inReplyTo: string | null;
  reviewId: string | null;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewInfo {
  id: string;
  author: UserSummary;
  state: ReviewState;
  body: string;
  commitSha: string;
  createdAt: string;
}

export interface PullEventInfo {
  id: string;
  actor: UserSummary | null;
  kind: 'opened' | 'closed' | 'reopened' | 'merged' | 'pushed' | 'renamed' | 'base_changed';
  data: Record<string, unknown>;
  createdAt: string;
}

export type TimelineItem =
  | ({ itemType: 'comment' } & CommentInfo)
  | ({ itemType: 'review'; comments: CommentInfo[] } & ReviewInfo)
  | ({ itemType: 'event' } & PullEventInfo);

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}
