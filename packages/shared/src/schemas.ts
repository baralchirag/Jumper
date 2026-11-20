// Request schemas (validated by the API) and response types (consumed by the web app).
import { z } from 'zod';
import type { PlanId } from './plans';
import {
  CHECK_CONCLUSIONS,
  CHECK_STATUSES,
  REPO_ROLES,
  TOKEN_SCOPES,
  type ArtifactKind,
  type CheckConclusion,
  type CheckName,
  type CheckStatus,
  type Capability,
  type RepoRole,
} from './constants';

const RESERVED_NAMES = new Set([
  'api', 'login', 'logout', 'signup', 'new', 'settings', 'explore', 'orgs', 'admin', 'assets',
  'static', 'help', 'about', 'search', 'notifications', 'pulls', 'issues', 'git', 'health',
  // Existing top-level pages.
  'docs', 'stars', 'tools', 'share', 'verify', 'forgot', 'reset', 'organizations',
  // Legal and pages planned on the roadmap, kept free so they never shadow an account.
  'terms', 'privacy', 'refunds', 'legal', 'pricing', 'billing', 'usage', 'embed', 'badge', 'badges', 'releases',
  'templates', 'trending', 'featured', 'sso', 'oauth', 'plugin', 'download', 'downloads', 'status', 'security',
  'contact', 'blog', 'enterprise', 'welcome', 'onboarding', 'referrals', 'invite', 'ghost',
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
  /** Username of whoever shared the invite link, from /signup?ref=. */
  ref: z.string().max(100).optional(),
});

export interface ReferralInfo {
  /** Your invite link. */
  link: string;
  signupOpen: boolean;
  bonusPerReferralMb: number;
  maxBonusMb: number;
  /** Storage your running invite bonuses add right now. */
  bonusMb: number;
  /** How long each bonus lasts from the day the person joined, and when the earliest running one ends. */
  bonusDays: number;
  bonusExpiresAt: string | null;
  /** False on instances that do not enforce plans: the bonus is recorded but there is no limit to raise. */
  bonusApplies: boolean;
  counted: number;
  /** `active`: still adding storage today. */
  invited: { username: string; joinedAt: string; counts: boolean; active: boolean }[];
}

export const loginSchema = z.object({
  login: z.string().min(1).max(254),
  password: z.string().min(1).max(256),
  /** Six-digit code from the authenticator app, or a recovery code, when the account has two-factor login. */
  code: z.string().trim().max(20).optional(),
});

const optionalUrl = z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(255)]);

export const updateProfileSchema = z.object({
  name: z.string().max(100).optional(),
  email: z.email().max(254).optional(),
  /** Required to change the email address of an account that has a password. */
  currentPassword: z.string().max(256).optional(),
  /** Email me about mentions and assignments. */
  notifyEmail: z.boolean().optional(),
  /** Send me the weekly summary of activity in my repositories. */
  digestEmail: z.boolean().optional(),
  bio: z.string().max(500).optional(),
  website: optionalUrl.optional(),
  location: z.string().max(100).optional(),
  company: z.string().max(100).optional(),
  pronouns: z.string().max(40).optional(),
  avatarUrl: optionalUrl.optional(),
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

/** A built-in repository role, or `custom:<id>` for one of the owner's custom roles. */
const roleRef = z.union([z.enum(REPO_ROLES), z.string().regex(/^custom:[0-9a-f-]{36}$/)]);

export const orgMemberSchema = z.object({
  username: z.string().min(1),
  role: z.enum(['owner', 'member']).default('member'),
  /** Access a member has to the organization's repositories: a built-in role or `custom:<id>`. Owners are always admins. */
  repoRole: roleRef.optional(),
});

// ---------- repos ----------

export const createRepoSchema = z.object({
  owner: z.string().optional(),
  name: repoNameSchema,
  description: z.string().max(350).default(''),
  visibility: z.enum(['public', 'private']).default('public'),
  initReadme: z.boolean().default(true),
  /** Start from a small complete KiCad project instead of an empty README. */
  sample: z.boolean().default(false),
  /** Start from a starter project (see GET /api/templates), e.g. `esp32-s3`. */
  template: z.string().max(40).optional(),
});

export const updateRepoSchema = z.object({
  name: repoNameSchema.optional(),
  description: z.string().max(350).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  defaultBranch: branchNameSchema.optional(),
  requiredApprovals: z.number().int().min(0).max(10).optional(),
  /** Restrict the repository to people cleared for export-controlled work (instance administrators only). */
  exportControlled: z.boolean().optional(),
});

export const collaboratorSchema = z.object({ role: roleRef });

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

export const checkStatusSchema = z.enum(CHECK_STATUSES);
export const checkConclusionSchema = z.enum(CHECK_CONCLUSIONS);

// ---------- response types ----------

export interface UserSummary {
  id: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface ProfileFields {
  bio: string | null;
  website: string | null;
  location: string | null;
  company: string | null;
  pronouns: string | null;
}

export interface CurrentUser extends UserSummary, ProfileFields {
  email: string;
  createdAt: string;
  isAdmin: boolean;
  /** False until the address is confirmed. Only matters when the instance enforces verification. */
  emailVerified: boolean;
  /** Receives email for mentions and assignments (when the instance can send mail). */
  notifyEmail: boolean;
  hasPassword: boolean;
  githubLinked: boolean;
  /** Receives the weekly summary email. */
  digestEmail: boolean;
  twoFactor: boolean;
  /** Cleared to view export-controlled repositories. */
  exportCleared: boolean;
  orgs: { slug: string; name: string; role: 'owner' | 'member' }[];
  /** Plan of the user's personal namespace. */
  plan: PlanId;
}

export interface SessionInfo {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

export interface AuditEntry {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
  actor?: UserSummary | null;
}

export interface AdminTableInfo {
  name: string;
  rows: number;
  bytes: number;
  columns: { name: string; type: string; nullable: boolean; hidden: boolean }[];
}

export interface AdminTablePage {
  table: string;
  columns: { name: string; type: string; hidden: boolean }[];
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminOverview {
  counts: { users: number; orgs: number; repos: number; checks: number; artifacts: number; sessions: number };
  checks: { conclusion: string | null; status: string; n: number }[];
  storageBytes: number;
  repoBytes: number;
  dbBytes: number;
  recentUsers: (UserSummary & { createdAt: string; isAdmin: boolean; disabled: boolean })[];
  recentAudit: AuditEntry[];
  version: { node: string; postgres: string };
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
  /** What the viewer may do; differs from the role's defaults when they hold a custom role. */
  capabilities: Capability[];
  /** Name of the viewer's custom role, if any. */
  customRole: string | null;
  /** Only people cleared for export-controlled work can see this repository. */
  exportControlled: boolean;
  /** Under legal hold: nothing in it can be deleted. */
  legalHold: boolean;
  cloneUrl: string;
  /** SSH clone URL, or null when the server does not run SSH. */
  sshCloneUrl: string | null;
}

export interface NamespaceInfo {
  slug: string;
  kind: 'user' | 'org';
  name: string | null;
  bio: string | null;
  avatarUrl: string | null;
  website?: string | null;
  location?: string | null;
  company?: string | null;
  pronouns?: string | null;
  createdAt: string;
  repos: RepoInfo[];
  members?: (UserSummary & { role: 'owner' | 'member' })[];
  /** Repositories the owner pinned to the top of the profile, in order (only ones the viewer can see). */
  pinned?: RepoInfo[];
  /** Public repositories shown here. */
  stats?: { repos: number };
  /** The owner's plan; shown as a badge for paid plans. */
  plan?: PlanId;
}

export const createInviteSchema = z.object({
  role: z.enum(['owner', 'member']).default('member'),
  repoRole: z.enum(['read', 'review', 'write', 'admin']).default('write'),
  email: z.email().max(254).optional(),
});

export interface OrgInviteInfo {
  id: string;
  role: 'owner' | 'member';
  repoRole: 'read' | 'review' | 'write' | 'admin';
  email: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Returned once, when an invite is created: the only time the link exists in clear. */
export interface CreatedInvite extends OrgInviteInfo {
  link: string;
  emailed: boolean;
}

/** What someone opening an invite link may see before joining. */
export interface InvitePreview {
  org: { slug: string; name: string; avatarUrl: string | null };
  role: 'owner' | 'member';
  invitedBy: string | null;
  expiresAt: string;
  /** Signed-in viewer is already in the organization. */
  alreadyMember: boolean;
}

export const pinsSchema = z.object({ repos: z.array(z.string().min(1).max(100)).max(6) });


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

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}
