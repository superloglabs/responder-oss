CREATE TABLE "telemetry_dashboard_widgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"config" jsonb NOT NULL,
	"layout" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry_dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telemetry_dashboard_widgets" ADD CONSTRAINT "telemetry_dashboard_widgets_dashboard_id_telemetry_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."telemetry_dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_dashboards" ADD CONSTRAINT "telemetry_dashboards_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_dashboards" ADD CONSTRAINT "telemetry_dashboards_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telemetry_dashboard_widgets_dashboard_idx" ON "telemetry_dashboard_widgets" USING btree ("dashboard_id");--> statement-breakpoint
CREATE INDEX "telemetry_dashboards_organization_idx" ON "telemetry_dashboards" USING btree ("organization_id");