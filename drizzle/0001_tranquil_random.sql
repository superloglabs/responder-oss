CREATE TYPE "public"."integration_resource_kind" AS ENUM('slack_channel', 'sentry_project', 'datadog_monitor');--> statement-breakpoint
CREATE TABLE "integration_connection_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"code_verifier" text,
	"return_to" text DEFAULT '/settings' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"kind" "integration_resource_kind" NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "available" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connection_states" ADD CONSTRAINT "integration_connection_states_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connection_states" ADD CONSTRAINT "integration_connection_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_resources" ADD CONSTRAINT "integration_resources_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_connection_states_expires_idx" ON "integration_connection_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "integration_connection_states_organization_idx" ON "integration_connection_states" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_resources_account_kind_external_idx" ON "integration_resources" USING btree ("integration_account_id","kind","external_id");--> statement-breakpoint
CREATE INDEX "integration_resources_account_idx" ON "integration_resources" USING btree ("integration_account_id");