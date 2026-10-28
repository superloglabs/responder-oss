CREATE TABLE "error_notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"target_key" text NOT NULL,
	"target" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "error_notification_event_target_key" UNIQUE("issue_id","event_key","target_key")
);
--> statement-breakpoint
CREATE TABLE "error_notification_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "error_notification_deliveries" ADD CONSTRAINT "error_notification_deliveries_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_notification_deliveries" ADD CONSTRAINT "error_notification_deliveries_issue_id_error_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."error_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_notification_settings" ADD CONSTRAINT "error_notification_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "error_notification_pending_idx" ON "error_notification_deliveries" USING btree ("status","next_attempt_at");