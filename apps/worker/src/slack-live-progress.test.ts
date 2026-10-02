import { describe, expect, it } from "vitest";
import {
  applySlackTraceUpdate,
  slackProgressFromTrace,
} from "@responder/core/integrations/slack-live-progress";

describe("Slack investigation progress", () => {
  it("maps repository work to a safe human-readable phase", () => {
    expect(
      slackProgressFromTrace({
        type: "actions.requested",
        data: {
          actions: [
            {
              callId: "call-read-1",
              toolName: "read_repository_file",
              input: { path: "secret/internal/path.ts" },
            },
          ],
        },
      }),
    ).toEqual({
      detail: "Inspecting the relevant source code.",
      traceItems: [
        {
          detail: '{\n  "path": "secret/internal/path.ts"\n}',
          id: "call-read-1",
          status: "in_progress",
          title: "read_repository_file",
        },
      ],
    });
  });

  it("describes Slack assistant steps without investigation wording", () => {
    const steps = [
      { type: "session.started" },
      { type: "instructions.configured" },
      { type: "reasoning.completed" },
      { type: "message.completed", data: { message: "Opened the pull request." } },
      ...["read_repository_file", "open_pull_request", "update_automation", "get_workspace", "sentry_search", "shell"]
        .map((toolName) => ({
          type: "actions.requested",
          data: { actions: [{ callId: `call-${toolName}`, toolName }] },
        })),
      { type: "action.result", data: { result: { callId: "call-shell" }, status: "failed" } },
    ].map((event) => slackProgressFromTrace(event, { assistant: true }));

    expect(steps.map((step) => step?.detail)).toEqual([
      "Starting and loading the workspace context.",
      "Reading the request.",
      "Thinking.",
      "Writing the reply.",
      "Reading the code.",
      "Opening a pull request.",
      "Updating the workspace.",
      "Reading the workspace settings.",
      "Checking connected tools.",
      "Working on the request.",
      "A tool call failed; continuing.",
    ]);
    expect(JSON.stringify(steps)).not.toMatch(/investigat|evidence|findings/i);
  });

  it("marks report submission as the final live update", () => {
    expect(
      slackProgressFromTrace({
        type: "actions.requested",
        data: {
          actions: [
            {
              callId: "call-report-1",
              toolName: "submit_investigation_report",
            },
          ],
        },
      }),
    ).toEqual({
      detail: "Preparing the final findings.",
      finalizing: true,
      traceItems: [
        {
          detail: "{}",
          id: "call-report-1",
          status: "in_progress",
          title: "submit_investigation_report",
        },
      ],
    });
  });

  it("keeps raw arguments while redacting unmistakable credentials", () => {
    const progress = slackProgressFromTrace({
      type: "actions.requested",
      data: {
        actions: [
          {
            callId: "call-mcp-1",
            toolName: "custom_mcp.query",
            input: {
              query: "service:checkout status:error",
              authorization: "Bearer secret-token",
              accessToken: "plain-access-token",
              apiKey: "plain-api-key",
            },
          },
        ],
      },
    });

    expect(progress?.traceItems?.[0]?.detail).toContain(
      '"query": "service:checkout status:error"',
    );
    expect(progress?.traceItems?.[0]?.detail).toContain(
      '"authorization": "[redacted]"',
    );
    expect(progress?.traceItems?.[0]?.detail).not.toContain("secret-token");
    expect(progress?.traceItems?.[0]?.detail).toContain(
      '"accessToken": "[redacted]"',
    );
    expect(progress?.traceItems?.[0]?.detail).toContain(
      '"apiKey": "[redacted]"',
    );
    expect(progress?.traceItems?.[0]?.detail).not.toContain("plain-access-token");
    expect(progress?.traceItems?.[0]?.detail).not.toContain("plain-api-key");
  });

  it("attaches scrubbed tool output when a call completes", () => {
    const result = slackProgressFromTrace({
      type: "action.result",
      data: {
        status: "completed",
        result: {
          callId: "call-read-1",
          output: { lines: ["line one", "line two"] },
        },
      },
    });
    expect(result).not.toBeNull();

    expect(
      applySlackTraceUpdate(
        [
          {
            detail: '{\n  "path": "src/app.ts"\n}',
            id: "call-read-1",
            status: "in_progress",
            title: "read_repository_file",
          },
        ],
        result!,
      ),
    ).toEqual([
      {
        detail: '{\n  "path": "src/app.ts"\n}',
        id: "call-read-1",
        output: '{\n  "lines": [\n    "line one",\n    "line two"\n  ]\n}',
        status: "complete",
        title: "read_repository_file",
      },
    ]);
  });

  it("ignores result payloads that cannot be matched to a tool call", () => {
    expect(
      slackProgressFromTrace({
        type: "action.result",
        data: { result: { output: "sensitive raw output" } },
      }),
    ).toBeNull();
  });
});
