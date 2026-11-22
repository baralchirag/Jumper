// Tables for the feature modules (share links, webhooks, issues, discussions, approval rules, ...).
// Kept apart from schema.ts so each feature's storage is easy to find; both are exported from the package index.
import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { namespaces, pullRequests, repoRole, repositories, users } from './schema';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const issueKind = pgEnum('issue_kind', ['issue', 'discussion']);
export const issueState = pgEnum('issue_state', ['open', 'closed']);

export interface IssueLocation {
  type: 'part' | 'net' | 'location';
  ref: string;
  /** Board coordinates in mm for type=location. */
  x?: number;
  y?: number;
  file?: string;
}

export interface Region {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// ---------- share links ----------

export const shareLinks = pgTable(
  'share_links',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the token; the token itself is shown once at creation. */
    tokenHash: text('token_hash').notNull(),
    label: text('label').notNull().default(''),
    ref: text('ref').notNull(),
    /** Restrict the link to one file or folder; null = whole repository at `ref`. */
    path: text('path'),
    canDownload: boolean('can_download').notNull().default(false),
    /** Text overlaid on shared renders (e.g. "Confidential — ACME"). */
    watermark: text('watermark'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('share_links_hash_idx').on(t.tokenHash), index('share_links_repo_idx').on(t.repoId)],
);

// ---------- webhooks ----------

export const webhooks = pgTable(
  'webhooks',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** HMAC key for the X-Jumper-Signature-256 header. Never returned by the API after creation. */
    secret: text('secret').notNull(),
    events: text('events').array().notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('webhooks_repo_idx').on(t.repoId)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    webhookId: uuid('webhook_id').notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: integer('status'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [index('webhook_deliveries_hook_idx').on(t.webhookId, t.createdAt)],
);

// ---------- issues, discussions, milestones ----------

export const milestones = pgTable(
  'milestones',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    dueOn: timestamp('due_on', { withTimezone: true }),
    state: issueState('state').notNull().default('open'),
    createdAt: createdAt(),
  },
  (t) => [index('milestones_repo_idx').on(t.repoId), uniqueIndex('milestones_title_idx').on(t.repoId, sql`lower(${t.title})`)],
);

export const issues = pgTable(
  'issues',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    /** Shares the per-repo counter with pull requests. */
    number: integer('number').notNull(),
    kind: issueKind('kind').notNull().default('issue'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    authorId: uuid('author_id').notNull().references(() => users.id),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    milestoneId: uuid('milestone_id').references(() => milestones.id, { onDelete: 'set null' }),
    state: issueState('state').notNull().default('open'),
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    locations: jsonb('locations').$type<IssueLocation[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('issues_repo_number_idx').on(t.repoId, t.number),
    index('issues_repo_state_idx').on(t.repoId, t.kind, t.state),
    index('issues_search_idx').using('gin', sql`to_tsvector('simple', ${t.title} || ' ' || ${t.body})`),
  ],
);

export const issueComments = pgTable(
  'issue_comments',
  {
    id: id(),
    issueId: uuid('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').notNull().references(() => users.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('issue_comments_issue_idx').on(t.issueId)],
);

// ---------- review process ----------

export const approvalRules = pgTable(
  'approval_rules',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    /** e.g. "Power sign-off". */
    name: text('name').notNull(),
    /** Glob over changed file paths (`power/**`, `*.kicad_pcb`). The rule applies when any changed file matches. */
    pathPattern: text('path_pattern').notNull(),
    requiredApprovals: integer('required_approvals').notNull().default(1),
    /** Only these users' approvals count; empty = any user with write access. */
    approverIds: uuid('approver_ids').array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
  },
  (t) => [index('approval_rules_repo_idx').on(t.repoId)],
);

export const checklistItems = pgTable(
  'checklist_items',
  {
    id: id(),
    pullId: uuid('pull_id').notNull().references(() => pullRequests.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    text: text('text').notNull(),
    doneBy: uuid('done_by').references(() => users.id, { onDelete: 'set null' }),
    doneAt: timestamp('done_at', { withTimezone: true }),
  },
  (t) => [index('checklist_items_pull_idx').on(t.pullId)],
);

// ---------- per-repo configuration ----------

export interface RepoConfig {
  /** Fab profile ids a PR must satisfy. */
  fabProfiles: string[];
  /** Checklist copied onto every new pull request. */
  checklistTemplate: string[];
  /** Saved stackups keyed by project path. */
  stackups: Record<string, { name: string; layers: { name: string; thicknessMm: number; er?: number }[]; notes?: string }>;
  /** Approved/banned parts. */
  partPolicy: {
    approvedManufacturers: string[];
    preferredParts: string[];
    bannedParts: { pattern: string; reason: string }[];
    bannedFootprints: { pattern: string; reason: string }[];
  };
  /** Block merges while required checklist items are open. */
  requireChecklist: boolean;
}

export const repoConfig = pgTable('repo_config', {
  repoId: uuid('repo_id').primaryKey().references(() => repositories.id, { onDelete: 'cascade' }),
  config: jsonb('config').$type<Partial<RepoConfig>>().notNull().default({}),
  updatedAt: updatedAt(),
});

// ---------- locking ----------

export const fileLocks = pgTable(
  'file_locks',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    /** Board region in mm; null locks the whole file. */
    region: jsonb('region').$type<Region>(),
    lockedBy: uuid('locked_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull().default(''),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('file_locks_repo_path_idx').on(t.repoId, t.path)],
);

// ---------- branch protection ----------

export const branchProtection = pgTable(
  'branch_protection',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    /** Shell-style glob over branch names: `main`, `release/*`. */
    pattern: text('pattern').notNull(),
    blockDeletion: boolean('block_deletion').notNull().default(true),
    blockForcePush: boolean('block_force_push').notNull().default(true),
    /** Direct pushes are refused; changes must arrive through a merged pull request. */
    requirePullRequest: boolean('require_pull_request').notNull().default(false),
    /** Apply the rule to repository admins too. */
    enforceAdmins: boolean('enforce_admins').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('branch_protection_pattern_idx').on(t.repoId, t.pattern)],
);

// ---------- password reset ----------

export const passwordResets = pgTable(
  'password_resets',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the emailed token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('password_resets_hash_idx').on(t.tokenHash), index('password_resets_user_idx').on(t.userId)],
);

// ---------- email verification ----------

export const emailVerifications = pgTable(
  'email_verifications',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** The address being verified: changing your email later does not verify the old token's address. */
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('email_verifications_hash_idx').on(t.tokenHash), index('email_verifications_user_idx').on(t.userId)],
);

// ---------- notifications ----------

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repositories.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    url: text('url'),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt, t.createdAt)],
);

export const repoFollows = pgTable(
  'repo_follows',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.repoId] })],
);

// ---------- Git LFS ----------

/** Large files stored through Git LFS, per repository (objects are content-addressed by sha256). */
export const lfsObjects = pgTable(
  'lfs_objects',
  {
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    /** Lower-case hex sha256 of the content. */
    oid: text('oid').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.oid] })],
);

// ---------- mirroring ----------

export const mirrorDirection = pgEnum('mirror_direction', ['pull', 'push']);

/**
 * Keeps a repository in step with a copy on another host (GitHub, GitLab, ...). A pull mirror fetches from the remote on
 * a schedule; a push mirror sends every change here to the remote. One of each on the same repository is a two-way
 * mirror: both sides only fast-forward unless `overwrite` is set, so divergent histories are reported, never lost.
 */
export const repoMirrors = pgTable(
  'repo_mirrors',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    direction: mirrorDirection('direction').notNull(),
    /** Remote URL without credentials. */
    url: text('url').notNull(),
    username: text('username'),
    /** Access token encrypted with the server secret (AES-256-GCM); never returned by the API. */
    secret: text('secret'),
    /** Pull: replace local branches with the remote's. Push: force-push. Off = fast-forward only. */
    overwrite: boolean('overwrite').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    intervalMinutes: integer('interval_minutes').notNull().default(60),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('repo_mirrors_repo_idx').on(t.repoId)],
);

// ---------- SSH keys ----------

export const sshKeys = pgTable(
  'ssh_keys',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** e.g. ssh-ed25519 */
    keyType: text('key_type').notNull(),
    /** Base64 key blob as it appears in authorized_keys. */
    publicKey: text('public_key').notNull(),
    /** OpenSSH-style SHA256:... fingerprint. */
    fingerprint: text('fingerprint').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ssh_keys_fingerprint_idx').on(t.fingerprint), index('ssh_keys_user_idx').on(t.userId)],
);

// ---------- releases ----------

export const releases = pgTable(
  'releases',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    name: text('name').notNull(),
    body: text('body').notNull().default(''),
    /** Commit the tag pointed at when the release was made. */
    sha: text('sha').notNull(),
    draft: boolean('draft').notNull().default(false),
    prerelease: boolean('prerelease').notNull().default(false),
    /** Generated files requested at creation; ones not built yet are attached when the revision's checks finish. */
    assetKinds: text('asset_kinds').array().notNull().default(sql`'{}'::text[]`),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Digest of the signed release record written when the release was published (see release_records). */
    recordDigest: text('record_digest'),
    createdAt: createdAt(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('releases_repo_tag_idx').on(t.repoId, t.tag), index('releases_repo_created_idx').on(t.repoId, t.createdAt)],
);

export const releaseAssets = pgTable(
  'release_assets',
  {
    id: id(),
    releaseId: uuid('release_id').notNull().references(() => releases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** gerbers | bom | step | jlcpcb | pcbway | oshpark | upload | ... */
    kind: text('kind').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    storageKey: text('storage_key').notNull(),
    downloadCount: integer('download_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('release_assets_name_idx').on(t.releaseId, t.name)],
);

// ---------- release approval and records ----------

/** A named person's decision on a release. Rows are never updated: a changed mind is a new row. */
export const releaseSignoffs = pgTable(
  'release_signoffs',
  {
    id: id(),
    releaseId: uuid('release_id').notNull().references(() => releases.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id),
    decision: text('decision').$type<'approved' | 'rejected'>().notNull(),
    comment: text('comment').notNull().default(''),
    /** Commit the release pointed at when the decision was made. */
    sha: text('sha').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('release_signoffs_release_idx').on(t.releaseId, t.createdAt)],
);

/**
 * The record of a published release: who made it, what was checked, who approved. Kept apart from `releases` and
 * without a cascade, so deleting a release leaves its record. Each record carries the digest of the one before it.
 */
export const releaseRecords = pgTable(
  'release_records',
  {
    id: id(),
    repoId: uuid('repo_id').notNull(),
    /** Repository name at the time, since the repository row may be gone later. */
    repoName: text('repo_name').notNull(),
    tag: text('tag').notNull(),
    record: jsonb('record').$type<Record<string, unknown>>().notNull(),
    digest: text('digest').notNull(),
    signature: text('signature').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('release_records_repo_idx').on(t.repoId, t.createdAt), uniqueIndex('release_records_digest_idx').on(t.digest)],
);

// ---------- roles and organization policies ----------

export const customRoles = pgTable(
  'custom_roles',
  {
    id: id(),
    namespaceId: uuid('namespace_id').notNull().references(() => namespaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Rank used by git and by plain role checks. */
    base: repoRole('base').notNull().default('read'),
    /** Capabilities from @jumper/shared CUSTOM_ROLE_CAPS. */
    capabilities: text('capabilities').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('custom_roles_name_idx').on(t.namespaceId, sql`lower(${t.name})`)],
);

/** Organization-wide rules (OrgPolicy from @jumper/shared), one row per owner. */
export const orgPolicies = pgTable('org_policies', {
  namespaceId: uuid('namespace_id').primaryKey().references(() => namespaces.id, { onDelete: 'cascade' }),
  policy: jsonb('policy').$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

// ---------- single sign-on ----------

export interface SsoConfig {
  issuer?: string;
  clientId?: string;
  /** Encrypted with the server key. */
  clientSecret?: string;
  entryPoint?: string;
  idpIssuer?: string;
  certificate?: string;
}

export const ssoConnections = pgTable(
  'sso_connections',
  {
    id: id(),
    /** Organization the connection belongs to; null = the whole instance. */
    namespaceId: uuid('namespace_id').references(() => namespaces.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'oidc' | 'saml'>().notNull(),
    name: text('name').notNull(),
    config: jsonb('config').$type<SsoConfig>().notNull().default({}),
    domains: text('domains').array().notNull().default(sql`'{}'::text[]`),
    enforced: boolean('enforced').notNull().default(false),
    autoProvision: boolean('auto_provision').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('sso_connections_ns_idx').on(t.namespaceId)],
);

/** Links a directory identity to an account. `connection` is a connection id, or `google` / `microsoft`. */
export const ssoIdentities = pgTable(
  'sso_identities',
  {
    connection: text('connection').notNull(),
    subject: text('subject').notNull(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    email: text('email'),
    createdAt: createdAt(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.connection, t.subject] }), index('sso_identities_user_idx').on(t.userId)],
);

// ---------- invoices ----------

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    namespaceId: uuid('namespace_id').notNull().references(() => namespaces.id, { onDelete: 'cascade' }),
    /** e.g. INV-2026-0042; unique across the instance. */
    number: text('number').notNull(),
    status: text('status').$type<'draft' | 'open' | 'paid' | 'void'>().notNull().default('open'),
    lines: jsonb('lines').$type<{ description: string; quantity: number; unitCents: number }[]>().notNull(),
    subtotalCents: integer('subtotal_cents').notNull(),
    taxPercent: integer('tax_basis_points').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    notes: text('notes').notNull().default(''),
    /** Billing details copied at issue time, so later edits do not change old invoices. */
    billTo: jsonb('bill_to').$type<Record<string, string>>().notNull().default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Set for invoices raised by Stripe for a card subscription (mirrored from webhooks). */
    stripeInvoiceId: text('stripe_invoice_id'),
    /** Stripe's hosted page for paying or viewing the invoice, and its PDF. */
    hostedUrl: text('hosted_url'),
    pdfUrl: text('pdf_url'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('invoices_number_idx').on(t.number), index('invoices_ns_idx').on(t.namespaceId, t.createdAt), uniqueIndex('invoices_stripe_idx').on(t.stripeInvoiceId)],
);

/** Stripe webhook events already applied, so a redelivered event is not applied twice. */
export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  createdAt: createdAt(),
});

// ---------- stock and end-of-life alerts ----------

export const bomWatches = pgTable('bom_watches', {
  repoId: uuid('repo_id').primaryKey().references(() => repositories.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  boards: integer('boards').notNull().default(10),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export const bomAlerts = pgTable(
  'bom_alerts',
  {
    id: id(),
    repoId: uuid('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    /** Stable identity of the problem: kind + project + part, so a check that finds it again does not re-alert. */
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    project: text('project').notNull().default(''),
    sha: text('sha').notNull(),
    references: text('references').array().notNull(),
    value: text('value').notNull().default(''),
    mpn: text('mpn'),
    detail: text('detail').notNull(),
    supplier: text('supplier'),
    lifecycle: text('lifecycle'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('bom_alerts_repo_idx').on(t.repoId, t.resolvedAt), uniqueIndex('bom_alerts_open_idx').on(t.repoId, t.key).where(sql`${t.resolvedAt} is null`)],
);

// ---------- legal hold, instance settings, SCIM ----------

export const legalHolds = pgTable(
  'legal_holds',
  {
    id: id(),
    /** Exactly one of these is set: an owner (everything they have) or one repository. */
    namespaceId: uuid('namespace_id').references(() => namespaces.id, { onDelete: 'restrict' }),
    repoId: uuid('repo_id').references(() => repositories.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    placedBy: uuid('placed_by').references(() => users.id, { onDelete: 'set null' }),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
    releasedBy: uuid('released_by').references(() => users.id, { onDelete: 'set null' }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [index('legal_holds_ns_idx').on(t.namespaceId), index('legal_holds_repo_idx').on(t.repoId)],
);

/** Settings an administrator changes at run time (retention, the result of the update check, ...). */
export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: updatedAt(),
});

export const scimTokens = pgTable(
  'scim_tokens',
  {
    id: id(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('scim_tokens_hash_idx').on(t.tokenHash)],
);

export type CustomRole = typeof customRoles.$inferSelect;
export type SsoConnection = typeof ssoConnections.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type BomAlert = typeof bomAlerts.$inferSelect;
export type LegalHold = typeof legalHolds.$inferSelect;
export type LfsObject = typeof lfsObjects.$inferSelect;
export type RepoMirror = typeof repoMirrors.$inferSelect;
export type SshKey = typeof sshKeys.$inferSelect;
export type Release = typeof releases.$inferSelect;
export type ReleaseAsset = typeof releaseAssets.$inferSelect;
export type BranchProtection = typeof branchProtection.$inferSelect;
export type ShareLink = typeof shareLinks.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type IssueComment = typeof issueComments.$inferSelect;
export type Milestone = typeof milestones.$inferSelect;
export type ApprovalRule = typeof approvalRules.$inferSelect;
export type FileLock = typeof fileLocks.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
