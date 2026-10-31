export const CHECK_NAMES = ['ERC', 'DRC', 'BOM', 'Render', 'Exports'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export const CHECK_STATUSES = ['queued', 'in_progress', 'completed'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const CHECK_CONCLUSIONS = ['success', 'failure', 'neutral', 'skipped', 'cancelled', 'timed_out'] as const;
export type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number];

export const ARTIFACT_KINDS = [
  'sch_svg',
  'pcb_svg',
  'glb',
  'step',
  'bom',
  'gerbers',
  'erc_report',
  'drc_report',
  'thumbnail',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const REPO_ROLES = ['read', 'write', 'admin'] as const;
export type RepoRole = (typeof REPO_ROLES)[number];

export const ROLE_RANK: Record<RepoRole | 'none', number> = { none: 0, read: 1, write: 2, admin: 3 };

export const PR_STATES = ['open', 'closed', 'merged'] as const;
export type PrState = (typeof PR_STATES)[number];

export const REVIEW_STATES = ['approved', 'changes_requested', 'commented'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const MERGE_METHODS = ['merge', 'squash', 'fast_forward'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export const TOKEN_SCOPES = ['repo:read', 'repo:write', 'admin'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const QUEUE_ANALYZE = 'analyze-commit';
export const EVENTS_CHANNEL = 'pcbhub:events';
