CREATE TABLE "automation_version_skills" (
	"automation_version_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	CONSTRAINT "automation_version_skills_automation_version_id_skill_id_pk" PRIMARY KEY("automation_version_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_skill_files" (
	"skill_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "workspace_skill_files_skill_id_path_pk" PRIMARY KEY("skill_id","path")
);
--> statement-breakpoint
CREATE TABLE "workspace_skill_secrets" (
	"skill_id" uuid NOT NULL,
	"workspace_secret_id" uuid NOT NULL,
	CONSTRAINT "workspace_skill_secrets_skill_id_workspace_secret_id_pk" PRIMARY KEY("skill_id","workspace_secret_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"instructions" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_version_skills" ADD CONSTRAINT "automation_version_skills_automation_version_id_automation_versions_id_fk" FOREIGN KEY ("automation_version_id") REFERENCES "public"."automation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_version_skills" ADD CONSTRAINT "automation_version_skills_skill_id_workspace_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."workspace_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skill_files" ADD CONSTRAINT "workspace_skill_files_skill_id_workspace_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."workspace_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skill_secrets" ADD CONSTRAINT "workspace_skill_secrets_skill_id_workspace_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."workspace_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skill_secrets" ADD CONSTRAINT "workspace_skill_secrets_workspace_secret_id_workspace_secrets_id_fk" FOREIGN KEY ("workspace_secret_id") REFERENCES "public"."workspace_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_version_skills_skill_idx" ON "automation_version_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_skills_organization_name_idx" ON "workspace_skills" USING btree ("organization_id","name");--> statement-breakpoint
CREATE FUNCTION "validate_workspace_skill_link_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_organization_id uuid;
  skill_organization_id uuid;
BEGIN
  SELECT "organization_id" INTO skill_organization_id
  FROM "workspace_skills" WHERE "id" = NEW."skill_id";

  IF TG_TABLE_NAME = 'workspace_skill_secrets' THEN
    SELECT "organization_id" INTO owner_organization_id
    FROM "workspace_secrets" WHERE "id" = NEW."workspace_secret_id";
  ELSIF TG_TABLE_NAME = 'automation_version_skills' THEN
    SELECT automation."organization_id" INTO owner_organization_id
    FROM "automation_versions" AS version
    JOIN "automations" AS automation ON automation."id" = version."automation_id"
    WHERE version."id" = NEW."automation_version_id";
  END IF;

  IF skill_organization_id IS NULL
    OR owner_organization_id IS DISTINCT FROM skill_organization_id THEN
    RAISE EXCEPTION 'workspace skill links must remain organization scoped' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "workspace_skill_secrets_scope_trigger"
BEFORE INSERT OR UPDATE ON "workspace_skill_secrets"
FOR EACH ROW EXECUTE FUNCTION "validate_workspace_skill_link_scope"();--> statement-breakpoint
CREATE TRIGGER "automation_version_skills_scope_trigger"
BEFORE INSERT OR UPDATE ON "automation_version_skills"
FOR EACH ROW EXECUTE FUNCTION "validate_workspace_skill_link_scope"();--> statement-breakpoint
CREATE TRIGGER "workspace_skills_organization_immutable_trigger"
BEFORE UPDATE OF "organization_id" ON "workspace_skills"
FOR EACH ROW EXECUTE FUNCTION "prevent_automation_resource_ownership_change"();
