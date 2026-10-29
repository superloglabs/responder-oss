import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linearAccountOfApp } from "./linear-agent-sessions.js";

describe("Linear connections of an app", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("counts connections that record no app as the default app's", () => {
    vi.stubEnv("LINEAR_CLIENT_ID", "current-client");
    vi.stubEnv("LINEAR_CLIENT_SECRET", "current-secret");

    const query = new PgDialect().sqlToQuery(linearAccountOfApp("current-client")!);

    expect(query.sql).toContain("->>'clientId' is null");
    expect(query.params).toEqual(["current-client"]);
  });

  it("matches only connections that record an additional app", () => {
    vi.stubEnv("LINEAR_CLIENT_ID", "current-client");
    vi.stubEnv("LINEAR_CLIENT_SECRET", "current-secret");

    const query = new PgDialect().sqlToQuery(linearAccountOfApp("earlier-client")!);

    expect(query.sql).not.toContain("is null");
    expect(query.params).toEqual(["earlier-client"]);
  });
});
