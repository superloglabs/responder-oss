CREATE TYPE "public"."investigation_replay_request_status" AS ENUM('pending', 'processing', 'queued', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "investigation_replay_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_investigation_id" uuid NOT NULL,
	"replay_investigation_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"status" "investigation_replay_request_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"processing_started_at" timestamp with time zone,
	"queued_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "investigation_replay_requests" ADD CONSTRAINT "investigation_replay_requests_source_investigation_id_investigations_id_fk" FOREIGN KEY ("source_investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_replay_requests_replay_idx" ON "investigation_replay_requests" USING btree ("replay_investigation_id");--> statement-breakpoint
CREATE INDEX "investigation_replay_requests_claim_idx" ON "investigation_replay_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "investigation_replay_requests_source_idx" ON "investigation_replay_requests" USING btree ("source_investigation_id","created_at");