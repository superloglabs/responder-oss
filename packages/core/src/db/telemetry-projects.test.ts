import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("telemetry projects", () => {
  const migration = readFileSync(
    new URL("../../../../drizzle/0074_telemetry_projects.sql", import.meta.url),
    "utf8",
  );

  it("links each project to at most one workspace", () => {
    expect(migration).toContain('"project_id" uuid PRIMARY KEY NOT NULL');
  });

  it("removes the links with their workspace", () => {
    expect(migration).toMatch(
      /FOREIGN KEY \("organization_id"\) REFERENCES "public"\."organization"\("id"\) ON DELETE cascade/u,
    );
  });
});
