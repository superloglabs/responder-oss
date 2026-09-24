CREATE TABLE "automation_model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"inference_source" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint,
	"billed_at" timestamp with time zone,
	"billing_attempted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_model_usage_source_check" CHECK ("automation_model_usage"."inference_source" in ('responder', 'byok', 'byos')),
	CONSTRAINT "automation_model_usage_tokens_check" CHECK ("automation_model_usage"."input_tokens" >= 0 and "automation_model_usage"."cached_input_tokens" >= 0 and "automation_model_usage"."cache_write_tokens" >= 0 and "automation_model_usage"."output_tokens" >= 0),
	CONSTRAINT "automation_model_usage_cost_check" CHECK ("automation_model_usage"."cost_micros" is null or "automation_model_usage"."cost_micros" >= 0)
);
--> statement-breakpoint
ALTER TABLE "automation_model_broker_grants" ALTER COLUMN "encrypted_credentials" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_versions" ALTER COLUMN "model_credential_id" DROP NOT NULL;--> statement-breakpoint
-- Grants issued before this migration carry an organization credential.
ALTER TABLE "automation_model_broker_grants" ADD COLUMN "inference_source" text DEFAULT 'byok' NOT NULL;--> statement-breakpoint
UPDATE "automation_model_broker_grants" SET "inference_source" = 'byos' WHERE "context_only";--> statement-breakpoint
ALTER TABLE "automation_model_broker_grants" ALTER COLUMN "inference_source" DROP DEFAULT;--> statement-breakpoint
-- Existing versions all select an organization credential. New versions
-- default to Responder-funded inference.
ALTER TABLE "automation_versions" ADD COLUMN "inference_source" text DEFAULT 'byok' NOT NULL;--> statement-breakpoint
UPDATE "automation_versions" AS version SET "inference_source" = 'byos'
FROM "organization_model_credentials" AS credential
WHERE credential."id" = version."model_credential_id" AND credential."auth_type" = 'chatgpt_subscription';--> statement-breakpoint
ALTER TABLE "automation_versions" ALTER COLUMN "inference_source" SET DEFAULT 'responder';--> statement-breakpoint
ALTER TABLE "automation_model_usage" ADD CONSTRAINT "automation_model_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_model_usage_run_idx" ON "automation_model_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "automation_model_usage_organization_created_idx" ON "automation_model_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_model_usage_unbilled_idx" ON "automation_model_usage" USING btree ("organization_id","created_at") WHERE "automation_model_usage"."billed_at" is null;--> statement-breakpoint
ALTER TABLE "automation_model_broker_grants" ADD CONSTRAINT "automation_model_broker_grants_credential_check" CHECK (("automation_model_broker_grants"."inference_source" = 'responder') = ("automation_model_broker_grants"."encrypted_credentials" is null));--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_inference_source_check" CHECK (("automation_versions"."inference_source" = 'responder' and "automation_versions"."model_credential_id" is null)
        or ("automation_versions"."inference_source" in ('byok', 'byos') and "automation_versions"."model_credential_id" is not null));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_automation_version_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  automation_organization_id uuid;
  credential_organization_id uuid;
  credential_auth_type text;
BEGIN
  SELECT "organization_id" INTO automation_organization_id
  FROM "automations" WHERE "id" = NEW."automation_id";
  IF automation_organization_id IS NULL THEN
    RAISE EXCEPTION 'automation version resources must belong to one organization' USING ERRCODE = '23514';
  END IF;
  IF NEW."model_credential_id" IS NOT NULL THEN
    SELECT "organization_id", "auth_type" INTO credential_organization_id, credential_auth_type
    FROM "organization_model_credentials" WHERE "id" = NEW."model_credential_id";
    IF credential_organization_id IS DISTINCT FROM automation_organization_id THEN
      RAISE EXCEPTION 'automation version resources must belong to one organization' USING ERRCODE = '23514';
    END IF;
    IF (NEW."inference_source" = 'byos') IS DISTINCT FROM (credential_auth_type = 'chatgpt_subscription') THEN
      RAISE EXCEPTION 'automation version inference source must match its model credential' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."inference_source" = 'byos' AND NEW."harness" <> 'codex' THEN
    RAISE EXCEPTION 'ChatGPT subscriptions require the Codex harness' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER "automation_versions_scope_trigger" ON "automation_versions";--> statement-breakpoint
CREATE TRIGGER "automation_versions_scope_trigger"
BEFORE INSERT OR UPDATE OF "automation_id", "model_credential_id", "inference_source", "harness" ON "automation_versions"
FOR EACH ROW EXECUTE FUNCTION "validate_automation_version_scope"();
