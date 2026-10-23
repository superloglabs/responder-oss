CREATE TABLE "error_issue_hourly_counts" (
	"issue_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"event_count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "error_issue_hourly_counts_issue_id_hour_pk" PRIMARY KEY("issue_id","hour")
);
--> statement-breakpoint
ALTER TABLE "error_issue_hourly_counts" ADD CONSTRAINT "error_issue_hourly_counts_issue_id_error_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."error_issues"("id") ON DELETE cascade ON UPDATE no action;