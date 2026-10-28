import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managementMcpRoutes } from "./mcp.js";
import { managementApiRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const apiKeyId = "31313131-3131-4131-8131-313131313131";
const checkId = "61616161-6161-4161-8161-616161616161";
const slackAccountId = "71717171-7171-4171-8171-717171717171";
const token = `slk_${"a".repeat(43)}`;

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  capabilities: new Set<string>(),
  createCheck: vi.fn(),
  deleteCheck: vi.fn(),
  findCheck: vi.fn(),
  listChecks: vi.fn(),
  slackChannels: vi.fn(),
  updateCheck: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/api-keys.js", () => ({
  authenticateApiKey: mocks.authenticate,
  listApiKeys: vi.fn().mockResolvedValue([]),
  revokeApiKey: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/oauth-access-tokens.js", () => ({
  authenticateOAuthAccessToken: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  listEnabledOrganizationCapabilities: vi.fn().mockResolvedValue([]),
  organizationHasCapability: vi.fn(async (_organization: string, capability: string) => mocks.capabilities.has(capability)),
}));
vi.mock("../../../../packages/core/src/db/synthetic-checks.js", () => ({
  createSyntheticCheck: mocks.createCheck,
  deleteSyntheticCheck: mocks.deleteCheck,
  findSyntheticCheck: mocks.findCheck,
  listSyntheticChecks: mocks.listChecks,
  updateSyntheticCheck: mocks.updateCheck,
}));
vi.mock("../../../../packages/core/src/db/telemetry-alerts.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listTelemetryAlertSlackChannels: mocks.slackChannels,
}));

const app = new Hono()
  .route("/api/v1", managementApiRoutes)
  .route("/api/mcp", managementMcpRoutes);

function api(path: string, method = "GET", body?: unknown) {
  return app.request(`/api/v1${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method,
  });
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const response = await app.request("/api/mcp", {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const { result } = await response.json() as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return { body: JSON.parse(result.content[0]!.text) as Record<string, unknown>, isError: result.isError };
}

const slack = { channelId: "C0123", integrationAccountId: slackAccountId };
const check = {
  assertions: [{ kind: "status_code", op: "eq", severity: "critical", value: "2xx" }],
  body: null,
  consecutiveFailures: 0,
  createdAt: "2026-10-28T10:00:00.000Z",
  enabled: true,
  failuresToAlert: 2,
  followRedirects: true,
  headers: [
    { name: "Accept", secret: false, value: "application/json" },
    { name: "Authorization", secret: true, value: "" },
  ],
  id: checkId,
  intervalSeconds: 60,
  lastRunAt: null,
  lastStatus: null,
  method: "GET",
  name: "API health",
  retries: 1,
  slack,
  statusSince: null,
  timeoutMs: 10_000,
  updatedAt: "2026-10-28T10:00:00.000Z",
  url: "https://api.example.com/health",
};

describe("synthetic check operations", () => {
  beforeEach(() => {
    mocks.authenticate.mockResolvedValue({
      apiKeyId,
      organizationId,
      role: "member",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });
    mocks.capabilities = new Set(["alerts"]);
    mocks.slackChannels.mockResolvedValue([{ ...slack, accountName: "Acme", name: "alerts", private: false }]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists checks with links to them", async () => {
    mocks.listChecks.mockResolvedValue([{ ...check, averageDurationMs: 120, recent: ["passed"], uptime: 1 }]);

    const response = await api("/synthetic-checks");
    const body = await response.json() as { checks: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(mocks.listChecks).toHaveBeenCalledWith(organizationId);
    expect(body.checks[0]).toMatchObject({
      id: checkId,
      uptime: 1,
      url: check.url,
      webUrl: expect.stringMatching(new RegExp(`/synthetics/${checkId}$`, "u")),
    });
    expect(body.checks[0]).not.toHaveProperty("consecutiveFailures");
  });

  it("creates a check as the caller with the editor's defaults", async () => {
    mocks.createCheck.mockResolvedValue({ check });

    const response = await api("/synthetic-checks", "POST", {
      headers: [{ name: "Authorization", secret: true, value: "Bearer s3cret" }],
      name: "API health",
      slack,
      url: "https://api.example.com/health",
    });

    expect(response.status).toBe(201);
    expect(mocks.createCheck).toHaveBeenCalledWith(organizationId, {
      assertions: [],
      body: null,
      createdBy: userId,
      enabled: true,
      failuresToAlert: 1,
      followRedirects: true,
      headers: [{ name: "Authorization", secret: true, value: "Bearer s3cret" }],
      intervalSeconds: 300,
      method: "GET",
      name: "API health",
      retries: 1,
      slack,
      timeoutMs: 10_000,
      url: "https://api.example.com/health",
    });
  });

  it("refuses a request the editor would refuse", async () => {
    const badInterval = await api("/synthetic-checks", "POST", { intervalSeconds: 120, name: "API", url: "https://example.com" });
    expect(badInterval.status).toBe(400);

    const getWithBody = await api("/synthetic-checks", "POST", { body: "{}", name: "API", url: "https://example.com" });
    expect(getWithBody.status).toBe(400);

    const badAssertion = await callTool("create_synthetic_check", {
      assertions: [{ kind: "response_time", op: "gt", value: "500" }],
      name: "API",
      url: "https://example.com",
    });
    expect(badAssertion.body.code).toBe("invalid_request");
    expect(mocks.createCheck).not.toHaveBeenCalled();
  });

  it("refuses a Slack channel the workspace cannot post to", async () => {
    const result = await callTool("create_synthetic_check", {
      name: "API",
      slack: { channelId: "C9999", integrationAccountId: slackAccountId },
      url: "https://example.com",
    });

    expect(result.body.code).toBe("slack_channel_unavailable");
    expect(mocks.createCheck).not.toHaveBeenCalled();
  });

  it("keeps secret header values out of MCP", async () => {
    const result = await callTool("create_synthetic_check", {
      headers: [{ name: "Authorization", secret: true, value: "Bearer s3cret" }],
      name: "API",
      url: "https://example.com",
    });

    expect(result.body.code).toBe("secret_header_value");
    expect(mocks.createCheck).not.toHaveBeenCalled();
  });

  it("changes the fields sent and keeps saved secrets", async () => {
    mocks.findCheck.mockResolvedValue(check);
    mocks.updateCheck.mockResolvedValue({ check: { ...check, intervalSeconds: 300 } });

    const result = await callTool("update_synthetic_check", { checkId, intervalSeconds: 300 });

    expect(result.isError).toBeUndefined();
    expect(mocks.updateCheck).toHaveBeenCalledWith(organizationId, checkId, expect.objectContaining({
      headers: [
        { name: "Accept", secret: false, value: "application/json" },
        { name: "Authorization", secret: true, value: null },
      ],
      intervalSeconds: 300,
      name: "API health",
      slack,
    }));
    // The saved channel is not checked again when it does not change.
    expect(mocks.slackChannels).not.toHaveBeenCalled();
  });

  it("asks for a change when an update sends none", async () => {
    expect((await callTool("update_synthetic_check", { checkId })).body.code).toBe("nothing_to_update");
    expect(mocks.updateCheck).not.toHaveBeenCalled();
  });

  it("reports checks that are gone", async () => {
    mocks.findCheck.mockResolvedValue(null);
    expect((await api(`/synthetic-checks/${checkId}`)).status).toBe(404);
    expect((await callTool("update_synthetic_check", { checkId, name: "API" })).body.code).toBe("synthetic_check_not_found");

    mocks.deleteCheck.mockResolvedValue(false);
    expect((await api(`/synthetic-checks/${checkId}`, "DELETE")).status).toBe(404);
    mocks.deleteCheck.mockResolvedValue(true);
    expect(await (await api(`/synthetic-checks/${checkId}`, "DELETE")).json()).toEqual({ deleted: true });
  });

  it("lists the Slack channels alerts and checks can post to", async () => {
    const response = await api("/slack-channels");

    expect(await response.json()).toEqual({
      channels: [{ ...slack, accountName: "Acme", name: "alerts", private: false }],
    });
  });

  it("is unavailable without alerts", async () => {
    mocks.capabilities = new Set();

    expect((await callTool("list_synthetic_checks")).body.code).toBe("synthetics_unavailable");
    expect((await api("/slack-channels")).status).toBe(404);
    expect(mocks.listChecks).not.toHaveBeenCalled();
    expect(mocks.slackChannels).not.toHaveBeenCalled();
  });
});
