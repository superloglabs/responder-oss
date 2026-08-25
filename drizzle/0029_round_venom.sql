CREATE TABLE "issue_pull_request_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"external_key" text,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_pull_request_activities" ADD CONSTRAINT "issue_pull_request_activities_request_id_issue_pull_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."issue_pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_pull_request_activities_request_idx" ON "issue_pull_request_activities" USING btree ("request_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_pull_request_activities_external_key_idx" ON "issue_pull_request_activities" USING btree ("request_id","external_key") WHERE "issue_pull_request_activities"."external_key" is not null;