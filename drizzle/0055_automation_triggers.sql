ALTER TABLE "automation_versions" ALTER COLUMN "trigger" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD COLUMN "triggers" jsonb;--> statement-breakpoint
-- Each existing version has the one trigger it was saved with.
UPDATE "automation_versions" SET "triggers" = jsonb_build_array("trigger");--> statement-breakpoint
ALTER TABLE "automation_versions" ALTER COLUMN "triggers" SET NOT NULL;
