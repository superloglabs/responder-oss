ALTER TABLE "sandbox_images" ADD COLUMN "snapshot_start_command" text;--> statement-breakpoint
-- A snapshot built from the saved settings runs with the saved start command.
-- One kept while a changed build is pending or running gets none.
UPDATE "sandbox_images" SET "snapshot_start_command" = "sandbox_image_settings"."start_command"
FROM "sandbox_image_settings"
WHERE "sandbox_image_settings"."organization_id" = "sandbox_images"."organization_id"
  AND "sandbox_images"."snapshot_id" IS NOT NULL
  AND "sandbox_images"."snapshot_key" = "sandbox_images"."key"
  AND ("sandbox_image_settings"."image_requested_at" IS NULL
    OR "sandbox_image_settings"."image_requested_at" <= "sandbox_images"."started_at");
