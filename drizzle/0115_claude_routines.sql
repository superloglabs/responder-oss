CREATE TABLE "claude_routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"trigger_id" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_fired_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "telemetry_alert_episodes" ADD COLUMN "claude_routine_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telemetry_alert_episodes" ADD COLUMN "claude_routine_session_url" text;--> statement-breakpoint
ALTER TABLE "telemetry_alerts" ADD COLUMN "claude_routine_id" uuid;--> statement-breakpoint
ALTER TABLE "claude_routines" ADD CONSTRAINT "claude_routines_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claude_routines" ADD CONSTRAINT "claude_routines_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claude_routines_organization_idx" ON "claude_routines" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "telemetry_alerts" ADD CONSTRAINT "telemetry_alerts_claude_routine_id_claude_routines_id_fk" FOREIGN KEY ("claude_routine_id") REFERENCES "public"."claude_routines"("id") ON DELETE set null ON UPDATE no action;