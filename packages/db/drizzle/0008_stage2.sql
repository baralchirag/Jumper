CREATE TYPE "public"."mirror_direction" AS ENUM('pull', 'push');--> statement-breakpoint
CREATE TABLE "release_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"name" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"sha" text NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"prerelease" boolean DEFAULT false NOT NULL,
	"asset_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repo_mirrors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"direction" "mirror_direction" NOT NULL,
	"url" text NOT NULL,
	"username" text,
	"secret" text,
	"overwrite" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_minutes" integer DEFAULT 60 NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"key_type" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "release_assets" ADD CONSTRAINT "release_assets_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_mirrors" ADD CONSTRAINT "repo_mirrors_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_mirrors" ADD CONSTRAINT "repo_mirrors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "release_assets_name_idx" ON "release_assets" USING btree ("release_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "releases_repo_tag_idx" ON "releases" USING btree ("repo_id","tag");--> statement-breakpoint
CREATE INDEX "releases_repo_created_idx" ON "releases" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE INDEX "repo_mirrors_repo_idx" ON "repo_mirrors" USING btree ("repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_keys_fingerprint_idx" ON "ssh_keys" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "ssh_keys_user_idx" ON "ssh_keys" USING btree ("user_id");