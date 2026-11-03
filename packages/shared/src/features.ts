// Wire types for the feature modules (issues, share links, webhooks, review rules, locks, notifications, tools).
import { z } from 'zod';
import type { UserSummary } from './schemas';

// ---------- issues & discussions ----------

export const issueLocationSchema = z.object({
  type: z.enum(['part', 'net', 'location']),
  ref: z.string().min(1).max(200),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  file: z.string().max(1000).optional(),
});

const labelSchema = z.string().trim().min(1).max(40);

export const createIssueSchema = z.object({
  kind: z.enum(['issue', 'discussion']).default('issue'),
  title: z.string().trim().min(1).max(256),
  body: z.string().max(65_536).default(''),
  labels: z.array(labelSchema).max(20).default([]),
  locations: z.array(issueLocationSchema).max(20).default([]),
  assignee: z.string().max(100).nullish(),
  milestoneId: z.uuid().nullish(),
});

export const updateIssueSchema = z.object({
  title: z.string().trim().min(1).max(256).optional(),
  body: z.string().max(65_536).optional(),
  state: z.enum(['open', 'closed']).optional(),
  labels: z.array(labelSchema).max(20).optional(),
  locations: z.array(issueLocationSchema).max(20).optional(),
  assignee: z.string().max(100).nullable().optional(),
  milestoneId: z.uuid().nullable().optional(),
});

export const milestoneInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(''),
  dueOn: z.iso.datetime().nullish(),
});

export interface IssueInfo {
  id: string;
  number: number;
  kind: 'issue' | 'discussion';
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: UserSummary;
  assignee: UserSummary | null;
  milestone: { id: string; title: string } | null;
  labels: string[];
  locations: z.infer<typeof issueLocationSchema>[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface IssueCommentInfo {
  id: string;
  author: UserSummary;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface MilestoneInfo {
  id: string;
  title: string;
  description: string;
  dueOn: string | null;
  state: 'open' | 'closed';
  openIssues: number;
  closedIssues: number;
}

// ---------- share links ----------

export const createShareLinkSchema = z.object({
  label: z.string().trim().max(120).default(''),
  ref: z.string().min(1).max(255),
  path: z.string().max(4096).nullish(),
  canDownload: z.boolean().default(false),
  watermark: z.string().trim().max(120).nullish(),
  /** Lifetime in hours; null = never expires. */
  expiresInHours: z.number().int().min(1).max(24 * 365).nullable().default(24 * 7),
});

export interface ShareLinkInfo {
  id: string;
  label: string;
  ref: string;
  path: string | null;
  canDownload: boolean;
  watermark: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
  createdBy: UserSummary;
  active: boolean;
}

// ---------- webhooks ----------

export const WEBHOOK_EVENTS = ['push', 'pull_request', 'check', 'issues', 'issue_comment'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const createWebhookSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length).default([...WEBHOOK_EVENTS]),
  /** Optional; generated when omitted. */
  secret: z.string().min(16).max(200).optional(),
  active: z.boolean().default(true),
});

export interface WebhookInfo {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  createdAt: string;
  lastDelivery: { status: number | null; error: string | null; at: string } | null;
}

export interface WebhookDeliveryInfo {
  id: string;
  event: string;
  status: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

// ---------- review rules ----------

export const approvalRuleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  pathPattern: z.string().trim().min(1).max(300),
  requiredApprovals: z.number().int().min(1).max(20).default(1),
  approvers: z.array(z.string().max(100)).max(50).default([]),
});

export interface ApprovalRuleInfo {
  id: string;
  name: string;
  pathPattern: string;
  requiredApprovals: number;
  approvers: UserSummary[];
}

export interface ChecklistItemInfo {
  id: string;
  text: string;
  done: boolean;
  doneBy: UserSummary | null;
  doneAt: string | null;
}

// ---------- locks ----------

export const regionSchema = z
  .object({ minX: z.number().finite(), minY: z.number().finite(), maxX: z.number().finite(), maxY: z.number().finite() })
  .refine((r) => r.maxX > r.minX && r.maxY > r.minY, 'Region must have a positive area');

export const createLockSchema = z.object({
  path: z.string().min(1).max(4096),
  region: regionSchema.nullish(),
  reason: z.string().trim().max(300).default(''),
  ttlMinutes: z.number().int().min(1).max(7 * 24 * 60).default(120),
});

export interface LockInfo {
  id: string;
  path: string;
  region: { minX: number; minY: number; maxX: number; maxY: number } | null;
  reason: string;
  lockedBy: UserSummary;
  expiresAt: string;
  createdAt: string;
}

// ---------- repo config ----------

export const repoConfigSchema = z.object({
  fabProfiles: z.array(z.string().max(40)).max(10).default([]),
  checklistTemplate: z.array(z.string().trim().min(1).max(300)).max(40).default([]),
  requireChecklist: z.boolean().default(false),
  partPolicy: z
    .object({
      approvedManufacturers: z.array(z.string().max(100)).max(200).default([]),
      preferredParts: z.array(z.string().max(100)).max(500).default([]),
      bannedParts: z.array(z.object({ pattern: z.string().min(1).max(100), reason: z.string().max(300).default('') })).max(500).default([]),
      bannedFootprints: z.array(z.object({ pattern: z.string().min(1).max(100), reason: z.string().max(300).default('') })).max(200).default([]),
    })
    .default({ approvedManufacturers: [], preferredParts: [], bannedParts: [], bannedFootprints: [] }),
  stackups: z
    .record(
      z.string().max(1000),
      z.object({
        name: z.string().max(120),
        layers: z.array(z.object({ name: z.string().max(60), thicknessMm: z.number().positive().max(50), er: z.number().min(1).max(100).optional() })).max(64),
        notes: z.string().max(2000).optional(),
      }),
    )
    .default({}),
});

// ---------- notifications ----------

export interface NotificationInfo {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  repo: string | null;
  actor: UserSummary | null;
  read: boolean;
  createdAt: string;
}
