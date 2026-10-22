ALTER TABLE "telemetry_alert_episodes" ADD COLUMN "rule_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "telemetry_alert_episodes" ADD COLUMN "end_reason" text;