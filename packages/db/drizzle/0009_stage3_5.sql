ALTER TYPE "public"."repo_role" ADD VALUE 'review' BEFORE 'write';--> statement-breakpoint
CREATE TABLE "bom_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"project" text DEFAULT '' NOT NULL,
	"sha" text NOT NULL,
	"references" text[] NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"mpn" text,
	"detail" text NOT NULL,
	"supplier" text,
	"lifecycle" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bom_watches" (
	"repo_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"boards" integer DEFAULT 10 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"base" "repo_role" DEFAULT 'read' NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"lines" jsonb NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"tax_basis_points" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL,
	"bill_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace_id" uuid,
	"repo_id" uuid,
	"reason" text NOT NULL,
	"placed_by" uuid,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org_policies" (
	"namespace_id" uuid PRIMARY KEY NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"repo_name" text NOT NULL,
	"tag" text NOT NULL,
	"record" jsonb NOT NULL,
	"digest" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_signoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"enforced" boolean DEFAULT false NOT NULL,
	"auto_provision" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_identities" (
	"connection" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "sso_identities_connection_subject_pk" PRIMARY KEY("connection","subject")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "namespace_id" uuid;--> statement-breakpoint
ALTER TABLE "namespaces" ADD COLUMN "billing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "org_members" ADD COLUMN "repo_role" "repo_role" DEFAULT 'write' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_members" ADD COLUMN "custom_role_id" uuid;--> statement-breakpoint
ALTER TABLE "repo_collaborators" ADD COLUMN "custom_role_id" uuid;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "export_controlled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "sso_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "digest_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_digest_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_codes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "export_cleared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "scim_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "record_digest" text;--> statement-breakpoint
ALTER TABLE "bom_alerts" ADD CONSTRAINT "bom_alerts_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_watches" ADD CONSTRAINT "bom_watches_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_watches" ADD CONSTRAINT "bom_watches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_placed_by_users_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_policies" ADD CONSTRAINT "org_policies_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_policies" ADD CONSTRAINT "org_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_signoffs" ADD CONSTRAINT "release_signoffs_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_signoffs" ADD CONSTRAINT "release_signoffs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bom_alerts_repo_idx" ON "bom_alerts" USING btree ("repo_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bom_alerts_open_idx" ON "bom_alerts" USING btree ("repo_id","key") WHERE "bom_alerts"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_roles_name_idx" ON "custom_roles" USING btree ("namespace_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_idx" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE INDEX "invoices_ns_idx" ON "invoices" USING btree ("namespace_id","created_at");--> statement-breakpoint
CREATE INDEX "legal_holds_ns_idx" ON "legal_holds" USING btree ("namespace_id");--> statement-breakpoint
CREATE INDEX "legal_holds_repo_idx" ON "legal_holds" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "release_records_repo_idx" ON "release_records" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "release_records_digest_idx" ON "release_records" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "release_signoffs_release_idx" ON "release_signoffs" USING btree ("release_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_tokens_hash_idx" ON "scim_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sso_connections_ns_idx" ON "sso_connections" USING btree ("namespace_id");--> statement-breakpoint
CREATE INDEX "sso_identities_user_idx" ON "sso_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_namespace_idx" ON "audit_log" USING btree ("namespace_id","created_at");