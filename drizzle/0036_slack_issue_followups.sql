CREATE TABLE "slack_investigation_thread_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"investigation_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"thread_timestamp" text NOT NULL,
	"message_timestamp" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_investigation_thread_links" ADD CONSTRAINT "slack_investigation_thread_links_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_investigation_thread_links" ADD CONSTRAINT "slack_investigation_thread_links_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_investigation_thread_links" ADD CONSTRAINT "slack_investigation_thread_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_investigation_thread_links" ADD CONSTRAINT "slack_investigation_thread_links_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_investigation_thread_links_message_idx" ON "slack_investigation_thread_links" USING btree ("integration_account_id","channel_id","message_timestamp");--> statement-breakpoint
CREATE INDEX "slack_investigation_thread_links_thread_idx" ON "slack_investigation_thread_links" USING btree ("integration_account_id","channel_id","thread_timestamp");--> statement-breakpoint
CREATE INDEX "slack_investigation_thread_links_investigation_idx" ON "slack_investigation_thread_links" USING btree ("investigation_id");