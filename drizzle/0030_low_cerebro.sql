CREATE TABLE "issue_pull_request_slack_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"message_timestamp" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_pull_request_slack_messages" ADD CONSTRAINT "issue_pull_request_slack_messages_request_id_issue_pull_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."issue_pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_pull_request_slack_messages" ADD CONSTRAINT "issue_pull_request_slack_messages_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_pull_request_slack_messages_message_idx" ON "issue_pull_request_slack_messages" USING btree ("request_id","integration_account_id","channel_id","message_timestamp");--> statement-breakpoint
CREATE INDEX "issue_pull_request_slack_messages_request_idx" ON "issue_pull_request_slack_messages" USING btree ("request_id");