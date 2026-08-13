CREATE TABLE "investigation_trace_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"investigation_id" uuid NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "investigation_trace_events" ADD CONSTRAINT "investigation_trace_events_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investigation_trace_events_investigation_id_idx" ON "investigation_trace_events" USING btree ("investigation_id","id");