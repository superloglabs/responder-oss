import { failedRequestRoute, stripNullBytes } from "./fingerprint.js";

// A request that failed with a server error often leaves no exception and no
// error log: only a request log line, at any level, with the status among
// its fields. Such a line becomes an error issue too. There is no standard
// name for these fields on a log record, so the names below are the ones
// OpenTelemetry uses on spans and the ones common in request logs. The
// status needs a route beside it: alone, a field called `code` or `status`
// may be anything.
//
// The ClickHouse view that feeds otel_issue_candidates lets these lines in
// with the same names. A name added here must be added there.
export const failedRequestStatusAttributes = [
  "http.response.status_code",
  "http.status_code",
  "status_code",
  "statusCode",
  "status",
  "code",
] as const;
export const failedRequestRouteAttributes = [
  "http.route",
  "url.path",
  "http.target",
  "route",
  "endpoint",
  "path",
  "url",
] as const;
// Where the error's text may be, the most specific first.
const messageAttributes = ["error.message", "error", "message", "msg", "response", "response.body"] as const;

const maximumTextLength = 300;

export type FailedRequest = {
  status: number;
  route: string;
  // What the request answered or logged as its error, when it says.
  message: string | null;
};

function firstValue(attributes: Record<string, string>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = attributes[name]?.trim();
    if (value) return value;
  }
  return null;
}

// The keys a JSON response body names its error under, the most specific
// first. `detail` and `title` are those of a problem details body (RFC 9457).
const bodyTextKeys = ["message", "error", "detail", "title"] as const;

// The error text of a field. A response body is often JSON, sometimes
// printed over several lines and not always valid, so its text is found by
// key instead of by parsing. A page of HTML says nothing worth grouping by.
function errorText(value: string): string | null {
  const text = stripNullBytes(value).trim();
  if (text.startsWith("<")) return null;
  if (text.startsWith("{") || text.startsWith("[")) {
    for (const key of bodyTextKeys) {
      const field = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "u"))?.[1];
      const found = field?.replace(/\\(["\\/])/gu, "$1").trim().slice(0, maximumTextLength);
      if (found) return found;
    }
    return null;
  }
  const line = text.split("\n").find((part) => part.trim())?.trim() ?? "";
  return line.slice(0, maximumTextLength) || null;
}

// The failed request a log record's fields describe, or null when they do
// not describe one.
export function failedRequestOf(attributes: Record<string, string> | null | undefined): FailedRequest | null {
  if (!attributes) return null;
  // Any of the names may hold it: a line can have a `status` of "error"
  // beside a `code` of 500.
  const status = failedRequestStatusAttributes.map((name) => attributes[name]?.trim()).find((value) => value && /^5\d\d$/u.test(value));
  if (!status) return null;
  const route = firstValue(attributes, failedRequestRouteAttributes);
  if (!route) return null;
  let message: string | null = null;
  for (const name of messageAttributes) {
    const value = attributes[name];
    message = value ? errorText(value) : null;
    if (message) break;
  }
  return { status: Number(status), route: failedRequestRoute(route), message };
}

// What the issue is called and grouped under in lists: the status, the
// route, and the error text.
export function failedRequestMessage(request: FailedRequest): string {
  return request.message ? `HTTP ${request.status} ${request.route}: ${request.message}` : `HTTP ${request.status} ${request.route}`;
}
