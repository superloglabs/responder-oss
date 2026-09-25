ALTER TABLE "automation_version_repositories" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Existing links were inserted in the order the user chose them.
UPDATE "automation_version_repositories" AS link SET "position" = ordered."position"
FROM (
	SELECT "automation_version_id", "repository_id", row_number() OVER (PARTITION BY "automation_version_id" ORDER BY ctid) - 1 AS "position"
	FROM "automation_version_repositories"
) AS ordered
WHERE link."automation_version_id" = ordered."automation_version_id" AND link."repository_id" = ordered."repository_id";
