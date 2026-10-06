CREATE TABLE "pull_request_origins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_full_name" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"branch" text NOT NULL,
	"slack_investigation_session_id" uuid,
	"automation_run_id" uuid,
	"bot_review_turns" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_request_origins_single_origin_check" CHECK (num_nonnulls("pull_request_origins"."slack_investigation_session_id", "pull_request_origins"."automation_run_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "pull_request_origins" ADD CONSTRAINT "pull_request_origins_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_origins" ADD CONSTRAINT "pull_request_origins_slack_investigation_session_id_slack_investigation_sessions_id_fk" FOREIGN KEY ("slack_investigation_session_id") REFERENCES "public"."slack_investigation_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_origins" ADD CONSTRAINT "pull_request_origins_automation_run_id_automation_runs_id_fk" FOREIGN KEY ("automation_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_origins_pull_request_idx" ON "pull_request_origins" USING btree ("repository_full_name","pull_request_number");--> statement-breakpoint
CREATE INDEX "pull_request_origins_session_idx" ON "pull_request_origins" USING btree ("slack_investigation_session_id");--> statement-breakpoint
CREATE INDEX "pull_request_origins_run_idx" ON "pull_request_origins" USING btree ("automation_run_id");