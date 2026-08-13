import { describe, expect, it } from "vitest";
import {
  customMcpCredentialUpdateFailureEvent,
  customMcpConnectionsLoadedEvent,
  customMcpRuntimeAccountSkippedEvent,
  customMcpTokenReuseEvent,
  customMcpTokenRefreshFailureEvent,
  customMcpTokenRefreshSuccessEvent,
  customMcpReconnectError,
  investigationCanBeRetried,
  replayReportMarkdownUpdate,
} from "./investigations.js";

describe("investigation retry", () => {
  it("allows terminal investigations to run again", () => {
    expect(investigationCanBeRetried("resolved")).toBe(true);
    expect(investigationCanBeRetried("failed")).toBe(true);
  });

  it("does not allow a duplicate run while work is active", () => {
    expect(investigationCanBeRetried("pending")).toBe(false);
    expect(investigationCanBeRetried("investigating")).toBe(false);
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
