CREATE TABLE "organization_ingest_pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"paused_by" text NOT NULL,
	"paused_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resumed_by" text,
	"resumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organization_ingest_pauses" ADD CONSTRAINT "organization_ingest_pauses_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_ingest_pauses_active_idx" ON "organization_ingest_pauses" USING btree ("organization_id") WHERE "organization_ingest_pauses"."resumed_at" is null;--> statement-breakpoint
CREATE INDEX "organization_ingest_pauses_organization_idx" ON "organization_ingest_pauses" USING btree ("organization_id","paused_at");