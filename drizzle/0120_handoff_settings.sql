CREATE TABLE "handoff_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"targets" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "handoff_settings" ADD CONSTRAINT "handoff_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;