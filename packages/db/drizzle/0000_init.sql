CREATE TYPE "public"."check_conclusion" AS ENUM('success', 'failure', 'neutral', 'skipped', 'cancelled', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."check_status" AS ENUM('queued', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."namespace_kind" AS ENUM('user', 'org');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."pr_state" AS ENUM('open', 'closed', 'merged');--> statement-breakpoint
CREATE TYPE "public"."repo_role" AS ENUM('read', 'write', 'admin');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('approved', 'changes_requested', 'commented');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"project_path" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blob_diffs" (
	"base_oid" text NOT NULL,
	"head_oid" text NOT NULL,
	"kind" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_diffs_base_oid_head_oid_kind_pk" PRIMARY KEY("base_oid","head_oid","kind")
);
--> statement-breakpoint
CREATE TABLE "check_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"name" text NOT NULL,
	"project_path" text DEFAULT '' NOT NULL,
	"status" "check_status" DEFAULT 'queued' NOT NULL,
	"conclusion" "check_conclusion",
	"summary" text,
	"details" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pull_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"review_id" uuid,
	"in_reply_to" uuid,
	"body" text NOT NULL,
	"anchor" jsonb,
	"resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "namespaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"kind" "namespace_kind" NOT NULL,
	"user_id" uuid,
	"org_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "org_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pull_id" uuid NOT NULL,
	"actor_id" uuid,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"author_id" uuid NOT NULL,
	"base_ref" text NOT NULL,
	"head_ref" text NOT NULL,
	"base_sha" text NOT NULL,
	"head_sha" text NOT NULL,
	"state" "pr_state" DEFAULT 'open' NOT NULL,
	"merge_commit_sha" text,
	"merged_by_id" uuid,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_collaborators" (
	"repo_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "repo_role" DEFAULT 'read' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_collaborators_repo_id_user_id_pk" PRIMARY KEY("repo_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"visibility" "visibility" DEFAULT 'public' NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"required_approvals" integer DEFAULT 0 NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pushed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pull_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"state" "review_state" NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"commit_sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"name" text,
	"bio" text,
	"avatar_url" text,
	"github_id" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_pull_id_pull_requests_id_fk" FOREIGN KEY ("pull_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespaces" ADD CONSTRAINT "namespaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespaces" ADD CONSTRAINT "namespaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_events" ADD CONSTRAINT "pull_events_pull_id_pull_requests_id_fk" FOREIGN KEY ("pull_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_events" ADD CONSTRAINT "pull_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_merged_by_id_users_id_fk" FOREIGN KEY ("merged_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_collaborators" ADD CONSTRAINT "repo_collaborators_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_collaborators" ADD CONSTRAINT "repo_collaborators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_pull_id_pull_requests_id_fk" FOREIGN KEY ("pull_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_sha_idx" ON "artifacts" USING btree ("repo_id","sha");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_unique_idx" ON "artifacts" USING btree ("repo_id","sha","project_path","kind","name");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "check_runs_unique_idx" ON "check_runs" USING btree ("repo_id","sha","name","project_path");--> statement-breakpoint
CREATE INDEX "check_runs_sha_idx" ON "check_runs" USING btree ("repo_id","sha");--> statement-breakpoint
CREATE INDEX "comments_pull_idx" ON "comments" USING btree ("pull_id");--> statement-breakpoint
CREATE UNIQUE INDEX "namespaces_slug_lower_idx" ON "namespaces" USING btree (lower("slug"));--> statement-breakpoint
CREATE UNIQUE INDEX "namespaces_user_idx" ON "namespaces" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "namespaces_org_idx" ON "namespaces" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pat_hash_idx" ON "personal_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "pat_user_idx" ON "personal_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pull_events_pull_idx" ON "pull_events" USING btree ("pull_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_repo_number_idx" ON "pull_requests" USING btree ("repo_id","number");--> statement-breakpoint
CREATE INDEX "pr_repo_state_idx" ON "pull_requests" USING btree ("repo_id","state");--> statement-breakpoint
CREATE INDEX "pr_head_idx" ON "pull_requests" USING btree ("repo_id","head_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_ns_name_lower_idx" ON "repositories" USING btree ("namespace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "repos_search_idx" ON "repositories" USING gin (to_tsvector('simple', "name" || ' ' || "description"));--> statement-breakpoint
CREATE INDEX "reviews_pull_idx" ON "reviews" USING btree ("pull_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_idx" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_github_id_idx" ON "users" USING btree ("github_id");