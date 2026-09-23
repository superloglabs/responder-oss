CREATE TABLE "automation_model_broker_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"credential_key_version" integer DEFAULT 1 NOT NULL,
	"remaining_requests" integer NOT NULL,
	"remaining_output_tokens" integer NOT NULL,
	"max_output_tokens_per_request" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_model_broker_grants_request_budget_check" CHECK ("automation_model_broker_grants"."remaining_requests" >= 0),
	CONSTRAINT "automation_model_broker_grants_output_budget_check" CHECK ("automation_model_broker_grants"."remaining_output_tokens" >= 0 and "automation_model_broker_grants"."max_output_tokens_per_request" > 0)
);
--> statement-breakpoint
ALTER TABLE "automation_model_broker_grants" ADD CONSTRAINT "automation_model_broker_grants_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_model_broker_grants_token_hash_idx" ON "automation_model_broker_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "automation_model_broker_grants_expires_idx" ON "automation_model_broker_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "automation_model_broker_grants_organization_run_idx" ON "automation_model_broker_grants" USING btree ("organization_id","run_id");