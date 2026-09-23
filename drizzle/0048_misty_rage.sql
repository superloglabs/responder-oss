ALTER TABLE "automation_version_integration_accounts" DROP CONSTRAINT "automation_version_integration_accounts_automation_version_id_integration_account_id_pk";--> statement-breakpoint
ALTER TABLE "automation_version_integration_accounts" ADD COLUMN "role" text;--> statement-breakpoint
UPDATE "automation_version_integration_accounts" AS link
SET "role" = CASE
  WHEN version."trigger"->>'integrationAccountId' = link."integration_account_id"::text THEN 'trigger'
  ELSE 'context'
END
FROM "automation_versions" AS version
WHERE version."id" = link."automation_version_id";--> statement-breakpoint
ALTER TABLE "automation_version_integration_accounts" ALTER COLUMN "role" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_version_integration_accounts" ADD CONSTRAINT "automation_version_integration_accounts_role_check" CHECK ("role" IN ('context', 'trigger'));--> statement-breakpoint
ALTER TABLE "automation_version_integration_accounts" ADD CONSTRAINT "automation_version_integration_accounts_automation_version_id_integration_account_id_role_pk" PRIMARY KEY("automation_version_id","integration_account_id","role");--> statement-breakpoint

ALTER TABLE "automation_model_broker_grants" ADD COLUMN "lease_id" uuid;--> statement-breakpoint
DELETE FROM "automation_model_broker_grants"
WHERE NOT pg_input_is_valid("run_id", 'uuid');--> statement-breakpoint
UPDATE "automation_model_broker_grants" AS broker_grant
SET "lease_id" = run."lease_id"
FROM "automation_runs" AS run
WHERE broker_grant."run_id"::uuid = run."id";--> statement-breakpoint
DELETE FROM "automation_model_broker_grants" WHERE "lease_id" IS NULL;--> statement-breakpoint
ALTER TABLE "automation_model_broker_grants" ALTER COLUMN "run_id" SET DATA TYPE uuid USING "run_id"::uuid;--> statement-breakpoint
ALTER TABLE "automation_model_broker_grants" ALTER COLUMN "lease_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_id_organization_lease_idx" ON "automation_runs" USING btree ("id","organization_id","lease_id");--> statement-breakpoint
ALTER TABLE "automation_model_broker_grants" ADD CONSTRAINT "automation_model_broker_grants_run_scope_fk" FOREIGN KEY ("run_id","organization_id","lease_id") REFERENCES "public"."automation_runs"("id","organization_id","lease_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "automations" ADD CONSTRAINT "automations_active_version_id_automation_versions_id_fk" FOREIGN KEY ("active_version_id") REFERENCES "public"."automation_versions"("id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint

CREATE FUNCTION "validate_automation_active_version_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."active_version_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "automation_versions"
    WHERE "id" = NEW."active_version_id"
      AND "automation_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'automation active version must belong to the automation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "automations_active_version_scope_trigger"
BEFORE INSERT OR UPDATE OF "active_version_id" ON "automations"
FOR EACH ROW EXECUTE FUNCTION "validate_automation_active_version_scope"();--> statement-breakpoint

CREATE FUNCTION "validate_automation_version_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  automation_organization_id uuid;
  credential_organization_id uuid;
BEGIN
  SELECT "organization_id" INTO automation_organization_id
  FROM "automations" WHERE "id" = NEW."automation_id";
  SELECT "organization_id" INTO credential_organization_id
  FROM "organization_model_credentials" WHERE "id" = NEW."model_credential_id";
  IF automation_organization_id IS NULL
    OR credential_organization_id IS DISTINCT FROM automation_organization_id THEN
    RAISE EXCEPTION 'automation version resources must belong to one organization' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "automation_versions_scope_trigger"
BEFORE INSERT OR UPDATE OF "automation_id", "model_credential_id" ON "automation_versions"
FOR EACH ROW EXECUTE FUNCTION "validate_automation_version_scope"();--> statement-breakpoint

CREATE FUNCTION "validate_automation_version_link_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_organization_id uuid;
  resource_organization_id uuid;
BEGIN
  SELECT automation."organization_id" INTO version_organization_id
  FROM "automation_versions" AS version
  JOIN "automations" AS automation ON automation."id" = version."automation_id"
  WHERE version."id" = NEW."automation_version_id";

  IF TG_TABLE_NAME = 'automation_version_integration_accounts' THEN
    SELECT "organization_id" INTO resource_organization_id
    FROM "integration_accounts" WHERE "id" = NEW."integration_account_id";
  ELSIF TG_TABLE_NAME = 'automation_version_repositories' THEN
    SELECT account."organization_id" INTO resource_organization_id
    FROM "repositories" AS repository
    JOIN "integration_accounts" AS account ON account."id" = repository."integration_account_id"
    WHERE repository."id" = NEW."repository_id";
  ELSIF TG_TABLE_NAME = 'automation_version_secrets' THEN
    SELECT "organization_id" INTO resource_organization_id
    FROM "workspace_secrets" WHERE "id" = NEW."workspace_secret_id";
  END IF;

  IF version_organization_id IS NULL
    OR resource_organization_id IS DISTINCT FROM version_organization_id THEN
    RAISE EXCEPTION 'automation version links must remain organization scoped' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "automation_version_integration_accounts_scope_trigger"
BEFORE INSERT OR UPDATE ON "automation_version_integration_accounts"
FOR EACH ROW EXECUTE FUNCTION "validate_automation_version_link_scope"();--> statement-breakpoint
CREATE TRIGGER "automation_version_repositories_scope_trigger"
BEFORE INSERT OR UPDATE ON "automation_version_repositories"
FOR EACH ROW EXECUTE FUNCTION "validate_automation_version_link_scope"();--> statement-breakpoint
CREATE TRIGGER "automation_version_secrets_scope_trigger"
BEFORE INSERT OR UPDATE ON "automation_version_secrets"
FOR EACH ROW EXECUTE FUNCTION "validate_automation_version_link_scope"();--> statement-breakpoint

CREATE FUNCTION "prevent_automation_resource_ownership_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'repositories' THEN
    IF NEW."integration_account_id" IS DISTINCT FROM OLD."integration_account_id" THEN
      RAISE EXCEPTION 'repository integration ownership is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."organization_id" IS DISTINCT FROM OLD."organization_id" THEN
    RAISE EXCEPTION 'automation resource organization ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "automations_organization_immutable_trigger"
BEFORE UPDATE OF "organization_id" ON "automations"
FOR EACH ROW EXECUTE FUNCTION "prevent_automation_resource_ownership_change"();--> statement-breakpoint
CREATE TRIGGER "organization_model_credentials_organization_immutable_trigger"
BEFORE UPDATE OF "organization_id" ON "organization_model_credentials"
FOR EACH ROW EXECUTE FUNCTION "prevent_automation_resource_ownership_change"();--> statement-breakpoint
CREATE TRIGGER "integration_accounts_organization_immutable_trigger"
BEFORE UPDATE OF "organization_id" ON "integration_accounts"
FOR EACH ROW EXECUTE FUNCTION "prevent_automation_resource_ownership_change"();--> statement-breakpoint
CREATE TRIGGER "workspace_secrets_organization_immutable_trigger"
BEFORE UPDATE OF "organization_id" ON "workspace_secrets"
FOR EACH ROW EXECUTE FUNCTION "prevent_automation_resource_ownership_change"();--> statement-breakpoint
CREATE TRIGGER "repositories_integration_account_immutable_trigger"
BEFORE UPDATE OF "integration_account_id" ON "repositories"
FOR EACH ROW EXECUTE FUNCTION "prevent_automation_resource_ownership_change"();--> statement-breakpoint

CREATE FUNCTION "validate_automation_run_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "automations" AS automation
    JOIN "automation_versions" AS version
      ON version."automation_id" = automation."id"
    WHERE automation."id" = NEW."automation_id"
      AND automation."organization_id" = NEW."organization_id"
      AND version."id" = NEW."automation_version_id"
  ) THEN
    RAISE EXCEPTION 'automation run references must share one organization and automation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "automation_runs_scope_trigger"
BEFORE INSERT OR UPDATE OF "automation_id", "automation_version_id", "organization_id" ON "automation_runs"
FOR EACH ROW EXECUTE FUNCTION "validate_automation_run_scope"();
