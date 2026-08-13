import { describe, expect, it } from "vitest";
import { scrubSentryEvent } from "./sentry-scrubbing";

describe("scrubSentryEvent", () => {
  it("removes OAuth secrets from the request URL and query string", () => {
    const event = {
      request: {
        query_string: "code=one-time-code&state=connection-state",
        url: "https://responder.example/api/integrations/sentry/callback?code=one-time-code&state=connection-state",
      },
      type: undefined,
    };

    expect(scrubSentryEvent(event).request).toEqual({
      url: "https://responder.example/api/integrations/sentry/callback",
    });
  });

  it("retains safe request metadata while removing sensitive content", () => {
    const event = {
      request: {
        cookies: { session: "secret" },
        data: { code: "one-time-code" },
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
          Cookie: "session=secret",
          Referer: "https://responder.example/callback?code=one-time-code",
          "X-Api-Key": "secret",
        },
        method: "GET",
        url: "https://responder.example/api/health",
      },
      type: undefined,
    };

    expect(scrubSentryEvent(event).request).toEqual({
      headers: {
        "Content-Type": "application/json",
      },
      method: "GET",
      url: "https://responder.example/api/health",
    });
  });
});
