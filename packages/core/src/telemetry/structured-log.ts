// A log line written as one JSON object, as pino, winston, bunyan, and
// structlog write it: `{"level":"error","msg":"...","err":{"stack":"..."}}`.
// Sources such as Vercel keep the whole object as the log's body.

import { pythonTracebackException } from "./fingerprint.js";

// Longer lines, in UTF-16 code units, are not read as JSON, so one huge line
// costs no parse.
const maxLineLength = 64 * 1024;

export type LogSeverity = { number: number; text: string };

// OpenTelemetry severities by level name, as loggers write them in any case.
const severities: Record<string, LogSeverity> = {
  critical: { number: 21, text: "FATAL" },
  debug: { number: 5, text: "DEBUG" },
  error: { number: 17, text: "ERROR" },
  fatal: { number: 21, text: "FATAL" },
  info: { number: 9, text: "INFO" },
  trace: { number: 1, text: "TRACE" },
  warn: { number: 13, text: "WARN" },
  warning: { number: 13, text: "WARN" },
};

// pino's and bunyan's numeric levels.
const numericLevels: Record<number, string> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };

// The severity a level name or number stands for, or undefined for any other
// value.
export function levelSeverity(level: unknown): LogSeverity | undefined {
  const name = typeof level === "number"
    ? numericLevels[level]
    : typeof level === "string" ? level.trim().toLowerCase() : undefined;
  return name !== undefined && Object.hasOwn(severities, name) ? severities[name] : undefined;
}

// The fields loggers name their level with, in the order they are read.
const levelFields = ["level", "severity", "levelname", "log_level"] as const;

// The severity of the first level field of a JSON log line that names a
// known level.
export function fieldsSeverity(fields: Record<string, unknown>): LogSeverity | undefined {
  for (const key of levelFields) {
    const severity = levelSeverity(fields[key]);
    if (severity) return severity;
  }
  return undefined;
}

// The fields of a line that is one JSON object, or null for any other text.
export function jsonLogFields(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string" || text.length > maxLineLength) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export type StructuredLogLine = {
  // The error a line carries, when it has one.
  errorMessage: string | null;
  errorType: string | null;
  // What the line says happened, without the fields that change with each
  // line, such as its time, process, host, and trace.
  message: string;
  stacktrace: string | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The exception type a stack names: on its last line for a Python traceback,
// and on its first line for a JavaScript stack, `TypeError: fetch failed`.
function stackType(stack: string | null): string | null {
  if (!stack) return null;
  const traceback = pythonTracebackException(stack);
  if (traceback) return traceback.type;
  const first = stack.split("\n", 1)[0]?.trim() ?? "";
  return /^([A-Za-z_$][\w.$]*)(?::|$)/u.exec(first)?.[1] ?? null;
}

// The message and error of a JSON log line, or null when the body is not one
// or says nothing beyond its fields' names.
export function structuredLogLine(body: string): StructuredLogLine | null {
  const fields = jsonLogFields(body);
  if (!fields) return null;
  const rawError = fields.err ?? fields.error ?? fields.exception;
  const error = rawError && typeof rawError === "object" && !Array.isArray(rawError) ? (rawError as Record<string, unknown>) : null;
  // A Python traceback given as the error is its stack, not its message.
  const errorText = error ? null : text(rawError);
  const errorTraceback = errorText ? pythonTracebackException(errorText) : null;
  const stacktrace = text(error?.stack) ?? text(error?.stacktrace) ?? (errorTraceback ? errorText : null) ??
    text(fields.stack) ?? text(fields.stacktrace);
  const errorMessage = error
    ? text(error.message)
    : errorTraceback ? text(errorTraceback.message) : errorText;
  const errorType = text(error?.type) ?? text(error?.name) ?? stackType(stacktrace);
  const message = text(fields.msg) ?? text(fields.message) ?? text(fields.event) ?? errorMessage ?? errorType;
  if (!message) return null;
  return {
    errorMessage,
    errorType,
    message: errorMessage && errorMessage !== message ? `${message}: ${errorMessage}` : message,
    stacktrace,
  };
}
