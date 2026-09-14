CREATE TABLE "suggestion_pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suggestion_id" uuid NOT NULL,
	"investigation_id" uuid NOT NULL,
	"agent_config_version_id" uuid NOT NULL,
	"repository_full_name" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"branch" text,
	"pull_request_number" integer,
	"pull_request_url" text,
	"eve_session_id" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "suggestion_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"auto_open_pull_requests" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"investigation_id" uuid NOT NULL,
	"agent_config_version_id" uuid NOT NULL,
	"title" text NOT NULL,
	"subtitle" text NOT NULL,
	"detail" text NOT NULL,
	"code_change" jsonb,
	"fingerprint" text NOT NULL,
	"embedding" jsonb,
	"embedding_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suggestion_pull_requests" ADD CONSTRAINT "suggestion_pull_requests_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_pull_requests" ADD CONSTRAINT "suggestion_pull_requests_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_pull_requests" ADD CONSTRAINT "suggestion_pull_requests_agent_config_version_id_agent_config_versions_id_fk" FOREIGN KEY ("agent_config_version_id") REFERENCES "public"."agent_config_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_settings" ADD CONSTRAINT "suggestion_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_agent_config_version_id_agent_config_versions_id_fk" FOREIGN KEY ("agent_config_version_id") REFERENCES "public"."agent_config_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suggestion_pull_requests_active_suggestion_idx" ON "suggestion_pull_requests" USING btree ("suggestion_id") WHERE "status" in ('queued', 'creating', 'created') and "repository_full_name" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "suggestion_pull_requests_active_repository_idx" ON "suggestion_pull_requests" USING btree ("suggestion_id","repository_full_name") WHERE "status" in ('queued', 'creating', 'created') and "repository_full_name" is not null;--> statement-breakpoint
CREATE INDEX "suggestion_pull_requests_suggestion_created_idx" ON "suggestion_pull_requests" USING btree ("suggestion_id","created_at");--> statement-breakpoint
CREATE INDEX "suggestion_pull_requests_investigation_idx" ON "suggestion_pull_requests" USING btree ("investigation_id");--> statement-breakpoint
CREATE INDEX "suggestions_organization_created_idx" ON "suggestions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suggestions_organization_fingerprint_idx" ON "suggestions" USING btree ("organization_id","fingerprint");