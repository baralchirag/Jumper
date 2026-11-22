import { resolveDataPath } from '@jumper/shared/node';
import { resolvePlans, type Plan, type PlanId } from '@jumper/shared';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PUBLIC_URL: z.url().default('http://localhost:5173'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REPOS_DIR: z.string().default('./data/repos'),
  MAX_PUSH_BYTES: z.coerce.number().int().default(500 * 1024 * 1024),
  MAX_VIEW_BYTES: z.coerce.number().int().default(64 * 1024 * 1024),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  TRUST_PROXY: z.stringbool().default(false),
  AUTO_MIGRATE: z.stringbool().default(true),
  /** `inline` runs the KiCad core on the main thread instead of worker threads (tests only). */
  KICAD_POOL: z.enum(['threads', 'inline']).default('threads'),
  /** e.g. smtps://user:pass@smtp.example.com:465 or smtp://localhost:1025. Without it, emails are logged instead of sent. */
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  /** Block writes from accounts whose email is unverified. Defaults to on when SMTP is configured (otherwise nobody could verify). */
  REQUIRE_VERIFIED_EMAIL: z.stringbool().optional(),
  /** Largest repository an import may bring in, in MB, and how long a single import may run. */
  IMPORT_MAX_MB: z.coerce.number().int().min(1).default(1024),
  IMPORT_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(300_000),
  ALLOW_SIGNUP: z.stringbool().default(true),
  /** Comma-separated IPs allowed to reach /api/admin (empty = any IP, still admin-session only). */
  /** Allow webhooks to reach private/loopback addresses (development only; leave off in production). */
  WEBHOOK_ALLOW_PRIVATE_NETWORKS: z.stringbool().default(false),
  ADMIN_ALLOWED_IPS: z.string().default(''),
  /** Live supplier pricing for BOMs (LCSC/JLCPCB need no keys). */
  PRICING_ENABLED: z.stringbool().default(true),
  MOUSER_API_KEY: z.string().optional(),
  DIGIKEY_CLIENT_ID: z.string().optional(),
  DIGIKEY_CLIENT_SECRET: z.string().optional(),
  /** Run scheduled jobs (housekeeping, digests, stock alerts) in this API process. Safe with several instances. */
  SCHEDULER_ENABLED: z.stringbool().default(true),
  /** Security-log entries older than this are deleted. */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(365),
  /** Card payments with Stripe. Both keys are needed; without them plans are assigned by hand and invoiced. */
  STRIPE_SECRET_KEY: z.string().startsWith('sk_').or(z.string().startsWith('rk_')).optional(),
  /** Signing secret of the webhook endpoint at /api/stripe/webhook (whsec_…). */
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
  /** Let Stripe Tax calculate sales tax / VAT at checkout. Needs Stripe Tax set up in the Stripe dashboard. */
  STRIPE_AUTOMATIC_TAX: z.stringbool().default(false),
  /** Tests only: send Stripe API calls to this base URL (a fake server) instead of api.stripe.com. */
  STRIPE_API_BASE: z.url().optional(),
  /** Enforce plan limits (storage, check minutes, seats). Off by default: self-hosted instances are unlimited. */
  PLANS_ENFORCED: z.stringbool().default(false),
  /** Serve the interactive OpenAPI explorer at /api/docs. Off by default: it lists every endpoint, internal ones included. */
  API_DOCS: z.stringbool().default(false),
  /** JSON overrides for plan limits, e.g. {"free":{"storageMb":5120,"checkMinutes":1000}}. */
  PLAN_LIMITS: z.string().optional(),
  /** Who runs this instance, shown on the terms, privacy and refund pages. */
  OPERATOR_NAME: z.string().optional(),
  OPERATOR_EMAIL: z.email().optional(),
  /** Governing law for the terms, e.g. "England and Wales" or "the State of Delaware, USA". */
  OPERATOR_JURISDICTION: z.string().optional(),
  /** Date the legal pages were last changed (YYYY-MM-DD). */
  LEGAL_UPDATED: z.iso.date().optional(),
  /** Encrypts stored credentials (mirror tokens). Without it a random key is created in SECRET_KEY_FILE. */
  SECRET_KEY: z.string().min(16).optional(),
  SECRET_KEY_FILE: z.string().default('./data/secret.key'),
  /** Shortest interval an owner may set for a pull mirror, in minutes. */
  MIRROR_MIN_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(10),
  /** Built-in SSH server for git push/pull over SSH. */
  SSH_ENABLED: z.stringbool().default(false),
  SSH_HOST: z.string().default('0.0.0.0'),
  SSH_PORT: z.coerce.number().int().default(2222),
  /** Port shown in clone URLs when a proxy or NAT maps it (e.g. 22). Defaults to SSH_PORT. */
  SSH_PUBLIC_PORT: z.coerce.number().int().optional(),
  /** Host name shown in SSH clone URLs. Defaults to the host of PUBLIC_URL. */
  SSH_PUBLIC_HOST: z.string().optional(),
  /** PEM host key. Generated on first start when missing. */
  SSH_HOST_KEY_FILE: z.string().default('./data/ssh_host_ed25519_key'),
  /** Largest single Git LFS object, in MB. */
  LFS_MAX_OBJECT_MB: z.coerce.number().int().min(1).default(2048),
  /** Sign in with Google / Microsoft for the whole instance (OpenID Connect). */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  /** Entra ID tenant: `common`, `organizations`, or a tenant id to accept only your own directory. */
  MICROSOFT_TENANT: z.string().default('common'),
  /** Sessions end this many hours after sign-in, whatever the activity. Unset = 30 days, sliding. */
  SESSION_MAX_HOURS: z.coerce.number().int().min(1).optional(),
  /** Licence key for the business and enterprise features of a self-hosted instance (or put it in LICENSE_FILE, or paste it in Admin). */
  LICENSE_KEY: z.string().optional(),
  LICENSE_FILE: z.string().default('./data/license.key'),
  /** Require a licence for business and enterprise features. Defaults to on in production. */
  LICENSE_ENFORCED: z.stringbool().optional(),
  /** Tests only: verify licences against this key instead of the built-in one. Ignored in production. */
  LICENSE_PUBLIC_KEY: z.string().optional(),
  /**
   * The instance may not contact anything outside your network on its own: no supplier pricing, stock alerts,
   * update check or sign-in with public providers. Mirrors, imports and webhooks still go where you point them.
   */
  AIR_GAPPED: z.stringbool().default(false),
  /** Ask UPDATE_CHECK_URL once a day whether a newer version exists. Nothing about the instance is sent. */
  UPDATE_CHECK: z.stringbool().default(true),
  UPDATE_CHECK_URL: z.url().optional(),
  /** Weekly summary emails and scheduled stock checks (both also need the scheduler). */
  DIGEST_ENABLED: z.stringbool().default(true),
  STOCK_ALERTS_ENABLED: z.stringbool().default(true),
  /**
   * Where the "Order from ..." buttons next to fab packages point. Set these to your referral or partner links to earn
   * credit for orders; the interface marks them as referral links. Unset, each goes to the fab's own upload page.
   */
  FAB_REFERRAL_JLCPCB: z.url().optional(),
  FAB_REFERRAL_PCBWAY: z.url().optional(),
  FAB_REFERRAL_OSHPARK: z.url().optional(),
  /** Storage added to a person's plan for each account that signs up with their invite link (0 turns it off), and the cap. */
  REFERRAL_BONUS_MB: z.coerce.number().int().min(0).default(1024),
  REFERRAL_MAX_BONUS_MB: z.coerce.number().int().min(0).default(10_240),
  /** How long each invite bonus lasts, counted from the day the invited person joined. */
  REFERRAL_BONUS_DAYS: z.coerce.number().int().min(1).default(15),
  /** The Free plan's storage is a trial: it lasts this many days from when the account or organization was created. */
  FREE_TRIAL_DAYS: z.coerce.number().int().min(0).default(30),
  /** Free-plan storage once the trial is over (MB). 0: pushes that add data need a paid plan; nothing is deleted. */
  FREE_STORAGE_AFTER_TRIAL_MB: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.output<typeof envSchema> & { reposDir: string; secureCookies: boolean; adminAllowedIps: string[]; emailVerificationRequired: boolean; plans: Record<PlanId, Plan>; secretKeyFile: string; sshHostKeyFile: string; licenseFile: string; licenseEnforced: boolean };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  return {
    ...env,
    reposDir: resolveDataPath(env.REPOS_DIR),
    secretKeyFile: resolveDataPath(env.SECRET_KEY_FILE),
    sshHostKeyFile: resolveDataPath(env.SSH_HOST_KEY_FILE),
    licenseFile: resolveDataPath(env.LICENSE_FILE),
    licenseEnforced: env.LICENSE_ENFORCED ?? env.NODE_ENV === 'production',
    secureCookies: env.PUBLIC_URL.startsWith('https://'),
    emailVerificationRequired: env.REQUIRE_VERIFIED_EMAIL ?? Boolean(env.SMTP_URL),
    adminAllowedIps: env.ADMIN_ALLOWED_IPS.split(',').map((x) => x.trim()).filter(Boolean),
    plans: resolvePlans(parsePlanLimits(env.PLAN_LIMITS)),
  };
}

function parsePlanLimits(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('PLAN_LIMITS must be JSON, e.g. {"free":{"storageMb":5120}}');
  }
}
