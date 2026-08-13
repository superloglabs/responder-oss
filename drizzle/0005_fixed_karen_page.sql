CREATE TABLE "issue_pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"investigation_id" uuid NOT NULL,
	"agent_config_version_id" uuid NOT NULL,
	"repository_full_name" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"branch" text,
	"pull_request_number" integer,
	"pull_request_url" text,
	"eve_session_id" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD COLUMN "pr_mode_policy" text DEFAULT 'disabled' NOT NULL;--> statement-breakpoint
UPDATE "agent_config_versions"
SET "pr_mode_policy" = CASE
	WHEN "pr_mode" THEN 'always'
	ELSE 'disabled'
END;--> statement-breakpoint
ALTER TABLE "issue_pull_requests" ADD CONSTRAINT "issue_pull_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_pull_requests" ADD CONSTRAINT "issue_pull_requests_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_pull_requests" ADD CONSTRAINT "issue_pull_requests_agent_config_version_id_agent_config_versions_id_fk" FOREIGN KEY ("agent_config_version_id") REFERENCES "public"."agent_config_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_pull_requests_issue_created_idx" ON "issue_pull_requests" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_pull_requests_investigation_idx" ON "issue_pull_requests" USING btree ("investigation_id");
