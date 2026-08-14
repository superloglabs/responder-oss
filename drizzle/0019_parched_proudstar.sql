CREATE TABLE "agent_version_secrets" (
	"agent_config_version_id" uuid NOT NULL,
	"workspace_secret_id" uuid NOT NULL,
	CONSTRAINT "agent_version_secrets_agent_config_version_id_workspace_secret_id_pk" PRIMARY KEY("agent_config_version_id","workspace_secret_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"daytona_secret_id" text NOT NULL,
	"daytona_secret_name" text NOT NULL,
	"allowed_hosts" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_version_secrets" ADD CONSTRAINT "agent_version_secrets_agent_config_version_id_agent_config_versions_id_fk" FOREIGN KEY ("agent_config_version_id") REFERENCES "public"."agent_config_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version_secrets" ADD CONSTRAINT "agent_version_secrets_workspace_secret_id_workspace_secrets_id_fk" FOREIGN KEY ("workspace_secret_id") REFERENCES "public"."workspace_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_secrets" ADD CONSTRAINT "workspace_secrets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_secrets" ADD CONSTRAINT "workspace_secrets_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_secrets_organization_name_idx" ON "workspace_secrets" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_secrets_daytona_id_idx" ON "workspace_secrets" USING btree ("daytona_secret_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_secrets_daytona_name_idx" ON "workspace_secrets" USING btree ("daytona_secret_name");