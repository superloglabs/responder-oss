// A log line written as one JSON object, as pino, winston, bunyan, and
// structlog write it: `{"level":"error","msg":"...","err":{"stack":"..."}}`.
// Sources such as Vercel keep the whole object as the log's body.

// Longer lines are not read as JSON, so one huge line costs no parse.
const maxLineLength = 64 * 1024;

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

// The exception type a JavaScript or Python stack names on its first line:
// `TypeError: fetch failed`.
function stackType(stack: string | null): string | null {
  const first = stack?.split("\n", 1)[0]?.trim() ?? "";
  return /^([A-Za-z_$][\w.$]*)(?::|$)/u.exec(first)?.[1] ?? null;
}

// The message and error of a JSON log line, or null when the body is not one
// or says nothing beyond its fields' names.
export function structuredLogLine(body: string): StructuredLogLine | null {
  const fields = jsonLogFields(body);
  if (!fields) return null;
  const rawError = fields.err ?? fields.error ?? fields.exception;
  const error = rawError && typeof rawError === "object" && !Array.isArray(rawError) ? (rawError as Record<string, unknown>) : null;
  const errorMessage = error ? text(error.message) : text(rawError);
  const stacktrace = text(error?.stack) ?? text(fields.stack) ?? text(fields.stacktrace);
  const errorType = text(error?.type) ?? text(error?.name) ?? stackType(stacktrace);
  const message = text(fields.msg) ?? text(fields.message) ?? text(fields.event) ?? errorMessage;
  if (!message) return null;
  return {
    errorMessage,
    errorType,
    message: errorMessage && errorMessage !== message ? `${message}: ${errorMessage}` : message,
    stacktrace,
  };
}
