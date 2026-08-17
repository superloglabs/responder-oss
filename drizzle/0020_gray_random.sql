ALTER TYPE "public"."integration_provider" ADD VALUE 'linear';--> statement-breakpoint
CREATE TABLE "issue_linear_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"investigation_id" uuid NOT NULL,
	"agent_config_version_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"team_id" text,
	"project_id" text,
	"linear_issue_id" text,
	"linear_identifier" text,
	"linear_issue_url" text,
	"failure_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD COLUMN "create_linear_tickets" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD COLUMN "linear_issue_template" text DEFAULT '## Responder issue
[{{issue_id}}]({{issue_url}})

## Description
{{description}}

## Evidence
{{evidence}}

## Recommended remediation
{{remediation}}' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_linear_tickets" ADD CONSTRAINT "issue_linear_tickets_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_linear_tickets" ADD CONSTRAINT "issue_linear_tickets_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_linear_tickets" ADD CONSTRAINT "issue_linear_tickets_agent_config_version_id_agent_config_versions_id_fk" FOREIGN KEY ("agent_config_version_id") REFERENCES "public"."agent_config_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_linear_tickets" ADD CONSTRAINT "issue_linear_tickets_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_linear_tickets_issue_idx" ON "issue_linear_tickets" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_linear_tickets_investigation_idx" ON "issue_linear_tickets" USING btree ("investigation_id");--> statement-breakpoint
CREATE INDEX "issue_linear_tickets_status_created_idx" ON "issue_linear_tickets" USING btree ("status","created_at");