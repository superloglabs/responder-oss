CREATE TABLE "legacy_mcp_forward_assertions" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_mcp_forwards" (
	"legacy_project_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_mcp_forwards_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
ALTER TABLE "legacy_mcp_forwards" ADD CONSTRAINT "legacy_mcp_forwards_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_mcp_forward_assertions_expires_at_idx" ON "legacy_mcp_forward_assertions" USING btree ("expires_at");