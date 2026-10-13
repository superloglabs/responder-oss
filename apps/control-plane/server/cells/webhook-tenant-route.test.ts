import { afterEach, describe, expect, it, vi } from "vitest";

const hasWebhookTenant = vi.hoisted(() => vi.fn());
vi.mock("../../../../packages/core/src/db/webhook-tenants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../packages/core/src/db/webhook-tenants.js")>()),
  hasWebhookTenant,
}));

import { app } from "../app.js";

const ask = (body: unknown, token?: string) =>
  app.request("/api/internal/cells/webhook-tenant", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    method: "POST",
  });

describe("webhook tenant route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("answers another cell that presents the shared cell token", async () => {
    vi.stubEnv("RESPONDER_CELL_TOKEN", "cell-token");
    hasWebhookTenant.mockResolvedValue(true);

    const response = await ask({ key: "T123", provider: "slack" }, "cell-token");

    await expect(response.json()).resolves.toEqual({ held: true });
    expect(hasWebhookTenant).toHaveBeenCalledWith({ key: "T123", provider: "slack" });
  });

  it("rejects callers without the token, and every caller when no token is configured", async () => {
    vi.stubEnv("RESPONDER_CELL_TOKEN", "cell-token");
    expect((await ask({ key: "T123", provider: "slack" }, "wrong")).status).toBe(401);
    vi.stubEnv("RESPONDER_CELL_TOKEN", "");
    expect((await ask({ key: "T123", provider: "slack" }, "")).status).toBe(401);
    vi.stubEnv("INTERNAL_INGEST_TOKEN", "internal-token");
    expect((await ask({ key: "T123", provider: "slack" }, "internal-token")).status).toBe(401);
    expect(hasWebhookTenant).not.toHaveBeenCalled();
  });

  it("rejects an invalid tenant", async () => {
    vi.stubEnv("RESPONDER_CELL_TOKEN", "cell-token");

    const response = await ask({ key: "not-a-uuid", provider: "integration_account" }, "cell-token");

    expect(response.status).toBe(400);
  });
});
