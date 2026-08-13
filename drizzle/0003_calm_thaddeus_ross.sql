CREATE TABLE "billing_notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"kind" text NOT NULL,
	"destination" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_notification_deliveries" ADD CONSTRAINT "billing_notification_deliveries_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_notification_deliveries" ADD CONSTRAINT "billing_notification_deliveries_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_notification_delivery_target_idx" ON "billing_notification_deliveries" USING btree ("organization_id","period_key","integration_account_id","kind","destination");--> statement-breakpoint
CREATE INDEX "billing_notification_delivery_status_idx" ON "billing_notification_deliveries" USING btree ("organization_id","status");