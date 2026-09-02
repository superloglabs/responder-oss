import type {
  InvestigationDetail,
  InvestigationTraceEvent,
} from "../agents-api";

export type InvestigationBadgeTone =
  | "danger"
  | "info"
  | "live"
  | "warning";

export interface InvestigationStatusPresentation {
  label: string;
  tone: InvestigationBadgeTone;
}

export function investigationStatusPresentation(
  investigation: Pick<InvestigationDetail, "issues" | "status"> &
    Partial<Pick<InvestigationDetail, "isReplay" | "replayReport">>,
): InvestigationStatusPresentation {
  switch (investigation.status) {
    case "pending":
      return { label: "Queued", tone: "info" };
    case "investigating":
      return { label: "Investigating", tone: "info" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "resolved": {
      const issueCount = investigation.isReplay
        ? (investigation.replayReport?.issues.length ?? 0)
        : investigation.issues.length;
      if (issueCount === 0) return { label: "No issues found", tone: "live" };
      return {
        label: issueCount === 1 ? "Issue found" : "Issues found",
        tone: "warning",
      };
    }
  }
}

export function providerLabel(
  provider: InvestigationDetail["input"]["provider"],
): string {
  const labels = {
    datadog: "Datadog",
    dash0: "Dash0",
    sentry: "Sentry",
    slack: "Slack",
  } as const;
  return labels[provider];
}

export function triggerContext(input: InvestigationDetail["input"]): string {
  const attributes = input.attributes ?? {};
  const candidates =
    input.provider === "slack"
      ? [
          attributes.channelName,
          attributes.channel,
          attributes.teamName,
        ]
      : input.provider === "sentry"
        ? [
            attributes.projectName,
            attributes.project,
            attributes.projectSlug,
            attributes.environment,
          ]
        : [attributes.service, attributes.monitorName, attributes.environment];
  const context = candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
  if (!context) return providerLabel(input.provider);
  return `${providerLabel(input.provider)} · ${context}`;
}

export function triggerTimestamp(
  input: InvestigationDetail["input"],
): string | null {
  const sentryDetails = sentryTriggerDetails(input);
  const value =
    input.attributes?.timestamp ??
    sentryDetails?.lastSeen ??
    sentryDetails?.firstSeen;
  if (typeof value !== "string" && typeof value !== "number") return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const date = new Date(numeric * 1_000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface SentryTriggerDetails {
  shortId: string | null;
  culprit: string | null;
  level: string | null;
  status: string | null;
  substatus: string | null;
  platform: string | null;
  projectName: string | null;
  projectSlug: string | null;
  issueType: string | null;
  issueCategory: string | null;
  priority: string | null;
  isUnhandled: boolean | null;
  count: string | null;
  userCount: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  errorType: string | null;
  errorValue: string | null;
  filename: string | null;
  functionName: string | null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numericValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sentryTriggerDetails(
  input: InvestigationDetail["input"],
): SentryTriggerDetails | null {
  if (input.provider !== "sentry") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return null;
  }

  const issue = asRecord(parsed);
  if (!issue) return null;
  const project = asRecord(issue.project);
  const metadata = asRecord(issue.metadata);

  return {
    shortId: stringValue(issue.shortId),
    culprit: stringValue(issue.culprit),
    level: stringValue(issue.level),
    status: stringValue(issue.status),
    substatus: stringValue(issue.substatus),
    platform: stringValue(issue.platform) ?? stringValue(project?.platform),
    projectName: stringValue(project?.name),
    projectSlug: stringValue(project?.slug),
    issueType: stringValue(issue.issueType),
    issueCategory: stringValue(issue.issueCategory),
    priority: stringValue(issue.priority),
    isUnhandled:
      typeof issue.isUnhandled === "boolean" ? issue.isUnhandled : null,
    count:
      typeof issue.count === "string" || typeof issue.count === "number"
        ? String(issue.count)
        : null,
    userCount: numericValue(issue.userCount),
    firstSeen: stringValue(issue.firstSeen),
    lastSeen: stringValue(issue.lastSeen),
    errorType: stringValue(metadata?.type),
    errorValue: stringValue(metadata?.value),
    filename: stringValue(metadata?.filename),
    functionName: stringValue(metadata?.function),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function traceEventText(
  event: InvestigationTraceEvent,
): string | null {
  const data = asRecord(event.data);
  const content =
    event.type === "reasoning.completed"
      ? data?.reasoning
      : event.type === "message.completed" || event.type === "message.received"
        ? data?.message
        : null;
  return typeof content === "string" && content.trim().length > 0
    ? content
    : null;
}

export function toolInputSummary(input: unknown): string | null {
  const record = asRecord(input);
  if (!record) return null;
  const preferredKeys = [
    "command",
    "query",
    "path",
    "filePath",
    "pattern",
    "url",
    "issueId",
    "repository",
  ];
  const value = preferredKeys
    .map((key) => record[key])
    .find(
      (candidate): candidate is string | number | boolean =>
        typeof candidate === "string" ||
        typeof candidate === "number" ||
        typeof candidate === "boolean",
    );
  if (value === undefined) return null;
  const summary = String(value).replace(/\s+/g, " ").trim();
  if (!summary) return null;
  return summary.length > 72 ? `${summary.slice(0, 69)}…` : summary;
}

export function sourceActionLabel(
  provider: InvestigationDetail["input"]["provider"],
): string {
  return `View in ${providerLabel(provider)}`;
}
