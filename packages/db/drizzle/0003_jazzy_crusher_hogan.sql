CREATE TABLE "branch_protection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"block_deletion" boolean DEFAULT true NOT NULL,
	"block_force_push" boolean DEFAULT true NOT NULL,
	"require_pull_request" boolean DEFAULT false NOT NULL,
	"enforce_admins" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "branch_protection" ADD CONSTRAINT "branch_protection_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branch_protection_pattern_idx" ON "branch_protection" USING btree ("repo_id","pattern");