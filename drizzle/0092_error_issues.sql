CREATE TABLE "error_issue_cursors" (
	"kind" text PRIMARY KEY NOT NULL,
	"discovered_at" timestamp (3) with time zone NOT NULL,
	"candidate_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_issue_daily_counts" (
	"issue_id" uuid NOT NULL,
	"day" date NOT NULL,
	"event_count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "error_issue_daily_counts_issue_id_day_pk" PRIMARY KEY("issue_id","day")
);
--> statement-breakpoint
CREATE TABLE "error_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"service" text,
	"exception_type" text NOT NULL,
	"title" text NOT NULL,
	"message" text,
	"top_frame" text,
	"frames" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_sample" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"regressed_at" timestamp with time zone,
	"event_count" bigint DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "error_issue_daily_counts" ADD CONSTRAINT "error_issue_daily_counts_issue_id_error_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."error_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_issues" ADD CONSTRAINT "error_issues_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "error_issues_fingerprint_idx" ON "error_issues" USING btree ("organization_id","fingerprint");--> statement-breakpoint
CREATE INDEX "error_issues_status_idx" ON "error_issues" USING btree ("organization_id","status","last_seen_at");