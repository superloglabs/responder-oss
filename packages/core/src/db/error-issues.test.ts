import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

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

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));

it("scopes combined filters and tie-breaking pagination to the workspace", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const { getDatabase } = await import("./client.js");
  const { listErrorIssues } = await import("./error-issues.js");
  const limit = vi.fn().mockResolvedValue([]);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  vi.mocked(getDatabase).mockReturnValue({ select: () => ({ from: () => ({ where }) }) } as never);
  await listErrorIssues("workspace-a", {
    limit: 50, statuses: ["open", "resolved"], services: ["api", "worker"], environments: ["production"],
    activity: "inactive", activeSince: "2026-10-23T11:45:00.000Z", since: "2026-10-22T12:00:00.000Z", search: "100%_error",
    sort: "events", before: { id: "11111111-1111-4111-8111-111111111111", lastSeenAt: "2026-10-23T11:00:00Z", eventCount: 10 },
  });
  const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0]);
  expect(query.sql).toContain('"error_issues"."organization_id" =');
  expect(query.sql).toContain('"error_issues"."status" in');
  expect(query.sql).toContain('"error_issues"."service" in');
  expect(query.sql).toContain("deployment.environment.name");
  expect(query.sql).toContain('"error_issues"."last_seen_at" <');
  expect(query.sql).toContain('"error_issues"."event_count" <');
  expect(query.sql).toContain('"error_issues"."id" <');
  expect(query.params).toEqual(expect.arrayContaining(["workspace-a", "open", "resolved", "api", "worker", "production", "2026-10-23T11:45:00.000Z", 10]));
  expect(query.params).toContain("%100\\%\\_error%");
  expect(limit).toHaveBeenCalledWith(50);
});
