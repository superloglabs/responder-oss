import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import { webhookTenantState } from "./webhook-tenants.js";

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));

function databaseReturning(rows: Array<{ paused: string | null }>) {
  const where = vi.fn().mockResolvedValue(rows);
  const database = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ leftJoin: vi.fn(() => ({ where })) })) })),
  };
  vi.mocked(getDatabase).mockReturnValue(database as never);
  return where;
}

describe("webhook tenant state", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("counts only connections of a Linear tenant's app", async () => {
    vi.stubEnv("LINEAR_CLIENT_ID", "current-client");
    vi.stubEnv("LINEAR_CLIENT_SECRET", "current-secret");
    const where = databaseReturning([]);

    await expect(webhookTenantState({ appId: "earlier-client", key: "linear-org", provider: "linear" }))
      .resolves.toEqual({ active: false, held: false });

    const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0]);
    expect(query.sql).toContain("->>'clientId' =");
    expect(query.params).toContain("earlier-client");
  });

  it("ignores the app for tenants that do not name one", async () => {
    const where = databaseReturning([{ paused: null }]);

    await expect(webhookTenantState({ key: "T123", provider: "slack" }))
      .resolves.toEqual({ active: true, held: true });

    expect(new PgDialect().sqlToQuery(where.mock.calls[0]![0]).sql).not.toContain("clientId");
  });
});
