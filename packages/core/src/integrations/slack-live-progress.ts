import { randomUUID } from "node:crypto";
import type { InvestigationSlackTraceItem } from "../db/schema.js";

export interface SlackProgressUpdate {
  detail: string;
  finalizing?: boolean;
  traceItems?: SlackInvestigationTraceItem[];
  traceResult?: {
    id: string;
    output: string;
    status: "complete" | "error";
  };
}

export type SlackInvestigationTraceItem = InvestigationSlackTraceItem;

export interface SlackProgressTraceEvent {
  data?: unknown;
  meta?: unknown;
  type: string;
}

export function applySlackTraceUpdate(
  items: SlackInvestigationTraceItem[],
  update: SlackProgressUpdate,
): SlackInvestigationTraceItem[] {
  let next = [...items];
  for (const traceItem of update.traceItems ?? []) {
    const existingIndex = next.findIndex((item) => item.id === traceItem.id);
    if (existingIndex >= 0) next[existingIndex] = traceItem;
    else next.push(traceItem);
  }
  if (update.traceResult) {
    next = next.map((item) =>
      item.id === update.traceResult?.id
        ? {
            ...item,
            output: update.traceResult.output,
            status: update.traceResult.status,
          }
        : item,
    );
  }
  return next.slice(-12);
}

function eventData(event: SlackProgressTraceEvent): Record<string, unknown> {
  return event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : {};
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requestedActions(
  event: SlackProgressTraceEvent,
): Record<string, unknown>[] {
  const actions = eventData(event).actions;
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((action) => {
    const value = record(action);
    return value ? [value] : [];
  });
}

const sensitiveKeyPattern =
  /(^|[_-])(authorization|cookie|credential|password|secret|token|api[_-]?key)($|[_-])/i;

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return sensitiveKeyPattern.test(normalized);
}

function scrubString(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\b(?:xox[baprs]-|gh[pousr]_|sk-)[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/([?&](?:access_token|api_key|key|token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/:\/\/([^/@\s]+):([^/@\s]+)@/g, "://[redacted]@")
    .slice(0, 1_000);
}

function scrubTraceValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (typeof value === "string") return scrubString(value);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value !== "object") return String(value ?? "");
  if (depth >= 5) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, 12)
      .map((entry) => scrubTraceValue(entry, seen, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 24)
      .map(([key, entry]) => [
        key,
        isSensitiveKey(key)
          ? "[redacted]"
          : scrubTraceValue(entry, seen, depth + 1),
      ]),
  );
}

function traceInput(value: unknown): string {
  const serialized = JSON.stringify(scrubTraceValue(value ?? {}), null, 2);
  return serialized.length > 1_500
    ? `${serialized.slice(0, 1_499).trimEnd()}…`
    : serialized;
}

function traceText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? scrubString(value.trim())
    : undefined;
}

function eventId(event: SlackProgressTraceEvent, prefix: string): string {
  const meta = record(event.meta);
  const at = typeof meta?.at === "string" ? meta.at : randomUUID();
  return `${prefix}:${at}`;
}

// A Slack assistant request describes its steps as work on the request, not
// as an investigation.
function assistantPhaseForTool(tool: string): string {
  if (tool === "open_pull_request") return "Opening a pull request.";
  if (/^(create|update)_automation$|^update_tag_mode$/.test(tool)) {
    return "Updating the workspace.";
  }
  if (/^get_(workspace|automation)/.test(tool)) return "Reading the workspace settings.";
  if (
    tool === "list_repository_files" ||
    tool === "search_repository" ||
    tool === "read_repository_file"
  ) {
    return "Reading the code.";
  }
  if (/axiom|datadog|grafana|sentry|clickstack|upstash|langfuse|vercel|mcp/i.test(tool)) {
    return "Checking connected tools.";
  }
  return "Working on the request.";
}

function phaseForTool(tool: string): string {
  if (tool === "search_existing_issues") {
    return "Checking for related issues and earlier incidents.";
  }
  if (
    tool === "list_repository_files" ||
    tool === "search_repository" ||
    tool === "read_repository_file"
  ) {
    return "Inspecting the relevant source code.";
  }
  if (/axiom|datadog|grafana|sentry|clickstack|upstash|langfuse|vercel|mcp/i.test(tool)) {
    return "Gathering telemetry and surrounding service activity.";
  }
  return "Gathering evidence for the investigation.";
}

export function slackProgressFromTrace(
  event: SlackProgressTraceEvent,
  options: { assistant?: boolean } = {},
): SlackProgressUpdate | null {
  const assistant = options.assistant === true;
  switch (event.type) {
    case "session.started":
      return {
        detail: assistant
          ? "Starting and loading the workspace context."
          : "Starting the investigation and loading its context.",
        traceItems: [
          {
            id: eventId(event, "session"),
            status: "complete",
            title: assistant
              ? "Loaded the workspace context"
              : "Loaded the investigation context",
          },
        ],
      };
    case "instructions.configured":
      return {
        detail: assistant ? "Reading the request." : "Preparing the investigation plan.",
        traceItems: [
          {
            id: eventId(event, "instructions"),
            status: "complete",
            title: assistant ? "Read the request" : "Prepared the investigation plan",
          },
        ],
      };
    case "reasoning.completed":
      return {
        detail: assistant ? "Thinking." : "Analyzing the evidence collected so far.",
        traceItems: [
          {
            id: eventId(event, "reasoning"),
            status: "complete",
            title: "Reasoning turn",
          },
        ],
      };
    case "message.completed": {
      const message = traceText(eventData(event).message);
      return {
        detail: assistant ? "Writing the reply." : "Summarizing the investigation findings.",
        traceItems: [
          {
            id: eventId(event, "message"),
            ...(message ? { output: message } : {}),
            status: "complete",
            title: "Assistant turn",
          },
        ],
      };
    }
    case "actions.requested": {
      const actions = requestedActions(event);
      if (actions.length === 0) return null;
      const traceItems = actions.map((action) => {
        const tool =
          typeof action.toolName === "string" ? action.toolName : "tool";
        return {
          detail: traceInput(action.input),
          id:
            typeof action.callId === "string"
              ? action.callId
              : eventId(event, tool),
          status: "in_progress" as const,
          title: tool,
        };
      });
      const finalizing = traceItems.some(
        (item) => item.title === "submit_investigation_report",
      );
      if (finalizing) {
        return {
          detail: "Preparing the final findings.",
          finalizing: true,
          traceItems,
        };
      }
      const tool = traceItems[0]?.title ?? "tool";
      return {
        detail: assistant ? assistantPhaseForTool(tool) : phaseForTool(tool),
        traceItems,
      };
    }
    case "action.result": {
      const data = eventData(event);
      const result = record(data.result);
      const id =
        typeof result?.callId === "string" ? result.callId : null;
      if (!id) return null;
      return {
        detail:
          data.status === "failed"
            ? assistant
              ? "A tool call failed; continuing."
              : "A tool call failed; continuing with the available evidence."
            : "Reviewing the latest tool result.",
        traceResult: {
          id,
          output: traceInput(result?.output),
          status: data.status === "failed" ? "error" : "complete",
        },
      };
    }
    default:
      return null;
  }
}
