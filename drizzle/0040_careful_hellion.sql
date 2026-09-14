CREATE TABLE "codebase_knowledge_bases" (
	"repository_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"overview" text,
	"documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"diagrams" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repository_revisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_reason" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"generated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "codebase_knowledge_bases" ADD CONSTRAINT "codebase_knowledge_bases_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "codebase_knowledge_bases_status_idx" ON "codebase_knowledge_bases" USING btree ("status");
