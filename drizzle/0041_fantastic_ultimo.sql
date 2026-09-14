CREATE TABLE "scan_configurations" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid,
	"frequency_hours" integer,
	"slack_channel_resource_id" uuid,
	"context_account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context_resource_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repository_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"run_lease_id" uuid,
	"run_lease_expires_at" timestamp with time zone,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scan_configurations_agent_id_unique" UNIQUE("agent_id"),
	CONSTRAINT "scan_configurations_frequency_hours_check" CHECK ("scan_configurations"."frequency_hours" is null or "scan_configurations"."frequency_hours" in (1, 6))
);
--> statement-breakpoint
ALTER TABLE "scan_configurations" ADD CONSTRAINT "scan_configurations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_configurations" ADD CONSTRAINT "scan_configurations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_configurations" ADD CONSTRAINT "scan_configurations_slack_channel_resource_id_integration_resources_id_fk" FOREIGN KEY ("slack_channel_resource_id") REFERENCES "public"."integration_resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_configurations" ADD CONSTRAINT "scan_configurations_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scan_configurations_due_idx" ON "scan_configurations" USING btree ("next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_organization_scan_idx" ON "agents" USING btree ("organization_id") WHERE "agents"."purpose" = 'scan';
