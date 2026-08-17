import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  addEventProcessor: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  init: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(false),
  scope: {
    setContext: vi.fn(),
    setTag: vi.fn(),
  },
  withScope: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  addEventProcessor: sentryMocks.addEventProcessor,
  captureException: sentryMocks.captureException,
  flush: sentryMocks.flush,
  init: sentryMocks.init,
  isInitialized: sentryMocks.isInitialized,
  withScope: sentryMocks.withScope.mockImplementation(
    (callback: (scope: typeof sentryMocks.scope) => void) =>
      callback(sentryMocks.scope),
  ),
}));

describe("worker error monitoring", () => {
  beforeEach(() => {
    vi.resetModules();
    sentryMocks.addEventProcessor.mockClear();
    sentryMocks.captureException.mockClear();
    sentryMocks.flush.mockClear();
    sentryMocks.init.mockClear();
    sentryMocks.isInitialized.mockReset().mockReturnValue(false);
    sentryMocks.scope.setContext.mockClear();
    sentryMocks.scope.setTag.mockClear();
    sentryMocks.withScope.mockClear();
  });

  it("stays disabled when no DSN is configured", async () => {
    const monitoring = await import("./monitoring.js");

    expect(monitoring.initializeErrorMonitoring({})).toBe(false);
    await monitoring.reportWorkerException(new Error("failed"), {
      operation: "worker",
    });

    expect(sentryMocks.init).not.toHaveBeenCalled();
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
  });

  it("configures secret redaction when Sentry is already initialized", async () => {
    sentryMocks.isInitialized.mockReturnValue(true);
    const monitoring = await import("./monitoring.js");
    const environment = {
      DAYTONA_API_KEY: "daytona-secret",
      SENTRY_DSN: "https://public@example.invalid/1",
    };

    expect(monitoring.initializeErrorMonitoring(environment)).toBe(true);
    expect(
      monitoring.initializeErrorMonitoring({
        ...environment,
        DAYTONA_API_KEY: "rotated-daytona-secret",
      }),
    ).toBe(true);

    expect(sentryMocks.init).not.toHaveBeenCalled();
    expect(sentryMocks.addEventProcessor).toHaveBeenCalledOnce();
    const processor = sentryMocks.addEventProcessor.mock.calls[0]?.[0] as (
      event: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(
      processor({ message: "request failed for rotated-daytona-secret" }),
    ).toEqual({ message: "request failed for [redacted]" });
  });

  it("preserves stack frames while removing error and event secrets", async () => {
    const monitoring = await import("./monitoring.js");
    const environment = {
      DAYTONA_API_KEY: "daytona-secret",
      NODE_ENV: "production",
      SENTRY_DSN: "https://public@example.invalid/1",
      SENTRY_RELEASE: "abc123",
      VERCEL_CLIENT_SECRET: "vercel-client-secret",
    };

    const originalError = new TypeError("request failed for daytona-secret");
    originalError.stack =
      "TypeError: request failed for daytona-secret\n" +
      "    at runInvestigation (/app/apps/worker/src/investigate.ts:10:2)";

    expect(monitoring.initializeErrorMonitoring(environment)).toBe(true);
    await monitoring.reportWorkerException(
      originalError,
      {
        investigationId: "investigation-1",
        operation: "investigation",
        organizationId: "organization-1",
      },
    );

    expect(sentryMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultIntegrations: false,
        dsn: environment.SENTRY_DSN,
        environment: "production",
        release: "abc123",
        sendDefaultPii: false,
      }),
    );
    const eventProcessor = sentryMocks.addEventProcessor.mock.calls[0]?.[0] as (
      event: Record<string, unknown>,
    ) => Record<string, unknown>;
    const serializedEvent = eventProcessor({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  context_line: "request failed for daytona-secret",
                  filename: "/app/apps/worker/src/investigate.ts",
                },
              ],
            },
            type: "TypeError",
            value: "request failed for daytona-secret",
          },
        ],
      },
      environment: "production",
      extra: {
        accessToken: "dynamic-provider-token",
        authorization: "Bearer dynamic-provider-token",
        diagnostic:
          "request failed for daytona-secret and vercel-client-secret",
        url: "https://example.invalid/callback?access_token=dynamic-provider-token",
      },
    });

    expect(serializedEvent).toEqual(
      expect.objectContaining({
        exception: {
          values: [
            expect.objectContaining({
              stacktrace: {
                frames: [
                  expect.objectContaining({
                    context_line: "request failed for [redacted]",
                  }),
                ],
              },
              type: "TypeError",
              value: "request failed for [redacted]",
            }),
          ],
        },
        environment: "production",
        extra: {
          accessToken: "[redacted]",
          authorization: "[redacted]",
          diagnostic: "request failed for [redacted] and [redacted]",
          url: "https://example.invalid/callback?access_token=[redacted]",
        },
      }),
    );
    expect(sentryMocks.scope.setContext).toHaveBeenCalledWith(
      "responder",
      expect.objectContaining({ investigationId: "investigation-1" }),
    );
    const capturedError = sentryMocks.captureException.mock.calls[0]?.[0] as Error;
    expect(capturedError).not.toBe(originalError);
    expect(capturedError.name).toBe("TypeError");
    expect(capturedError.message).toBe("request failed for [redacted]");
    expect(capturedError.stack).toContain(
      "at runInvestigation (/app/apps/worker/src/investigate.ts:10:2)",
    );
    expect(capturedError.stack).not.toContain("daytona-secret");
    expect(sentryMocks.flush).not.toHaveBeenCalled();

    await expect(monitoring.flushWorkerMonitoring()).resolves.toBe(true);
    expect(sentryMocks.flush).toHaveBeenCalledWith(2_000);
  });

  it("redacts short explicit secrets and inferred key variants", async () => {
    const monitoring = await import("./monitoring.js");
    monitoring.initializeErrorMonitoring({
      AUTUMN_SECRET_KEY: "autumn-value",
      AWS_ACCESS_KEY: "access-value",
      INTERNAL_INGEST_TOKEN: "tiny",
      SENTRY_DSN: "https://public@example.invalid/1",
    });

    await monitoring.reportWorkerException(
      new Error("request failed for tiny, autumn-value, and access-value"),
      { operation: "worker" },
    );

    const processor = sentryMocks.addEventProcessor.mock.calls[0]?.[0] as (
      event: Record<string, unknown>,
    ) => Record<string, unknown>;
    const event = processor({
      extra: {
        accessKey: "dynamic-access-key",
        apiKey: "dynamic-api-key",
        diagnostic:
          "https://example.invalid/callback?client_secret=client-value&refresh-token=refresh-value&id_token=id-value&request_id=req-1",
      },
    });
    const serialized = JSON.stringify(event);

    expect(event).toEqual({
      extra: {
        accessKey: "[redacted]",
        apiKey: "[redacted]",
        diagnostic:
          "https://example.invalid/callback?client_secret=[redacted]&refresh-token=[redacted]&id_token=[redacted]&request_id=req-1",
      },
    });
    expect(serialized).not.toContain("client-value");
    expect(serialized).not.toContain("refresh-value");
    expect(serialized).not.toContain("id-value");

    const capturedError = sentryMocks.captureException.mock.calls[0]?.[0] as Error;
    expect(capturedError.message).toBe(
      "request failed for [redacted], [redacted], and [redacted]",
    );
  });

  it("redacts access-key query parameters while preserving diagnostics", async () => {
    const monitoring = await import("./monitoring.js");
    monitoring.initializeErrorMonitoring({
      SENTRY_DSN: "https://public@example.invalid/1",
    });

    const processor = sentryMocks.addEventProcessor.mock.calls[0]?.[0] as (
      event: Record<string, unknown>,
    ) => Record<string, unknown>;
    const event = processor({
      extra: {
        diagnostic:
          "https://example.invalid/callback?access_key=underscored-value&AcCeSs-KeY=hyphenated-value&request_id=req-1&status=failed",
      },
    });

    expect(event).toEqual({
      extra: {
        diagnostic:
          "https://example.invalid/callback?access_key=[redacted]&AcCeSs-KeY=[redacted]&request_id=req-1&status=failed",
      },
    });
  });

  it("redacts complete error fields before truncating them", async () => {
    const monitoring = await import("./monitoring.js");
    const secret = "boundary-crossing-value";
    monitoring.initializeErrorMonitoring({
      DAYTONA_API_KEY: secret,
      SENTRY_DSN: "https://public@example.invalid/1",
    });

    const originalError = new Error(`${"m".repeat(1_990)}${secret}`);
    originalError.stack = [
      `Error: ${originalError.message}`,
      `    at operation (${"s".repeat(972)}${secret})`,
    ].join("\n");
    await monitoring.reportWorkerException(originalError, {
      operation: "worker",
    });

    const capturedError = sentryMocks.captureException.mock.calls[0]?.[0] as Error;
    expect(capturedError.message).toHaveLength(2_000);
    expect(capturedError.message).toContain("[redacted]");
    expect(capturedError.message).not.toContain("boundary-");
    expect(capturedError.stack).toContain("[redacted]");
    expect(capturedError.stack).not.toContain("boundary-");
  });

  it("attaches safe Slack diagnostics to delivery failures", async () => {
    const monitoring = await import("./monitoring.js");
    const { SlackApiError } = await import(
      "@responder/core/integrations/slack"
    );
    monitoring.initializeErrorMonitoring({
      SENTRY_DSN: "https://public@example.invalid/1",
    });
    const error = new AggregateError(
      [
        new SlackApiError("chat.update", "invalid_blocks", [
          "must be more than 0 characters: /0/tasks/1/output",
        ]),
      ],
      "Slack investigation delivery incomplete",
    );

    await monitoring.reportWorkerException(error, {
      investigationId: "investigation-1",
      operation: "slack_delivery",
      organizationId: "organization-1",
    });

    expect(sentryMocks.scope.setTag).toHaveBeenCalledWith(
      "responder.operation",
      "slack_delivery",
    );
    expect(sentryMocks.scope.setContext).toHaveBeenCalledWith("slack", {
      causes: ["Slack chat.update failed (invalid_blocks)"],
      error: "Slack investigation delivery incomplete",
      slackErrors: [
        {
          code: "invalid_blocks",
          diagnostics: [
            "must be more than 0 characters: /0/tasks/1/output",
          ],
          method: "chat.update",
        },
      ],
    });
    const capturedError = sentryMocks.captureException.mock.calls[0]?.[0] as Error;
    expect(capturedError).not.toBe(error);
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedError.message).toBe(
      "Slack investigation delivery incomplete",
    );
  });

  it("stores structured remediation diagnostics separately from identifiers", async () => {
    const monitoring = await import("./monitoring.js");
    monitoring.initializeErrorMonitoring({
      SENTRY_DSN: "https://public@example.invalid/1",
    });
    const error = new Error("Max turns (40) exceeded");

    await monitoring.reportWorkerException(error, {
      diagnostics: {
        applyPatchFailures: [
          {
            error: "Invalid Context",
            operation: "update_file",
            path: "/workspace/repositories/example/app/src/app.ts",
          },
        ],
        completedTurns: 40,
        maxTurns: 40,
      },
      operation: "remediation",
      requestId: "request-1",
    });

    expect(sentryMocks.scope.setContext).toHaveBeenCalledWith("responder", {
      operation: "remediation",
      requestId: "request-1",
    });
    expect(sentryMocks.scope.setContext).toHaveBeenCalledWith("diagnostics", {
      applyPatchFailures: [
        {
          error: "Invalid Context",
          operation: "update_file",
          path: "/workspace/repositories/example/app/src/app.ts",
        },
      ],
      completedTurns: 40,
      maxTurns: 40,
    });
  });
});
