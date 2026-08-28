import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptCredentials } from "../credentials/encryption.js";
import {
  recordInvestigationSlackReply,
  recordInvestigationSlackTrace,
  setInvestigationSlackReaction,
} from "../db/investigations.js";
import { getSlackInvestigationLiveContext } from "../db/issues.js";
import {
  SlackApiError,
  removeSlackReaction,
  setSlackThreadStatus,
  stopSlackResponseStream,
  updateSlackMessage,
} from "./slack.js";
import {
  failInvestigationSlackCard,
  investigationIdFromFeedbackBlockId,
  slackCardFailureMetricEvent,
  slackErrorLogFields,
  slackInvestigationCard,
  updateInvestigationSlackProgress,
} from "./slack-live-card.js";

vi.mock("../credentials/encryption.js", () => ({
  decryptCredentials: vi.fn(),
}));
vi.mock("../db/investigations.js", () => ({
  recordInvestigationSlackReply: vi.fn(),
  recordInvestigationSlackTrace: vi.fn(),
  setInvestigationSlackReaction: vi.fn(),
}));
vi.mock("../db/issues.js", () => ({
  getSlackInvestigationLiveContext: vi.fn(),
}));
vi.mock("./slack.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./slack.js")>()),
  removeSlackReaction: vi.fn(),
  setSlackThreadStatus: vi.fn(),
  stopSlackResponseStream: vi.fn(),
  updateSlackMessage: vi.fn(),
}));

const context = {
  agentId: "13131313-1313-4313-8313-131313131313",
  executionMode: "standard" as const,
  investigationId: "16161616-1616-4616-8616-161616161616",
  title: "Plant API error rate is elevated",
  traceItems: [],
  source: {
    channelId: "C123",
    encryptedCredentials: "encrypted-slack-token",
    messageTimestamp: "1785500001.000200",
    threadTimestamp: "1785500000.000100",
  },
};

describe("Slack live investigation card", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps individual Slack failures in structured log fields", () => {
    expect(
      slackErrorLogFields(
        new AggregateError(
          [new Error("message update failed"), "status update failed"],
          "Slack progress failed",
        ),
      ),
    ).toEqual({
      error: "Slack progress failed",
      causes: ["message update failed", "status update failed"],
    });
  });

  it("retains safe Slack validation diagnostics in structured log fields", () => {
    expect(
      slackErrorLogFields(
        new AggregateError(
          [
            new SlackApiError("chat.update", "invalid_blocks", [
              "must be more than 0 characters: /0/tasks/1/output",
            ]),
          ],
          "Slack progress failed",
        ),
      ),
    ).toEqual({
      error: "Slack progress failed",
      causes: ["Slack chat.update failed (invalid_blocks)"],
      slackErrors: [
        {
          code: "invalid_blocks",
          diagnostics: [
            "must be more than 0 characters: /0/tasks/1/output",
          ],
          method: "chat.update",
        },
      ],
    });
  });

  it("builds a low-cardinality Slack card failure counter", () => {
    expect(slackCardFailureMetricEvent("progress_failed", 123)).toEqual({
      _aws: {
        Timestamp: 123,
        CloudWatchMetrics: [
          {
            Dimensions: [["outcome"]],
            Metrics: [
              {
                Name: "slack.investigation_card.failure.total",
                Unit: "Count",
              },
            ],
            Namespace: "Responder",
          },
        ],
      },
      outcome: "progress_failed",
      "slack.investigation_card.failure.total": 1,
    });
  });

  it("renders one native plan block with a linked current task", () => {
    vi.stubEnv("RESPONDER_APP_URL", "https://responder.example");

    const message = slackInvestigationCard({
      agentId: context.agentId,
      detail: "Inspecting the relevant source code.",
      investigationId: context.investigationId,
      status: "in_progress",
      title: context.title,
    });

    expect(message.blocks).toEqual([
      expect.objectContaining({
        type: "plan",
        title: "Trace",
        tasks: [
          expect.objectContaining({
            status: "in_progress",
            title: "Inspecting the relevant source code.",
            sources: [
              {
                type: "url",
                text: "View investigation",
                url: `https://responder.example/agents/${context.agentId}/investigations/${context.investigationId}`,
              },
            ],
          }),
        ],
      }),
    ]);
  });

  it("omits the investigation link from tag mode cards", () => {
    const message = slackInvestigationCard({
      agentId: context.agentId,
      detail: "Inspecting the relevant source code.",
      investigationId: context.investigationId,
      showInvestigationLink: false,
      status: "in_progress",
      title: context.title,
    });

    expect(message.blocks).toEqual([
      expect.objectContaining({
        type: "plan",
        tasks: [
          expect.not.objectContaining({ sources: expect.anything() }),
        ],
      }),
    ]);
  });

  it("reads an investigation ID only from its feedback block", () => {
    expect(
      investigationIdFromFeedbackBlockId(
        `investigation_feedback_${context.investigationId}_card-version`,
      ),
    ).toBe(context.investigationId);
    expect(
      investigationIdFromFeedbackBlockId(
        `other_feedback_${context.investigationId}_card-version`,
      ),
    ).toBeNull();
    expect(
      investigationIdFromFeedbackBlockId(
        "investigation_feedback_not-an-investigation_card-version",
      ),
    ).toBeNull();
  });

  it("keeps the investigation title in fallback text while using a fixed plan title", () => {
    vi.stubEnv("RESPONDER_APP_URL", "https://responder.example");

    const message = slackInvestigationCard({
      agentId: context.agentId,
      detail: "Inspecting the alert.",
      investigationId: context.investigationId,
      status: "in_progress",
      title: '*:rotating_light: Alert for "Errors"*',
    });

    expect(message.blocks).toEqual([
      expect.objectContaining({
        type: "plan",
        title: "Trace",
      }),
    ]);
    expect(message.text).toBe(
      '🚨 Alert for "Errors" — Inspecting the alert.',
    );
  });

  it("updates the task card and refreshes Slack's rotating loading state", async () => {
    vi.mocked(getSlackInvestigationLiveContext).mockResolvedValue(context);
    vi.mocked(decryptCredentials).mockReturnValue({ accessToken: "xoxb-test" });
    vi.mocked(updateSlackMessage).mockResolvedValue();
    vi.mocked(setSlackThreadStatus).mockResolvedValue();

    await expect(
      updateInvestigationSlackProgress(
        context.investigationId,
        "Inspecting the relevant source code.",
        [
          {
            id: "turn-plan",
            status: "complete",
            title: "Prepared the investigation plan",
          },
        ],
      ),
    ).resolves.toBe(true);

    expect(updateSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123",
        timestamp: "1785500001.000200",
        blocks: [expect.objectContaining({ type: "plan" })],
      }),
    );
    expect(recordInvestigationSlackTrace).toHaveBeenCalledWith(
      context.investigationId,
      [expect.objectContaining({ id: "turn-plan" })],
    );
    expect(setSlackThreadStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        loadingMessages: expect.arrayContaining(["Gathering evidence…"]),
        status: "is investigating this alert…",
      }),
    );
  });

  it("records one metric and one contextual error for a progress failure", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const metricLog = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(getSlackInvestigationLiveContext).mockResolvedValue(context);
    vi.mocked(decryptCredentials).mockReturnValue({ accessToken: "xoxb-test" });
    vi.mocked(updateSlackMessage).mockRejectedValue(
      new Error("message update failed"),
    );
    vi.mocked(setSlackThreadStatus).mockResolvedValue();

    await expect(
      updateInvestigationSlackProgress(
        context.investigationId,
        "Inspecting the relevant source code.",
      ),
    ).rejects.toThrow(
      `Slack investigation progress update failed for ${context.investigationId}`,
    );

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(metricLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(metricLog.mock.calls[0]?.[0]))).toEqual(
      expect.objectContaining({
        outcome: "progress_failed",
        "slack.investigation_card.failure.total": 1,
      }),
    );
    expect(JSON.parse(String(errorLog.mock.calls[0]?.[0]))).toEqual(
      expect.objectContaining({
        causes: ["message update failed"],
        error: `Slack investigation progress update failed for ${context.investigationId}`,
        event: "investigation_slack_card_failure",
        investigationId: context.investigationId,
        outcome: "progress_failed",
      }),
    );
  });

  it("distinguishes a context lookup failure from a normal Slack skip", async () => {
    vi.mocked(getSlackInvestigationLiveContext).mockRejectedValue(
      new Error("database connection refused"),
    );

    await expect(
      updateInvestigationSlackProgress(
        context.investigationId,
        "Inspecting the relevant source code.",
      ),
    ).rejects.toThrow(
      `Slack investigation progress update failed for ${context.investigationId}`,
    );
    expect(recordInvestigationSlackTrace).not.toHaveBeenCalled();
    expect(updateSlackMessage).not.toHaveBeenCalled();
  });

  it("renders repository tools and agent turns with readable titles", () => {
    const message = slackInvestigationCard({
      agentId: context.agentId,
      detail: "Gathering telemetry and surrounding service activity.",
      investigationId: context.investigationId,
      status: "in_progress",
      title: context.title,
      traceItems: [
        {
          detail:
            '{\n  "repository": "example-org/example-service",\n  "path": "."\n}',
          id: "call-list-1",
          output: '"/workspace/src/app.ts\\n/workspace/package.json"',
          status: "complete",
          title: "list_repository_files",
        },
        {
          id: "message-1",
          output: "I’m reading the relevant source files now.",
          status: "complete",
          title: "Assistant turn",
        },
        {
          detail:
            '{\n  "repository": "example-org/example-service",\n  "path": "src/app.ts",\n  "startLine": 1,\n  "endLine": 300\n}',
          id: "call-read-1",
          output: JSON.stringify(
            '1: import { trace } from "@opentelemetry/api";\n2: \n3: const tracer = trace.getTracer("app");',
          ),
          status: "complete",
          title: "read_repository_file",
        },
        {
          detail:
            '{\n  "repository": "example-org/example-service",\n  "path": "config.yaml"\n}',
          id: "call-read-yaml",
          output: '"enabled: true\\n"',
          status: "complete",
          title: "read_repository_file",
        },
      ],
    });

    expect(message.blocks).toHaveLength(1);
    expect(message.blocks).toEqual([
      expect.objectContaining({
        type: "plan",
        tasks: expect.arrayContaining([
          expect.objectContaining({
            task_id: `${context.investigationId}:call-list-1`,
            title: "List repository files (`example-org/example-service`)",
            status: "complete",
            output: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_preformatted",
                  elements: [
                    {
                      type: "text",
                      text: '"/workspace/src/app.ts\\n/workspace/package.json"',
                    },
                  ],
                },
              ],
            },
          }),
          expect.objectContaining({
            task_id: `${context.investigationId}:message-1`,
            title: "Agent",
            output: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: "I’m reading the relevant source files now.",
                    },
                  ],
                },
              ],
            },
          }),
          expect.objectContaining({
            task_id: `${context.investigationId}:call-read-1`,
            title: "Read file `src/app.ts` (lines 1:300)",
            status: "complete",
            output: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_preformatted",
                  language: "javascript",
                  elements: [
                    {
                      type: "text",
                      text:
                        'import { trace } from "@opentelemetry/api";\n\nconst tracer = trace.getTracer("app");',
                    },
                  ],
                },
              ],
            },
          }),
          expect.objectContaining({
            task_id: `${context.investigationId}:call-read-yaml`,
            title: "Read file `config.yaml`",
            output: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_preformatted",
                  language: "yaml",
                  elements: [{ type: "text", text: "enabled: true\n" }],
                },
              ],
            },
          }),
        ]),
      }),
    ]);
  });

  it("renders Datadog tools with styled inputs, raw data, and deep links", () => {
    const traceUrl = "https://app.datadoghq.eu/apm/trace/abc123";
    const logsUrl = "https://app.datadoghq.eu/logs?query=status%3Aerror";
    const message = slackInvestigationCard({
      agentId: context.agentId,
      detail: "Gathering telemetry.",
      investigationId: context.investigationId,
      status: "in_progress",
      title: context.title,
      traceItems: [
        {
          detail: '{"trace_id":"abc123"}',
          id: "call-trace-1",
          output: JSON.stringify({
            type: "text",
            text: `<METADATA>\n<trace_deep_link_url>${traceUrl}</trace_deep_link_url>\n</METADATA>\n<YAML_DATA>\n- root_span:\n  service: api`,
          }),
          status: "complete",
          title: "get_datadog_trace",
        },
        {
          detail: JSON.stringify({
            query: 'source:vercel status:error -"cart.add failed"',
            from: "now-24h",
            to: "now",
            extra_fields: ["path", "statusCode"],
          }),
          id: "call-logs-1",
          output: JSON.stringify({
            type: "text",
            text: `<METADATA>\n<logs_explorer_url>${logsUrl}</logs_explorer_url>\n</METADATA>\n<YAML_DATA>\n- message: failed\n</YAML_DATA>`,
          }),
          status: "complete",
          title: "search_datadog_logs",
        },
      ],
    });

    expect(message.blocks).toEqual([
      expect.objectContaining({
        tasks: expect.arrayContaining([
          expect.objectContaining({
            title: "Get Datadog trace `abc123`",
            output: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_preformatted",
                  elements: [
                    { type: "text", text: "root_span:\n  service: api" },
                  ],
                },
              ],
            },
            sources: [
              {
                type: "url",
                url: traceUrl,
                text: "See trace on Datadog",
              },
            ],
          }),
          expect.objectContaining({
            title: "Search Datadog logs",
            details: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    { type: "text", text: "Query: ", style: { bold: true } },
                    {
                      type: "text",
                      text: 'source:vercel status:error -"cart.add failed"',
                    },
                    { type: "text", text: "\nFrom: ", style: { bold: true } },
                    { type: "text", text: "now-24h" },
                    { type: "text", text: "\nTo: ", style: { bold: true } },
                    { type: "text", text: "now" },
                    {
                      type: "text",
                      text: "\nExtra fields: ",
                      style: { bold: true },
                    },
                    { type: "text", text: "path, statusCode" },
                  ],
                },
              ],
            },
            output: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_preformatted",
                  elements: [{ type: "text", text: "- message: failed" }],
                },
              ],
            },
            sources: [
              {
                type: "url",
                url: logsUrl,
                text: "See logs on Datadog",
              },
            ],
          }),
        ]),
      }),
    ]);
  });

  it("formats all stable local and Slack tool families", () => {
    vi.stubEnv("RESPONDER_APP_URL", "https://responder.example");
    const pullRequestUrl = "https://github.com/example-org/responder/pull/123";
    const message = slackInvestigationCard({
      agentId: context.agentId,
      detail: "Inspecting code and related issues.",
      investigationId: context.investigationId,
      status: "in_progress",
      title: context.title,
      traceItems: [
        {
          detail: JSON.stringify({ pattern: "**/*.ts", path: "/workspace" }),
          id: "call-glob",
          output: JSON.stringify({
            content: "/workspace/src/app.ts",
            count: 1,
            path: "/workspace",
            truncated: false,
          }),
          status: "complete",
          title: "glob",
        },
        {
          detail: JSON.stringify({
            pattern: "throw new Error",
            path: "/workspace",
            glob: "*.ts",
          }),
          id: "call-grep",
          output: JSON.stringify({
            content: "/workspace/src/app.ts:10:throw new Error()",
            matchCount: 1,
            path: "/workspace",
            truncated: false,
          }),
          status: "complete",
          title: "grep",
        },
        {
          detail: JSON.stringify({
            filePath: "/workspace/src/app.ts",
            offset: 10,
            limit: 20,
          }),
          id: "call-read-file",
          output: JSON.stringify({
            content: "10: throw new Error();",
            path: "/workspace/src/app.ts",
            totalLines: 50,
            truncated: false,
          }),
          status: "complete",
          title: "read_file",
        },
        {
          detail: JSON.stringify({
            repository: "example-org/responder",
            path: "src",
            query: "throw new Error",
          }),
          id: "call-search-repository",
          output: '"src/app.ts:10:throw new Error();"',
          status: "complete",
          title: "search_repository",
        },
        {
          detail: JSON.stringify({ query: "plant API failure", limit: 5 }),
          id: "call-search-issues",
          output: JSON.stringify({
            mode: "semantic",
            issues: [
              { id: "issue-1", title: "Plant API failed" },
              { id: "issue-2", title: "Cart route timed out" },
            ],
          }),
          status: "complete",
          title: "search_existing_issues",
        },
        {
          detail: JSON.stringify({
            issueId: "issue-1",
            repository: "example-org/responder",
            summary: "Handle the failure.",
            testing: "Unit tests pass.",
          }),
          id: "call-create-pr",
          output: JSON.stringify({ created: true, pullRequestUrl }),
          status: "complete",
          title: "create_pull_request",
        },
        {
          detail: JSON.stringify({
            channel_id: "C123",
            thread_ts: "1785500000.000100",
            limit: 50,
          }),
          id: "call-slack-thread",
          output: '{"messages":[]}',
          status: "complete",
          title: "slack_read_thread",
        },
      ],
    });

    expect(message.blocks).toEqual([
      expect.objectContaining({
        tasks: expect.arrayContaining([
          expect.objectContaining({
            title: "Find files matching `**/*.ts`",
            output: expect.objectContaining({ type: "rich_text" }),
          }),
          expect.objectContaining({
            title: "Search files for `throw new Error`",
            output: expect.objectContaining({ type: "rich_text" }),
          }),
          expect.objectContaining({
            title: "Read file `/workspace/src/app.ts` (lines 10:29)",
            output: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_preformatted",
                  language: "javascript",
                  elements: [
                    { type: "text", text: "throw new Error();" },
                  ],
                },
              ],
            },
          }),
          expect.objectContaining({
            title: "Search repository for `throw new Error`",
          }),
          expect.objectContaining({
            title: "Search existing issues for `plant API failure`",
            output: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_list",
                  style: "bullet",
                  elements: [
                    {
                      type: "rich_text_section",
                      elements: [
                        {
                          type: "link",
                          url: "https://responder.example/issues/issue-1",
                          text: "Plant API failed",
                        },
                      ],
                    },
                    {
                      type: "rich_text_section",
                      elements: [
                        {
                          type: "link",
                          url: "https://responder.example/issues/issue-2",
                          text: "Cart route timed out",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
          expect.objectContaining({
            title: "Create pull request in `example-org/responder`",
            sources: [
              { type: "url", url: pullRequestUrl, text: "Open on GitHub" },
            ],
          }),
          expect.objectContaining({
            title:
              "Read Slack thread `1785500000.000100` in `C123`",
          }),
        ]),
      }),
    ]);
  });

  it("humanizes unknown provider tools and falls back to raw data", () => {
    const message = slackInvestigationCard({
      agentId: context.agentId,
      detail: "Gathering provider evidence.",
      investigationId: context.investigationId,
      status: "in_progress",
      title: context.title,
      traceItems: [
        {
          detail: '{"sourceId":"logs","lookback":"24h"}',
          id: "call-clickstack",
          output: '{"patterns":[]}',
          status: "complete",
          title: "clickstack_event_patterns",
        },
        {
          detail: '{"organizationSlug":"acme","query":"level:error"}',
          id: "call-sentry",
          output: '{"issues":[]}',
          status: "complete",
          title: "search_issues",
        },
        {
          detail: "provider-v2-input",
          id: "call-changed-datadog",
          output: "provider-v2-output",
          status: "complete",
          title: "get_datadog_trace",
        },
      ],
    });

    expect(message.blocks).toEqual([
      expect.objectContaining({
        tasks: expect.arrayContaining([
          expect.objectContaining({
            title: "ClickStack event patterns",
            details: expect.objectContaining({ type: "rich_text" }),
            output: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_preformatted",
                  elements: [{ type: "text", text: '{"patterns":[]}' }],
                },
              ],
            },
          }),
          expect.objectContaining({
            title: "Search Sentry issues",
            details: expect.objectContaining({ type: "rich_text" }),
            output: expect.objectContaining({ type: "rich_text" }),
          }),
          expect.objectContaining({
            title: "Get Datadog trace",
            details: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_preformatted",
                  elements: [{ type: "text", text: "provider-v2-input" }],
                },
              ],
            },
            output: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_preformatted",
                  elements: [{ type: "text", text: "provider-v2-output" }],
                },
              ],
            },
          }),
        ]),
      }),
    ]);
  });

  it("falls back to raw issue-search output if any result is malformed", () => {
    const output = JSON.stringify({
      mode: "semantic",
      issues: [
        { id: "issue-1", title: "Plant API failed" },
        { id: 2, title: "Malformed issue" },
      ],
    });
    const message = slackInvestigationCard({
      agentId: context.agentId,
      detail: "Checking earlier incidents.",
      investigationId: context.investigationId,
      status: "in_progress",
      title: context.title,
      traceItems: [
        {
          detail: JSON.stringify({ query: "plant API failure", limit: 5 }),
          id: "call-search-issues",
          output,
          status: "complete",
          title: "search_existing_issues",
        },
      ],
    });

    expect(message.blocks).toEqual([
      expect.objectContaining({
        tasks: expect.arrayContaining([
          expect.objectContaining({
            title: "Search existing issues for `plant API failure`",
            output: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_preformatted",
                  elements: [{ type: "text", text: output }],
                },
              ],
            },
          }),
        ]),
      }),
    ]);
  });

  it("formats the submitted report as readable text", () => {
    const message = slackInvestigationCard({
      agentId: context.agentId,
      detail: "Completed the investigation plan.",
      investigationId: context.investigationId,
      status: "complete",
      title: context.title,
      traceItems: [
        {
          detail: JSON.stringify({
            headline: "Example service errors were expected",
            summary: "The failures are intentional.",
            issues: [],
          }),
          id: "call-report-1",
          status: "complete",
          title: "submit_investigation_report",
        },
      ],
    });

    expect(message.blocks).toEqual([
      expect.objectContaining({
        tasks: [
          expect.objectContaining({
            title: "Submit investigation report:",
            output: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text:
                        "Example service errors were expected\nThe failures are intentional.\nNo issues identified",
                    },
                  ],
                },
              ],
            },
          }),
          expect.not.objectContaining({
            output: expect.anything(),
          }),
        ],
      }),
    ]);
  });

  it("finishes the active trace task when the investigation completes", () => {
    const message = slackInvestigationCard({
      agentId: context.agentId,
      detail: "One issue identified.",
      investigationId: context.investigationId,
      status: "complete",
      title: context.title,
      traceItems: [
        {
          detail: '{\n  "headline": "Plant API failed"\n}',
          id: "call-report-1",
          status: "in_progress",
          title: "submit_investigation_report",
        },
      ],
    });

    expect(message.blocks).toEqual([
      expect.objectContaining({
        type: "plan",
        tasks: [
          expect.objectContaining({
            status: "complete",
            title: "Submit investigation report:",
          }),
          expect.objectContaining({
            status: "complete",
            title: "Investigation complete",
          }),
        ],
      }),
    ]);
    const plan = message.blocks[0] as {
      tasks: Array<{ output?: unknown; title: string }>;
    };
    expect(
      plan.tasks.find((task) => task.title === "Investigation complete"),
    ).not.toHaveProperty("output");
    expect(message.text).toBe(
      `${context.title} — Investigation complete`,
    );
  });

  it("renders empty structured tool output as valid non-empty rich text", () => {
    const message = slackInvestigationCard({
      agentId: context.agentId,
      detail: "Reviewing search results.",
      investigationId: context.investigationId,
      status: "in_progress",
      title: context.title,
      traceItems: [
        {
          detail: JSON.stringify({ pattern: "missing" }),
          id: "call-empty-grep",
          output: JSON.stringify({ content: "" }),
          status: "complete",
          title: "grep",
        },
      ],
    });

    expect(message.blocks).toEqual([
      expect.objectContaining({
        tasks: expect.arrayContaining([
          expect.objectContaining({
            output: expect.objectContaining({
              elements: [
                expect.objectContaining({
                  elements: [{ text: "No output.", type: "text" }],
                }),
              ],
            }),
          }),
        ]),
      }),
    ]);
  });

  it("moves the card to an error state and clears the spinner", async () => {
    vi.mocked(getSlackInvestigationLiveContext).mockResolvedValue(context);
    vi.mocked(decryptCredentials).mockReturnValue({ accessToken: "xoxb-test" });
    vi.mocked(updateSlackMessage).mockResolvedValue();
    vi.mocked(setSlackThreadStatus).mockResolvedValue();

    await expect(
      failInvestigationSlackCard(context.investigationId, [
        {
          detail: '{\n  "query": "latest work"\n}',
          id: "call-latest",
          status: "in_progress",
          title: "datadog.search_logs",
        },
      ]),
    ).resolves.toBe(true);

    expect(recordInvestigationSlackTrace).toHaveBeenCalledWith(
      context.investigationId,
      [expect.objectContaining({ id: "call-latest" })],
    );

    expect(updateSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: "plan",
            tasks: [
              expect.objectContaining({
                status: "error",
                title: "Datadog search logs",
              }),
              expect.objectContaining({ status: "error" }),
            ],
          }),
        ],
      }),
    );
    expect(setSlackThreadStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "" }),
    );
  });

  it("finalizes the tag-mode response stream and removes eyes on failure", async () => {
    const threadContext = {
      ...context,
      executionMode: "slack_thread" as const,
      source: {
        ...context.source,
        reactionTimestamp: "1785500000.000100",
        responseMessageTimestamp: "1785500002.000300",
      },
    };
    vi.mocked(getSlackInvestigationLiveContext).mockResolvedValue(threadContext);
    vi.mocked(decryptCredentials).mockReturnValue({ accessToken: "xoxb-test" });
    vi.mocked(stopSlackResponseStream).mockResolvedValue();
    vi.mocked(updateSlackMessage).mockResolvedValue();
    vi.mocked(removeSlackReaction).mockResolvedValue();
    vi.mocked(setSlackThreadStatus).mockResolvedValue();

    await expect(
      failInvestigationSlackCard(threadContext.investigationId),
    ).resolves.toBe(true);

    expect(stopSlackResponseStream).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp: "1785500002.000300",
      }),
    );
    expect(recordInvestigationSlackReply).toHaveBeenCalledWith(
      threadContext.investigationId,
      expect.objectContaining({
        key: "thread-response",
        slackTimestamp: "1785500002.000300",
      }),
    );
    expect(removeSlackReaction).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: "1785500000.000100" }),
    );
    expect(setInvestigationSlackReaction).toHaveBeenCalledWith(
      threadContext.investigationId,
      "eyes",
      false,
    );
  });
});
