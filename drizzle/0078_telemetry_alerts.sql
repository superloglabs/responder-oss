CREATE TABLE "telemetry_alert_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"group_key" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'firing' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"open_value" double precision NOT NULL,
	"peak_value" double precision NOT NULL,
	"last_value" double precision NOT NULL,
	"slack_integration_account_id" uuid,
	"slack_channel_id" text,
	"slack_message_ts" text,
	"recovery_notified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" text NOT NULL,
	"metric_name" text,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"group_by" text,
	"group_mode" text DEFAULT 'single' NOT NULL,
	"aggregation" text NOT NULL,
	"comparator" text NOT NULL,
	"threshold" double precision NOT NULL,
	"window_minutes" integer DEFAULT 5 NOT NULL,
	"evaluation_interval_seconds" integer DEFAULT 60 NOT NULL,
	"slack_integration_account_id" uuid,
	"slack_channel_id" text,
	"created_by" uuid,
	"last_evaluated_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telemetry_alert_episodes" ADD CONSTRAINT "telemetry_alert_episodes_alert_id_telemetry_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."telemetry_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_alerts" ADD CONSTRAINT "telemetry_alerts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_alerts" ADD CONSTRAINT "telemetry_alerts_slack_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("slack_integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_alerts" ADD CONSTRAINT "telemetry_alerts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telemetry_alert_episodes_alert_idx" ON "telemetry_alert_episodes" USING btree ("alert_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_alert_episodes_open_idx" ON "telemetry_alert_episodes" USING btree ("alert_id","group_key") WHERE "telemetry_alert_episodes"."state" = 'firing';--> statement-breakpoint
CREATE INDEX "telemetry_alerts_organization_idx" ON "telemetry_alerts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "telemetry_alerts_due_idx" ON "telemetry_alerts" USING btree ("last_evaluated_at") WHERE "telemetry_alerts"."enabled";