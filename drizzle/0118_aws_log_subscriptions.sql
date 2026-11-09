CREATE TABLE "aws_log_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"aws_account_id" text NOT NULL,
	"region" text NOT NULL,
	"filter_pattern" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"applied_at" timestamp with time zone,
	"claimed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aws_log_subscriptions_status_check" CHECK ("aws_log_subscriptions"."status" IN ('pending', 'active', 'failed', 'removing'))
);
--> statement-breakpoint
ALTER TABLE "aws_log_subscriptions" ADD CONSTRAINT "aws_log_subscriptions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aws_log_subscriptions" ADD CONSTRAINT "aws_log_subscriptions_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aws_log_subscriptions_account_region_idx" ON "aws_log_subscriptions" USING btree ("aws_account_id","region");--> statement-breakpoint
CREATE INDEX "aws_log_subscriptions_integration_account_idx" ON "aws_log_subscriptions" USING btree ("integration_account_id");--> statement-breakpoint
CREATE INDEX "aws_log_subscriptions_status_idx" ON "aws_log_subscriptions" USING btree ("status") WHERE "aws_log_subscriptions"."status" <> 'active';