CREATE TABLE "telemetry_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"integration_account_id" uuid,
	"ingest_key_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"last_received_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telemetry_sources" ADD CONSTRAINT "telemetry_sources_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_sources" ADD CONSTRAINT "telemetry_sources_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_sources" ADD CONSTRAINT "telemetry_sources_ingest_key_id_telemetry_ingest_keys_id_fk" FOREIGN KEY ("ingest_key_id") REFERENCES "public"."telemetry_ingest_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_sources" ADD CONSTRAINT "telemetry_sources_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_sources_organization_provider_external_idx" ON "telemetry_sources" USING btree ("organization_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "telemetry_sources_provider_status_idx" ON "telemetry_sources" USING btree ("provider","status");