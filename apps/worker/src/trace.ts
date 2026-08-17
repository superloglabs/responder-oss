import type { RunStreamEvent } from "@openai/agents";
import type { InvestigationTraceEvent } from "@responder/core/db/schema";
import { redactDaytonaSecretPlaceholders } from "./secret-safety.js";

const maximumTextLength = 20_000;
const secretFieldPattern =
  /(^|[_-])(authorization|cookie|credential|password|secret|token|api[_-]?key)($|[_-])/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function redactText(
  value: string,
  environment: NodeJS.ProcessEnv,
): string {
  let safe = redactDaytonaSecretPlaceholders(value);
  for (const name of ["OPENAI_API_KEY", "DAYTONA_API_KEY"] as const) {
    const secret = environment[name];
    if (secret) safe = safe.replaceAll(secret, "[redacted]");
  }
  return safe.length > maximumTextLength
    ? `${safe.slice(0, maximumTextLength)}…`
    : safe;
}

function safeTraceValue(
  value: unknown,
  environment: NodeJS.ProcessEnv,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (typeof value === "string") return redactText(value, environment);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value ?? "");
  if (depth >= 8) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((entry) => safeTraceValue(entry, environment, seen, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, entry]) => [
        key,
        secretFieldPattern.test(key)
          ? "[redacted]"
          : safeTraceValue(entry, environment, seen, depth + 1),
      ]),
  );
}

function joinedText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .flatMap((part) => {
      const record = asRecord(part);
      const value = text(record?.text);
      return value ? [value] : [];
    })
    .join("\n")
    .trim();
  return result || undefined;
}

function toolName(item: Record<string, unknown>, raw: Record<string, unknown>): string {
  const direct = text(item.toolName) ?? text(raw.name);
  if (direct) return direct;
  switch (raw.type) {
    case "apply_patch_call":
      return "apply_patch";
    case "computer_call":
      return "computer";
    case "program":
      return "programmatic_tool_calling";
    case "shell_call":
      return "bash";
    default:
      return text(raw.type) ?? "tool";
  }
}

function toolInput(raw: Record<string, unknown>): unknown {
  const argumentsText = text(raw.arguments);
  if (argumentsText) {
    try {
      return JSON.parse(argumentsText) as unknown;
    } catch {
      return { arguments: argumentsText };
    }
  }
  if (raw.action !== undefined) return raw.action;
  if (raw.operation !== undefined) return raw.operation;
  if (typeof raw.code === "string") return { code: raw.code };
  return {};
}

export function traceEvent(
  type: string,
  data?: unknown,
  at = new Date(),
): InvestigationTraceEvent {
  return {
    ...(data === undefined ? {} : { data }),
    meta: { at: at.toISOString() },
    type,
  };
}

export function investigationTraceEventFromStream(
  event: RunStreamEvent,
  environment: NodeJS.ProcessEnv = process.env,
  at = new Date(),
): InvestigationTraceEvent | null {
  if (event.type !== "run_item_stream_event") return null;

  const item = asRecord(event.item);
  const raw = asRecord(item?.rawItem) ?? {};
  if (!item) return null;

  if (event.name === "message_output_created") {
    const message =
      text(item.content) ?? joinedText(raw.content) ?? "";
    if (!message.trim()) return null;
    return traceEvent(
      "message.completed",
      { message: redactText(message, environment) },
      at,
    );
  }

  if (event.name === "reasoning_item_created") {
    const reasoning = joinedText(raw.rawContent) ?? joinedText(raw.content);
    if (!reasoning) return null;
    return traceEvent(
      "reasoning.completed",
      { reasoning: redactText(reasoning, environment) },
      at,
    );
  }

  if (event.name === "tool_called") {
    const callId = text(item.callId) ?? text(raw.callId) ?? text(raw.id);
    const name = toolName(item, raw);
    return traceEvent(
      "actions.requested",
      {
        actions: [
          {
            callId,
            input: safeTraceValue(toolInput(raw), environment),
            kind: "tool-call",
            toolName: name,
          },
        ],
      },
      at,
    );
  }

  if (event.name === "tool_output") {
    const callId = text(item.callId) ?? text(raw.callId) ?? text(raw.id);
    return traceEvent(
      "action.result",
      {
        result: {
          callId,
          kind: "tool-result",
          output: safeTraceValue(item.output ?? raw.output, environment),
        },
        status: raw.status === "incomplete" ? "failed" : "completed",
      },
      at,
    );
  }

  return null;
}
