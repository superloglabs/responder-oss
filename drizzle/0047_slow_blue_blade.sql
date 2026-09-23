ALTER TYPE "public"."integration_provider" ADD VALUE 'discord';--> statement-breakpoint
ALTER TYPE "public"."integration_resource_kind" ADD VALUE 'discord_channel';--> statement-breakpoint
CREATE TABLE "automation_action_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"redacted_input" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_reference" text,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_run_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"type" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"automation_version_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trigger_input" jsonb NOT NULL,
	"redacted_trigger" jsonb NOT NULL,
	"sandbox_id" text,
	"harness_session_id" text,
	"result_summary" text,
	"usage" jsonb,
	"failure_category" text,
	"failure_message" text,
	"lease_id" uuid,
	"heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_trigger_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_version_integration_accounts" (
	"automation_version_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	CONSTRAINT "automation_version_integration_accounts_automation_version_id_integration_account_id_pk" PRIMARY KEY("automation_version_id","integration_account_id")
);
--> statement-breakpoint
CREATE TABLE "automation_version_repositories" (
	"automation_version_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	CONSTRAINT "automation_version_repositories_automation_version_id_repository_id_pk" PRIMARY KEY("automation_version_id","repository_id")
);
--> statement-breakpoint
CREATE TABLE "automation_version_secrets" (
	"automation_version_id" uuid NOT NULL,
	"workspace_secret_id" uuid NOT NULL,
	CONSTRAINT "automation_version_secrets_automation_version_id_workspace_secret_id_pk" PRIMARY KEY("automation_version_id","workspace_secret_id")
);
--> statement-breakpoint
CREATE TABLE "automation_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"prompt" text NOT NULL,
	"harness" text NOT NULL,
	"model_provider" text NOT NULL,
	"model" text NOT NULL,
	"model_credential_id" uuid NOT NULL,
	"trigger" jsonb NOT NULL,
	"connection_mode" text DEFAULT 'all_selected' NOT NULL,
	"tool_policy" text DEFAULT 'full' NOT NULL,
	"max_runtime_seconds" integer NOT NULL,
	"max_model_requests" integer NOT NULL,
	"max_output_tokens_per_request" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_versions_runtime_check" CHECK ("automation_versions"."max_runtime_seconds" between 60 and 3600),
	CONSTRAINT "automation_versions_model_request_check" CHECK ("automation_versions"."max_model_requests" between 1 and 128),
	CONSTRAINT "automation_versions_output_tokens_check" CHECK ("automation_versions"."max_output_tokens_per_request" between 256 and 100000)
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"active_version_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_capabilities" (
	"organization_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_capabilities_organization_id_capability_pk" PRIMARY KEY("organization_id","capability")
);
--> statement-breakpoint
CREATE TABLE "organization_model_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"credential_key_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_four" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_action_attempts" ADD CONSTRAINT "automation_action_attempts_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run_events" ADD CONSTRAINT "automation_run_events_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_version_id_automation_versions_id_fk" FOREIGN KEY ("automation_version_id") REFERENCES "public"."automation_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_trigger_receipts" ADD CONSTRAINT "automation_trigger_receipts_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_trigger_receipts" ADD CONSTRAINT "automation_trigger_receipts_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_version_integration_accounts" ADD CONSTRAINT "automation_version_integration_accounts_automation_version_id_automation_versions_id_fk" FOREIGN KEY ("automation_version_id") REFERENCES "public"."automation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_version_integration_accounts" ADD CONSTRAINT "automation_version_integration_accounts_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_version_repositories" ADD CONSTRAINT "automation_version_repositories_automation_version_id_automation_versions_id_fk" FOREIGN KEY ("automation_version_id") REFERENCES "public"."automation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_version_repositories" ADD CONSTRAINT "automation_version_repositories_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_version_secrets" ADD CONSTRAINT "automation_version_secrets_automation_version_id_automation_versions_id_fk" FOREIGN KEY ("automation_version_id") REFERENCES "public"."automation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_version_secrets" ADD CONSTRAINT "automation_version_secrets_workspace_secret_id_workspace_secrets_id_fk" FOREIGN KEY ("workspace_secret_id") REFERENCES "public"."workspace_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_model_credential_id_organization_model_credentials_id_fk" FOREIGN KEY ("model_credential_id") REFERENCES "public"."organization_model_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_capabilities" ADD CONSTRAINT "organization_capabilities_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_capabilities" ADD CONSTRAINT "organization_capabilities_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_model_credentials" ADD CONSTRAINT "organization_model_credentials_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_action_attempts_idempotency_idx" ON "automation_action_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "automation_action_attempts_run_idx" ON "automation_action_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "automation_run_events_run_idx" ON "automation_run_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "automation_runs_organization_created_idx" ON "automation_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_automation_created_idx" ON "automation_runs" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_status_lease_idx" ON "automation_runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_trigger_receipts_event_idx" ON "automation_trigger_receipts" USING btree ("automation_id","provider","external_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_automation_version_idx" ON "automation_versions" USING btree ("automation_id","version");--> statement-breakpoint
CREATE INDEX "automation_versions_automation_idx" ON "automation_versions" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "automations_organization_updated_idx" ON "automations" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automations_organization_name_idx" ON "automations" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "organization_model_credentials_organization_idx" ON "organization_model_credentials" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_model_credentials_label_idx" ON "organization_model_credentials" USING btree ("organization_id","label");