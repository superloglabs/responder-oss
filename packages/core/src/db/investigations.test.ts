import { describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import {
  investigationIssues,
  investigationTraceEvents,
  issues,
} from "./schema.js";
import {
  customMcpCredentialUpdateFailureEvent,
  customMcpConnectionsLoadedEvent,
  customMcpRuntimeAccountSkippedEvent,
  customMcpTokenReuseEvent,
  customMcpTokenRefreshFailureEvent,
  customMcpTokenRefreshSuccessEvent,
  customMcpReconnectError,
  getInvestigationForSlackAction,
  investigationCanBeRetried,
  markInvestigationStarted,
  prepareInvestigationRetry,
  replayReportMarkdownUpdate,
} from "./investigations.js";

vi.mock("./client.js", () => ({
  getDatabase: vi.fn(),
}));

describe("Slack investigation actions", () => {
  it("resolves an investigation through a connected Slack workspace", async () => {
    const investigation = {
      agentId: "agent-1",
      id: "investigation-1",
      organizationId: "organization-1",
    };
    const query = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue([investigation]),
    };
    query.from.mockReturnValue(query);
    query.innerJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    vi.mocked(getDatabase).mockReturnValue({
      select: vi.fn(() => query),
    } as never);

    await expect(
      getInvestigationForSlackAction({
        investigationId: investigation.id,
        teamId: "T123",
      }),
    ).resolves.toEqual(investigation);
    expect(query.innerJoin).toHaveBeenCalledOnce();
  });
});

describe("investigation retry", () => {
  it("allows terminal investigations to run again", () => {
    expect(investigationCanBeRetried("resolved")).toBe(true);
    expect(investigationCanBeRetried("failed")).toBe(true);
  });

  it("does not allow a duplicate run while work is active", () => {
    expect(investigationCanBeRetried("pending")).toBe(false);
    expect(investigationCanBeRetried("investigating")).toBe(false);
  });

  it("switches to the active agent configuration without deleting old issues", async () => {
    const sourceInput = {
      agentId: "agent-1",
      body: "Original alert",
      externalEventId: "event-1",
      provider: "sentry" as const,
      title: "Production error",
    };
    const investigationQuery = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue([{
        agentId: "agent-1",
        configId: "active-config",
        createLinearTickets: true,
        id: "investigation-1",
        input: sourceInput,
        linearIssueTemplate: "Current template",
        model: "current-model",
        organizationId: "organization-1",
        prMode: "always",
        prompt: "Current instructions",
        status: "resolved",
      }]),
    };
    investigationQuery.from.mockReturnValue(investigationQuery);
    investigationQuery.innerJoin.mockReturnValue(investigationQuery);
    investigationQuery.where.mockReturnValue(investigationQuery);
    const profileQuery = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue([{ id: "active-runtime" }]),
    };
    profileQuery.from.mockReturnValue(profileQuery);
    profileQuery.innerJoin.mockReturnValue(profileQuery);
    profileQuery.where.mockReturnValue(profileQuery);
    const select = vi
      .fn()
      .mockReturnValueOnce(investigationQuery)
      .mockReturnValueOnce(profileQuery);
    const deleteWhere = vi.fn().mockResolvedValue([]);
    const set = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: "investigation-1" }]),
      })),
    }));
    const tx = {
      delete: vi.fn(() => ({ where: deleteWhere })),
      select,
      update: vi.fn(() => ({ set })),
    };
    const transaction = vi.fn(async (callback) => callback(tx));
    vi.mocked(getDatabase).mockReturnValue({ transaction } as never);

    await expect(
      prepareInvestigationRetry("investigation-1"),
    ).resolves.toEqual({
      config: {
        agentId: "agent-1",
        createLinearTickets: true,
        id: "active-config",
        linearIssueTemplate: "Current template",
        model: "current-model",
        organizationId: "organization-1",
        prMode: "always",
        prompt: "Current instructions",
      },
      input: sourceInput,
      investigationId: "investigation-1",
      runtimeProfileId: "active-runtime",
    });
    expect(tx.delete).toHaveBeenNthCalledWith(1, investigationIssues);
    expect(tx.delete).toHaveBeenNthCalledWith(2, investigationTraceEvents);
    expect(tx.delete).not.toHaveBeenCalledWith(issues);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      agentConfigVersionId: "active-config",
      runtimeProfileId: "active-runtime",
    }));
  });
});

describe("investigation worker recovery", () => {
  it("starts an investigation that still needs work", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "investigation-1" }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    vi.mocked(getDatabase).mockReturnValue({
      update: vi.fn(() => ({ set })),
    } as never);

    await expect(
      markInvestigationStarted("investigation-1", "openai-daytona:job-1"),
    ).resolves.toBe("started");
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      completedAt: null,
      eveSessionId: "openai-daytona:job-1",
      failureReason: null,
      status: "investigating",
    }));
  });

  it("preserves a report that completed before the worker stopped", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const updateWhere = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where: updateWhere }));
    const selectQuery = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue([{ status: "resolved" }]),
    };
    selectQuery.from.mockReturnValue(selectQuery);
    selectQuery.where.mockReturnValue(selectQuery);
    vi.mocked(getDatabase).mockReturnValue({
      select: vi.fn(() => selectQuery),
      update: vi.fn(() => ({ set })),
    } as never);

    await expect(
      markInvestigationStarted("investigation-1", "openai-daytona:job-1"),
    ).resolves.toBe("completed");
    expect(set).toHaveBeenCalledTimes(1);
  });
});

describe("replay completion", () => {
  it("preserves the first completed report when a replay job is redelivered", () => {
    expect(replayReportMarkdownUpdate("First report", "Retry report")).toEqual(
      {},
    );
    expect(replayReportMarkdownUpdate(null, "First report")).toEqual({
      reportMarkdown: "First report",
    });
  });
});

describe("custom MCP runtime logging", () => {
  it("identifies the connection that needs OAuth reconnection", () => {
    expect(
      customMcpTokenRefreshFailureEvent({
        id: "account-1",
        displayName: "Production metrics",
        errorType: "TimeoutError",
        investigationVersionId: "version-1",
      }, 123),
    ).toEqual({
      _aws: {
        Timestamp: 123,
        CloudWatchMetrics: [
          {
            Dimensions: [["errorType"]],
            Metrics: [
              { Name: "custom_mcp.token_refresh_failed", Unit: "Count" },
            ],
            Namespace: "Responder",
          },
        ],
      },
      accountId: "account-1",
      "custom_mcp.token_refresh_failed": 1,
      displayName: "Production metrics",
      errorType: "TimeoutError",
      event: "custom_mcp_token_refresh_failed",
      investigationVersionId: "version-1",
    });
  });

  it("identifies a skipped OAuth credential update", () => {
    expect(
      customMcpCredentialUpdateFailureEvent({
        accountId: "account-1",
        investigationVersionId: "version-1",
      }, 123),
    ).toEqual({
      _aws: {
        Timestamp: 123,
        CloudWatchMetrics: [
          {
            Dimensions: [],
            Metrics: [
              { Name: "custom_mcp.credential_update_failed", Unit: "Count" },
            ],
            Namespace: "Responder",
          },
        ],
      },
      accountId: "account-1",
      "custom_mcp.credential_update_failed": 1,
      event: "custom_mcp_credential_update_failed",
      investigationVersionId: "version-1",
      note:
        "investigation continues with non-persisted token; account may need reconnection",
    });
  });

  it("records a successful OAuth token refresh", () => {
    expect(
      customMcpTokenRefreshSuccessEvent({
        accountId: "account-1",
        investigationVersionId: "version-1",
      }, 123),
    ).toEqual({
      _aws: {
        Timestamp: 123,
        CloudWatchMetrics: [
          {
            Dimensions: [],
            Metrics: [
              { Name: "custom_mcp.token_refresh_succeeded", Unit: "Count" },
            ],
            Namespace: "Responder",
          },
        ],
      },
      accountId: "account-1",
      "custom_mcp.token_refresh_succeeded": 1,
      event: "custom_mcp_token_refreshed",
      investigationVersionId: "version-1",
    });
  });

  it("identifies a selected account that cannot supply credentials", () => {
    expect(
      customMcpRuntimeAccountSkippedEvent({
        accountId: "account-1",
        investigationVersionId: "version-1",
        reason: "credentials_missing",
      }, 123),
    ).toEqual({
      _aws: {
        Timestamp: 123,
        CloudWatchMetrics: [
          {
            Dimensions: [["reason"]],
            Metrics: [
              { Name: "custom_mcp.runtime_account_skipped", Unit: "Count" },
            ],
            Namespace: "Responder",
          },
        ],
      },
      accountId: "account-1",
      "custom_mcp.runtime_account_skipped": 1,
      event: "custom_mcp_runtime_account_skipped",
      investigationVersionId: "version-1",
      reason: "credentials_missing",
    });
  });

  it("identifies a no-op OAuth token reuse", () => {
    expect(
      customMcpTokenReuseEvent({
        accountId: "account-1",
        investigationVersionId: "version-1",
      }),
    ).toEqual({
      accountId: "account-1",
      event: "custom_mcp_token_reused",
      investigationVersionId: "version-1",
    });
  });

  it("attaches the account ID to a reconnect error", () => {
    const cause = new Error("Refresh failed");
    const error = customMcpReconnectError(
      { id: "account-1", displayName: "Production metrics" },
      cause,
    );

    expect(error.message).toBe("Reconnect custom MCP Production metrics");
    expect(error.accountId).toBe("account-1");
    expect(error.cause).toBe(cause);
  });

  it("records the custom MCP accounts loaded for an investigation", () => {
    expect(
      customMcpConnectionsLoadedEvent({
        accountIds: ["account-1", "account-2"],
        investigationVersionId: "version-1",
      }),
    ).toEqual({
      accountIds: ["account-1", "account-2"],
      count: 2,
      event: "custom_mcp_connections_loaded",
      investigationVersionId: "version-1",
    });
  });
});
