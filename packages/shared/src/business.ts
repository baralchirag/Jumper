// Wire types for the retention, business and enterprise features: stock alerts, templates,
// single sign-on, two-factor login, roles, organization policies, invoices, licensing, SCIM, legal hold,
// export control and compliance reports.
import { z } from 'zod';
import { CUSTOM_ROLE_CAPS, REPO_ROLES, type Capability, type RepoRole } from './constants';
import { BILLING_CYCLES, type BillingCycle, type PlanId } from './plans';
import type { Lifecycle, Supplier } from './pricing';
import type { UserSummary } from './schemas';

// ---------- entitlements ----------

/** Features that need the Business plan (hosted) or a licence (self-hosted). */
export const BUSINESS_FEATURES = ['sso', 'custom_roles', 'org_policies', 'audit_export', 'security_policies'] as const;
/** Features that need the Enterprise plan or an enterprise licence. */
export const ENTERPRISE_FEATURES = ['saml', 'scim', 'legal_hold', 'export_control', 'compliance', 'retention'] as const;
export const FEATURES = [...BUSINESS_FEATURES, ...ENTERPRISE_FEATURES] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_LABELS: Record<Feature, string> = {
  sso: 'Single sign-on (Google, Microsoft, OIDC)',
  custom_roles: 'Custom roles',
  org_policies: 'Organization-wide policies',
  audit_export: 'Audit log export',
  security_policies: 'Required two-factor login, IP allowlists, session timeouts',
  saml: 'SAML single sign-on',
  scim: 'SCIM user provisioning',
  legal_hold: 'Legal hold',
  export_control: 'Export-controlled repositories',
  compliance: 'RoHS and REACH reports',
  retention: 'Data retention settings',
};

/** Features included in a hosted plan. */
export function planFeatures(plan: PlanId): Feature[] {
  if (plan === 'enterprise') return [...FEATURES];
  if (plan === 'team') return [...BUSINESS_FEATURES];
  return [];
}

export interface Entitlements {
  /** `plan` on a hosted instance that enforces plans; `license` on a licensed self-hosted one; `development` otherwise. */
  source: 'plan' | 'license' | 'development' | 'none';
  features: Feature[];
  /** Why features are missing, in words for the upgrade notice. */
  reason: string | null;
}

// ---------- licence ----------

export interface LicensePayload {
  /** Licence id, for support. */
  id: string;
  licensee: string;
  /** Host name the instance must be served from (PUBLIC_URL); `*.example.com` allows sub-domains. */
  domain: string;
  /** Active accounts allowed. */
  seats: number;
  /** ISO dates. */
  issued: string;
  expires: string;
  tier: 'business' | 'enterprise';
  /** Extra features beyond the tier, if any. */
  features?: Feature[];
}

export type LicenseState = 'valid' | 'grace' | 'expired' | 'invalid' | 'wrong_domain' | 'missing';

export interface LicenseStatus {
  state: LicenseState;
  /** Human-readable explanation of the state. */
  message: string;
  license: LicensePayload | null;
  seatsUsed: number;
  /** Days until expiry (negative once expired). */
  daysLeft: number | null;
  features: Feature[];
}

// ---------- two-factor login ----------

export const totpCodeSchema = z.object({ code: z.string().trim().min(6).max(20) });

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
  /** Organizations that require two-factor login from their members. */
  requiredBy: string[];
}

export interface TwoFactorSetup {
  /** Base32 secret for manual entry. */
  secret: string;
  /** otpauth:// URI for authenticator apps. */
  uri: string;
}

// ---------- single sign-on ----------

export const SSO_KINDS = ['oidc', 'saml'] as const;
export type SsoKind = (typeof SSO_KINDS)[number];

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Enter a domain such as example.com');

export const ssoConnectionSchema = z.object({
  kind: z.enum(SSO_KINDS),
  name: z.string().trim().min(1).max(60),
  /** OIDC: issuer URL with a /.well-known/openid-configuration document. */
  issuer: z.url({ protocol: /^https?$/ }).max(500).optional(),
  clientId: z.string().trim().max(300).optional(),
  /** Stored encrypted; send an empty string to keep the saved secret. */
  clientSecret: z.string().max(500).optional(),
  /** SAML: the identity provider's sign-in URL, entity id and signing certificate (PEM or bare base64). */
  entryPoint: z.url({ protocol: /^https?$/ }).max(1000).optional(),
  idpIssuer: z.string().trim().max(500).optional(),
  certificate: z.string().trim().max(20_000).optional(),
  /** People whose email is on one of these domains are sent to this connection from the sign-in page. */
  domains: z.array(domainSchema).max(20).default([]),
  /** Members must have signed in through this connection to reach the organization's private work. */
  enforced: z.boolean().default(false),
  /** Create an account for a first-time sign-in (otherwise only existing or SCIM-provisioned accounts may sign in). */
  autoProvision: z.boolean().default(true),
});

export interface SsoConnectionInfo {
  id: string;
  /** Organization slug, or null for an instance-wide connection. */
  org: string | null;
  kind: SsoKind;
  name: string;
  issuer: string | null;
  clientId: string | null;
  hasSecret: boolean;
  entryPoint: string | null;
  idpIssuer: string | null;
  hasCertificate: boolean;
  domains: string[];
  enforced: boolean;
  autoProvision: boolean;
  /** Values to enter at the identity provider. */
  callbackUrl: string;
  /** SAML only: the service-provider entity id and metadata URL. */
  spEntityId: string | null;
  metadataUrl: string | null;
  createdAt: string;
}

/** What the sign-in page needs to show a button. */
export interface SsoProvider {
  id: string;
  name: string;
  kind: SsoKind | 'google' | 'microsoft' | 'github';
  url: string;
}

// ---------- roles ----------

export const customRoleSchema = z.object({
  name: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, 'Use letters, numbers, spaces, dashes and underscores'),
  description: z.string().trim().max(200).default(''),
  /** What the role can do in git and in role checks elsewhere; Admin cannot be customised. */
  base: z.enum(['read', 'review', 'write']),
  capabilities: z.array(z.enum(CUSTOM_ROLE_CAPS)).max(CUSTOM_ROLE_CAPS.length).default([]),
});

export interface CustomRoleInfo {
  id: string;
  name: string;
  description: string;
  base: Exclude<RepoRole, 'admin'>;
  capabilities: Capability[];
  /** People holding the role (organization members and repository collaborators). */
  members: number;
}

/** A built-in role name, or `custom:<id>` for a custom role. */
export const roleRefSchema = z.union([z.enum(REPO_ROLES), z.string().regex(/^custom:[0-9a-f-]{36}$/)]);
export type RoleRef = z.infer<typeof roleRefSchema>;

export interface OrgMemberInfo extends UserSummary {
  role: 'owner' | 'member';
  /** Access a member has to the organization's repositories. */
  repoRole: RepoRole;
  customRole: { id: string; name: string } | null;
  twoFactor: boolean;
  joinedAt: string;
}

// ---------- organization policies ----------

const patternItem = z.object({ pattern: z.string().trim().min(1).max(100), reason: z.string().trim().max(300).default('') });
const cidr = z
  .string()
  .trim()
  .regex(/^(\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|[0-9a-fA-F:]+(\/\d{1,3})?)$/, 'Use an address or CIDR range such as 203.0.113.0/24');

export const orgPolicySchema = z.object({
  /** Checks that must pass before any pull request in the organization is merged, on top of each repository's own. */
  requiredChecks: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  /** Floor for approvals on every pull request. */
  minApprovals: z.number().int().min(0).max(10).default(0),
  /** Sign-off rules applied in every repository: when a changed file matches, the named people must approve. */
  signoffRules: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        pathPattern: z.string().trim().min(1).max(300),
        requiredApprovals: z.number().int().min(1).max(10).default(1),
        approvers: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
      }),
    )
    .max(20)
    .default([]),
  partPolicy: z
    .object({
      approvedManufacturers: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
      bannedParts: z.array(patternItem).max(500).default([]),
      bannedFootprints: z.array(patternItem).max(200).default([]),
    })
    .prefault({}),
  /** Branches that hold released revisions: no deletion, no force-push and no direct push, for admins too. */
  releaseBranches: z.array(z.string().trim().regex(/^[A-Za-z0-9._/*?-]{1,100}$/, 'Use a branch name or a pattern such as release/*')).max(20).default([]),
  /** People who must approve a release before it can be published, and how many of them. */
  releaseApprovers: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  releaseApprovals: z.number().int().min(0).max(10).default(0),
  /** Every share link must carry a watermark; `defaultWatermark` is used when the creator leaves it empty. */
  requireWatermark: z.boolean().default(false),
  defaultWatermark: z.string().trim().max(120).default(''),
  /** Members must have two-factor login switched on to reach private work. */
  requireTwoFactor: z.boolean().default(false),
  /** When not empty, private work is only reachable from these addresses. */
  ipAllowlist: z.array(cidr).max(100).default([]),
  /** Members must sign in again after this many hours; null = the instance default. */
  sessionMaxHours: z.number().int().min(1).max(24 * 90).nullable().default(null),
});
export type OrgPolicy = z.output<typeof orgPolicySchema>;
export const DEFAULT_ORG_POLICY: OrgPolicy = orgPolicySchema.parse({});

/** Why the current session cannot reach an organization's private work, for the notice shown instead. */
export type AccessDenial = 'two_factor' | 'ip' | 'session_age' | 'sso';

// ---------- billing ----------

export const billingProfileSchema = z.object({
  cycle: z.enum(BILLING_CYCLES).default('monthly'),
  email: z.union([z.email(), z.literal('')]).default(''),
  company: z.string().trim().max(200).default(''),
  address: z.string().trim().max(600).default(''),
  taxId: z.string().trim().max(60).default(''),
  /** Purchase-order number printed on invoices. */
  poNumber: z.string().trim().max(60).default(''),
});
export type BillingProfile = z.output<typeof billingProfileSchema>;

export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const invoiceLineSchema = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(100_000),
  unitCents: z.number().int().min(0).max(100_000_000),
});

export const createInvoiceSchema = z.object({
  /** Leave empty to bill the owner's plan for its seats over one period. */
  lines: z.array(invoiceLineSchema).max(50).default([]),
  /** Tax rate in percent. */
  taxPercent: z.number().min(0).max(50).default(0),
  dueInDays: z.number().int().min(0).max(120).default(30),
  notes: z.string().trim().max(1000).default(''),
  status: z.enum(['draft', 'open']).default('open'),
});

export interface InvoiceInfo {
  id: string;
  number: string;
  owner: string;
  status: InvoiceStatus;
  currency: 'USD';
  lines: { description: string; quantity: number; unitCents: number; totalCents: number }[];
  subtotalCents: number;
  taxPercent: number;
  taxCents: number;
  totalCents: number;
  periodStart: string;
  periodEnd: string;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  notes: string;
  billTo: BillingProfile;
  /** Who issued it (the operator of this instance). */
  from: { name: string | null; email: string | null };
}

export interface BillingInfo {
  owner: string;
  plan: PlanId;
  profile: BillingProfile;
  seats: number;
  /** Price of the next period at list price, in cents; null when the plan is quoted individually. */
  nextPeriodCents: number | null;
  cycle: BillingCycle;
  invoices: InvoiceInfo[];
}

// ---------- stock and end-of-life alerts ----------

export const BOM_ALERT_KINDS = ['out_of_stock', 'low_stock', 'eol', 'not_found'] as const;
export type BomAlertKind = (typeof BOM_ALERT_KINDS)[number];

export const bomWatchSchema = z.object({
  enabled: z.boolean(),
  /** Boards per build: a part is low on stock when no supplier can cover this many boards. */
  boards: z.number().int().min(1).max(100_000).default(10),
});

export interface BomAlertInfo {
  id: string;
  kind: BomAlertKind;
  /** Designators, e.g. ["U3"] or ["C1", "C2"]. */
  references: string[];
  value: string;
  mpn: string | null;
  /** What was found, e.g. "0 in stock at LCSC, JLCPCB" or "Marked obsolete by Mouser". */
  detail: string;
  supplier: Supplier | null;
  lifecycle: Lifecycle | null;
  project: string;
  sha: string;
  firstSeenAt: string;
  resolvedAt: string | null;
}

export interface BomWatchInfo {
  enabled: boolean;
  boards: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** False when the instance cannot reach suppliers (pricing switched off, or an air-gapped install). */
  available: boolean;
  alerts: BomAlertInfo[];
}

// ---------- compliance ----------

export type ComplianceStatus = 'compliant' | 'exempt' | 'non_compliant' | 'unknown';

export interface ComplianceLine {
  references: string[];
  value: string;
  footprint: string;
  mpn: string | null;
  manufacturer: string | null;
  rohs: ComplianceStatus;
  reach: ComplianceStatus;
  /** Where each answer came from: a symbol field name, or a supplier. */
  rohsSource: string | null;
  reachSource: string | null;
  /** SVHC substances declared in the BOM, if any. */
  svhc: string | null;
  dnp: boolean;
}

export interface ComplianceReport {
  sha: string;
  project: string;
  generatedAt: string;
  lines: ComplianceLine[];
  summary: Record<'rohs' | 'reach', Record<ComplianceStatus, number>>;
  /** Overall verdicts: compliant only when every fitted part is compliant or exempt. */
  rohs: ComplianceStatus;
  reach: ComplianceStatus;
  /** True when supplier data was used in addition to the fields in the schematic. */
  usedSuppliers: boolean;
}

// ---------- insights ----------

// ---------- templates ----------

export interface RepoTemplateInfo {
  id: string;
  name: string;
  /** e.g. "ESP32-S3-WROOM-1" */
  part: string;
  description: string;
  /** What is on the starting schematic. */
  includes: string[];
}

// ---------- legal hold, export control, retention ----------

export const legalHoldSchema = z.object({
  /** `owner` for everything an owner has, or `owner/repo` for one repository. */
  target: z.string().trim().min(1).max(210),
  reason: z.string().trim().min(3).max(500),
});

export interface LegalHoldInfo {
  id: string;
  target: string;
  scope: 'owner' | 'repository';
  reason: string;
  placedBy: UserSummary | null;
  placedAt: string;
  releasedBy: UserSummary | null;
  releasedAt: string | null;
}

export const retentionSchema = z.object({
  /** Days to keep each kind of record; null = keep forever. The audit log has a floor of 30 days. */
  auditDays: z.number().int().min(30).max(3650).nullable().default(365),
  notificationDays: z.number().int().min(7).max(3650).nullable().default(180),
  webhookDeliveryDays: z.number().int().min(1).max(3650).nullable().default(30),
  /** Generated outputs of commits that are not the tip of a branch, a tag or a release. */
  outputDays: z.number().int().min(7).max(3650).nullable().default(null),
});
export type RetentionSettings = z.output<typeof retentionSchema>;
export const DEFAULT_RETENTION: RetentionSettings = retentionSchema.parse({});

// ---------- release records ----------

// ---------- version ----------

export interface VersionInfo {
  version: string;
  /** Applied database migrations and the number this build expects. */
  migrations: { applied: number; expected: number };
  /** Latest published version, when the update check is on and has run. */
  latest: { version: string; url: string | null; notes: string | null; checkedAt: string } | null;
  updateAvailable: boolean;
  /** Why the update check is off, if it is. */
  updateCheck: 'on' | 'disabled' | 'air_gapped';
  airGapped: boolean;
  node: string;
}

// ---------- SCIM ----------

export interface ScimTokenInfo {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
}
