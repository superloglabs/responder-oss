import { SpanKind } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  ScrubbingSpanProcessor,
  scrubSentryBreadcrumb,
  scrubSentryEventTelemetry,
  scrubSentrySpan,
  scrubSpanAttributes,
  scrubSpanName,
  scrubUrl,
} from "./span-scrubbing.js";

describe("scrubSpanAttributes", () => {
  it("keeps only the listed request and response headers", () => {
    expect(scrubSpanAttributes({
      "http.method": "POST",
      "http.request.header.authorization": "Bearer abc",
      "http.request.header.content_length": "120",
      "http.request.header.content_type": "application/json",
      "http.request.header.cookie.session": "abc",
      "http.request.header.linear_signature": "sig",
      "http.request.header.user_agent": "Slackbot 1.0",
      "http.request.header.x_hub_signature_256": "sha256=abc",
      "http.request.header.x_responder_origin_verify": "origin-secret",
      "http.request.header.x_slack_signature": "v0=abc",
      "http.response.header.content-type": "text/html",
      "http.response.header.set_cookie": "session=abc",
    })).toEqual({
      "http.method": "POST",
      "http.request.header.content_length": "120",
      "http.request.header.content_type": "application/json",
      "http.request.header.user_agent": "Slackbot 1.0",
      "http.response.header.content-type": "text/html",
    });
  });

  it("removes query strings from URL attributes", () => {
    expect(scrubSpanAttributes({
      "http.fragment": "#section",
      "http.query": "?code=abc&state=def",
      "http.route": "/api/integrations/:provider/callback",
      "http.target": "/api/integrations/github/callback?code=abc&state=def",
      "http.url": "https://app.example.com/api/integrations/github/callback?code=abc&state=def",
      "url.full": "https://checks.example.com/health?api_key=abc#top",
      "url.path": "/health",
      "url.query": "?api_key=abc",
    })).toEqual({
      "http.route": "/api/integrations/:provider/callback",
      "http.target": "/api/integrations/github/callback",
      "http.url": "https://app.example.com/api/integrations/github/callback",
      "url.full": "https://checks.example.com/health",
      "url.path": "/health",
    });
  });

  it("replaces tokens in password reset paths", () => {
    expect(scrubSpanAttributes({
      "http.target": "/api/auth/reset-password/tok123?callbackURL=%2Freset",
      "url.full": "https://app.example.com/api/auth/reset-password/tok123",
      "url.path": "/api/auth/reset-password/tok123",
    })).toEqual({
      "http.target": "/api/auth/reset-password/[redacted]",
      "url.full": "https://app.example.com/api/auth/reset-password/[redacted]",
      "url.path": "/api/auth/reset-password/[redacted]",
    });
  });

  it("replaces the path of Slack webhook and response URLs", () => {
    expect(scrubSpanAttributes({
      "server.address": "hooks.slack.com",
      "url.full": "https://hooks.slack.com/actions/T123/456/abcdef",
      "url.path": "/actions/T123/456/abcdef",
    })).toEqual({
      "server.address": "hooks.slack.com",
      "url.full": "https://hooks.slack.com/actions/[redacted]",
      "url.path": "/actions/[redacted]",
    });
  });

  it("leaves the attributes it was given unchanged", () => {
    const attributes = { "http.url": "https://app.example.com/?token=abc" };
    scrubSpanAttributes(attributes);
    expect(attributes).toEqual({ "http.url": "https://app.example.com/?token=abc" });
  });
});

describe("scrubSpanName", () => {
  it("scrubs the target of a request span's name", () => {
    expect(scrubSpanName("GET /api/auth/reset-password/tok123")).toBe(
      "GET /api/auth/reset-password/[redacted]",
    );
    expect(scrubSpanName("GET https://checks.example.com/health?api_key=abc")).toBe(
      "GET https://checks.example.com/health",
    );
  });

  it("leaves other names alone", () => {
    expect(scrubSpanName("select * from widgets where id = ?")).toBe(
      "select * from widgets where id = ?",
    );
    expect(scrubSpanName("pg.query:SELECT acme")).toBe("pg.query:SELECT acme");
  });
});

describe("scrubUrl", () => {
  it("keeps a URL without a query as it is", () => {
    expect(scrubUrl("https://app.example.com/api/widgets")).toBe(
      "https://app.example.com/api/widgets",
    );
  });
});

describe("ScrubbingSpanProcessor", () => {
  it("scrubs spans before later processors export them", () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new ScrubbingSpanProcessor(), new SimpleSpanProcessor(exporter)],
    });
    const span = provider.getTracer("test").startSpan(
      "GET /api/auth/reset-password/tok123",
      {
        attributes: {
          "http.request.header.user_agent": "curl/8",
          "http.request.header.x_responder_origin_verify": "origin-secret",
          "http.url": "https://app.example.com/api/auth/reset-password/tok123?callbackURL=%2F",
        },
        kind: SpanKind.SERVER,
      },
    );
    span.end();

    const [exported] = exporter.getFinishedSpans();
    expect(exported?.name).toBe("GET /api/auth/reset-password/[redacted]");
    expect(exported?.attributes).toEqual({
      "http.request.header.user_agent": "curl/8",
      "http.url": "https://app.example.com/api/auth/reset-password/[redacted]",
    });
  });
});

describe("Sentry scrubbing", () => {
  it("scrubs a span's data and description", () => {
    expect(scrubSentrySpan({
      data: {
        "http.request.header.x_slack_signature": "v0=abc",
        "url.full": "https://mcp.example.com/sse?key=abc",
      },
      description: "GET https://mcp.example.com/sse?key=abc",
      op: "http.client",
    })).toEqual({
      data: { "url.full": "https://mcp.example.com/sse" },
      description: "GET https://mcp.example.com/sse",
      op: "http.client",
    });
  });

  it("scrubs an HTTP breadcrumb's URL", () => {
    expect(scrubSentryBreadcrumb({
      category: "http",
      data: {
        "http.query": "?token=abc",
        method: "GET",
        url: "https://checks.example.com/health?token=abc",
      },
    })).toEqual({
      category: "http",
      data: { method: "GET", url: "https://checks.example.com/health" },
    });
  });

  it("scrubs a transaction's name, root span, spans, and request", () => {
    const rootData = {
      "http.request.header.x_responder_origin_verify": "origin-secret",
      "http.target": "/api/integrations/chat/complete?ticket=abc",
    };
    const event = scrubSentryEventTelemetry({
      breadcrumbs: [{ data: { url: "https://example.com/?api_key=abc" } }],
      contexts: {
        trace: {
          data: rootData,
          description: "GET /api/auth/reset-password/tok123",
          span_id: "1",
        },
      },
      request: {
        cookies: { session: "abc" },
        headers: {
          "Content-Type": "application/json",
          "x-responder-origin-verify": "origin-secret",
        },
        query_string: "ticket=abc",
        url: "https://app.example.com/api/integrations/chat/complete?ticket=abc",
      },
      spans: [{ data: { "url.query": "?api_key=abc" }, description: "GET /x?api_key=abc" }],
      transaction: "GET /api/auth/reset-password/tok123",
    });

    expect(event).toEqual({
      breadcrumbs: [{ data: { url: "https://example.com/" } }],
      contexts: {
        trace: {
          data: { "http.target": "/api/integrations/chat/complete" },
          description: "GET /api/auth/reset-password/[redacted]",
          span_id: "1",
        },
      },
      request: {
        headers: { "Content-Type": "application/json" },
        url: "https://app.example.com/api/integrations/chat/complete",
      },
      spans: [{ data: {}, description: "GET /x" }],
      transaction: "GET /api/auth/reset-password/[redacted]",
    });
    expect(rootData["http.request.header.x_responder_origin_verify"]).toBe("origin-secret");
  });
});
