ALTER TABLE "sandbox_images" ADD COLUMN "snapshot_start_command" text;--> statement-breakpoint
-- Snapshots built before this column run with the start command saved now.
UPDATE "sandbox_images" SET "snapshot_start_command" = "sandbox_image_settings"."start_command"
FROM "sandbox_image_settings"
WHERE "sandbox_image_settings"."organization_id" = "sandbox_images"."organization_id"
  AND "sandbox_images"."snapshot_id" IS NOT NULL;
