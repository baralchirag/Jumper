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
import type { CheckDetails, CommentAnchor } from '@pcbhub/shared';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const namespaceKind = pgEnum('namespace_kind', ['user', 'org']);
export const visibility = pgEnum('visibility', ['public', 'private']);
export const repoRole = pgEnum('repo_role', ['read', 'write', 'admin']);
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
    avatarUrl: text('avatar_url'),
    githubId: text('github_id'),
    isAdmin: boolean('is_admin').notNull().default(false),
    disabled: boolean('disabled').notNull().default(false),
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
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
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
    requiredApprovals: integer('required_approvals').notNull().default(0),
    nextNumber: integer('next_number').notNull().default(1),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
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
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.userId] })],
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
    createdAt: createdAt(),
  },
  (t) => [index('audit_actor_idx').on(t.actorId), index('audit_created_idx').on(t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Namespace = typeof namespaces.$inferSelect;
export type Repository = typeof repositories.$inferSelect;
export type PullRequest = typeof pullRequests.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type CheckRun = typeof checkRuns.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
