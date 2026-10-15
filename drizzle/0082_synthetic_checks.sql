CREATE TABLE "synthetic_check_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"state" text DEFAULT 'failing' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"reason" text NOT NULL,
	"failed_runs" integer DEFAULT 1 NOT NULL,
	"slack_integration_account_id" uuid,
	"slack_channel_id" text,
	"slack_message_ts" text,
	"recovery_notified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "synthetic_check_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"location" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"duration_ms" double precision NOT NULL,
	"timings" jsonb NOT NULL,
	"status_code" integer,
	"error" text,
	"assertions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"response" jsonb
);
--> statement-breakpoint
CREATE TABLE "synthetic_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"method" text DEFAULT 'GET' NOT NULL,
	"url" text NOT NULL,
	"headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"encrypted_secrets" text,
	"body" text,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"follow_redirects" boolean DEFAULT true NOT NULL,
	"assertions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"interval_seconds" integer DEFAULT 300 NOT NULL,
	"retries" integer DEFAULT 1 NOT NULL,
	"failures_to_alert" integer DEFAULT 1 NOT NULL,
	"slack_integration_account_id" uuid,
	"slack_channel_id" text,
	"created_by" uuid,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"status_since" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "synthetic_check_episodes" ADD CONSTRAINT "synthetic_check_episodes_check_id_synthetic_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."synthetic_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_check_episodes" ADD CONSTRAINT "synthetic_check_episodes_slack_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("slack_integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_check_runs" ADD CONSTRAINT "synthetic_check_runs_check_id_synthetic_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."synthetic_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_checks" ADD CONSTRAINT "synthetic_checks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_checks" ADD CONSTRAINT "synthetic_checks_slack_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("slack_integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_checks" ADD CONSTRAINT "synthetic_checks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "synthetic_check_episodes_check_idx" ON "synthetic_check_episodes" USING btree ("check_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "synthetic_check_episodes_open_idx" ON "synthetic_check_episodes" USING btree ("check_id") WHERE "synthetic_check_episodes"."state" = 'failing';--> statement-breakpoint
CREATE INDEX "synthetic_check_runs_check_idx" ON "synthetic_check_runs" USING btree ("check_id","started_at");--> statement-breakpoint
CREATE INDEX "synthetic_check_runs_started_idx" ON "synthetic_check_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "synthetic_checks_organization_idx" ON "synthetic_checks" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "synthetic_checks_due_idx" ON "synthetic_checks" USING btree ("last_run_at") WHERE "synthetic_checks"."enabled";