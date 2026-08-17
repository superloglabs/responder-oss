LOCK TABLE "issue_pull_requests" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
WITH "ranked_active_requests" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "issue_id"
			ORDER BY
				CASE "status"
					WHEN 'created' THEN 1
					WHEN 'creating' THEN 2
					WHEN 'queued' THEN 3
					ELSE 4
				END,
				("pull_request_url" IS NOT NULL) DESC,
				("eve_session_id" IS NOT NULL) DESC,
				"updated_at" DESC,
				"created_at",
				"id"
		) AS "active_rank"
	FROM "issue_pull_requests"
	WHERE "status" in ('queued', 'creating', 'created')
)
UPDATE "issue_pull_requests" AS "request"
SET
	"status" = 'failed',
	"failure_reason" = COALESCE(
		"request"."failure_reason",
		'Superseded by another active pull request during database migration'
	),
	"completed_at" = COALESCE("request"."completed_at", now()),
	"updated_at" = now()
FROM "ranked_active_requests" AS "ranked"
WHERE "request"."id" = "ranked"."id"
	AND "ranked"."active_rank" > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_pull_requests_active_issue_idx" ON "issue_pull_requests" USING btree ("issue_id") WHERE "status" in ('queued', 'creating', 'created');--> statement-breakpoint
LOCK TABLE "integration_connection_states" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DELETE FROM "integration_connection_states"
WHERE "expires_at" <= now();--> statement-breakpoint
WITH "ranked_connection_states" AS (
	SELECT
		"state_hash",
		row_number() OVER (
			PARTITION BY "organization_id", "user_id", "provider"
			ORDER BY "expires_at" DESC, "created_at" DESC, "state_hash" DESC
		) AS "state_rank"
	FROM "integration_connection_states"
)
DELETE FROM "integration_connection_states" AS "connection_state"
USING "ranked_connection_states" AS "ranked"
WHERE "connection_state"."state_hash" = "ranked"."state_hash"
	AND "ranked"."state_rank" > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connection_states_owner_provider_idx" ON "integration_connection_states" USING btree ("organization_id", "user_id", "provider");
--> statement-breakpoint
LOCK TABLE "integration_accounts" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
UPDATE "integration_accounts" AS "legacy"
SET
	"external_account_id" = btrim("legacy"."metadata" ->> 'workspaceId'),
	"updated_at" = now()
WHERE "legacy"."provider" = 'linear'
	AND "legacy"."external_account_id" = 'https://mcp.linear.app/mcp'
	AND NULLIF(btrim("legacy"."metadata" ->> 'workspaceId'), '') IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM "integration_accounts" AS "current"
		WHERE "current"."organization_id" = "legacy"."organization_id"
			AND "current"."provider" = 'linear'
			AND "current"."external_account_id" = btrim("legacy"."metadata" ->> 'workspaceId')
			AND "current"."id" <> "legacy"."id"
	);--> statement-breakpoint
UPDATE "integration_accounts"
SET
	"status" = 'error',
	"encrypted_credentials" = NULL,
	"credential_key_version" = NULL,
	"metadata" = "metadata" || '{"legacyAccountRetired":true}'::jsonb,
	"updated_at" = now()
WHERE "provider" = 'linear'
	AND "external_account_id" = 'https://mcp.linear.app/mcp';
