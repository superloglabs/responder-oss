import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("error issues", () => {
  const migration = readFileSync(new URL("../../../../drizzle/0092_error_issues.sql", import.meta.url), "utf8");

  it("keeps one issue per fingerprint in a workspace", () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "error_issues_fingerprint_idx" ON "error_issues" USING btree ("organization_id","fingerprint")',
    );
  });

  it("removes issues with their workspace, and daily counts with their issue", () => {
    expect(migration).toMatch(/"error_issues_organization_id_organization_id_fk" FOREIGN KEY \("organization_id"\) REFERENCES "public"\."organization"\("id"\) ON DELETE cascade/u);
    expect(migration).toMatch(/FOREIGN KEY \("issue_id"\) REFERENCES "public"\."error_issues"\("id"\) ON DELETE cascade/u);
  });
});
