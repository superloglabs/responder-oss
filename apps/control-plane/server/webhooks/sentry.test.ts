import { createHash, createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findAgentsForSentryIssue } from "../../../../packages/core/src/db/agents.js";
import { deleteIntegrationAccountsByExternalId } from "../../../../packages/core/src/db/integrations.js";
import { queueInvestigation } from "../investigations/queue.js";
import { sentryWebhookRoutes, verifySentrySignature } from "./sentry.js";

vi.mock("../../../../packages/core/src/db/agents.js", () => ({
  findAgentsForSentryIssue: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  deleteIntegrationAccountsByExternalId: vi.fn(),
}));

vi.mock("../investigations/queue.js", () => ({
  queueInvestigation: vi.fn(),
}));

const app = new Hono().route("/api/webhooks/sentry", sentryWebhookRoutes);

function signedIssueRequest(
  issueId: string,
  options: {
    action?: "created" | "unresolved" | "resolved";
    lastSeen?: string;
  } = {},
) {
  const body = JSON.stringify({
    action: options.action ?? "created",
    installation: { uuid: "60000000-0000-4000-8000-000000000000" },
    data: {
      issue: {
        id: issueId,
        shortId: `EXAMPLE-${issueId}`,
        title: `Example capacity error ${issueId}`,
        lastSeen: options.lastSeen ?? "2024-01-02T03:04:05.000Z",
        web_url: `https://example.sentry.io/issues/${issueId}/`,
        project: {
          id: "1234567890123456",
          name: "Example",
          slug: "example",
          platform: "javascript-nextjs",
        },
      },
    },
  });
  const signature = createHmac("sha256", "sentry-secret")
    .update(body, "utf8")
    .digest("hex");
  return { body, signature };
}

describe("Sentry issue webhooks", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the Sentry app client secret", () => {
    vi.stubEnv("SENTRY_CLIENT_SECRET", "current-client-secret");
    const rawBody = JSON.stringify({ action: "created" });
    const signature = createHmac("sha256", "current-client-secret")
      .update(rawBody, "utf8")
      .digest("hex");

    expect(verifySentrySignature({ rawBody, signature })).toBe(true);
  });

  it("fans one issue out to matching agents with agent-scoped idempotency keys", async () => {
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");
    const matches = Array.from({ length: 10 }, (_, index) => ({
      agentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      organizationId: "10000000-0000-4000-8000-000000000000",
    }));
    vi.mocked(findAgentsForSentryIssue).mockResolvedValue(matches);
    vi.mocked(queueInvestigation).mockResolvedValue({
      kind: "queued",
      investigationId: "20000000-0000-4000-8000-000000000000",
      jobId: "30000000-0000-4000-8000-000000000000",
    });
    const request = signedIssueRequest("1234567890");

    const response = await app.request("/api/webhooks/sentry", {
      method: "POST",
      body: request.body,
      headers: {
        "content-type": "application/json",
        "request-id": "request-1",
        "sentry-hook-resource": "issue",
        "sentry-hook-signature": request.signature,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      matchedAgents: 10,
    });
    await vi.waitFor(() => expect(queueInvestigation).toHaveBeenCalledTimes(10));

    const payloads = vi.mocked(queueInvestigation).mock.calls.map(([payload]) =>
      payload,
    );
    expect(new Set(payloads.map((payload) => payload.externalEventId)).size).toBe(
      10,
    );
    for (const payload of payloads) {
      expect(payload.externalEventId).toBe(
        `60000000-0000-4000-8000-000000000000:1234567890:${payload.agentId}`,
      );
      expect(payload).toMatchObject({
        provider: "sentry",
        title: "EXAMPLE-1234567890: Example capacity error 1234567890",
        attributes: {
          action: "created",
          projectId: "1234567890123456",
          projectName: "Example",
          requestId: "request-1",
          timestamp: "2024-01-02T03:04:05.000Z",
        },
      });
    }
  });

  it("gives each regression occurrence a distinct, retry-safe idempotency key", async () => {
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");
    vi.mocked(findAgentsForSentryIssue).mockResolvedValue([
      {
        agentId: "00000000-0000-4000-8000-000000000001",
        organizationId: "10000000-0000-4000-8000-000000000000",
      },
    ]);
    vi.mocked(queueInvestigation).mockResolvedValue({
      kind: "queued",
      investigationId: "20000000-0000-4000-8000-000000000000",
      jobId: "30000000-0000-4000-8000-000000000000",
    });

    const send = async (action: "created" | "unresolved", lastSeen: string) => {
      const request = signedIssueRequest("1234567890", { action, lastSeen });
      return app.request("/api/webhooks/sentry", {
        method: "POST",
        body: request.body,
        headers: {
          "sentry-hook-resource": "issue",
          "sentry-hook-signature": request.signature,
        },
      });
    };

    expect((await send("created", "2024-01-02T03:04:05.000Z")).status).toBe(200);
    expect(
      (await send("unresolved", "2024-01-03T09:00:00.000Z")).status,
    ).toBe(200);
    expect(
      (await send("unresolved", "2024-01-03T09:00:00.000Z")).status,
    ).toBe(200);
    expect(
      (await send("unresolved", "2024-01-03T10:00:00.000Z")).status,
    ).toBe(200);

    const payloads = vi.mocked(queueInvestigation).mock.calls.map(([payload]) =>
      payload,
    );
    const firstRegression = createHash("sha256")
      .update("2024-01-03T09:00:00.000Z", "utf8")
      .digest("hex");
    const secondRegression = createHash("sha256")
      .update("2024-01-03T10:00:00.000Z", "utf8")
      .digest("hex");
    expect(payloads.map((payload) => payload.externalEventId)).toEqual([
      "60000000-0000-4000-8000-000000000000:1234567890:00000000-0000-4000-8000-000000000001",
      `60000000-0000-4000-8000-000000000000:1234567890:unresolved:${firstRegression}:00000000-0000-4000-8000-000000000001`,
      `60000000-0000-4000-8000-000000000000:1234567890:unresolved:${firstRegression}:00000000-0000-4000-8000-000000000001`,
      `60000000-0000-4000-8000-000000000000:1234567890:unresolved:${secondRegression}:00000000-0000-4000-8000-000000000001`,
    ]);
    expect(payloads.map((payload) => payload.attributes?.action)).toEqual([
      "created",
      "unresolved",
      "unresolved",
      "unresolved",
    ]);
  });

  it("ignores unsupported issue actions without querying agents", async () => {
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");
    const request = signedIssueRequest("1234567892", { action: "resolved" });

    const response = await app.request("/api/webhooks/sentry", {
      method: "POST",
      body: request.body,
      headers: {
        "sentry-hook-resource": "issue",
        "sentry-hook-signature": request.signature,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(findAgentsForSentryIssue).not.toHaveBeenCalled();
  });

  it("removes local connections after a signed Sentry uninstall", async () => {
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");
    vi.mocked(deleteIntegrationAccountsByExternalId).mockResolvedValue(1);
    const body = JSON.stringify({
      action: "deleted",
      installation: { uuid: "60000000-0000-4000-8000-000000000000" },
    });
    const signature = createHmac("sha256", "sentry-secret")
      .update(body, "utf8")
      .digest("hex");

    const response = await app.request("/api/webhooks/sentry", {
      method: "POST",
      body,
      headers: {
        "sentry-hook-resource": "installation",
        "sentry-hook-signature": signature,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      removedAccounts: 1,
    });
    expect(deleteIntegrationAccountsByExternalId).toHaveBeenCalledWith({
      externalAccountId: "60000000-0000-4000-8000-000000000000",
      provider: "sentry",
    });
    expect(findAgentsForSentryIssue).not.toHaveBeenCalled();
  });

  it("ignores other signed Sentry installation events", async () => {
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");
    const body = JSON.stringify({
      action: "created",
      installation: { uuid: "60000000-0000-4000-8000-000000000000" },
    });
    const signature = createHmac("sha256", "sentry-secret")
      .update(body, "utf8")
      .digest("hex");

    const response = await app.request("/api/webhooks/sentry", {
      method: "POST",
      body,
      headers: {
        "sentry-hook-resource": "installation",
        "sentry-hook-signature": signature,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(deleteIntegrationAccountsByExternalId).not.toHaveBeenCalled();
  });

  it("returns a retryable failure when an agent handoff fails", async () => {
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");
    vi.mocked(findAgentsForSentryIssue).mockResolvedValue([
      {
        agentId: "00000000-0000-4000-8000-000000000001",
        organizationId: "10000000-0000-4000-8000-000000000000",
      },
    ]);
    vi.mocked(queueInvestigation).mockRejectedValue(
      new Error("Investigation worker is unavailable"),
    );
    const request = signedIssueRequest("1234567891");

    const response = await app.request("/api/webhooks/sentry", {
      method: "POST",
      body: request.body,
      headers: {
        "sentry-hook-resource": "issue",
        "sentry-hook-signature": request.signature,
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Unable to start Sentry investigation",
    });
  });
});
