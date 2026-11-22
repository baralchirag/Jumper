CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "namespaces" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "namespaces" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "namespaces" ADD COLUMN "subscription_status" text;--> statement-breakpoint
ALTER TABLE "namespaces" ADD COLUMN "subscription_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "namespaces" ADD COLUMN "subscription_cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "stripe_invoice_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "hosted_url" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "pdf_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX "namespaces_stripe_customer_idx" ON "namespaces" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_stripe_idx" ON "invoices" USING btree ("stripe_invoice_id");