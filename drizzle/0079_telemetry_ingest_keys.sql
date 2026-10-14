CREATE TABLE "telemetry_ingest_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telemetry_ingest_keys" ADD CONSTRAINT "telemetry_ingest_keys_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_ingest_keys" ADD CONSTRAINT "telemetry_ingest_keys_project_id_telemetry_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."telemetry_projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_ingest_keys" ADD CONSTRAINT "telemetry_ingest_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_ingest_keys_token_hash_idx" ON "telemetry_ingest_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "telemetry_ingest_keys_organization_idx" ON "telemetry_ingest_keys" USING btree ("organization_id");