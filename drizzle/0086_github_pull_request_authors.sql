CREATE TABLE "github_member_pull_request_branches" (
	"repository_full_name" text NOT NULL,
	"branch" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_member_pull_request_branches_repository_full_name_branch_pk" PRIMARY KEY("repository_full_name","branch")
);
--> statement-breakpoint
CREATE TABLE "github_pull_request_authors" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_member_pull_request_branches" ADD CONSTRAINT "github_member_pull_request_branches_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pull_request_authors" ADD CONSTRAINT "github_pull_request_authors_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pull_request_authors" ADD CONSTRAINT "github_pull_request_authors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_member_pull_request_branches_organization_idx" ON "github_member_pull_request_branches" USING btree ("organization_id");