import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decryptCredentials } from "../credentials/encryption.js";
import { responderIssueUrl } from "../responder-urls.js";
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
import type { SlackInvestigationTraceItem } from "./slack-live-progress.js";

const slackCredentialsSchema = z.object({
  accessToken: z.string().min(1),
});
const investigationIdSchema = z.uuid();
const INVESTIGATION_FEEDBACK_BLOCK_PREFIX = "investigation_feedback_";

export type SlackInvestigationCardStatus =
  | "pending"
  | "in_progress"
  | "complete"
  | "error";

export function slackInvestigationFeedbackBlock(investigationId: string) {
  return {
    type: "context_actions",
    block_id: `${INVESTIGATION_FEEDBACK_BLOCK_PREFIX}${investigationId}_${randomUUID()}`,
    elements: [
      {
        type: "feedback_buttons",
        action_id: "feedback",
        positive_button: {
          text: { type: "plain_text", text: "Good Response" },
          value: "positive",
          accessibility_label: "Submit positive investigation feedback",
        },
        negative_button: {
          text: { type: "plain_text", text: "Bad Response" },
          value: "negative",
          accessibility_label: "Submit negative investigation feedback",
        },
      },
    ],
  };
}

export function investigationIdFromFeedbackBlockId(
  blockId: string | undefined,
): string | null {
  if (!blockId?.startsWith(INVESTIGATION_FEEDBACK_BLOCK_PREFIX)) return null;
  const investigationId = blockId.slice(
    INVESTIGATION_FEEDBACK_BLOCK_PREFIX.length,
    INVESTIGATION_FEEDBACK_BLOCK_PREFIX.length + 36,
  );
  return investigationIdSchema.safeParse(investigationId).success
    ? investigationId
    : null;
}

function truncate(value: string, maximum: number): string {
  return value.length > maximum
    ? `${value.slice(0, maximum - 1).trimEnd()}…`
    : value;
}

function nonEmptyText(
  value: string,
  maximum: number,
  fallback: string,
): string {
  const rendered = truncate(value, maximum);
  return rendered.trim().length > 0 ? rendered : fallback;
}

function responderAppUrl(): string {
  return (
    process.env.RESPONDER_APP_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function investigationUrl(agentId: string, investigationId: string): string {
  const origin = responderAppUrl();
  return `${origin}/agents/${encodeURIComponent(agentId)}/investigations/${encodeURIComponent(investigationId)}`;
}

function richText(value: string, preformatted = false) {
  return {
    type: "rich_text",
    elements: [
      {
        type: preformatted ? "rich_text_preformatted" : "rich_text_section",
        elements: [
          {
            type: "text",
            text: nonEmptyText(value, 1_500, "No content."),
          },
        ],
      },
    ],
  };
}

function parseObject(value?: string): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseString(value?: string): string | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function stripGeneratedLineNumbers(value: string): string {
  const lines = value.split("\n");
  const nonemptyLines = lines.filter((line) => line.length > 0);
  const numbers = nonemptyLines.map((line) =>
    line.match(/^(\d+):(?: |$)/)?.[1],
  );
  const firstNumber = Number(numbers[0]);
  if (
    nonemptyLines.length === 0 ||
    !Number.isSafeInteger(firstNumber) ||
    !numbers.every(
      (number, index) => Number(number) === firstNumber + index,
    )
  ) {
    return value;
  }
  return lines.map((line) => line.replace(/^\d+: ?/, "")).join("\n");
}

function humanizeToolName(value: string): string {
  const words = value.split(/[_\-.]+/).filter(Boolean);
  const replacements: Record<string, string> = {
    ai: "AI",
    apm: "APM",
    axiom: "Axiom",
    clickstack: "ClickStack",
    datadog: "Datadog",
    dsn: "DSN",
    dsns: "DSNs",
    mcp: "MCP",
    pr: "PR",
    rum: "RUM",
    sentry: "Sentry",
    slack: "Slack",
    upstash: "Upstash",
    langfuse: "Langfuse",
    slo: "SLO",
    slos: "SLOs",
    sql: "SQL",
    url: "URL",
  };
  const title = words
    .map((word) => replacements[word.toLowerCase()] ?? word.toLowerCase())
    .join(" ");
  return title ? `${title[0]!.toUpperCase()}${title.slice(1)}` : "Tool";
}

const sentryInspectToolNames = new Set([
  "execute_sentry_tool",
  "find_alert_rules",
  "find_dashboards",
  "find_monitors",
  "find_organizations",
  "find_projects",
  "find_releases",
  "find_teams",
  "find_uptime_monitors",
  "get_ai_conversation_details",
  "get_alert_rule",
  "get_dashboard_details",
  "get_doc",
  "get_event_attachment",
  "get_event_stacktrace",
  "get_issue_activity",
  "get_issue_breadcrumbs",
  "get_issue_details",
  "get_issue_tag_values",
  "get_issue_user_reports",
  "get_latest_base_snapshot",
  "get_monitor_details",
  "get_profile",
  "get_profile_details",
  "get_release_details",
  "get_replay_details",
  "get_sentry_resource",
  "get_snapshot",
  "get_snapshot_image",
  "get_span_details",
  "get_trace_details",
  "get_uptime_monitor_details",
  "search_ai_conversations",
  "search_docs",
  "search_events",
  "search_issue_events",
  "search_issues",
  "search_sentry_tools",
  "whoami",
]);

function displayToolTitle(value: string): string {
  const title = humanizeToolName(value);
  if (!sentryInspectToolNames.has(value) || /\bSentry\b/.test(title)) {
    return title;
  }
  if (value === "whoami") return "Identify Sentry user";
  const separator = title.indexOf(" ");
  return separator < 0
    ? `${title} Sentry`
    : `${title.slice(0, separator)} Sentry${title.slice(separator)}`;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

function objectDetails(
  input: Record<string, unknown>,
  omittedKeys: ReadonlySet<string> = new Set(),
) {
  const visibleEntries = Object.entries(input).filter(
    ([key]) => !omittedKeys.has(key),
  );
  const elements = visibleEntries.flatMap(([key, value], index) => {
    return [
      {
        type: "text" as const,
        text: `${index === 0 ? "" : "\n"}${humanizeToolName(key)}: `,
        style: { bold: true },
      },
      {
        type: "text" as const,
        text: nonEmptyText(displayValue(value), 500, "—"),
      },
    ];
  });
  return elements.length > 0 ? richTextSection(elements) : null;
}

function structuredContent(value?: string): string | null {
  const parsed = parseObject(value);
  return typeof parsed?.content === "string" ? parsed.content : null;
}

function languageForPath(path: string): string | undefined {
  const extension = path.split(".").pop()?.toLowerCase();
  const languages: Record<string, string> = {
    cjs: "javascript",
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "shell",
    sql: "sql",
    ts: "javascript",
    tsx: "javascript",
    yaml: "yaml",
    yml: "yaml",
  };
  return extension ? languages[extension] : undefined;
}

function firstUrl(value?: string): string | null {
  if (!value) return null;
  const parsed = parseObject(value);
  const candidates = parsed
    ? Object.entries(parsed).flatMap(([key, entry]) =>
        /(?:url|link)$/i.test(key) && typeof entry === "string" ? [entry] : [],
      )
    : [];
  const raw = (
    candidates[0] ?? value.match(/https:\/\/[^\s<>"']+/)?.[0]
  )?.replace(/[),.;]+$/, "");
  if (!raw) return null;
  try {
    return new URL(raw).toString();
  } catch {
    return null;
  }
}

function sourceLabel(url: string): string {
  const host = new URL(url).hostname;
  if (host.includes("datadog")) return "Open in Datadog";
  if (host.includes("sentry")) return "Open in Sentry";
  if (host.includes("slack")) return "Open in Slack";
  if (host.includes("clickhouse") || host.includes("hyperdx")) {
    return "Open in ClickStack";
  }
  if (host.includes("github")) return "Open on GitHub";
  return "Open source";
}

function richTextSection(
  elements: Array<{
    style?: { bold?: boolean; italic?: boolean };
    text: string;
    type: "text";
  }>,
) {
  return {
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements }],
  };
}

function preformatted(value: string, language?: string) {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_preformatted",
        ...(language ? { language } : {}),
        elements: [
          {
            type: "text",
            text: nonEmptyText(value, 1_500, "No output."),
          },
        ],
      },
    ],
  };
}

function issueLinkList(
  issues: Array<{ id: string; title: string }>,
) {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_list",
        style: "bullet",
        elements: issues.map((issue) => ({
          type: "rich_text_section",
          elements: [
            {
              type: "link",
              url: responderIssueUrl(issue.id, responderAppUrl()),
              text: nonEmptyText(issue.title, 2_000, "Untitled issue"),
            },
          ],
        })),
      },
    ],
  };
}

function issueSearchResults(
  value?: string,
): Array<{ id: string; title: string }> | null {
  const result = parseObject(value);
  if (!Array.isArray(result?.issues)) return null;
  const issues: Array<{ id: string; title: string }> = [];
  for (const issue of result.issues) {
    const record =
      issue && typeof issue === "object" && !Array.isArray(issue)
        ? (issue as Record<string, unknown>)
        : null;
    if (
      typeof record?.id !== "string" ||
      typeof record.title !== "string"
    ) {
      return null;
    }
    issues.push({ id: record.id, title: record.title });
  }
  return issues;
}

function datadogResult(value?: string): {
  data?: string;
  deepLinkUrl?: string;
} {
  const parsed = parseObject(value);
  const rawText = typeof parsed?.text === "string" ? parsed.text : value;
  if (!rawText) return {};
  const deepLinkUrl = rawText.match(
    /<(?:trace_deep_link_url|logs_explorer_url)>([^<]+)<\/(?:trace_deep_link_url|logs_explorer_url)>/,
  )?.[1];
  const dataMatch = rawText.match(
    /<(YAML_DATA|TSV_DATA)>\n?([\s\S]*?)(?:\n?<\/\1>|$)/,
  );
  const data = dataMatch
    ? dataMatch[2]?.trim() || (dataMatch[1] === "YAML_DATA" ? "[]" : "")
    : undefined;
  return {
    ...(data ? { data } : {}),
    ...(deepLinkUrl ? { deepLinkUrl } : {}),
  };
}

function datadogSource(url: string, text: string) {
  return [{ type: "url", url, text }];
}

function formattedTraceTask(
  investigationId: string,
  item: SlackInvestigationTraceItem,
  status: SlackInvestigationCardStatus,
) {
  const input = parseObject(item.detail);
  const taskId = `${investigationId}:${item.id}`.slice(0, 255);

  if (item.title === "list_repository_files") {
    const repository = input?.repository;
    if (typeof repository !== "string") return null;
    return {
      task_id: taskId,
      title: `List repository files (\`${repository}\`)`,
      status,
      ...(item.output
        ? { output: preformatted(item.output) }
        : {}),
    };
  }

  if (item.title === "Assistant turn") {
    return {
      task_id: taskId,
      title: "Agent",
      status,
      ...(item.output ? { output: richText(item.output) } : {}),
    };
  }

  if (item.title === "read_repository_file") {
    const path = input?.path;
    if (typeof path !== "string") return null;
    const startLine = input?.startLine;
    const endLine = input?.endLine;
    const range =
      typeof startLine === "number" && typeof endLine === "number"
        ? ` (lines ${startLine}:${endLine})`
        : "";
    const output = item.output
      ? stripGeneratedLineNumbers(parseString(item.output) ?? item.output)
      : null;
    return {
      task_id: taskId,
      title: `Read file \`${path}\`${range}`,
      status,
      ...(output
        ? {
            output: preformatted(output, languageForPath(path)),
          }
        : {}),
    };
  }

  if (item.title === "get_datadog_trace") {
    const traceId = input?.trace_id;
    if (typeof traceId !== "string") return null;
    const result = datadogResult(item.output);
    const deepLinkUrl = firstUrl(result.deepLinkUrl) ?? firstUrl(item.output);
    return {
      task_id: taskId,
      title: `Get Datadog trace \`${traceId}\``,
      status,
      ...(item.output
        ? {
            output: preformatted(
              (result.data ?? item.output).replace(
                /^- root_span:/,
                "root_span:",
              ),
            ),
          }
        : {}),
      ...(deepLinkUrl
        ? { sources: datadogSource(deepLinkUrl, "See trace on Datadog") }
        : {}),
    };
  }

  if (item.title === "search_datadog_logs") {
    const query = input?.query;
    const from = input?.from;
    const to = input?.to;
    const extraFields = input?.extra_fields;
    if (
      typeof query !== "string" ||
      typeof from !== "string" ||
      typeof to !== "string"
    ) {
      return null;
    }
    const details = [
      { type: "text" as const, text: "Query: ", style: { bold: true } },
      {
        type: "text" as const,
        text: nonEmptyText(String(query ?? ""), 1_500, "—"),
      },
      { type: "text" as const, text: "\nFrom: ", style: { bold: true } },
      {
        type: "text" as const,
        text: nonEmptyText(String(from ?? ""), 1_500, "—"),
      },
      { type: "text" as const, text: "\nTo: ", style: { bold: true } },
      {
        type: "text" as const,
        text: nonEmptyText(String(to ?? ""), 1_500, "—"),
      },
      ...(Array.isArray(extraFields)
        ? [
            {
              type: "text" as const,
              text: "\nExtra fields: ",
              style: { bold: true },
            },
            {
              type: "text" as const,
              text: nonEmptyText(extraFields.join(", "), 1_500, "—"),
            },
          ]
        : []),
    ];
    const result = datadogResult(item.output);
    const deepLinkUrl = firstUrl(result.deepLinkUrl) ?? firstUrl(item.output);
    return {
      task_id: taskId,
      title: "Search Datadog logs",
      status,
      details: richTextSection(details),
      ...(item.output
        ? { output: preformatted(result.data ?? item.output) }
        : {}),
      ...(deepLinkUrl
        ? { sources: datadogSource(deepLinkUrl, "See logs on Datadog") }
        : {}),
    };
  }

  if (item.title === "submit_investigation_report") {
    const headline = input?.headline;
    const summary = input?.summary;
    const issues = input?.issues;
    const issueCount = Array.isArray(issues) ? issues.length : null;
    const reportText =
      typeof headline === "string" && typeof summary === "string"
        ? [
            headline,
            summary,
            ...(issueCount === null
              ? []
              : [
                  issueCount === 0
                    ? "No issues identified"
                    : `${issueCount} ${issueCount === 1 ? "issue" : "issues"} identified`,
                ]),
          ].join("\n")
        : null;
    return {
      task_id: taskId,
      title: "Submit investigation report:",
      status,
      ...(reportText
        ? { output: richText(reportText) }
        : item.output
          ? { output: richText(item.output, true) }
          : {}),
    };
  }

  if (item.title === "search_repository") {
    const query = input?.query;
    if (!input || typeof query !== "string") return null;
    const details = objectDetails(input, new Set(["query"]));
    return {
      task_id: taskId,
      title: `Search repository for \`${query}\``,
      status,
      ...(details ? { details } : {}),
      ...(item.output
        ? { output: preformatted(parseString(item.output) ?? item.output) }
        : {}),
    };
  }

  if (item.title === "glob") {
    const pattern = input?.pattern;
    if (!input || typeof pattern !== "string") return null;
    const details = objectDetails(input, new Set(["pattern"]));
    return {
      task_id: taskId,
      title: `Find files matching \`${pattern}\``,
      status,
      ...(details ? { details } : {}),
      ...(item.output
        ? { output: preformatted(structuredContent(item.output) ?? item.output) }
        : {}),
    };
  }

  if (item.title === "grep") {
    const pattern = input?.pattern;
    if (!input || typeof pattern !== "string") return null;
    const details = objectDetails(input, new Set(["pattern"]));
    return {
      task_id: taskId,
      title: `Search files for \`${pattern}\``,
      status,
      ...(details ? { details } : {}),
      ...(item.output
        ? { output: preformatted(structuredContent(item.output) ?? item.output) }
        : {}),
    };
  }

  if (item.title === "read_file") {
    const path = input?.filePath;
    if (typeof path !== "string") return null;
    const offset = typeof input?.offset === "number" ? input.offset : 1;
    const limit = typeof input?.limit === "number" ? input.limit : null;
    const range = limit
      ? ` (lines ${offset}:${offset + limit - 1})`
      : offset > 1
        ? ` (from line ${offset})`
        : "";
    const output = item.output
      ? stripGeneratedLineNumbers(
          structuredContent(item.output) ?? item.output,
        )
      : null;
    return {
      task_id: taskId,
      title: `Read file \`${path}\`${range}`,
      status,
      ...(output
        ? {
            output: preformatted(output, languageForPath(path)),
          }
        : {}),
    };
  }

  if (item.title === "search_existing_issues") {
    const query = input?.query;
    if (!input || typeof query !== "string") return null;
    const issues = issueSearchResults(item.output);
    const details = objectDetails(input, new Set(["query"]));
    return {
      task_id: taskId,
      title: `Search existing issues for \`${truncate(query, 100)}\``,
      status,
      ...(details ? { details } : {}),
      ...(issues
        ? {
            output:
              issues.length > 0
                ? issueLinkList(issues)
                : richText("No matching issues found."),
          }
        : item.output
          ? { output: preformatted(item.output) }
          : {}),
    };
  }

  if (item.title === "create_pull_request") {
    const repository = input?.repository;
    if (!input || typeof repository !== "string") return null;
    const details = objectDetails(
      input,
      new Set(["repository", "issueId"]),
    );
    const url = firstUrl(item.output);
    return {
      task_id: taskId,
      title: `Create pull request in \`${repository}\``,
      status,
      ...(details ? { details } : {}),
      ...(item.output ? { output: preformatted(item.output) } : {}),
      ...(url ? { sources: [{ type: "url", url, text: "Open on GitHub" }] } : {}),
    };
  }

  if (
    item.title === "slack_read_channel" ||
    item.title === "slack_read_thread"
  ) {
    const channelId = input?.channel_id;
    if (!input || typeof channelId !== "string") return null;
    const threadTimestamp = input?.thread_ts ?? input?.thread_timestamp;
    const details = objectDetails(
      input,
      new Set(["channel_id", "thread_ts", "thread_timestamp"]),
    );
    const url = firstUrl(item.output);
    return {
      task_id: taskId,
      title:
        item.title === "slack_read_thread" &&
        typeof threadTimestamp === "string"
          ? `Read Slack thread \`${threadTimestamp}\` in \`${channelId}\``
          : `Read Slack channel \`${channelId}\``,
      status,
      ...(details ? { details } : {}),
      ...(item.output ? { output: preformatted(item.output) } : {}),
      ...(url ? { sources: [{ type: "url", url, text: "Open in Slack" }] } : {}),
    };
  }

  return null;
}

function genericTraceTask(
  investigationId: string,
  item: SlackInvestigationTraceItem,
  status: SlackInvestigationCardStatus,
) {
  const input = parseObject(item.detail);
  const details = input ? objectDetails(input) : null;
  const url = firstUrl(item.output);
  return {
    task_id: `${investigationId}:${item.id}`.slice(0, 255),
    title: truncate(displayToolTitle(item.title), 180),
    status,
    ...(details
      ? { details }
      : item.detail
        ? { details: richText(item.detail, true) }
        : {}),
    ...(item.output ? { output: richText(item.output, true) } : {}),
    ...(url ? { sources: [{ type: "url", url, text: sourceLabel(url) }] } : {}),
  };
}

function traceTask(
  investigationId: string,
  item: SlackInvestigationTraceItem,
  cardStatus: SlackInvestigationCardStatus,
) {
  const status =
    (item.status === "pending" || item.status === "in_progress") &&
    cardStatus === "complete"
      ? "complete"
      : (item.status === "pending" || item.status === "in_progress") &&
          cardStatus === "error"
        ? "error"
        : item.status;
  return (
    formattedTraceTask(investigationId, item, status) ??
    genericTraceTask(investigationId, item, status)
  );
}

export function slackInvestigationCard(input: {
  agentId: string;
  detail: string;
  investigationId: string;
  showInvestigationLink?: boolean;
  status: SlackInvestigationCardStatus;
  title: string;
  traceItems?: SlackInvestigationTraceItem[];
}): { blocks: unknown[]; text: string } {
  const rawTitle = input.title.trim() || "Investigation";
  const title = truncate(
    rawTitle
      .replace(/^\*([^\n]+)\*$/u, "$1")
      .replace(/:rotating_light:/giu, "🚨"),
    180,
  );
  const summaryTask = {
    task_id: `${input.investigationId}:current`.slice(0, 255),
    title:
      input.status === "complete"
        ? "Investigation complete"
        : input.status === "error"
          ? "Investigation stopped"
          : nonEmptyText(input.detail, 180, "Investigation in progress"),
    status: input.status,
    ...(input.status === "error" ? { output: richText(input.detail) } : {}),
    ...(input.showInvestigationLink === false
      ? {}
      : {
          sources: [
            {
              type: "url",
              text: "View investigation",
              url: investigationUrl(input.agentId, input.investigationId),
            },
          ],
        }),
  };
  return {
    text:
      input.status === "complete"
        ? `${title} — Investigation complete`
        : `${title} — ${input.detail}`,
    blocks: [
      {
        type: "plan",
        block_id: `investigation_plan_${input.status}_${randomUUID()}`,
        title: "Trace",
        tasks: [
          ...(input.traceItems ?? [])
            .slice(-11)
            .map((item) =>
              traceTask(input.investigationId, item, input.status),
            ),
          summaryTask,
        ],
      },
    ],
  };
}

function accessToken(encryptedCredentials: string): string {
  return slackCredentialsSchema.parse(
    decryptCredentials<Record<string, unknown>>(encryptedCredentials),
  ).accessToken;
}

const loadingMessages = [
  "Gathering evidence…",
  "Checking telemetry…",
  "Inspecting relevant code…",
  "Connecting the dots…",
];

export type SlackCardFailureOutcome =
  | "progress_failed"
  | "failure_update_failed";

export function slackCardFailureMetricEvent(
  outcome: SlackCardFailureOutcome,
  timestamp = Date.now(),
) {
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Dimensions: [["outcome"]],
          Metrics: [
            { Name: "slack.investigation_card.failure.total", Unit: "Count" },
          ],
          Namespace: "Responder",
        },
      ],
    },
    outcome,
    "slack.investigation_card.failure.total": 1,
  };
}

function recordSlackCardFailure(
  outcome: SlackCardFailureOutcome,
  investigationId: string,
  error: AggregateError,
): void {
  console.log(JSON.stringify(slackCardFailureMetricEvent(outcome)));
  console.error(
    JSON.stringify({
      ...slackErrorLogFields(error),
      event: "investigation_slack_card_failure",
      investigationId,
      outcome,
    }),
  );
}

async function slackInvestigationLiveContext(investigationId: string) {
  try {
    return await getSlackInvestigationLiveContext(investigationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Slack investigation context lookup failed: ${message}`, {
      cause: error,
    });
  }
}

export function slackErrorLogFields(error: unknown): {
  causes?: string[];
  error: string;
  slackErrors?: Array<{
    code: string;
    diagnostics: string[];
    method: string;
  }>;
} {
  const slackErrors: SlackApiError[] = [];
  const collectSlackErrors = (value: unknown): void => {
    if (value instanceof SlackApiError) slackErrors.push(value);
    if (value instanceof AggregateError) {
      for (const cause of value.errors) collectSlackErrors(cause);
    } else if (value instanceof Error && value.cause) {
      collectSlackErrors(value.cause);
    }
  };
  collectSlackErrors(error);
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof AggregateError
      ? {
          causes: error.errors.map((cause: unknown) =>
            cause instanceof Error ? cause.message : String(cause),
          ),
      }
      : {}),
    ...(slackErrors.length > 0
      ? {
          slackErrors: slackErrors.map(({ code, diagnostics, method }) => ({
            code,
            diagnostics,
            method,
          })),
        }
      : {}),
  };
}

async function performInvestigationSlackProgressUpdate(
  investigationId: string,
  detail: string,
  traceItems: SlackInvestigationTraceItem[] = [],
): Promise<boolean> {
  const context = await slackInvestigationLiveContext(investigationId);
  if (!context) return false;
  await recordInvestigationSlackTrace(investigationId, traceItems);
  const token = accessToken(context.source.encryptedCredentials);
  const failures: unknown[] = [];

  if (context.source.messageTimestamp) {
    const card = slackInvestigationCard({
      agentId: context.agentId,
      detail,
      investigationId: context.investigationId,
      showInvestigationLink: context.executionMode !== "slack_thread",
      status: "in_progress",
      title: context.title,
      traceItems,
    });
    try {
      await updateSlackMessage({
        accessToken: token,
        blocks: card.blocks,
        channelId: context.source.channelId,
        text: card.text,
        timestamp: context.source.messageTimestamp,
      });
      await recordInvestigationSlackReply(investigationId, {
        attachments: [],
        authorName: "Responder",
        blocks: card.blocks,
        key: "investigation-status",
        slackTimestamp: context.source.messageTimestamp,
        text: card.text,
      });
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    await setSlackThreadStatus({
      accessToken: token,
      channelId: context.source.channelId,
      loadingMessages,
      status: "is investigating this alert…",
      threadTimestamp: context.source.threadTimestamp,
    });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Slack investigation progress update failed for ${investigationId}`,
    );
  }
  return true;
}

export async function updateInvestigationSlackProgress(
  investigationId: string,
  detail: string,
  traceItems: SlackInvestigationTraceItem[] = [],
): Promise<boolean> {
  try {
    return await performInvestigationSlackProgressUpdate(
      investigationId,
      detail,
      traceItems,
    );
  } catch (cause) {
    const error = new AggregateError(
      cause instanceof AggregateError ? cause.errors : [cause],
      `Slack investigation progress update failed for ${investigationId}`,
    );
    recordSlackCardFailure("progress_failed", investigationId, error);
    throw error;
  }
}

async function performInvestigationSlackCardFailure(
  investigationId: string,
  traceItems?: SlackInvestigationTraceItem[],
): Promise<boolean> {
  const context = await slackInvestigationLiveContext(investigationId);
  if (!context) return false;
  const token = accessToken(context.source.encryptedCredentials);
  const failures: unknown[] = [];
  const failureMessage =
    "I couldn't complete this investigation. Please try again or add more context.";

  if (traceItems) {
    try {
      await recordInvestigationSlackTrace(investigationId, traceItems);
    } catch (error) {
      failures.push(error);
    }
  }

  if (
    context.executionMode === "slack_thread" &&
    context.source.responseMessageTimestamp
  ) {
    try {
      await stopSlackResponseStream({
        accessToken: token,
        channelId: context.source.channelId,
        markdownText: failureMessage,
        timestamp: context.source.responseMessageTimestamp,
      });
      await recordInvestigationSlackReply(investigationId, {
        attachments: [],
        authorName: "Responder",
        blocks: [{ type: "markdown", text: failureMessage }],
        key: "thread-response",
        slackTimestamp: context.source.responseMessageTimestamp,
        text: failureMessage,
      });
    } catch (error) {
      failures.push(error);
    }
  }

  if (context.source.messageTimestamp) {
    const card = slackInvestigationCard({
      agentId: context.agentId,
      detail: "The investigation stopped before it could finish.",
      investigationId: context.investigationId,
      showInvestigationLink: context.executionMode !== "slack_thread",
      status: "error",
      title: context.title,
      traceItems: traceItems ?? context.traceItems,
    });
    try {
      await updateSlackMessage({
        accessToken: token,
        blocks: card.blocks,
        channelId: context.source.channelId,
        text: card.text,
        timestamp: context.source.messageTimestamp,
      });
      await recordInvestigationSlackReply(investigationId, {
        attachments: [],
        authorName: "Responder",
        blocks: card.blocks,
        key: "investigation-status",
        slackTimestamp: context.source.messageTimestamp,
        text: card.text,
      });
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    await setSlackThreadStatus({
      accessToken: token,
      channelId: context.source.channelId,
      status: "",
      threadTimestamp: context.source.threadTimestamp,
    });
  } catch (error) {
    failures.push(error);
  }
  if (context.source.reactionTimestamp) {
    try {
      await removeSlackReaction({
        accessToken: token,
        channelId: context.source.channelId,
        name: "eyes",
        timestamp: context.source.reactionTimestamp,
      });
      await setInvestigationSlackReaction(investigationId, "eyes", false);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Slack investigation failure card update failed for ${investigationId}`,
    );
  }
  return true;
}

export async function failInvestigationSlackCard(
  investigationId: string,
  traceItems?: SlackInvestigationTraceItem[],
): Promise<boolean> {
  try {
    return await performInvestigationSlackCardFailure(
      investigationId,
      traceItems,
    );
  } catch (cause) {
    const error = new AggregateError(
      cause instanceof AggregateError ? cause.errors : [cause],
      `Slack investigation failure update failed for ${investigationId}`,
    );
    recordSlackCardFailure("failure_update_failed", investigationId, error);
    throw error;
  }
}
