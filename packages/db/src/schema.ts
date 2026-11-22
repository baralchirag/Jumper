import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { CheckDetails, CommentAnchor } from '@jumper/shared';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const namespaceKind = pgEnum('namespace_kind', ['user', 'org']);
export const visibility = pgEnum('visibility', ['public', 'private']);
export const repoRole = pgEnum('repo_role', ['read', 'review', 'write', 'admin']);
export const orgRole = pgEnum('org_role', ['owner', 'member']);
export const prState = pgEnum('pr_state', ['open', 'closed', 'merged']);
export const reviewState = pgEnum('review_state', ['approved', 'changes_requested', 'commented']);
export const checkStatus = pgEnum('check_status', ['queued', 'in_progress', 'completed']);
export const checkConclusion = pgEnum('check_conclusion', ['success', 'failure', 'neutral', 'skipped', 'cancelled', 'timed_out']);

// ---------- identity ----------

export const users = pgTable(
  'users',
  {
    id: id(),
    username: text('username').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    name: text('name'),
    bio: text('bio'),
    website: text('website'),
    location: text('location'),
    company: text('company'),
    pronouns: text('pronouns'),
    avatarUrl: text('avatar_url'),
    githubId: text('github_id'),
    isAdmin: boolean('is_admin').notNull().default(false),
    disabled: boolean('disabled').notNull().default(false),
    /** Null until the owner of the address proved they can read mail sent to it. */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** Email me about mentions and assignments (the in-app inbox is always on). */
    notifyEmail: boolean('notify_email').notNull().default(true),
    /** Weekly summary of activity in the repositories this user owns, follows or collaborates on. */
    digestEmail: boolean('digest_email').notNull().default(true),
    lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
    /** TOTP secret, encrypted with the server key. Set while enrolling; active once `totpEnabledAt` is set. */
    totpSecret: text('totp_secret'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    /** sha256 of each unused recovery code. */
    recoveryCodes: text('recovery_codes').array().notNull().default(sql`'{}'::text[]`),
    /** Cleared by an administrator to view export-controlled repositories. */
    exportCleared: boolean('export_cleared').notNull().default(false),
    /** Identifier in the company directory (SCIM externalId). */
    externalId: text('external_id'),
    /** Created or managed through SCIM: the directory decides whether the account is active. */
    scimManaged: boolean('scim_managed').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_username_lower_idx').on(sql`lower(${t.username})`),
    uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
    uniqueIndex('users_github_id_idx').on(t.githubId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 of the session token; the raw token only lives in the cookie. */
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    /** Single sign-on connection this session was started through, if any. */
    ssoConnectionId: uuid('sso_connection_id'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const personalAccessTokens = pgTable(
  'personal_access_tokens',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    prefix: text('prefix').notNull(),
    scopes: text('scopes').array().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('pat_hash_idx').on(t.tokenHash), index('pat_user_idx').on(t.userId)],
);

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  avatarUrl: text('avatar_url'),
  createdAt: createdAt(),
});

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull().default('member'),
    /** What a member can do in the organization's repositories. Owners are always admins. */
    repoRole: repoRole('repo_role').notNull().default('write'),
    /** A custom role of the organization; when set it replaces `repoRole`. */
    customRoleId: uuid('custom_role_id'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

/** A link that lets someone join an organization. Single use, expires, stored only as a hash. */
export const orgInvites = pgTable(
  'org_invites',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    role: orgRole('role').notNull().default('member'),
    repoRole: repoRole('repo_role').notNull().default('write'),
    /** Who the link was meant for; informational, and where it was emailed when mail is configured. */
    email: text('email'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('org_invites_token_idx').on(t.tokenHash), index('org_invites_org_idx').on(t.orgId)],
);

/** Unifies users and organizations under one URL slug space (`/:owner`). */
export const namespaces = pgTable(
  'namespaces',
  {
    id: id(),
    slug: text('slug').notNull(),
    kind: namespaceKind('kind').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    /** Repositories shown first on the profile, in order (a portfolio). */
    pinnedRepoIds: uuid('pinned_repo_ids').array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('namespaces_slug_lower_idx').on(sql`lower(${t.slug})`),
    uniqueIndex('namespaces_user_idx').on(t.userId),
    uniqueIndex('namespaces_org_idx').on(t.orgId),
  ],
);

// ---------- repositories ----------

export const repositories = pgTable(
  'repositories',
  {
    id: id(),
    namespaceId: uuid('namespace_id').notNull().references(() => namespaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    visibility: visibility('visibility').notNull().default('public'),
    defaultBranch: text('default_branch').notNull().default('main'),
    /** Repository this one was forked from; cleared if the original is deleted. */
    forkOfId: uuid('fork_of_id'),
    requiredApprovals: integer('required_approvals').notNull().default(0),
    nextNumber: integer('next_number').notNull().default(1),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    /** Visible only to people cleared for export-controlled work, whatever their role. */
    exportControlled: boolean('export_controlled').notNull().default(false),
    /** Picked by an administrator for the Explore page; null when not featured. */
    featuredAt: timestamp('featured_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    pushedAt: timestamp('pushed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('repos_ns_name_lower_idx').on(t.namespaceId, sql`lower(${t.name})`),
    index('repos_search_idx').using('gin', sql`to_tsvector('simple', ${t.name} || ' ' || ${t.description})`),
  ],
);

export const repoCollaborators = pgTable(
  'repo_collaborators',
  {
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: repoRole('role').notNull().default('read'),
    /** A custom role of the repository's owner; when set it replaces `role`. */
    customRoleId: uuid('custom_role_id'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.userId] })],
);

export const stars = pgTable(
  'stars',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.repoId] }), index('stars_repo_idx').on(t.repoId)],
);

/** A user following another user: their public activity shows up for the follower. */
export const follows = pgTable(
  'follows',
  {
    followerId: uuid('follower_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    followeeId: uuid('followee_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.followerId, t.followeeId] }), index('follows_followee_idx').on(t.followeeId)],
);

// ---------- pull requests ----------

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    authorId: uuid('author_id').notNull().references(() => users.id),
    baseRef: text('base_ref').notNull(),
    headRef: text('head_ref').notNull(),
    baseSha: text('base_sha').notNull(),
    headSha: text('head_sha').notNull(),
    state: prState('state').notNull().default('open'),
    /** A draft cannot be merged until its author marks it ready for review. */
    draft: boolean('draft').notNull().default(false),
    mergeCommitSha: text('merge_commit_sha'),
    mergedById: uuid('merged_by_id').references(() => users.id),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('pr_repo_number_idx').on(t.repoId, t.number),
    index('pr_repo_state_idx').on(t.repoId, t.state),
    index('pr_head_idx').on(t.repoId, t.headRef),
  ],
);

export const reviews = pgTable(
  'reviews',
  {
    id: id(),
    pullId: uuid('pull_id').notNull().references(() => pullRequests.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').notNull().references(() => users.id),
    state: reviewState('state').notNull(),
    body: text('body').notNull().default(''),
    commitSha: text('commit_sha').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('reviews_pull_idx').on(t.pullId)],
);

export const comments = pgTable(
  'comments',
  {
    id: id(),
    pullId: uuid('pull_id').notNull().references(() => pullRequests.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').notNull().references(() => users.id),
    reviewId: uuid('review_id').references(() => reviews.id, { onDelete: 'cascade' }),
    inReplyTo: uuid('in_reply_to'),
    body: text('body').notNull(),
    anchor: jsonb('anchor').$type<CommentAnchor>(),
    resolved: boolean('resolved').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('comments_pull_idx').on(t.pullId)],
);

/**
 * Comments on a commit's design, pinned to a part (by KiCad UUID, so the thread follows the part to later commits)
 * or to an area of the board. Replies point at their thread's first comment.
 */
export const commitComments = pgTable(
  'commit_comments',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    commitSha: text('commit_sha').notNull(),
    authorId: uuid('author_id').notNull().references(() => users.id),
    inReplyTo: uuid('in_reply_to'),
    body: text('body').notNull(),
    anchor: jsonb('anchor').$type<CommentAnchor>(),
    resolved: boolean('resolved').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('commit_comments_repo_path_idx').on(t.repoId, t.path)],
);

export const pullEvents = pgTable(
  'pull_events',
  {
    id: id(),
    pullId: uuid('pull_id').notNull().references(() => pullRequests.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id),
    kind: text('kind').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('pull_events_pull_idx').on(t.pullId)],
);

// ---------- processing ----------

export const checkRuns = pgTable(
  'check_runs',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    name: text('name').notNull(),
    projectPath: text('project_path').notNull().default(''),
    status: checkStatus('status').notNull().default('queued'),
    conclusion: checkConclusion('conclusion'),
    summary: text('summary'),
    details: jsonb('details').$type<CheckDetails>(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('check_runs_unique_idx').on(t.repoId, t.sha, t.name, t.projectPath),
    index('check_runs_sha_idx').on(t.repoId, t.sha),
  ],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    projectPath: text('project_path').notNull().default(''),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('artifacts_sha_idx').on(t.repoId, t.sha),
    uniqueIndex('artifacts_unique_idx').on(t.repoId, t.sha, t.projectPath, t.kind, t.name),
  ],
);

/** Content-addressed cache: semantic diff between two blob ids. */
export const blobDiffs = pgTable(
  'blob_diffs',
  {
    baseOid: text('base_oid').notNull(),
    headOid: text('head_oid').notNull(),
    kind: text('kind').notNull(),
    result: jsonb('result').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.baseOid, t.headOid, t.kind] })],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    /** Owner (user or organization) the event belongs to, for per-organization export. */
    namespaceId: uuid('namespace_id'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_actor_idx').on(t.actorId), index('audit_created_idx').on(t.createdAt), index('audit_namespace_idx').on(t.namespaceId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Namespace = typeof namespaces.$inferSelect;
export type OrgInvite = typeof orgInvites.$inferSelect;
export type Repository = typeof repositories.$inferSelect;
export type PullRequest = typeof pullRequests.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type CommitComment = typeof commitComments.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type CheckRun = typeof checkRuns.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
