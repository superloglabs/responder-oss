import type { ErrorEvent } from "@sentry/hono/node";

const retainedHeaders = new Set(["content-length", "content-type"]);

export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  const request = event.request;
  if (!request) return event;

  delete request.cookies;
  delete request.data;
  delete request.query_string;

  if (request.url) {
    const queryIndex = request.url.indexOf("?");
    if (queryIndex !== -1) {
      request.url = request.url.slice(0, queryIndex);
    }
  }

  if (request.headers) {
    for (const name of Object.keys(request.headers)) {
      if (!retainedHeaders.has(name.toLowerCase())) {
        delete request.headers[name];
      }
    }
  }

  return event;
}
