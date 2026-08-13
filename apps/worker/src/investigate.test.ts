import { describe, expect, it } from "vitest";
import {
  contextServerConnectFailureEvent,
  initialInvestigationMessage,
  investigationCapabilities,
  investigationInstructions,
  investigationInstructionsTraceEvent,
  investigationTraceWriteFailure,
  safeInvestigationError,
  sandboxAgentConfig,
} from "./investigate.js";

describe("sandbox agent configuration", () => {
  it("identifies the custom MCP account when its server cannot connect", () => {
    expect(
      contextServerConnectFailureEvent({
        customMcpConnections: [
          {
            accountId: "account-1",
          },
        ],
        error: new Error("Connection refused"),
        investigationId: "investigation-123",
        serverName: "custom-mcp-account-1",
      }),
    ).toEqual({
      accountId: "account-1",
      error: "Connection refused",
      event: "context_server_connect_failed",
      investigationId: "investigation-123",
      server: "custom-mcp-account-1",
    });
  });

  it("requires both service keys", () => {
    expect(() => sandboxAgentConfig({})).toThrow("OPENAI_API_KEY is required");
    expect(() =>
      sandboxAgentConfig({ OPENAI_API_KEY: "openai-test" }),
    ).toThrow("DAYTONA_API_KEY is required");
  });

  it("uses the supported default model", () => {
    expect(
      sandboxAgentConfig({
        DAYTONA_API_KEY: "daytona-test",
        OPENAI_API_KEY: "openai-test",
      }).model,
    ).toBe("gpt-5.6-sol");
  });

  it("removes service keys from saved errors", () => {
    expect(
      safeInvestigationError(new Error("request failed for openai-secret"), {
        OPENAI_API_KEY: "openai-secret",
      }),
    ).toBe("request failed for [redacted]");
  });

  it("gives investigations and replays the same sandbox capabilities", () => {
    expect(investigationCapabilities(true).map(({ type }) => type)).toEqual([
      "compaction",
    ]);
    expect(investigationCapabilities(false).map(({ type }) => type)).toEqual([
      "compaction",
    ]);
  });

  it("keeps investigation instructions read-only in every PR mode", () => {
    const instructions = investigationInstructions({
      agentPrompt: "Inspect the reported failure.",
      clickStackConnected: false,
      datadogConnected: false,
      repositories: [
        {
          branch: "main",
          path: "/home/daytona/workspace/repositories/acme/service",
          repository: "acme/service",
          sha: "a".repeat(40),
          workspaceBaseSha: "b".repeat(40),
        },
      ],
      sentryConnected: true,
    });

    expect(instructions).toContain("read-only repository inspection tools");
    expect(instructions).toContain("only for investigation and reporting");
    expect(instructions).toContain("remediation, when enabled, runs separately");
    expect(instructions).not.toContain("call create_pull_request");
    expect(instructions).toContain("posts the report to Slack");
  });

  it("keeps ClickStack investigation access read-only", () => {
    const instructions = investigationInstructions({
      agentPrompt: "Inspect the reported failure.",
      clickStackConnected: true,
      datadogConnected: false,
      repositories: [],
      sentryConnected: false,
    });

    expect(instructions).toContain("connected ClickStack tools");
    expect(instructions).toContain(
      "Do not create, update, or delete ClickStack resources",
    );
  });

  it("stores the exact initial message that is sent to the agent", () => {
    const initial = initialInvestigationMessage(
      {
        body: "The checkout endpoint returned 503.",
        externalEventId: "event-123",
        provider: "sentry",
        sourceUrl: "https://sentry.example/issues/123",
        title: "Checkout failed",
      },
      new Date("2026-08-10T12:00:00.000Z"),
    );

    expect(initial.message).toBe([
      "# sentry event",
      "",
      "Title: Checkout failed",
      "Source: https://sentry.example/issues/123",
      "",
      "The checkout endpoint returned 503.",
    ].join("\n"));
    expect(initial.traceEvent).toEqual({
      data: { message: initial.message },
      meta: { at: "2026-08-10T12:00:00.000Z" },
      type: "message.received",
    });
  });

  it("identifies a failed trace write without exposing service keys", () => {
    expect(
      investigationTraceWriteFailure(
        {
          error: new Error("database failed after openai-secret"),
          investigationId: "investigation-123",
          jobId: "job-123",
          traceEventType: "message.received",
        },
        { OPENAI_API_KEY: "openai-secret" },
      ),
    ).toEqual({
      error: "database failed after [redacted]",
      event: "investigation_trace_write_failed",
      investigationId: "investigation-123",
      jobId: "job-123",
      traceEventType: "message.received",
    });
  });

  it("stores the exact instructions configured on the agent", () => {
    const instructions = "System rules\n\nAgent rules\n\nRepository details";

    expect(
      investigationInstructionsTraceEvent(
        instructions,
        new Date("2026-08-11T13:03:27.000Z"),
      ),
    ).toEqual({
      data: { instructions },
      meta: { at: "2026-08-11T13:03:27.000Z" },
      type: "instructions.configured",
    });
  });
});
