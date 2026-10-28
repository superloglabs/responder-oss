CREATE TABLE "source_maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"debug_id" uuid NOT NULL,
	"file" text NOT NULL,
	"release" text,
	"content" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_maps" ADD CONSTRAINT "source_maps_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_maps_debug_id_idx" ON "source_maps" USING btree ("organization_id","debug_id");--> statement-breakpoint
CREATE INDEX "source_maps_created_at_idx" ON "source_maps" USING btree ("created_at");