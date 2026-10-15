ALTER TABLE "telemetry_ingest_keys" DROP CONSTRAINT "telemetry_ingest_keys_project_fk";--> statement-breakpoint
ALTER TABLE "telemetry_ingest_keys" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "telemetry_alerts" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "telemetry_dashboards" DROP COLUMN "project_id";--> statement-breakpoint
DROP TABLE "telemetry_projects";
