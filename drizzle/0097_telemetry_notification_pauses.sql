CREATE TABLE "telemetry_notification_pauses" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"paused_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telemetry_alert_episodes" ADD COLUMN "notifications_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry_notification_pauses" ADD CONSTRAINT "telemetry_notification_pauses_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_notification_pauses" ADD CONSTRAINT "telemetry_notification_pauses_paused_by_user_id_fk" FOREIGN KEY ("paused_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;