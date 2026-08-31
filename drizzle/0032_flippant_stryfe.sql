CREATE TABLE "slack_investigation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_config_version_id" uuid NOT NULL,
	"runtime_profile_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_timestamp" text NOT NULL,
	"sandbox_session_state" jsonb,
	"previous_response_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "purpose" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "execution_mode" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "slack_investigation_session_id" uuid;--> statement-breakpoint
ALTER TABLE "slack_investigation_sessions" ADD CONSTRAINT "slack_investigation_sessions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_investigation_sessions" ADD CONSTRAINT "slack_investigation_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_investigation_sessions" ADD CONSTRAINT "slack_investigation_sessions_agent_config_version_id_agent_config_versions_id_fk" FOREIGN KEY ("agent_config_version_id") REFERENCES "public"."agent_config_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_investigation_sessions" ADD CONSTRAINT "slack_investigation_sessions_runtime_profile_id_runtime_profiles_id_fk" FOREIGN KEY ("runtime_profile_id") REFERENCES "public"."runtime_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_investigation_sessions_thread_idx" ON "slack_investigation_sessions" USING btree ("organization_id","agent_id","team_id","channel_id","thread_timestamp");--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_slack_investigation_session_id_slack_investigation_sessions_id_fk" FOREIGN KEY ("slack_investigation_session_id") REFERENCES "public"."slack_investigation_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_organization_slack_thread_idx" ON "agents" USING btree ("organization_id") WHERE "agents"."purpose" = 'slack_thread';