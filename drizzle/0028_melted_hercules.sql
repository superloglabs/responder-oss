ALTER TABLE "issue_pull_requests" ADD COLUMN "remediation_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "remediations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "issues"
SET "remediations" = jsonb_build_array(
  jsonb_build_object(
    'id', gen_random_uuid()::text,
    'type', 'external_action',
    'title', 'Recommended remediation',
    'description', "remediation",
    'agentPrompt', concat(
      'Address this issue in the appropriate external system.', E'\n\n',
      'Issue: ', "title", E'\n',
      'Description: ', "description", E'\n',
      'Recommended action: ', "remediation"
    )
  )
)
WHERE jsonb_array_length("remediations") = 0;
