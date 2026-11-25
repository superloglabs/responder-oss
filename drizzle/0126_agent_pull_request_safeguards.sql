CREATE TABLE "pull_request_approval_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"require_approval" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_versions" ADD COLUMN "allow_dependency_changes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pull_request_approval_settings" ADD CONSTRAINT "pull_request_approval_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;