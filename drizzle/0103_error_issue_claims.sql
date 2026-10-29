CREATE TABLE "error_issue_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" jsonb NOT NULL,
	"message" text,
	"pull_request_url" text,
	"status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_notification_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "error_notification_followup_key" UNIQUE("delivery_id","activity_id")
);
--> statement-breakpoint
ALTER TABLE "error_issues" ADD COLUMN "claim" jsonb;--> statement-breakpoint
ALTER TABLE "error_notification_deliveries" ADD COLUMN "message_timestamp" text;--> statement-breakpoint
ALTER TABLE "error_issue_activities" ADD CONSTRAINT "error_issue_activities_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_issue_activities" ADD CONSTRAINT "error_issue_activities_issue_id_error_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."error_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_notification_followups" ADD CONSTRAINT "error_notification_followups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_notification_followups" ADD CONSTRAINT "error_notification_followups_delivery_id_error_notification_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."error_notification_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_notification_followups" ADD CONSTRAINT "error_notification_followups_activity_id_error_issue_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."error_issue_activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "error_issue_activities_issue_idx" ON "error_issue_activities" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "error_notification_followup_pending_idx" ON "error_notification_followups" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "error_notification_issue_idx" ON "error_notification_deliveries" USING btree ("issue_id");