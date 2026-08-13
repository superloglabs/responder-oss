ALTER TABLE "agent_config_versions"
	ADD COLUMN IF NOT EXISTS "context_account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_type
		JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
		WHERE pg_namespace.nspname = 'public'
			AND pg_type.typname = 'issue_relationship'
	) THEN
		CREATE TYPE "public"."issue_relationship" AS ENUM('new', 'recurrence');
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" serial NOT NULL,
	"system_prompt" text NOT NULL,
	"model" text NOT NULL,
	"model_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "instance_configuration" (
	"id" text PRIMARY KEY NOT NULL,
	"active_runtime_profile_id" uuid,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"severity" "severity" NOT NULL,
	"remediation" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" jsonb,
	"embedding_model" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investigation_issues" (
	"investigation_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"relationship" "issue_relationship" NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investigation_issues_investigation_id_issue_id_pk"
		PRIMARY KEY("investigation_id", "issue_id")
);
--> statement-breakpoint
ALTER TABLE "investigations"
	ADD COLUMN IF NOT EXISTS "runtime_profile_id" uuid;
--> statement-breakpoint
ALTER TABLE "investigations"
	ADD COLUMN IF NOT EXISTS "structured_report" jsonb;
--> statement-breakpoint
ALTER TABLE "issues"
	ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'instance_configuration_active_runtime_profile_id_runtime_profiles_id_fk'
	) THEN
		ALTER TABLE "instance_configuration" ADD CONSTRAINT
			"instance_configuration_active_runtime_profile_id_runtime_profiles_id_fk"
			FOREIGN KEY ("active_runtime_profile_id") REFERENCES "public"."runtime_profiles"("id")
			ON DELETE restrict ON UPDATE no action;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'issues_organization_id_organization_id_fk'
	) THEN
		ALTER TABLE "issues" ADD CONSTRAINT
			"issues_organization_id_organization_id_fk"
			FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'investigation_issues_investigation_id_investigations_id_fk'
	) THEN
		ALTER TABLE "investigation_issues" ADD CONSTRAINT
			"investigation_issues_investigation_id_investigations_id_fk"
			FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'investigation_issues_issue_id_issues_id_fk'
	) THEN
		ALTER TABLE "investigation_issues" ADD CONSTRAINT
			"investigation_issues_issue_id_issues_id_fk"
			FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'investigations_runtime_profile_id_runtime_profiles_id_fk'
	) THEN
		ALTER TABLE "investigations" ADD CONSTRAINT
			"investigations_runtime_profile_id_runtime_profiles_id_fk"
			FOREIGN KEY ("runtime_profile_id") REFERENCES "public"."runtime_profiles"("id")
			ON DELETE restrict ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_profiles_version_idx"
	ON "runtime_profiles" USING btree ("version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_organization_created_idx"
	ON "issues" USING btree ("organization_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "investigation_issues_issue_idx"
	ON "investigation_issues" USING btree ("issue_id");
--> statement-breakpoint
ALTER TABLE "investigations"
	DROP COLUMN IF EXISTS "severity";
