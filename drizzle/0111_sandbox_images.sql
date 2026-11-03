CREATE TABLE "sandbox_image_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"packages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"setup_script" text DEFAULT '' NOT NULL,
	"start_command" text DEFAULT '' NOT NULL,
	"vcpus" integer DEFAULT 2 NOT NULL,
	"image_requested_at" timestamp with time zone,
	"rebuild_requested_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_image_settings_vcpus_check" CHECK ("sandbox_image_settings"."vcpus" IN (2, 4, 8))
);
--> statement-breakpoint
CREATE TABLE "sandbox_image_snapshot_deletions" (
	"snapshot_id" text PRIMARY KEY NOT NULL,
	"delete_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_images" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"log" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"snapshot_id" text,
	"snapshot_key" text,
	"snapshot_base_id" text,
	"snapshot_region" text,
	"snapshot_built_at" timestamp with time zone,
	CONSTRAINT "sandbox_images_status_check" CHECK ("sandbox_images"."status" IN ('building', 'failed', 'ready'))
);
--> statement-breakpoint
ALTER TABLE "sandbox_image_settings" ADD CONSTRAINT "sandbox_image_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_image_settings" ADD CONSTRAINT "sandbox_image_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_images" ADD CONSTRAINT "sandbox_images_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_image_snapshot_deletions_due_idx" ON "sandbox_image_snapshot_deletions" USING btree ("delete_after");--> statement-breakpoint
CREATE FUNCTION "queue_sandbox_image_snapshot_deletion"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."snapshot_id" IS NOT NULL AND (TG_OP = 'DELETE' OR NEW."snapshot_id" IS DISTINCT FROM OLD."snapshot_id") THEN
    -- Runs that read the old snapshot just before the change may still be
    -- starting from it.
    INSERT INTO "sandbox_image_snapshot_deletions" ("snapshot_id", "delete_after")
    VALUES (OLD."snapshot_id", now() + interval '1 minute')
    ON CONFLICT ("snapshot_id") DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "sandbox_images_snapshot_deletion_trigger"
AFTER UPDATE OF "snapshot_id" OR DELETE ON "sandbox_images"
FOR EACH ROW EXECUTE FUNCTION "queue_sandbox_image_snapshot_deletion"();
