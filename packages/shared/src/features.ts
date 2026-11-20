// Wire types for the feature modules (issues, share links, webhooks, review rules, locks, notifications, tools).
import { z } from 'zod';
import type { UserSummary } from './schemas';

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

export const WEBHOOK_EVENTS = ['push', 'check'] as const;
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

// ---------- locks ----------

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
