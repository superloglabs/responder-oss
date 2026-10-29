import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managementMcpRoutes } from "./mcp.js";
import { managementApiRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const apiKeyId = "31313131-3131-4131-8131-313131313131";
const integrationAccountId = "51515151-5151-4151-8151-515151515151";
const token = `slk_${"a".repeat(43)}`;

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  capability: vi.fn(),
  channels: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
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
  organizationHasCapability: mocks.capability,
}));
vi.mock("../../../../packages/core/src/db/error-notifications.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getErrorNotificationSettings: mocks.get,
  saveErrorNotificationSettings: mocks.save,
}));
vi.mock("../../../../packages/core/src/db/telemetry-alerts.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listTelemetryAlertSlackChannels: mocks.channels,
}));

const app = new Hono()
  .route("/api/v1", managementApiRoutes)
  .route("/api/mcp", managementMcpRoutes);

async function mcp(method: string, params?: Record<string, unknown>) {
  const response = await app.request("/api/mcp", {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  return ((await response.json()) as { result: Record<string, unknown> }).result;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await mcp("tools/call", { arguments: args, name }) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { body: JSON.parse(result.content[0]!.text) as Record<string, unknown>, isError: result.isError };
}

const channel = { accountName: "Acme", channelId: "C0123ABCD", integrationAccountId, metadata: {}, name: "errors" };
const slack = { channelId: "C0123ABCD", integrationAccountId };

describe("error notification operations", () => {
  let stored = { enabled: false, targets: [] as Array<Record<string, string>> };

  beforeEach(() => {
    stored = { enabled: false, targets: [] };
    mocks.authenticate.mockResolvedValue({
      apiKeyId,
      organizationId,
      role: "admin",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });
    mocks.capability.mockImplementation(async (_organization: string, capability: string) => capability === "telemetry");
    mocks.channels.mockResolvedValue([channel]);
    mocks.get.mockImplementation(async () => stored);
    mocks.save.mockImplementation(async (_organization: string, settings: typeof stored) => { stored = settings; });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("marks reading as read-only and updating as a write", async () => {
    const { tools } = await mcp("tools/list") as {
      tools: Array<{ annotations: Record<string, unknown>; name: string }>;
    };
    const annotations = (name: string) => tools.find((tool) => tool.name === name)?.annotations;

    expect(annotations("get_error_notifications")).toMatchObject({ readOnlyHint: true });
    expect(annotations("update_error_notifications")).toMatchObject({ readOnlyHint: false });
  });

  it("turns notifications on for an available channel", async () => {
    const { body } = await callTool("update_error_notifications", { enabled: true, slack });

    expect(body).toEqual({ notifications: { enabled: true, slack } });
    expect(mocks.save).toHaveBeenCalledWith(organizationId, { enabled: true, targets: [{ kind: "slack", ...slack }] });
  });

  it("keeps the channel when turning notifications off", async () => {
    stored = { enabled: true, targets: [{ kind: "slack", ...slack }] };
    const { body } = await callTool("update_error_notifications", { enabled: false });

    expect(body).toEqual({ notifications: { enabled: false, slack } });
  });

  it("turns notifications off after their channel became unavailable", async () => {
    stored = { enabled: true, targets: [{ kind: "slack", ...slack }] };
    mocks.channels.mockResolvedValue([]);
    const { body, isError } = await callTool("update_error_notifications", { enabled: false });

    expect(isError).toBeFalsy();
    expect(body).toEqual({ notifications: { enabled: false, slack } });
  });

  it("needs a channel to turn notifications on", async () => {
    expect(await callTool("update_error_notifications", { enabled: true })).toMatchObject({
      body: { code: "slack_channel_required" },
      isError: true,
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses a channel Superlog cannot post to", async () => {
    mocks.channels.mockResolvedValue([]);
    expect(await callTool("update_error_notifications", { enabled: true, slack })).toMatchObject({
      body: { code: "slack_channel_unavailable" },
      isError: true,
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("is for workspace owners and admins only", async () => {
    mocks.authenticate.mockResolvedValue({
      apiKeyId,
      organizationId,
      role: "member",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });

    expect(await callTool("get_error_notifications")).toMatchObject({ body: { code: "admin_required" }, isError: true });
    expect(await callTool("update_error_notifications", { enabled: true, slack })).toMatchObject({
      body: { code: "admin_required" },
      isError: true,
    });
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("is not available without telemetry", async () => {
    mocks.capability.mockResolvedValue(false);
    expect(await callTool("get_error_notifications")).toMatchObject({ body: { code: "telemetry_unavailable" }, isError: true });
  });
});
