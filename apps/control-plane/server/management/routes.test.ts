import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managementMcpRoutes } from "./mcp.js";
import { managementOperations } from "./operations.js";
import { managementApiRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const apiKeyId = "31313131-3131-4131-8131-313131313131";
const automationId = "41414141-4141-4141-8141-414141414141";
const runId = "51515151-5151-4151-8151-515151515151";
const repositoryId = "61616161-6161-4161-8161-616161616161";
const slackAccountId = "71717171-7171-4171-8171-717171717171";
const token = `slk_${"a".repeat(43)}`;

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  capability: vi.fn(),
  createAutomation: vi.fn(),
  getAutomation: vi.fn(),
  getAutomationRun: vi.fn(),
  getTagMode: vi.fn(),
  listAutomations: vi.fn(),
  listCapabilities: vi.fn(),
  queueRun: vi.fn(),
  revokeApiKey: vi.fn(),
  saveTagMode: vi.fn(),
  setAutomationEnabled: vi.fn(),
  updateAutomation: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/api-keys.js", () => ({
  authenticateApiKey: mocks.authenticate,
  listApiKeys: vi.fn().mockResolvedValue([]),
  revokeApiKey: mocks.revokeApiKey,
}));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  listEnabledOrganizationCapabilities: mocks.listCapabilities,
  organizationHasCapability: mocks.capability,
}));
vi.mock("../../../../packages/core/src/db/automations.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createAutomation: mocks.createAutomation,
  getAutomation: mocks.getAutomation,
  getAutomationRun: mocks.getAutomationRun,
  listAutomations: mocks.listAutomations,
  setAutomationEnabled: mocks.setAutomationEnabled,
  updateAutomation: mocks.updateAutomation,
}));
vi.mock("../../../../packages/core/src/db/agents.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getSlackThreadModeConfiguration: mocks.getTagMode,
  saveSlackThreadModeConfiguration: mocks.saveTagMode,
}));
vi.mock("../../../../packages/core/src/analytics.js", () => ({
  captureAnalyticsEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../automations/queue.js", () => ({
  queueAutomationRun: mocks.queueRun,
  queueAutomationRunFollowUp: vi.fn(),
}));

const app = new Hono()
  .route("/api/v1", managementApiRoutes)
  .route("/api/mcp", managementMcpRoutes);

const automation = {
  configuration: {
    contextAccountIds: [slackAccountId],
    harness: "codex",
    maxModelRequests: 500,
    maxOutputTokensPerRequest: 16_000,
    maxRuntimeSeconds: 1_800,
    model: "gpt-5.4",
    modelProvider: "openai",
    notifications: [],
    prompt: "Triage new issues.",
    repositoryIds: [repositoryId],
    toolPolicy: "full",
    triggers: [{ frequency: "daily", hour: 9, kind: "schedule", timezone: "Europe/Paris", weekday: 1 }],
    workspaceSecretIds: [],
  },
  createdAt: new Date("2026-10-01T10:00:00.000Z"),
  description: "",
  enabled: true,
  id: automationId,
  name: "Daily triage",
  runs: [],
  updatedAt: new Date("2026-10-01T10:00:00.000Z"),
  version: 3,
  versionId: "81818181-8181-4181-8181-818181818181",
};

function request(path: string, init: RequestInit = {}) {
  return app.request(`/api/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function mcp(body: unknown, headers: Record<string, string> = {}) {
  return app.request("/api/mcp", {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

describe("management API", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function signedIn(role = "member") {
    mocks.authenticate.mockResolvedValue({
      apiKeyId,
      organizationId,
      role,
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });
    mocks.capability.mockResolvedValue(true);
    mocks.listCapabilities.mockResolvedValue(["automations"]);
  }

  it("requires an API key and ignores session cookies", async () => {
    mocks.authenticate.mockResolvedValue(null);

    const missing = await app.request("/api/v1/automations", {
      headers: { cookie: "responder-auth.session_token=session" },
    });
    const revoked = await request("/automations");

    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="superlog"');
    expect(revoked.status).toBe(401);
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.authenticate).toHaveBeenCalledWith(token);
    expect(mocks.listAutomations).not.toHaveBeenCalled();
  });

  it("hides automation operations from workspaces without automations", async () => {
    signedIn();
    mocks.capability.mockResolvedValue(false);

    const response = await request("/automations");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "automations_unavailable" });
    expect(mocks.listAutomations).not.toHaveBeenCalled();
  });

  it("returns only documented fields", async () => {
    signedIn();
    mocks.getAutomationRun.mockResolvedValue({
      automationEnabled: true,
      automationId,
      automationName: "Daily triage",
      automationVersionId: automation.versionId,
      cancelRequestedAt: null,
      completedAt: null,
      createdAt: new Date("2026-10-02T10:00:00.000Z"),
      events: [{ createdAt: new Date("2026-10-02T10:00:01.000Z"), data: { text: "hi" }, id: 1, runId, type: "transcript" }],
      failureCategory: null,
      failureMessage: null,
      heartbeatAt: null,
      id: runId,
      inferenceUsage: null,
      number: 4,
      organizationId,
      redactedTrigger: { provider: "manual" },
      resultSummary: null,
      sandboxId: "sandbox-secret",
      startedAt: null,
      status: "pending",
      trigger: { attributes: {}, provider: "manual", sourceUrl: null, title: "Manual run" },
      updatedAt: new Date("2026-10-02T10:00:00.000Z"),
      usage: null,
    });

    const response = await request(`/runs/${runId}`);
    const body = await response.json() as { run: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.run.id).toBe(runId);
    expect(body.run.createdAt).toBe("2026-10-02T10:00:00.000Z");
    expect(body.run).not.toHaveProperty("sandboxId");
    expect(body.run).not.toHaveProperty("organizationId");
    expect(body.run).not.toHaveProperty("redactedTrigger");
    expect((body.run.events as Array<Record<string, unknown>>)[0]).not.toHaveProperty("runId");
  });

  it("creates an automation with default model settings", async () => {
    signedIn();
    mocks.createAutomation.mockResolvedValue({ id: automationId });
    mocks.getAutomation.mockResolvedValue(automation);

    const response = await request("/automations", {
      body: JSON.stringify({
        configuration: {
          prompt: "Triage new issues.",
          repositoryIds: [repositoryId],
          triggers: automation.configuration.triggers,
        },
        name: "Daily triage",
      }),
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(mocks.createAutomation).toHaveBeenCalledWith(organizationId, userId, {
      configuration: {
        contextAccountIds: [],
        harness: "codex",
        maxModelRequests: 500,
        maxOutputTokensPerRequest: 16_000,
        maxRuntimeSeconds: 1_800,
        model: "gpt-5.4",
        modelProvider: "openai",
        notifications: [],
        prompt: "Triage new issues.",
        repositoryIds: [repositoryId],
        toolPolicy: "full",
        triggers: automation.configuration.triggers,
        workspaceSecretIds: [],
      },
      description: "",
      enabled: true,
      name: "Daily triage",
    });
    const body = await response.json() as { automation: Record<string, unknown> };
    expect(body.automation.id).toBe(automationId);
    expect(body.automation).not.toHaveProperty("versionId");
    expect(body.automation).not.toHaveProperty("runs");
  });

  it("reports each invalid field", async () => {
    signedIn();

    const response = await request("/automations", {
      body: JSON.stringify({
        configuration: {
          harness: "claude_agent_sdk",
          prompt: "Triage",
          repositoryIds: [repositoryId],
          triggers: automation.configuration.triggers,
        },
        name: "Daily triage",
      }),
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid_request",
      issues: [{ message: "Claude Agent SDK requires an Anthropic model", path: ["configuration", "modelProvider"] }],
    });
    expect(mocks.createAutomation).not.toHaveBeenCalled();
  });

  it("rejects a body that is not a JSON object", async () => {
    signedIn();

    const response = await request("/automations", { body: "[1]", method: "POST" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });

  it("keeps configuration fields a change leaves out", async () => {
    signedIn();
    mocks.getAutomation.mockResolvedValue(automation);
    mocks.updateAutomation.mockResolvedValue(true);

    const response = await request(`/automations/${automationId}`, {
      body: JSON.stringify({ configuration: { prompt: "Triage regressions too." } }),
      method: "PATCH",
    });

    expect(response.status).toBe(200);
    expect(mocks.updateAutomation).toHaveBeenCalledWith(
      organizationId,
      automationId,
      userId,
      expect.objectContaining({
        configuration: expect.objectContaining({
          contextAccountIds: [slackAccountId],
          prompt: "Triage regressions too.",
          repositoryIds: [repositoryId],
        }),
        name: "Daily triage",
      }),
    );
  });

  it("turns an automation off without saving a new version", async () => {
    signedIn();
    mocks.setAutomationEnabled.mockResolvedValue(true);
    mocks.getAutomation.mockResolvedValue({ ...automation, enabled: false });

    const response = await request(`/automations/${automationId}`, {
      body: JSON.stringify({ enabled: false }),
      method: "PATCH",
    });

    expect(response.status).toBe(200);
    expect(mocks.setAutomationEnabled).toHaveBeenCalledWith({
      automationId,
      enabled: false,
      organizationId,
    });
    expect(mocks.updateAutomation).not.toHaveBeenCalled();
  });

  it("starts a manual run attributed to the API", async () => {
    signedIn();
    mocks.getAutomation.mockResolvedValue(automation);
    mocks.queueRun.mockResolvedValue({ duplicate: false, jobId: "job", runId });

    const response = await request(`/automations/${automationId}/runs`, { method: "POST" });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ duplicate: false, runId });
    expect(mocks.queueRun).toHaveBeenCalledWith({
      automationId,
      trigger: expect.objectContaining({
        body: "Manual run requested through the API.",
        provider: "manual",
        title: "Manual run",
      }),
    });
  });

  it("asks to turn a disabled automation on before starting a run", async () => {
    signedIn();
    mocks.getAutomation.mockResolvedValue({ ...automation, enabled: false });

    const response = await request(`/automations/${automationId}/runs`, { method: "POST" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "automation_disabled" });
    expect(mocks.queueRun).not.toHaveBeenCalled();
  });

  it("changes only the tag mode fields it receives", async () => {
    signedIn();
    const current = {
      contextAccountIds: [slackAccountId],
      contextResourceIds: [],
      enabled: false,
      instructions: "Answer questions.",
      model: "instance/default",
      repositoryIds: [repositoryId],
      secretIds: [],
    };
    mocks.getTagMode.mockResolvedValue(current);

    const response = await request("/tag-mode", {
      body: JSON.stringify({ enabled: true }),
      method: "PATCH",
    });

    expect(response.status).toBe(200);
    expect(mocks.saveTagMode).toHaveBeenCalledWith({
      configuration: { ...current, enabled: true },
      organizationId,
      userId,
    });
  });

  it("revokes keys with the caller's role", async () => {
    signedIn("admin");
    mocks.revokeApiKey.mockResolvedValue(true);

    const response = await request(`/api-keys/${apiKeyId}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(mocks.revokeApiKey).toHaveBeenCalledWith({
      apiKeyId,
      organizationId,
      role: "admin",
      userId,
    });
  });

  it("does not expose unexpected errors", async () => {
    signedIn();
    mocks.listAutomations.mockRejectedValue(new Error("connection to 10.0.0.1 refused"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await request("/automations");

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("10.0.0.1");
  });

  it("publishes an OpenAPI document for every operation", async () => {
    const response = await app.request("/api/v1/openapi.json");
    const document = await response.json() as {
      paths: Record<string, Record<string, { operationId: string }>>;
    };

    expect(response.status).toBe(200);
    const operationIds = Object.values(document.paths)
      .flatMap((methods) => Object.values(methods))
      .map((operation) => operation.operationId);
    expect(operationIds.sort()).toEqual(
      managementOperations.map((operation) => operation.name).sort(),
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it("answers unknown paths with JSON", async () => {
    signedIn();

    const response = await request("/nothing-here");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "not_found", error: "Not found" });
  });
});

describe("management MCP server", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function signedIn() {
    mocks.authenticate.mockResolvedValue({
      apiKeyId,
      organizationId,
      role: "member",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });
    mocks.capability.mockResolvedValue(true);
  }

  it("requires an API key", async () => {
    mocks.authenticate.mockResolvedValue(null);

    const response = await mcp({ id: 1, jsonrpc: "2.0", method: "tools/list" });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="superlog"');
  });

  it("initializes without a session", async () => {
    signedIn();

    const response = await mcp({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2025-06-18",
      },
    });
    const body = await response.json() as {
      result: { instructions: string; serverInfo: { name: string } };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(body.result.serverInfo.name).toBe("superlog");
    expect(body.result.instructions).toContain("list_integrations");
  });

  it("lists tools without operations that take secret values", async () => {
    signedIn();

    const response = await mcp({ id: 2, jsonrpc: "2.0", method: "tools/list" });
    const body = await response.json() as {
      result: { tools: Array<{ annotations: Record<string, unknown>; inputSchema: { type: string }; name: string }> };
    };
    const names = body.result.tools.map((tool) => tool.name);

    expect(names).toContain("create_automation");
    expect(names).toContain("update_tag_mode");
    expect(names).not.toContain("create_secret");
    expect(names).not.toContain("create_model_credential");
    expect(names).not.toContain("rotate_model_credential");
    for (const tool of body.result.tools) expect(tool.inputSchema.type).toBe("object");
    expect(body.result.tools.find((tool) => tool.name === "list_automations")?.annotations)
      .toMatchObject({ destructiveHint: false, readOnlyHint: true });
    expect(body.result.tools.find((tool) => tool.name === "revoke_api_key")?.annotations)
      .toMatchObject({ destructiveHint: true, readOnlyHint: false });
  });

  it("runs a tool as the key's member", async () => {
    signedIn();
    mocks.listAutomations.mockResolvedValue([]);

    const response = await mcp({
      id: 3,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "list_automations" },
    });
    const body = await response.json() as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };

    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({ automations: [] });
    expect(mocks.listAutomations).toHaveBeenCalledWith(organizationId);
  });

  it("returns operation errors as tool errors", async () => {
    signedIn();
    mocks.getAutomation.mockResolvedValue(null);

    const response = await mcp({
      id: 4,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { automationId }, name: "get_automation" },
    });
    const body = await response.json() as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };

    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({
      code: "automation_not_found",
    });
  });

  it("attributes manual runs to MCP", async () => {
    signedIn();
    mocks.getAutomation.mockResolvedValue(automation);
    mocks.queueRun.mockResolvedValue({ duplicate: false, jobId: "job", runId });

    await mcp({
      id: 5,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { automationId }, name: "start_automation_run" },
    });

    expect(mocks.queueRun).toHaveBeenCalledWith(expect.objectContaining({
      trigger: expect.objectContaining({ body: "Manual run requested through MCP." }),
    }));
  });

  it("rejects stream requests", async () => {
    const response = await app.request("/api/mcp", { method: "GET" });

    expect(response.status).toBe(405);
  });
});
