ALTER TABLE "invoices" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stripe_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "invoices" CASCADE;--> statement-breakpoint
DROP TABLE "stripe_events" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_referred_by_users_id_fk";
--> statement-breakpoint
DROP INDEX "namespaces_stripe_customer_idx";--> statement-breakpoint
ALTER TABLE "namespaces" DROP COLUMN "plan";--> statement-breakpoint
ALTER TABLE "namespaces" DROP COLUMN "billing";--> statement-breakpoint
ALTER TABLE "namespaces" DROP COLUMN "stripe_customer_id";--> statement-breakpoint
ALTER TABLE "namespaces" DROP COLUMN "stripe_subscription_id";--> statement-breakpoint
ALTER TABLE "namespaces" DROP COLUMN "subscription_status";--> statement-breakpoint
ALTER TABLE "namespaces" DROP COLUMN "subscription_started_at";--> statement-breakpoint
ALTER TABLE "namespaces" DROP COLUMN "subscription_period_end";--> statement-breakpoint
ALTER TABLE "namespaces" DROP COLUMN "subscription_cancel_at_period_end";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "referred_by";