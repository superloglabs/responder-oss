CREATE TABLE "automation_issue_runs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"issue_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"slack_messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" jsonb,
	"embedding_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_issues_occurrences_check" CHECK ("automation_issues"."occurrences" >= 1)
);
--> statement-breakpoint
ALTER TABLE "automation_issue_runs" ADD CONSTRAINT "automation_issue_runs_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_issue_runs" ADD CONSTRAINT "automation_issue_runs_issue_id_automation_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."automation_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_issues" ADD CONSTRAINT "automation_issues_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_issues" ADD CONSTRAINT "automation_issues_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_issue_runs_issue_idx" ON "automation_issue_runs" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "automation_issues_automation_seen_idx" ON "automation_issues" USING btree ("automation_id","last_seen_at");