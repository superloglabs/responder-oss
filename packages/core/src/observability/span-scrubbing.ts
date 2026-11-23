import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

// What spans may keep of HTTP requests, in our own telemetry and in Sentry.
//
// - Request and response headers: only the ones listed here. Others can hold
//   credentials, signatures, cookies, or the origin secret.
// - URLs: no query string or fragment, which can hold OAuth codes, one-time
//   tokens, or keys in a URL someone configured.
// - Paths that carry a token have the token replaced.

// Header names as Sentry records them: lower case, dashes as underscores.
const keptHeaders = new Set(["content_length", "content_type", "user_agent"]);
const headerAttribute = /^http\.(?:request|response)\.header\.(.+)$/u;
// Attributes that hold a URL or a path, which may end in a query string.
const urlAttributes = [
  "http.target",
  "http.url",
  "url.full",
  "url.original",
  "url.path",
] as const;
// Attributes that hold only a query string or a fragment.
const queryAttributes = [
  "http.fragment",
  "http.query",
  "url.fragment",
  "url.query",
] as const;
export const redactedValue = "[redacted]";

// A path segment, or the rest of a path, that is a credential.
const slackHookPath = /^(\/(?:actions|services|triggers|workflows)\/)[^?#\s]+/iu;
const tokenPaths: ReadonlyArray<readonly [RegExp, string]> = [
  // Password reset links.
  [/(\/api\/auth\/reset-password\/)[^/?#\s]+/gu, `$1${redactedValue}`],
  // Slack incoming webhooks and response URLs.
  [
    /(\/\/hooks\.slack\.com\/(?:actions|services|triggers|workflows)\/)[^?#\s]+/giu,
    `$1${redactedValue}`,
  ],
];
// Attributes that name the host of an outgoing request.
const hostAttributes = ["server.address", "net.peer.name", "http.host"] as const;

// A URL or path without its query string and fragment, and with any token in
// its path replaced.
export function scrubUrl(value: string): string {
  const end = value.search(/[?#]/u);
  const withoutQuery = end === -1 ? value : value.slice(0, end);
  return tokenPaths.reduce(
    (scrubbed, [pattern, replacement]) => scrubbed.replace(pattern, replacement),
    withoutQuery,
  );
}

// Sentry and HTTP instrumentations name a request's span "METHOD target".
// Other names, such as a SQL statement, are left alone.
export function scrubSpanName(name: string): string {
  const match = /^([A-Z]+) (\S+)$/u.exec(name);
  return match ? `${match[1]} ${scrubUrl(match[2]!)}` : name;
}

// A copy of span attributes without headers, query strings, or path tokens.
export function scrubSpanAttributes<T extends Record<string, unknown>>(
  attributes: T,
): T {
  const record: Record<string, unknown> = { ...attributes };
  for (const key of Object.keys(record)) {
    const header = headerAttribute.exec(key)?.[1];
    if (header !== undefined && !keptHeaders.has(header.replace(/-/gu, "_"))) {
      delete record[key];
    }
  }
  for (const key of queryAttributes) delete record[key];
  const slackHook = hostAttributes.some((key) => {
    const host = record[key];
    return typeof host === "string" && /^hooks\.slack\.com(?::\d+)?$/iu.test(host);
  });
  for (const key of urlAttributes) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const scrubbed = scrubUrl(value);
    record[key] = slackHook
      ? scrubbed.replace(slackHookPath, `$1${redactedValue}`)
      : scrubbed;
  }
  return record as T;
}

// Runs before the processors that export spans, so neither Sentry nor the
// OTLP endpoint receives what it removes.
export class ScrubbingSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    const writable = span as { attributes: ReadableSpan["attributes"]; name: string };
    writable.attributes = scrubSpanAttributes(span.attributes);
    writable.name = scrubSpanName(span.name);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// Sentry's shapes, kept loose so both its Node and Hono SDKs' types fit.
type SentrySpanLike = {
  data?: Record<string, unknown>;
  description?: string;
};
type SentryBreadcrumbLike = { data?: Record<string, unknown> };
type SentryEventLike = {
  breadcrumbs?: SentryBreadcrumbLike[];
  contexts?: {
    trace?: { data?: Record<string, unknown>; description?: string };
  };
  request?: {
    cookies?: unknown;
    data?: unknown;
    headers?: Record<string, string>;
    query_string?: unknown;
    url?: string;
  };
  spans?: SentrySpanLike[];
  transaction?: string;
};

// For Sentry's beforeSendSpan, which Sentry applies to a transaction's root
// span and to each of its spans. Returns a scrubbed copy.
export function scrubSentrySpan<T extends SentrySpanLike>(span: T): T {
  return {
    ...span,
    ...(span.data ? { data: scrubSpanAttributes(span.data) } : {}),
    ...(typeof span.description === "string"
      ? { description: scrubSpanName(span.description) }
      : {}),
  };
}

// For Sentry's beforeBreadcrumb: an HTTP breadcrumb keeps its URL without the
// query string. Returns a scrubbed copy.
export function scrubSentryBreadcrumb<T extends SentryBreadcrumbLike>(
  breadcrumb: T,
): T {
  if (!breadcrumb.data) return breadcrumb;
  const data = { ...breadcrumb.data };
  delete data["http.query"];
  delete data["http.fragment"];
  if (typeof data.url === "string") data.url = scrubUrl(data.url);
  return { ...breadcrumb, data };
}

// Scrubs the request, spans, and breadcrumbs of a Sentry error or transaction
// event. The event's own fields are replaced with scrubbed copies; the objects
// they held are not changed.
export function scrubSentryEventTelemetry<T extends SentryEventLike>(event: T): T {
  if (typeof event.transaction === "string") {
    event.transaction = scrubSpanName(event.transaction);
  }
  const trace = event.contexts?.trace;
  if (trace) event.contexts = { ...event.contexts, trace: scrubSentrySpan(trace) };
  if (event.spans) event.spans = event.spans.map(scrubSentrySpan);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubSentryBreadcrumb);
  }
  if (event.request) {
    const request = { ...event.request };
    delete request.cookies;
    delete request.data;
    delete request.query_string;
    if (typeof request.url === "string") request.url = scrubUrl(request.url);
    if (request.headers) {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).filter(([name]) =>
          keptHeaders.has(name.toLowerCase().replace(/-/gu, "_"))),
      );
    }
    event.request = request;
  }
  return event;
}
