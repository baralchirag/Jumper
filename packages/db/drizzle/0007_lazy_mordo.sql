CREATE TABLE "lfs_objects" (
	"repo_id" uuid NOT NULL,
	"oid" text NOT NULL,
	"size" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lfs_objects_repo_id_oid_pk" PRIMARY KEY("repo_id","oid")
);
--> statement-breakpoint
ALTER TABLE "namespaces" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "lfs_objects" ADD CONSTRAINT "lfs_objects_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lfs_objects" ADD CONSTRAINT "lfs_objects_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;