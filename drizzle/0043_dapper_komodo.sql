ALTER TABLE "issues" ADD COLUMN "source_investigation_id" uuid;--> statement-breakpoint
UPDATE "issues"
SET "source_investigation_id" = (
	SELECT "investigation_issues"."investigation_id"
	FROM "investigation_issues"
	WHERE "investigation_issues"."issue_id" = "issues"."id"
		AND "investigation_issues"."relationship" = 'new'
	ORDER BY
		"investigation_issues"."created_at" ASC,
		"investigation_issues"."investigation_id" ASC
	LIMIT 1
);--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_source_investigation_id_investigations_id_fk" FOREIGN KEY ("source_investigation_id") REFERENCES "public"."investigations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_source_investigation_idx" ON "issues" USING btree ("source_investigation_id");
