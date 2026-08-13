ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "last_organization_id" uuid;--> statement-breakpoint
UPDATE "user" AS selected_user
SET "last_organization_id" = recent_session."organization_id"
FROM (
	SELECT DISTINCT ON (active_session."user_id")
		active_session."user_id",
		active_session."active_organization_id"::uuid AS "organization_id"
	FROM "session" AS active_session
	INNER JOIN "member" AS active_membership
		ON active_membership."user_id" = active_session."user_id"
		AND active_membership."organization_id"::text = active_session."active_organization_id"
	WHERE active_session."active_organization_id" IS NOT NULL
	ORDER BY active_session."user_id", active_session."updated_at" DESC
) AS recent_session
WHERE selected_user."id" = recent_session."user_id"
	AND selected_user."last_organization_id" IS NULL;
