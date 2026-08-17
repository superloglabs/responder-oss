import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import {
  listAgentOptions,
  setAgentEnabled,
} from "../../../../packages/core/src/db/agents.js";
import {
  listConnectedIntegrationAccountCredentials,
  replaceIntegrationResources,
} from "../../../../packages/core/src/db/integrations.js";
import {
  getInvestigationDetail,
  listInvestigationTraceEvents,
} from "../../../../packages/core/src/db/investigations.js";
import {
  createWorkspaceSecretRecord,
  findWorkspaceSecretByName,
} from "../../../../packages/core/src/db/workspace-secrets.js";
import { getActiveTenant } from "../tenant.js";
import { listSlackChannels } from "../integrations/slack.js";
import {
  createDaytonaWorkspaceSecret,
  deleteDaytonaWorkspaceSecret,
} from "./daytona-secrets.js";
import { agentRoutes } from "./routes.js";

vi.mock("../../../../packages/core/src/credentials/encryption.js", () => ({
  decryptCredentials: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/agents.js", () => ({
  createAgent: vi.fn(),
  getAgent: vi.fn(),
  listAgentOptions: vi.fn(),
  listAgents: vi.fn(),
  setAgentEnabled: vi.fn(),
  updateAgent: vi.fn(),
  AgentConfigurationError: class AgentConfigurationError extends Error {},
}));
vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  getSlackChannelConnection: vi.fn(),
  listConnectedIntegrationAccountCredentials: vi.fn(),
  markSlackChannelJoined: vi.fn(),
  replaceIntegrationResources: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/investigations.js", () => ({
  getInvestigationDetail: vi.fn(),
  getInvestigationForRetry: vi.fn(),
  investigationCanBeRetried: vi.fn(),
  listInvestigationTraceEvents: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/workspace-secrets.js", () => ({
  createWorkspaceSecretRecord: vi.fn(),
  findWorkspaceSecretByName: vi.fn(),
}));
vi.mock("../integrations/slack.js", () => ({
  joinSlackChannel: vi.fn(),
  listSlackChannels: vi.fn(),
  SlackChannelJoinError: class SlackChannelJoinError extends Error {
    slackCode: string;

    constructor(slackCode: string) {
      super(slackCode);
      this.slackCode = slackCode;
    }
  },
}));
vi.mock("../tenant.js", () => ({
  getActiveTenant: vi.fn(),
}));
vi.mock("../investigations/queue.js", () => ({
  queueInvestigationRetry: vi.fn(),
}));
vi.mock("./daytona-secrets.js", () => ({
  createDaytonaWorkspaceSecret: vi.fn(),
  deleteDaytonaWorkspaceSecret: vi.fn(),
}));

const app = new Hono().route("/api/agents", agentRoutes);
const options: Awaited<ReturnType<typeof listAgentOptions>> = {
  accounts: [
    {
      id: "slack-account-1",
      provider: "slack",
      displayName: "Example",
      slackContextAvailable: true,
    },
  ],
  resources: [
    {
      id: "resource-1",
      integrationAccountId: "slack-account-1",
      kind: "slack_channel",
      externalId: "C123",
      displayName: "new-incidents",
    },
  ],
  repositories: [],
  secrets: [],
};

const tenant = {
  ok: true as const,
  organizationId: "10000000-0000-4000-8000-000000000000",
  user: {
    id: "20000000-0000-4000-8000-000000000000",
    name: "Test User",
    email: "test@example.com",
  },
};

describe("workspace secrets", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("stores plaintext only in Daytona and returns metadata", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(findWorkspaceSecretByName).mockResolvedValue(null);
    vi.mocked(createDaytonaWorkspaceSecret).mockResolvedValue({
      id: "daytona-secret-1",
      name: "responder_external_1",
    });
    vi.mocked(createWorkspaceSecretRecord).mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000000",
      name: "SERVICE_API_KEY",
      allowedHosts: ["api.example.com"],
      createdAt: new Date("2026-08-14T10:00:00.000Z"),
    });

    const response = await app.request("/api/agents/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "service_api_key",
        value: "never-return-this",
        allowedHosts: ["API.EXAMPLE.COM"],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(JSON.stringify(body)).not.toContain("never-return-this");
    expect(createDaytonaWorkspaceSecret).toHaveBeenCalledWith({
      value: "never-return-this",
      allowedHosts: ["api.example.com"],
    });
    expect(createWorkspaceSecretRecord).toHaveBeenCalledWith({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      name: "SERVICE_API_KEY",
      allowedHosts: ["api.example.com"],
      daytonaSecretId: "daytona-secret-1",
      daytonaSecretName: "responder_external_1",
    });
    expect(
      vi.mocked(createWorkspaceSecretRecord).mock.calls[0]?.[0],
    ).not.toHaveProperty("value");
  });

  it("requires a host allowlist before accepting a value", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);

    const response = await app.request("/api/agents/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "SERVICE_API_KEY",
        value: "never-store-this",
        allowedHosts: [],
      }),
    });

    expect(response.status).toBe(400);
    expect(createDaytonaWorkspaceSecret).not.toHaveBeenCalled();
    expect(createWorkspaceSecretRecord).not.toHaveBeenCalled();
  });

  it("rejects environment variables that could alter the sandbox runtime", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);

    const response = await app.request("/api/agents/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "NODE_OPTIONS",
        value: "--require=./payload.js",
        allowedHosts: ["api.example.com"],
      }),
    });

    expect(response.status).toBe(400);
    expect(createDaytonaWorkspaceSecret).not.toHaveBeenCalled();
  });

  it("does not overwrite a workspace secret or send its new value", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(findWorkspaceSecretByName).mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000000",
      name: "SERVICE_API_KEY",
      allowedHosts: ["api.example.com"],
      createdAt: new Date(),
    });

    const response = await app.request("/api/agents/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "SERVICE_API_KEY",
        value: "replacement",
        allowedHosts: ["api.example.com"],
      }),
    });

    expect(response.status).toBe(409);
    expect(createDaytonaWorkspaceSecret).not.toHaveBeenCalled();
    expect(deleteDaytonaWorkspaceSecret).not.toHaveBeenCalled();
  });

  it("removes the Daytona secret when metadata storage fails", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(findWorkspaceSecretByName).mockResolvedValue(null);
    vi.mocked(createDaytonaWorkspaceSecret).mockResolvedValue({
      id: "daytona-secret-orphan",
      name: "responder_external_orphan",
    });
    vi.mocked(createWorkspaceSecretRecord).mockRejectedValue(
      new Error("database unavailable"),
    );
    vi.mocked(deleteDaytonaWorkspaceSecret).mockResolvedValue(undefined);

    const response = await app.request("/api/agents/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "SERVICE_API_KEY",
        value: "never-return-this",
        allowedHosts: ["api.example.com"],
      }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Unable to store workspace secret",
    });
    expect(deleteDaytonaWorkspaceSecret).toHaveBeenCalledWith(
      "daytona-secret-orphan",
    );
  });

  it("returns a conflict and removes the external secret after a concurrent create", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(findWorkspaceSecretByName).mockResolvedValue(null);
    vi.mocked(createDaytonaWorkspaceSecret).mockResolvedValue({
      id: "daytona-secret-race",
      name: "responder_external_race",
    });
    vi.mocked(createWorkspaceSecretRecord).mockRejectedValue({
      code: "23505",
      constraint: "workspace_secrets_organization_name_idx",
    });
    vi.mocked(deleteDaytonaWorkspaceSecret).mockResolvedValue(undefined);

    const response = await app.request("/api/agents/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "SERVICE_API_KEY",
        value: "never-return-this",
        allowedHosts: ["api.example.com"],
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "SERVICE_API_KEY already exists in this workspace",
    });
    expect(deleteDaytonaWorkspaceSecret).toHaveBeenCalledWith(
      "daytona-secret-race",
    );
  });

  it("surfaces an external cleanup failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(findWorkspaceSecretByName).mockResolvedValue(null);
    vi.mocked(createDaytonaWorkspaceSecret).mockResolvedValue({
      id: "daytona-secret-orphan",
      name: "responder_external_orphan",
    });
    vi.mocked(createWorkspaceSecretRecord).mockRejectedValue(
      new Error("database unavailable"),
    );
    vi.mocked(deleteDaytonaWorkspaceSecret).mockRejectedValue(
      new Error("vault unavailable"),
    );

    const response = await app.request("/api/agents/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "SERVICE_API_KEY",
        value: "never-return-this",
        allowedHosts: ["api.example.com"],
      }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Unable to clean up workspace secret after storage failed",
    });
    expect(console.error).toHaveBeenCalledWith(
      "Unable to clean up workspace secret",
      expect.objectContaining({ daytonaSecretId: "daytona-secret-orphan" }),
    );
  });
});

describe("Slack channel option refresh", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("fetches live channels for every connected Slack account", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue({
      ok: true,
      organizationId: "10000000-0000-4000-8000-000000000000",
      user: {
        id: "20000000-0000-4000-8000-000000000000",
        name: "Test User",
        email: "test@example.com",
      },
    });
    vi.mocked(listConnectedIntegrationAccountCredentials).mockResolvedValue([
      { id: "slack-account-1", encryptedCredentials: "encrypted-1" },
      { id: "slack-account-2", encryptedCredentials: "encrypted-2" },
    ]);
    vi.mocked(decryptCredentials).mockImplementation((encrypted) => ({
      accessToken: encrypted === "encrypted-1" ? "token-1" : "token-2",
    }));
    vi.mocked(listSlackChannels)
      .mockResolvedValueOnce([
        { externalId: "C123", displayName: "new-incidents", metadata: {} },
      ])
      .mockResolvedValueOnce([
        { externalId: "C456", displayName: "ops", metadata: {} },
      ]);
    vi.mocked(listAgentOptions).mockResolvedValue(options);

    const response = await app.request("/api/agents/options/refresh/slack", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(options);
    expect(listSlackChannels).toHaveBeenCalledTimes(2);
    expect(listSlackChannels).toHaveBeenCalledWith("token-1");
    expect(listSlackChannels).toHaveBeenCalledWith("token-2");
    expect(replaceIntegrationResources).toHaveBeenCalledWith(
      "slack-account-1",
      "slack_channel",
      [expect.objectContaining({ externalId: "C123" })],
    );
    expect(replaceIntegrationResources).toHaveBeenCalledWith(
      "slack-account-2",
      "slack_channel",
      [expect.objectContaining({ externalId: "C456" })],
    );
  });

  it("returns a retryable error without replacing resources when Slack fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getActiveTenant).mockResolvedValue({
      ok: true,
      organizationId: "10000000-0000-4000-8000-000000000000",
      user: {
        id: "20000000-0000-4000-8000-000000000000",
        name: "Test User",
        email: "test@example.com",
      },
    });
    vi.mocked(listConnectedIntegrationAccountCredentials).mockResolvedValue([
      { id: "slack-account-1", encryptedCredentials: "encrypted-1" },
    ]);
    vi.mocked(decryptCredentials).mockReturnValue({ accessToken: "token-1" });
    vi.mocked(listSlackChannels).mockRejectedValue(new Error("Slack unavailable"));

    const response = await app.request("/api/agents/options/refresh/slack", {
      method: "POST",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Unable to refresh Slack channels",
      code: "slack_refresh_failed",
    });
    expect(replaceIntegrationResources).not.toHaveBeenCalled();
    expect(listAgentOptions).not.toHaveBeenCalled();
  });
});

describe("agent status updates", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("updates an agent in the active organization", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue({
      ok: true,
      organizationId: "10000000-0000-4000-8000-000000000000",
      user: {
        id: "20000000-0000-4000-8000-000000000000",
        name: "Test User",
        email: "test@example.com",
      },
    });
    vi.mocked(setAgentEnabled).mockResolvedValue(true);

    const response = await app.request(
      "/api/agents/30000000-0000-4000-8000-000000000000",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      agentId: "30000000-0000-4000-8000-000000000000",
      enabled: true,
    });
    expect(setAgentEnabled).toHaveBeenCalledWith({
      agentId: "30000000-0000-4000-8000-000000000000",
      organizationId: "10000000-0000-4000-8000-000000000000",
      enabled: true,
    });
  });

  it("does not reveal agents outside the active organization", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue({
      ok: true,
      organizationId: "10000000-0000-4000-8000-000000000000",
      user: {
        id: "20000000-0000-4000-8000-000000000000",
        name: "Test User",
        email: "test@example.com",
      },
    });
    vi.mocked(setAgentEnabled).mockResolvedValue(false);

    const response = await app.request(
      "/api/agents/30000000-0000-4000-8000-000000000000",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Agent not found" });
  });

  it("rejects invalid status updates", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue({
      ok: true,
      organizationId: "10000000-0000-4000-8000-000000000000",
      user: {
        id: "20000000-0000-4000-8000-000000000000",
        name: "Test User",
        email: "test@example.com",
      },
    });

    const response = await app.request(
      "/api/agents/30000000-0000-4000-8000-000000000000",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: "yes" }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid agent status",
    });
    expect(setAgentEnabled).not.toHaveBeenCalled();
  });
});

describe("AWS investigation traces", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads saved events for the existing investigation page", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue({
      ok: true,
      organizationId: "10000000-0000-4000-8000-000000000000",
      user: {
        id: "20000000-0000-4000-8000-000000000000",
        name: "Test User",
        email: "test@example.com",
      },
    });
    vi.mocked(getInvestigationDetail).mockResolvedValue({
      id: "40000000-0000-4000-8000-000000000000",
      agentId: "30000000-0000-4000-8000-000000000000",
      runtimeProfileId: "50000000-0000-4000-8000-000000000000",
      status: "investigating",
      title: "Example alert",
      input: {
        provider: "slack",
        externalEventId: "event-1",
        title: "Example alert",
        body: "Example alert body",
      },
      finding: null,
      structuredReport: null,
      replayReport: null,
      isReplay: false,
      replayOfInvestigationId: null,
      reportMarkdown: null,
      eveSessionId: "openai-daytona:job-1",
      failureReason: null,
      startedAt: new Date("2026-08-05T13:00:00.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-05T13:00:00.000Z"),
      updatedAt: new Date("2026-08-05T13:00:00.000Z"),
      issues: [],
    });
    vi.mocked(listInvestigationTraceEvents).mockResolvedValue({
      events: [
        {
          type: "session.started",
          meta: { at: "2026-08-05T13:00:00.000Z" },
        },
        {
          type: "message.received",
          data: { message: "Duplicate alert input" },
          meta: { at: "2026-08-05T13:00:01.000Z" },
        },
        {
          type: "instructions.configured",
          data: { instructions: "private runtime instructions" },
          meta: { at: "2026-08-05T13:00:02.000Z" },
        },
        {
          type: "reasoning.completed",
          data: { reasoning: "Checked the relevant service logs." },
          meta: { at: "2026-08-05T13:00:03.000Z" },
        },
      ],
      truncated: false,
    });

    const response = await app.request(
      "/api/agents/30000000-0000-4000-8000-000000000000/investigations/40000000-0000-4000-8000-000000000000",
    );
    const payload = (await response.json()) as {
      trace: unknown;
      traceError: string | null;
    };

    expect(response.status).toBe(200);
    expect(payload.trace).toEqual({
      events: [
        {
          type: "session.started",
          meta: { at: "2026-08-05T13:00:00.000Z" },
        },
        {
          type: "reasoning.completed",
          data: { reasoning: "Checked the relevant service logs." },
          meta: { at: "2026-08-05T13:00:03.000Z" },
        },
      ],
      sessionId: "openai-daytona:job-1",
      truncated: false,
    });
    expect(JSON.stringify(payload)).not.toContain("private runtime instructions");
    expect(JSON.stringify(payload)).not.toContain("Duplicate alert input");
    expect(payload.traceError).toBeNull();
    expect(listInvestigationTraceEvents).toHaveBeenCalledWith(
      "40000000-0000-4000-8000-000000000000",
    );
  });
});

describe("investigation replay API", () => {
  it("is not exposed to the tenant app", async () => {
    const response = await app.request(
      "/api/agents/30000000-0000-4000-8000-000000000000/investigations/40000000-0000-4000-8000-000000000000/replay",
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    expect(getActiveTenant).not.toHaveBeenCalled();
  });
});
