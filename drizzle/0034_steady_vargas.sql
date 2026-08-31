UPDATE "issues"
SET "remediations" = COALESCE((
  SELECT jsonb_agg(
    CASE
      WHEN value->>'type' = 'code_change'
        AND value ? 'diff'
        AND NOT value ? 'changes'
      THEN (value - 'diff') || jsonb_build_object(
        'changes', jsonb_build_array(
          jsonb_build_object('repository', NULL, 'diff', value->>'diff')
        )
      )
      ELSE value
    END
  )
  FROM jsonb_array_elements("issues"."remediations") AS value
), '[]'::jsonb)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements("issues"."remediations") AS value
  WHERE value->>'type' = 'code_change'
    AND value ? 'diff'
    AND NOT value ? 'changes'
);--> statement-breakpoint
DROP INDEX "issue_pull_requests_active_issue_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "issue_pull_requests_active_issue_repository_idx" ON "issue_pull_requests" USING btree ("issue_id","repository_full_name") WHERE "status" in ('queued', 'creating', 'created') and "repository_full_name" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_pull_requests_active_issue_idx" ON "issue_pull_requests" USING btree ("issue_id") WHERE "status" in ('queued', 'creating', 'created') and "repository_full_name" is null;
